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
/** En `sales.kind`: además "pendiente" (Decles), algo anotado que todavía no está en la lista de precios. */
export type SaleKind = PriceKind | "pendiente";
export type BillingSource = "manual" | "agent";
/** Medio de pago (Decles). Transferencia va al precio de efectivo. */
export type PaymentMethod = "efectivo" | "transferencia" | "tarjeta";

export interface PriceItem {
  id: string;
  organizationId: string;
  kind: PriceKind;
  name: string;
  /** Precio base = efectivo / transferencia. */
  amount: number;
  /** Precio con tarjeta; null = igual a `amount`. */
  cardAmount: number | null;
  providerId: string | null;
  providerName: string | null;
  stockItemId: string | null;
  active: boolean;
  /** Decles: % de comisión propio del ítem; null = el de la médica. */
  commissionPct: number | null;
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
  kind: SaleKind;
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
  /** null = no se cargó el medio de pago. */
  paymentMethod: PaymentMethod | null;
  /** Valor de la venta a precio efectivo y a precio tarjeta (congelados al vender). */
  cashTotal: number;
  cardTotal: number;
  /** Renglones anotados juntos comparten visitId (null en ventas viejas). */
  visitId: string | null;
  /** Planilla (Decles): importe y/o parte de la profesional escritos a mano; columna Observaciones. */
  priceManual: boolean;
  commissionManual: boolean;
  observations: string;
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
  cardAmount: r.card_amount === null || r.card_amount === undefined ? null : Number(r.card_amount),
  providerId: (r.provider_id as string) ?? null,
  providerName: (r.provider_name as string) ?? null,
  stockItemId: (r.stock_item_id as string) ?? null,
  active: Boolean(r.active),
  commissionPct: r.commission_pct === null || r.commission_pct === undefined ? null : Number(r.commission_pct),
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
  v: { kind: PriceKind; name: string; amount: number; cardAmount?: number | null; providerId: string | null; stockItemId: string | null },
  who: BillingWho,
): Promise<string> {
  const id = uid("pli");
  const now = realNowIso();
  await getSql().begin(async (tx) => {
    await tx`
      INSERT INTO price_list_items (id, organization_id, kind, name, amount, card_amount, provider_id, stock_item_id, created_at)
      VALUES (${id}, ${orgId}, ${v.kind}, ${v.name}, ${v.amount}, ${v.cardAmount ?? null}, ${v.providerId}, ${v.stockItemId}, ${now})`;
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
  v: { name: string; amount: number; cardAmount: number | null; active: boolean; stockItemId: string | null },
  who: BillingWho,
): Promise<void> {
  const now = realNowIso();
  await getSql().begin(async (tx) => {
    await tx`
      UPDATE price_list_items
      SET name = ${v.name}, amount = ${v.amount}, card_amount = ${v.cardAmount}, active = ${v.active}, stock_item_id = ${v.stockItemId}
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
  kind: r.kind as SaleKind,
  quantity: Number(r.quantity),
  unitPrice: Number(r.unit_price),
  total: Number(r.total),
  providerId: (r.provider_id as string) ?? null,
  providerName: (r.provider_name as string) ?? null,
  patientId: (r.patient_id as string) ?? null,
  patientName: (r.patient_name as string) || (r.patient_label as string) || null,
  note: (r.note as string) ?? "",
  status: r.status as Sale["status"],
  createdByName: r.created_by_name as string,
  source: r.source as BillingSource,
  createdAt: r.created_at as string,
  voidReason: (r.void_reason as string) ?? null,
  commissionPct: Number(r.commission_pct ?? 0),
  commissionAmount: Number(r.commission_amount ?? 0),
  paymentMethod: (r.payment_method as PaymentMethod) ?? null,
  cashTotal: Number(r.cash_total ?? r.total),
  cardTotal: Number(r.card_total ?? r.total),
  visitId: (r.visit_id as string) ?? null,
  priceManual: Boolean(r.price_manual),
  commissionManual: Boolean(r.commission_manual),
  observations: (r.observations as string) ?? "",
});

export async function insertSale(
  orgId: string,
  v: {
    item: PriceItem;
    quantity: number;
    providerId: string | null;
    patientId: string | null;
    note: string;
    /** % de comisión de la médica que vendió (0 = sin comisión). Siempre sobre el precio efectivo. */
    commissionPct?: number;
    /** null/undefined = no se cargó: se registra a precio efectivo y se guardan los dos valores. */
    paymentMethod?: PaymentMethod | null;
    /** Paciente escrito a mano (Decles: no hay ficha). */
    patientLabel?: string;
    visitId?: string | null;
  },
  who: BillingWho,
): Promise<{ id: string; total: number; cashTotal: number; cardTotal: number; commissionAmount: number }> {
  const id = uid("sal");
  const cashUnit = v.item.amount;
  const cardUnit = v.item.cardAmount ?? v.item.amount;
  const cashTotal = cashUnit * v.quantity;
  const cardTotal = cardUnit * v.quantity;
  const method = v.paymentMethod ?? null;
  const unitPrice = method === "tarjeta" ? cardUnit : cashUnit;
  const total = unitPrice * v.quantity;
  const pct = v.commissionPct ?? 0;
  const commissionAmount = Math.round((cashTotal * pct) / 100);
  await getSql()`
    INSERT INTO sales (id, organization_id, item_id, item_name, kind, quantity, unit_price, total, provider_id, patient_id, note,
                       created_by, created_by_name, source, created_at, commission_pct, commission_amount,
                       payment_method, cash_total, card_total, patient_label, visit_id)
    VALUES (${id}, ${orgId}, ${v.item.id}, ${v.item.name}, ${v.item.kind}, ${v.quantity}, ${unitPrice}, ${total},
            ${v.providerId}, ${v.patientId}, ${v.note}, ${who.id}, ${who.name}, ${who.source}, ${realNowIso()}, ${pct}, ${commissionAmount},
            ${method}, ${cashTotal}, ${cardTotal}, ${v.patientLabel ?? ""}, ${v.visitId ?? null})`;
  return { id, total, cashTotal, cardTotal, commissionAmount };
}

/** Carga el medio de pago de una venta que quedó sin él (solo si sigue sin medio y paga). */
export async function setSalePayment(orgId: string, id: string, method: PaymentMethod): Promise<boolean> {
  const rows = (await getSql()`
    UPDATE sales SET payment_method = ${method},
      total = CASE WHEN ${method} = 'tarjeta' THEN card_total ELSE cash_total END,
      unit_price = CASE WHEN ${method} = 'tarjeta' THEN card_total ELSE cash_total END / quantity
    WHERE id = ${id} AND organization_id = ${orgId} AND payment_method IS NULL AND status = 'paid'
    RETURNING id`) as unknown as Row[];
  return rows.length > 0;
}

export interface CommissionRow {
  providerId: string | null;
  providerName: string;
  sales: number;
  units: number;
  total: number;
  commission: number;
}

export const newVisitId = () => uid("vis");

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
      AND s.status <> 'edited'
    ORDER BY s.created_at DESC, s.id DESC LIMIT ${limit}`) as unknown as Row[];
  return rows.map(toSale);
}

export async function markSaleVoided(orgId: string, id: string, reason: string, who: BillingWho): Promise<boolean> {
  const rows = (await getSql()`
    UPDATE sales SET status = 'voided', voided_at = ${realNowIso()}, voided_by = ${who.id}, void_reason = ${reason}
    WHERE id = ${id} AND organization_id = ${orgId} AND status = 'paid' RETURNING id`) as unknown as Row[];
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Quién ofrece cada ítem (Decles): price_item_providers. Vacío = cualquiera.
// ---------------------------------------------------------------------------

/** item_id → provider_ids vinculados. */
export async function listItemProviders(orgId: string): Promise<Map<string, string[]>> {
  const rows = (await getSql()`
    SELECT item_id, provider_id FROM price_item_providers WHERE organization_id = ${orgId}`) as unknown as Row[];
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.item_id as string, [...(map.get(r.item_id as string) ?? []), r.provider_id as string]);
  return map;
}

export async function getItemProviders(orgId: string, itemId: string): Promise<string[]> {
  const rows = (await getSql()`
    SELECT provider_id FROM price_item_providers WHERE organization_id = ${orgId} AND item_id = ${itemId}`) as unknown as Row[];
  return rows.map((r) => r.provider_id as string);
}

export async function setItemProviders(orgId: string, itemId: string, providerIds: string[]): Promise<void> {
  await getSql().begin(async (tx) => {
    await tx`DELETE FROM price_item_providers WHERE organization_id = ${orgId} AND item_id = ${itemId}`;
    for (const pid of providerIds)
      await tx`INSERT INTO price_item_providers (organization_id, item_id, provider_id) VALUES (${orgId}, ${itemId}, ${pid})`;
  });
}

// ---------------------------------------------------------------------------
// Pendientes (Decles): anotado con un nombre que no está en la lista de precios.
// ---------------------------------------------------------------------------

export async function insertPendingSale(
  orgId: string,
  v: {
    name: string;
    quantity: number;
    providerId: string;
    patientLabel: string;
    visitId: string;
    paymentMethod: PaymentMethod | null;
    note: string;
    /** Lo que se cobró por unidad, si la secretaria lo cargó (0 = a definir por el admin). */
    unitPrice?: number;
    commissionPct?: number;
    /** Planilla: renglón sin práctica elegida ("Atención") = 'tratamiento' sin ítem (no es un pendiente). */
    kind?: SaleKind;
  },
  who: BillingWho,
): Promise<string> {
  const id = uid("sal");
  const unit = v.unitPrice ?? 0;
  const total = unit * v.quantity;
  const pct = unit > 0 ? (v.commissionPct ?? 0) : 0;
  const commission = Math.round((total * pct) / 100);
  await getSql()`
    INSERT INTO sales (id, organization_id, item_id, item_name, kind, quantity, unit_price, total, provider_id, patient_id, note,
                       created_by, created_by_name, source, created_at, commission_pct, commission_amount,
                       payment_method, cash_total, card_total, patient_label, visit_id)
    VALUES (${id}, ${orgId}, NULL, ${v.name}, ${v.kind ?? "pendiente"}, ${v.quantity}, ${unit}, ${total}, ${v.providerId}, NULL, ${v.note},
            ${who.id}, ${who.name}, ${who.source}, ${realNowIso()}, ${pct}, ${commission}, ${v.paymentMethod}, ${total}, ${total}, ${v.patientLabel}, ${v.visitId})`;
  return id;
}

export async function listPendingSales(orgId: string): Promise<Sale[]> {
  const rows = (await getSql()`
    SELECT s.*, pr.name AS provider_name, NULL AS patient_name
    FROM sales s LEFT JOIN providers pr ON pr.id = s.provider_id
    WHERE s.organization_id = ${orgId} AND s.kind = 'pendiente' AND s.status = 'paid'
    ORDER BY s.created_at`) as unknown as Row[];
  return rows.map(toSale);
}

/** Completa un pendiente con el ítem real (precio, comisión). Devuelve false si ya no estaba pendiente. */
export async function resolvePendingSale(
  orgId: string,
  saleId: string,
  v: { item: PriceItem; commissionPct: number },
): Promise<boolean> {
  const rows = (await getSql()`
    SELECT quantity, payment_method, total FROM sales
    WHERE id = ${saleId} AND organization_id = ${orgId} AND kind = 'pendiente' AND status = 'paid' FOR UPDATE`) as unknown as Row[];
  if (!rows.length) return false;
  // Si al anotar se cargó lo que se cobró, eso manda: solo se vincula el ítem.
  if (Number(rows[0].total) > 0) {
    const kept = (await getSql()`
      UPDATE sales SET item_id = ${v.item.id}, item_name = ${v.item.name}, kind = ${v.item.kind}
      WHERE id = ${saleId} AND organization_id = ${orgId} AND kind = 'pendiente' AND status = 'paid'
      RETURNING id`) as unknown as Row[];
    return kept.length > 0;
  }
  const q = Number(rows[0].quantity);
  const method = (rows[0].payment_method as PaymentMethod) ?? null;
  const cashTotal = v.item.amount * q;
  const cardTotal = (v.item.cardAmount ?? v.item.amount) * q;
  const unit = method === "tarjeta" ? (v.item.cardAmount ?? v.item.amount) : v.item.amount;
  const commission = Math.round((cashTotal * v.commissionPct) / 100);
  const done = (await getSql()`
    UPDATE sales SET item_id = ${v.item.id}, item_name = ${v.item.name}, kind = ${v.item.kind}, unit_price = ${unit},
      total = ${unit * q}, cash_total = ${cashTotal}, card_total = ${cardTotal},
      commission_pct = ${v.commissionPct}, commission_amount = ${commission}
    WHERE id = ${saleId} AND organization_id = ${orgId} AND kind = 'pendiente' AND status = 'paid'
    RETURNING id`) as unknown as Row[];
  return done.length > 0;
}

// ---------------------------------------------------------------------------
// Editar una anotación (Decles): la versión vieja queda con status 'edited' (no se lista ni suma).
// ---------------------------------------------------------------------------

/** Renglones vigentes de una anotación (por visit_id, o la venta suelta si es vieja sin visit_id). */
export async function listVisitSales(orgId: string, key: string): Promise<Sale[]> {
  const rows = (await getSql()`
    SELECT s.*, pr.name AS provider_name, pa.full_name AS patient_name
    FROM sales s LEFT JOIN providers pr ON pr.id = s.provider_id LEFT JOIN patients pa ON pa.id = s.patient_id
    WHERE s.organization_id = ${orgId} AND s.status = 'paid'
      AND (s.visit_id = ${key} OR (s.id = ${key} AND s.visit_id IS NULL))
    ORDER BY s.created_at, s.id`) as unknown as Row[];
  return rows.map(toSale);
}

export async function markSaleEdited(orgId: string, id: string, who: BillingWho): Promise<boolean> {
  const rows = (await getSql()`
    UPDATE sales SET status = 'edited', voided_at = ${realNowIso()}, voided_by = ${who.id}, void_reason = ${`Editado por ${who.name}`}
    WHERE id = ${id} AND organization_id = ${orgId} AND status = 'paid' RETURNING id`) as unknown as Row[];
  return rows.length > 0;
}

/** La versión editada conserva la hora original y deja dicho quién la editó. */
export async function stampVisit(orgId: string, visitId: string, createdAt: string, note: string): Promise<void> {
  await getSql()`
    UPDATE sales SET created_at = ${createdAt}, note = ${note}
    WHERE organization_id = ${orgId} AND visit_id = ${visitId} AND status = 'paid'`;
}

/**
 * Planilla (Decles): importe ("Abona", total del renglón) y/o parte de la profesional ($K) escritos a mano.
 * Sin `commission`, la comisión se recalcula con el % congelado sobre el importe nuevo.
 */
export async function applyManualAmounts(orgId: string, saleId: string, v: { amount?: number | null; commission?: number | null }): Promise<void> {
  const amount = v.amount ?? null;
  const commission = v.commission ?? null;
  if (amount !== null) {
    await getSql()`
      UPDATE sales SET total = ${amount}, cash_total = ${amount}, card_total = ${amount},
        unit_price = ROUND(${amount}::numeric / quantity), price_manual = TRUE,
        commission_amount = ROUND(${amount}::numeric * commission_pct / 100)
      WHERE id = ${saleId} AND organization_id = ${orgId}`;
  }
  if (commission !== null) {
    await getSql()`UPDATE sales SET commission_amount = ${commission}, commission_manual = TRUE WHERE id = ${saleId} AND organization_id = ${orgId}`;
  }
}

/** Planilla: la columna Observaciones de una anotación. */
export async function setVisitObservations(orgId: string, visitId: string, text: string): Promise<void> {
  await getSql()`UPDATE sales SET observations = ${text} WHERE organization_id = ${orgId} AND visit_id = ${visitId} AND status = 'paid'`;
}

/** Decles: % de comisión propio del ítem (null = el de la médica). */
export async function setItemCommission(orgId: string, itemId: string, pct: number | null): Promise<void> {
  await getSql()`UPDATE price_list_items SET commission_pct = ${pct} WHERE id = ${itemId} AND organization_id = ${orgId}`;
}
