import { randomUUID } from "node:crypto";
import { realNowIso } from "@/lib/domain/clock";
import type { StaffRole } from "@/lib/domain/types";
import { getSql } from "./connection";

/**
 * Acceso a datos de precios y ventas. Autorización y validación: `src/lib/domain/billing.ts`.
 * Toda query filtra por `organization_id`. Importes en pesos enteros.
 */

type Row = Record<string, unknown>;
const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

export type PriceKind = "consulta" | "tratamiento" | "producto";
export type BillingSource = "manual" | "agent";

export interface PriceItem {
  id: string;
  organizationId: string;
  kind: PriceKind;
  name: string;
  amount: number;
  providerId: string | null;
  providerName: string | null;
  stockItemId: string | null;
  active: boolean;
}

export interface PriceChange {
  id: string;
  itemId: string;
  oldAmount: number | null;
  newAmount: number;
  changedByName: string;
  source: BillingSource;
  changedAt: string;
}

export interface Sale {
  id: string;
  itemId: string | null;
  itemName: string;
  kind: PriceKind;
  quantity: number;
  unitPrice: number;
  total: number;
  providerId: string | null;
  providerName: string | null;
  patientId: string | null;
  patientName: string | null;
  note: string;
  status: "paid" | "voided";
  createdByName: string;
  source: BillingSource;
  createdAt: string;
  voidReason: string | null;
  /** % y monto de comisión congelados al vender (0 si no hubo médica). */
  commissionPct: number;
  commissionAmount: number;
}

export interface BillingWho {
  id: string;
  name: string;
  source: BillingSource;
}

const toItem = (r: Row): PriceItem => ({
  id: r.id as string,
  organizationId: r.organization_id as string,
  kind: r.kind as PriceKind,
  name: r.name as string,
  amount: Number(r.amount),
  providerId: (r.provider_id as string) ?? null,
  providerName: (r.provider_name as string) ?? null,
  stockItemId: (r.stock_item_id as string) ?? null,
  active: Boolean(r.active),
});

export async function getPricingRoles(orgId: string): Promise<StaffRole[]> {
  const [r] = (await getSql()`SELECT pricing_roles FROM organizations WHERE id = ${orgId}`) as unknown as Row[];
  return JSON.parse((r?.pricing_roles as string) || "[]") as StaffRole[];
}

export async function setPricingRoles(orgId: string, roles: StaffRole[]): Promise<void> {
  await getSql()`UPDATE organizations SET pricing_roles = ${JSON.stringify(roles)} WHERE id = ${orgId}`;
}

export async function listPriceItems(orgId: string, includeInactive = false): Promise<PriceItem[]> {
  const rows = (await getSql()`
    SELECT i.*, p.name AS provider_name
    FROM price_list_items i LEFT JOIN providers p ON p.id = i.provider_id
    WHERE i.organization_id = ${orgId} AND (i.active OR ${includeInactive})
    ORDER BY i.kind, lower(i.name), p.name NULLS FIRST`) as unknown as Row[];
  return rows.map(toItem);
}

export async function getPriceItem(orgId: string, id: string): Promise<PriceItem | undefined> {
  const [r] = (await getSql()`
    SELECT i.*, p.name AS provider_name
    FROM price_list_items i LEFT JOIN providers p ON p.id = i.provider_id
    WHERE i.id = ${id} AND i.organization_id = ${orgId}`) as unknown as Row[];
  return r ? toItem(r) : undefined;
}

export async function createPriceItem(
  orgId: string,
  v: { kind: PriceKind; name: string; amount: number; providerId: string | null; stockItemId: string | null },
  who: BillingWho,
): Promise<string> {
  const id = uid("pli");
  const now = realNowIso();
  await getSql().begin(async (tx) => {
    await tx`
      INSERT INTO price_list_items (id, organization_id, kind, name, amount, provider_id, stock_item_id, created_at)
      VALUES (${id}, ${orgId}, ${v.kind}, ${v.name}, ${v.amount}, ${v.providerId}, ${v.stockItemId}, ${now})`;
    await tx`
      INSERT INTO price_history (id, organization_id, item_id, old_amount, new_amount, changed_by, changed_by_name, source, changed_at)
      VALUES (${uid("prh")}, ${orgId}, ${id}, NULL, ${v.amount}, ${who.id}, ${who.name}, ${who.source}, ${now})`;
  });
  return id;
}

/** Actualiza un ítem; si cambia el importe deja la entrada en el historial. */
export async function updatePriceItem(
  orgId: string,
  cur: PriceItem,
  v: { name: string; amount: number; active: boolean; stockItemId: string | null },
  who: BillingWho,
): Promise<void> {
  const now = realNowIso();
  await getSql().begin(async (tx) => {
    await tx`
      UPDATE price_list_items
      SET name = ${v.name}, amount = ${v.amount}, active = ${v.active}, stock_item_id = ${v.stockItemId}
      WHERE id = ${cur.id} AND organization_id = ${orgId}`;
    if (v.amount !== cur.amount) {
      await tx`
        INSERT INTO price_history (id, organization_id, item_id, old_amount, new_amount, changed_by, changed_by_name, source, changed_at)
        VALUES (${uid("prh")}, ${orgId}, ${cur.id}, ${cur.amount}, ${v.amount}, ${who.id}, ${who.name}, ${who.source}, ${now})`;
    }
  });
}

