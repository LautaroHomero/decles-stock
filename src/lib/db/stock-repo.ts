import { randomUUID } from "node:crypto";
import { realNowIso } from "@/lib/domain/clock";
import type { StaffRole } from "@/lib/domain/types";
import { getSql } from "./connection";

/**
 * Acceso a datos del stock (items, lotes, movimientos). La autorización y las
 * validaciones viven en `src/lib/domain/stock.ts`; acá solo SQL, y toda query
 * filtra por `organization_id`.
 */

type Row = Record<string, unknown>;
const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

/** Hoy en fecha real (no el reloj simulado de la agenda): el vencimiento es del mundo real. */
export const todayYmd = () => realNowIso().slice(0, 10);

export type StockReason = "ingreso" | "uso" | "vencimiento" | "perdida" | "ajuste";
export type StockSource = "manual" | "agent";

export interface StockLot {
  id: string;
  itemId: string;
  lotCode: string;
  quantity: number;
  initialQuantity: number;
  /** YYYY-MM-DD; null = no vence. */
  expiresOn: string | null;
  receivedAt: string;
  expired: boolean;
}

export interface StockItem {
  id: string;
  organizationId: string;
  name: string;
  unit: string;
  category: string;
  minQuantity: number;
  active: boolean;
  /** Suma de lotes vigentes (lo que realmente se puede usar). */
  available: number;
  /** Suma de lotes vencidos que todavía no se dieron de baja. */
  expiredQuantity: number;
  /** Vencimiento más próximo entre los lotes vigentes con stock. */
  nextExpiry: string | null;
  low: boolean;
  /** Decles: unidades vendidas sin stock cargado (se compensan con el próximo ingreso). */
  owed: number;
  lots: StockLot[];
}

export interface StockMovement {
  id: string;
  itemId: string;
  itemName: string;
  lotId: string | null;
  delta: number;
  reason: StockReason;
  note: string;
  actorName: string;
  source: StockSource;
  appointmentId: string | null;
  consultationId: string | null;
  createdAt: string;
}

export interface StockSettings {
  roles: StaffRole[];
  expiryDays: number;
}

export interface Actor4Stock {
  id: string;
  name: string;
  source: StockSource;
}

const toLot = (r: Row, today: string): StockLot => {
  const expiresOn = (r.expires_on as string) ?? null;
  return {
    id: r.id as string,
    itemId: r.item_id as string,
    lotCode: (r.lot_code as string) ?? "",
    quantity: Number(r.quantity),
    initialQuantity: Number(r.initial_quantity),
    expiresOn,
    receivedAt: r.received_at as string,
    expired: expiresOn !== null && expiresOn < today,
  };
};

function buildItem(r: Row, lots: StockLot[]): StockItem {
  const live = lots.filter((l) => !l.expired && l.quantity > 0);
  // Decles: lo vendido sin stock cargado (`owed`) se resta; puede quedar negativo hasta que entre el ingreso.
  const owed = Number(r.owed ?? 0);
  const available = live.reduce((n, l) => n + l.quantity, 0) - owed;
  const expiries = live.map((l) => l.expiresOn).filter((d): d is string => !!d).sort();
  const minQuantity = Number(r.min_quantity ?? 0);
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    name: r.name as string,
    unit: r.unit as string,
    category: (r.category as string) ?? "",
    minQuantity,
    active: Boolean(r.active),
    available,
    expiredQuantity: lots.filter((l) => l.expired).reduce((n, l) => n + l.quantity, 0),
    nextExpiry: expiries[0] ?? null,
    low: Boolean(r.active) && minQuantity > 0 && available < minQuantity,
    owed,
    lots: lots.filter((l) => l.quantity > 0),
  };
}

export async function getStockSettings(orgId: string): Promise<StockSettings> {
  const [r] = (await getSql()`
    SELECT stock_roles, stock_expiry_days FROM organizations WHERE id = ${orgId}`) as unknown as Row[];
  return {
    roles: JSON.parse((r?.stock_roles as string) || "[]") as StaffRole[],
    expiryDays: Number(r?.stock_expiry_days ?? 30),
  };
}

export async function setStockSettings(orgId: string, s: StockSettings): Promise<void> {
  await getSql()`
    UPDATE organizations
    SET stock_roles = ${JSON.stringify(s.roles)}, stock_expiry_days = ${s.expiryDays}
    WHERE id = ${orgId}`;
}

/** Items del consultorio con sus lotes con stock. `includeInactive` trae también los dados de baja. */
export async function listStockItems(orgId: string, includeInactive = false): Promise<StockItem[]> {
  const sql = getSql();
  const today = todayYmd();
  const items = (await sql`
    SELECT * FROM stock_items
    WHERE organization_id = ${orgId} AND (active OR ${includeInactive})
    ORDER BY lower(name)`) as unknown as Row[];
  if (items.length === 0) return [];
  const lots = (await sql`
    SELECT * FROM stock_lots
    WHERE organization_id = ${orgId} AND quantity > 0
    ORDER BY expires_on NULLS LAST, received_at`) as unknown as Row[];
  const byItem = new Map<string, StockLot[]>();
  for (const l of lots) {
    const lot = toLot(l, today);
    byItem.set(lot.itemId, [...(byItem.get(lot.itemId) ?? []), lot]);
  }
  return items.map((r) => buildItem(r, byItem.get(r.id as string) ?? []));
}

export async function getStockItem(orgId: string, itemId: string): Promise<StockItem | undefined> {
  return (await listStockItems(orgId, true)).find((i) => i.id === itemId);
}

export async function createStockItem(
  orgId: string,
  v: { name: string; unit: string; category: string; minQuantity: number },
): Promise<string> {
  const id = uid("sti");
  await getSql()`
    INSERT INTO stock_items (id, organization_id, name, unit, category, min_quantity, created_at)
    VALUES (${id}, ${orgId}, ${v.name}, ${v.unit}, ${v.category}, ${v.minQuantity}, ${realNowIso()})`;
  return id;
}

export async function updateStockItem(
  orgId: string,
  itemId: string,
  v: { name: string; unit: string; category: string; minQuantity: number; active: boolean },
): Promise<void> {
  await getSql()`
    UPDATE stock_items
    SET name = ${v.name}, unit = ${v.unit}, category = ${v.category},
        min_quantity = ${v.minQuantity}, active = ${v.active}
    WHERE id = ${itemId} AND organization_id = ${orgId}`;
}

/** Ingreso de un lote nuevo + su movimiento, en una transacción. */
export async function addStockLot(
  orgId: string,
  v: { itemId: string; quantity: number; expiresOn: string | null; lotCode: string; note: string },
  actor: Actor4Stock,
): Promise<string> {
  const lotId = uid("stl");
  const now = realNowIso();
  await getSql().begin(async (tx) => {
    await tx`
      INSERT INTO stock_lots (id, organization_id, item_id, lot_code, quantity, initial_quantity, expires_on, received_at, created_by)
      VALUES (${lotId}, ${orgId}, ${v.itemId}, ${v.lotCode}, ${v.quantity}, ${v.quantity}, ${v.expiresOn}, ${now}, ${actor.id})`;
    await tx`
      INSERT INTO stock_movements (id, organization_id, item_id, lot_id, delta, reason, note, actor_id, actor_name, source, created_at)
      VALUES (${uid("stm")}, ${orgId}, ${v.itemId}, ${lotId}, ${v.quantity}, 'ingreso', ${v.note}, ${actor.id}, ${actor.name}, ${actor.source}, ${now})`;
    // Decles: si se había vendido sin stock cargado, este ingreso lo compensa.
    const [it] = (await tx`SELECT owed FROM stock_items WHERE id = ${v.itemId} FOR UPDATE`) as unknown as Row[];
    const settle = Math.min(Number(it?.owed ?? 0), v.quantity);
    if (settle > 0) {
      await tx`UPDATE stock_items SET owed = owed - ${settle} WHERE id = ${v.itemId}`;
      await tx`UPDATE stock_lots SET quantity = quantity - ${settle} WHERE id = ${lotId}`;
      await tx`
        INSERT INTO stock_movements (id, organization_id, item_id, lot_id, delta, reason, note, actor_id, actor_name, source, created_at)
        VALUES (${uid("stm")}, ${orgId}, ${v.itemId}, ${lotId}, ${-settle}, 'ajuste', 'Compensa ventas sin stock cargado', ${actor.id}, ${actor.name}, ${actor.source}, ${now})`;
    }
  });
  return lotId;
}