export async function listPriceHistory(orgId: string, itemId: string): Promise<PriceChange[]> {
  const rows = (await getSql()`
    SELECT * FROM price_history WHERE organization_id = ${orgId} AND item_id = ${itemId}
    ORDER BY changed_at DESC, id DESC`) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    itemId: r.item_id as string,
    oldAmount: r.old_amount === null ? null : Number(r.old_amount),
    newAmount: Number(r.new_amount),
    changedByName: r.changed_by_name as string,
    source: r.source as BillingSource,
    changedAt: r.changed_at as string,
  }));
}

// ---------------------------------------------------------------------------
// Ventas
// ---------------------------------------------------------------------------

const toSale = (r: Row): Sale => ({
  id: r.id as string,
  itemId: (r.item_id as string) ?? null,
  itemName: r.item_name as string,
  kind: r.kind as PriceKind,
  quantity: Number(r.quantity),
  unitPrice: Number(r.unit_price),
  total: Number(r.total),
  providerId: (r.provider_id as string) ?? null,
  providerName: (r.provider_name as string) ?? null,
  patientId: (r.patient_id as string) ?? null,
  patientName: (r.patient_name as string) ?? null,
  note: (r.note as string) ?? "",
  status: r.status as Sale["status"],
  createdByName: r.created_by_name as string,
  source: r.source as BillingSource,
  createdAt: r.created_at as string,
  voidReason: (r.void_reason as string) ?? null,
  commissionPct: Number(r.commission_pct ?? 0),
  commissionAmount: Number(r.commission_amount ?? 0),
});

export async function insertSale(
  orgId: string,
  v: {
    item: PriceItem;
    quantity: number;
    providerId: string | null;
    patientId: string | null;
    note: string;
    /** % de comisión de la médica que vendió (0 = sin comisión). */
    commissionPct?: number;
  },
  who: BillingWho,
): Promise<{ id: string; total: number; commissionAmount: number }> {
  const id = uid("sal");
  const total = v.item.amount * v.quantity;
  const pct = v.commissionPct ?? 0;
  const commissionAmount = Math.round((total * pct) / 100);
  await getSql()`
    INSERT INTO sales (id, organization_id, item_id, item_name, kind, quantity, unit_price, total, provider_id, patient_id, note,
                       created_by, created_by_name, source, created_at, commission_pct, commission_amount)
    VALUES (${id}, ${orgId}, ${v.item.id}, ${v.item.name}, ${v.item.kind}, ${v.quantity}, ${v.item.amount}, ${total},
            ${v.providerId}, ${v.patientId}, ${v.note}, ${who.id}, ${who.name}, ${who.source}, ${realNowIso()}, ${pct}, ${commissionAmount})`;
  return { id, total, commissionAmount };
}

export interface CommissionRow {
  providerId: string | null;
  providerName: string;
  sales: number;
  units: number;
  total: number;
  commission: number;
}

/** Ventas pagas del período agrupadas por médica (las anuladas no cuentan). */
export async function commissionSummary(orgId: string, from: string, to: string): Promise<CommissionRow[]> {
  const rows = (await getSql()`
    SELECT s.provider_id, COALESCE(p.name, 'Sin médica') AS provider_name,
           count(*)::int AS sales, sum(s.quantity)::int AS units,
           sum(s.total)::bigint AS total, sum(s.commission_amount)::bigint AS commission
    FROM sales s LEFT JOIN providers p ON p.id = s.provider_id
    WHERE s.organization_id = ${orgId} AND s.status = 'paid'
      AND substr(s.created_at, 1, 10) BETWEEN ${from} AND ${to}
    GROUP BY s.provider_id, p.name
    ORDER BY sum(s.total) DESC`) as unknown as Row[];
  return rows.map((r) => ({
    providerId: (r.provider_id as string) ?? null,
    providerName: r.provider_name as string,
    sales: Number(r.sales),
    units: Number(r.units),
    total: Number(r.total),
    commission: Number(r.commission),
  }));
}

export async function getSale(orgId: string, id: string): Promise<Sale | undefined> {
  const [r] = (await getSql()`
    SELECT s.*, pr.name AS provider_name, pa.full_name AS patient_name
    FROM sales s LEFT JOIN providers pr ON pr.id = s.provider_id LEFT JOIN patients pa ON pa.id = s.patient_id
    WHERE s.id = ${id} AND s.organization_id = ${orgId}`) as unknown as Row[];
  return r ? toSale(r) : undefined;
}

export async function listSales(orgId: string, from: string, to: string, limit = 200): Promise<Sale[]> {
  const rows = (await getSql()`
    SELECT s.*, pr.name AS provider_name, pa.full_name AS patient_name
    FROM sales s LEFT JOIN providers pr ON pr.id = s.provider_id LEFT JOIN patients pa ON pa.id = s.patient_id
    WHERE s.organization_id = ${orgId} AND substr(s.created_at, 1, 10) BETWEEN ${from} AND ${to}
    ORDER BY s.created_at DESC, s.id DESC LIMIT ${limit}`) as unknown as Row[];
  return rows.map(toSale);
}

export async function markSaleVoided(orgId: string, id: string, reason: string, who: BillingWho): Promise<boolean> {
  const rows = (await getSql()`
    UPDATE sales SET status = 'voided', voided_at = ${realNowIso()}, voided_by = ${who.id}, void_reason = ${reason}
    WHERE id = ${id} AND organization_id = ${orgId} AND status = 'paid' RETURNING id`) as unknown as Row[];
  return rows.length > 0;
}