/**
 * Baja de `quantity` unidades por FEFO: primero el lote que vence antes (los que
 * no vencen, al final), nunca de un lote ya vencido. Con `preferExpiry`, primero los
 * lotes de ese vencimiento (la secretaria indica de cuál vendió). Parte el movimiento si cruza
 * lotes. Descuenta lo que haya; el faltante se devuelve en `shortfall` (nunca queda
 * un lote en negativo).
 */
export async function consumeStockFefo(
  orgId: string,
  v: {
    itemId: string;
    quantity: number;
    reason: Exclude<StockReason, "ingreso" | "vencimiento">;
    note: string;
    appointmentId?: string;
    consultationId?: string;
    saleId?: string;
    /** Vencimiento (YYYY-MM-DD) del que se quiere descontar primero; si no alcanza, sigue por FEFO. */
    preferExpiry?: string | null;
  },
  actor: Actor4Stock,
): Promise<{ taken: number; shortfall: number }> {
  const today = todayYmd();
  const now = realNowIso();
  return getSql().begin(async (tx) => {
    const lots = (await tx`
      SELECT id, quantity FROM stock_lots
      WHERE organization_id = ${orgId} AND item_id = ${v.itemId} AND quantity > 0
        AND (expires_on IS NULL OR expires_on >= ${today})
      ORDER BY CASE WHEN expires_on = ${v.preferExpiry ?? ""} THEN 0 ELSE 1 END, expires_on NULLS LAST, received_at
      FOR UPDATE`) as unknown as Row[];
    let left = v.quantity;
    for (const l of lots) {
      if (left <= 0) break;
      const take = Math.min(left, Number(l.quantity));
      await tx`UPDATE stock_lots SET quantity = quantity - ${take} WHERE id = ${l.id as string}`;
      await tx`
        INSERT INTO stock_movements (id, organization_id, item_id, lot_id, delta, reason, note, actor_id, actor_name, source, appointment_id, consultation_id, sale_id, created_at)
        VALUES (${uid("stm")}, ${orgId}, ${v.itemId}, ${l.id as string}, ${-take}, ${v.reason}, ${v.note}, ${actor.id}, ${actor.name}, ${actor.source},
                ${v.appointmentId ?? null}, ${v.consultationId ?? null}, ${v.saleId ?? null}, ${now})`;
      left -= take;
    }
    return { taken: v.quantity - left, shortfall: left };
  });
}

/** Revierte el stock que descontó una venta (al anularla): devuelve cada movimiento a su lote. */
export async function restoreStockForSale(orgId: string, saleId: string, actor: Actor4Stock): Promise<number> {
  const now = realNowIso();
  return getSql().begin(async (tx) => {
    const moves = (await tx`
      SELECT item_id, lot_id, delta FROM stock_movements
      WHERE organization_id = ${orgId} AND sale_id = ${saleId} AND delta < 0 AND lot_id IS NOT NULL`) as unknown as Row[];
    let units = 0;
    // Decles: lo que se había vendido sin stock (sin lote) baja la deuda.
    const owedMoves = (await tx`
      SELECT item_id, delta FROM stock_movements
      WHERE organization_id = ${orgId} AND sale_id = ${saleId} AND delta < 0 AND lot_id IS NULL AND reason = 'uso'`) as unknown as Row[];
    for (const m of owedMoves) {
      const back = -Number(m.delta);
      await tx`UPDATE stock_items SET owed = GREATEST(owed - ${back}, 0) WHERE id = ${m.item_id as string}`;
      await tx`
        INSERT INTO stock_movements (id, organization_id, item_id, lot_id, delta, reason, note, actor_id, actor_name, source, sale_id, created_at)
        VALUES (${uid("stm")}, ${orgId}, ${m.item_id as string}, NULL, ${back}, 'ajuste', 'Anulación de venta sin stock', ${actor.id}, ${actor.name}, ${actor.source}, ${saleId}, ${now})`;
      units += back;
    }
    for (const m of moves) {
      const back = -Number(m.delta);
      await tx`UPDATE stock_lots SET quantity = quantity + ${back} WHERE id = ${m.lot_id as string}`;
      await tx`
        INSERT INTO stock_movements (id, organization_id, item_id, lot_id, delta, reason, note, actor_id, actor_name, source, sale_id, created_at)
        VALUES (${uid("stm")}, ${orgId}, ${m.item_id as string}, ${m.lot_id as string}, ${back}, 'ajuste', 'Anulación de venta', ${actor.id}, ${actor.name}, ${actor.source}, ${saleId}, ${now})`;
      units += back;
    }
    return units;
  });
}

/** Da de baja un lote entero (típicamente vencido): lo deja en 0 con su movimiento. */
export async function writeOffStockLot(
  orgId: string,
  lotId: string,
  reason: "vencimiento" | "perdida" | "ajuste",
  note: string,
  actor: Actor4Stock,
): Promise<{ itemId: string; quantity: number } | undefined> {
  const now = realNowIso();
  return getSql().begin(async (tx) => {
    const [lot] = (await tx`
      SELECT id, item_id, quantity FROM stock_lots
      WHERE id = ${lotId} AND organization_id = ${orgId} AND quantity > 0
      FOR UPDATE`) as unknown as Row[];
    if (!lot) return undefined;
    const quantity = Number(lot.quantity);
    await tx`UPDATE stock_lots SET quantity = 0 WHERE id = ${lotId}`;
    await tx`
      INSERT INTO stock_movements (id, organization_id, item_id, lot_id, delta, reason, note, actor_id, actor_name, source, created_at)
      VALUES (${uid("stm")}, ${orgId}, ${lot.item_id as string}, ${lotId}, ${-quantity}, ${reason}, ${note}, ${actor.id}, ${actor.name}, ${actor.source}, ${now})`;
    return { itemId: lot.item_id as string, quantity };
  });
}

export async function listStockMovements(orgId: string, itemId?: string, limit = 100): Promise<StockMovement[]> {
  const rows = (await getSql()`
    SELECT m.*, i.name AS item_name
    FROM stock_movements m JOIN stock_items i ON i.id = m.item_id
    WHERE m.organization_id = ${orgId} AND (${itemId ?? null}::text IS NULL OR m.item_id = ${itemId ?? null})
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${limit}`) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    itemId: r.item_id as string,
    itemName: r.item_name as string,
    lotId: (r.lot_id as string) ?? null,
    delta: Number(r.delta),
    reason: r.reason as StockReason,
    note: (r.note as string) ?? "",
    actorName: r.actor_name as string,
    source: r.source as StockSource,
    appointmentId: (r.appointment_id as string) ?? null,
    consultationId: (r.consultation_id as string) ?? null,
    createdAt: r.created_at as string,
  }));
}

/** Decles: vendido sin stock cargado. Suma a `owed` y deja el movimiento (sin lote) atado a la venta. */
export async function addOwed(orgId: string, v: { itemId: string; quantity: number; saleId: string; note: string }, actor: Actor4Stock): Promise<void> {
  const now = realNowIso();
  await getSql().begin(async (tx) => {
    await tx`UPDATE stock_items SET owed = owed + ${v.quantity} WHERE id = ${v.itemId} AND organization_id = ${orgId}`;
    await tx`
      INSERT INTO stock_movements (id, organization_id, item_id, lot_id, delta, reason, note, actor_id, actor_name, source, sale_id, created_at)
      VALUES (${uid("stm")}, ${orgId}, ${v.itemId}, NULL, ${-v.quantity}, 'uso', ${v.note}, ${actor.id}, ${actor.name}, ${actor.source}, ${v.saleId}, ${now})`;
  });
}
