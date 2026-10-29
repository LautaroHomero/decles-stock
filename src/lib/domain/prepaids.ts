import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { getPriceItem } from "@/lib/db/billing-repo";
import { getProvider } from "@/lib/db/repo";
import { realNowIso } from "@/lib/domain/clock";
import { commissionFor } from "@/lib/domain/billing";
import { createExpense, voidExpense } from "@/lib/domain/expenses";
import type { Actor } from "@/lib/domain/types";

/**
 * Abonos (Decles): la paciente paga antes un tratamiento para congelar el precio y después se hace las sesiones,
 * con cualquier profesional. Dos formas:
 *  · N sesiones («5 sesiones de Venus freeze, pagó 250000»): cada vez que viene se descuenta una.
 *  · saldo en plata («dejó 200000 para Venus freeze»): cada sesión descuenta el precio congelado (`unitPrice`).
 * La plata entra a la caja el día que se paga (un ingreso en `expenses`, con su medio). Cada sesión es una atención
 * normal pero a la caja no entra nada; la profesional cobra su parte ese día, sobre el precio congelado.
 * Una sesión cuenta mientras su atención esté vigente (si se anula la atención, la sesión vuelve al abono).
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });
type Row = Record<string, unknown>;
type Method = "efectivo" | "transferencia" | "tarjeta";
const methodOf = (m: unknown): Method => (m === "transferencia" || m === "tarjeta" ? m : "efectivo");

export interface Prepaid {
  id: string;
  patient: string;
  itemId: string;
  itemName: string;
  /** Precio congelado de una sesión. */
  unitPrice: number;
  /** Sesiones compradas; null = saldo en plata. */
  sessions: number | null;
  /** Lo que pagó. */
  amount: number;
  method: Method;
  /** Sesiones hechas (vigentes). */
  used: number;
  /** Plata ya usada (precio congelado × sesiones). */
  usedAmount: number;
  /** Sesiones que quedan (con saldo: cuántas alcanzan). */
  sessionsLeft: number;
  /** Plata que queda (con sesiones: sesiones que quedan × precio congelado). */
  balance: number;
  status: "open" | "voided";
  createdByName: string;
  createdAt: string;
}

function ctx(actor: Actor) {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente") return null;
  return { orgId, isAdmin: !!actor.activeOrg?.canAdmin, canWrite: actor.role !== "medico" };
}

const clean = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");

async function raw(orgId: string, where: { ids?: string[]; status?: "open"; exceptVisit?: string } = {}): Promise<Prepaid[]> {
  const sql = getSql();
  // Una sesión cuenta si su atención sigue vigente (alguna venta 'paid' de ese ítem en esa visita).
  const rows = (await sql`
    SELECT p.*,
      COALESCE(u.n, 0)::int AS used, COALESCE(u.amt, 0)::int AS used_amount
    FROM prepaids p
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS n, SUM(x.amount) AS amt FROM prepaid_uses x
      WHERE x.prepaid_id = p.id ${where.exceptVisit ? sql`AND x.visit_id <> ${where.exceptVisit}` : sql``} AND EXISTS (
        SELECT 1 FROM sales s WHERE s.organization_id = x.organization_id AND s.visit_id = x.visit_id AND s.item_id = p.item_id AND s.status = 'paid')
    ) u ON TRUE
    WHERE p.organization_id = ${orgId}
      ${where.status ? sql`AND p.status = ${where.status}` : sql`AND p.status <> 'voided'`}
      ${where.ids ? sql`AND p.id IN ${sql(where.ids)}` : sql``}
    ORDER BY p.created_at`) as unknown as Row[];
  return rows.map((r) => {
    const unitPrice = Number(r.unit_price);
    const sessions = r.sessions === null ? null : Number(r.sessions);
    const amount = Number(r.amount);
    const used = Number(r.used);
    const usedAmount = Number(r.used_amount);
    const sessionsLeft = sessions !== null ? Math.max(0, sessions - used) : Math.floor(Math.max(0, amount - usedAmount) / unitPrice);
    const balance = sessions !== null ? sessionsLeft * unitPrice : Math.max(0, amount - usedAmount);
    return {
      id: r.id as string,
      patient: r.patient_label as string,
      itemId: r.item_id as string,
      itemName: r.item_name as string,
      unitPrice,
      sessions,
      amount,
      method: methodOf(r.method),
      used,
      usedAmount,
      sessionsLeft,
      balance,
      status: r.status as Prepaid["status"],
      createdByName: r.created_by_name as string,
      createdAt: r.created_at as string,
    };
  });
}

/** Abonos con sesiones o saldo pendiente. */
export async function listPrepaids(actor: Actor): Promise<Result<{ prepaids: Prepaid[] }>> {
  const c = ctx(actor);
  if (!c) return { ok: true, prepaids: [] };
  return { ok: true, prepaids: (await raw(c.orgId, { status: "open" })).filter((p) => p.sessionsLeft > 0 || p.balance > 0) };
}

/**
 * Anotar un abono. `sessions` = cantidad de sesiones (null = saldo en plata). `unitPrice` = precio congelado de una
 * sesión (por defecto: con sesiones, lo pagado / sesiones; con saldo, el precio de lista de hoy). Entra a la caja hoy.
 */
export async function createPrepaid(
  actor: Actor,
  v: { patient?: unknown; itemId?: unknown; sessions?: unknown; amount?: unknown; unitPrice?: unknown; method?: unknown },
): Promise<Result<{ prepaid: Prepaid }>> {
  const c = ctx(actor);
  if (!c?.canWrite) return fail("Los abonos los anota la secretaría o el admin.", 403);
  const patient = clean(v.patient).slice(0, 120);
  if (!patient) return fail("¿De qué paciente es el abono?");
  const item = typeof v.itemId === "string" ? await getPriceItem(c.orgId, v.itemId) : undefined;
  if (!item || !item.active) return fail("¿Para qué tratamiento es el abono?", 404);
  if (item.kind === "producto") return fail("Los abonos son de tratamientos, no de productos.");
  const int = (x: unknown) => (x === null || x === undefined || x === "" ? null : Number(x));
  const sessions = int(v.sessions);
  if (sessions !== null && (!Number.isInteger(sessions) || sessions < 1 || sessions > 100)) return fail("La cantidad de sesiones no parece correcta.");
  const amount = int(v.amount);
  if (amount === null || !Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) return fail("¿Cuánto pagó? Tiene que ser un número entero de pesos.");
  let unitPrice = int(v.unitPrice);
  if (unitPrice === null) unitPrice = sessions ? Math.round(amount / sessions) : item.amount;
  if (!Number.isInteger(unitPrice) || unitPrice <= 0) return fail("El precio por sesión no parece correcto.");
  if (sessions === null && amount < unitPrice) return fail(`Con ${amount.toLocaleString("es-AR")} pesos no alcanza para una sesión (${unitPrice.toLocaleString("es-AR")}).`);
  const method = methodOf(v.method);
  const label = sessions ? `${sessions} × ${item.name}` : item.name;
  const inc = await createExpense(actor, { concept: `Abono · ${patient} · ${label}`, amount, direction: "ingreso", method });
  if (!inc.ok) return inc;
  const id = `abo_${randomUUID().slice(0, 8)}`;
  await getSql()`
    INSERT INTO prepaids (id, organization_id, patient_label, item_id, item_name, unit_price, sessions, amount, method, income_id, created_by, created_by_name, created_at)
    VALUES (${id}, ${c.orgId}, ${patient}, ${item.id}, ${item.name}, ${unitPrice}, ${sessions}, ${amount}, ${method}, ${inc.expense.id}, ${actor.userId}, ${actor.name}, ${realNowIso()})`;
  return { ok: true, prepaid: (await raw(c.orgId, { ids: [id] }))[0] };
}

/** Anular un abono mal anotado (solo si todavía no se usó ninguna sesión). Saca la plata de la caja. */
export async function voidPrepaid(actor: Actor, id: string): Promise<Result<object>> {
  const c = ctx(actor);
  if (!c?.canWrite) return fail("No autorizado.", 403);
  const [p] = await raw(c.orgId, { ids: [id] });
  if (!p) return fail("Ese abono ya no existe.", 404);
  if (p.used > 0) return fail("Ya se usó una sesión de este abono: primero anulá esa atención.", 409);
  if (!c.isAdmin && p.createdAt.slice(0, 10) !== realNowIso().slice(0, 10)) return fail("Lo de días anteriores lo corrige el admin.", 403);
  const [r] = (await getSql()`SELECT income_id FROM prepaids WHERE id = ${id}`) as unknown as Row[];
  await getSql()`UPDATE prepaids SET status = 'voided', voided_at = ${realNowIso()}, voided_by = ${actor.userId} WHERE id = ${id} AND organization_id = ${c.orgId}`;
  if (r?.income_id) await voidExpense(actor, r.income_id as string, true);
  return { ok: true };
}

/**
 * Para `recordVisit`: valida que el abono sirva para esa sesión y calcula la parte de la profesional sobre el
 * precio congelado. Devuelve el renglón a usar (el del tratamiento del abono).
 */
export async function prepaidForVisit(
  orgId: string,
  prepaidId: string,
  itemIds: (string | undefined)[],
  providerId: string | null,
  /** Al editar una atención: su sesión vieja no cuenta (se reemplaza). */
  replacingVisitId?: string,
): Promise<Result<{ prepaid: Prepaid; lineIndex: number; commission: number }>> {
  const [p] = await raw(orgId, { ids: [prepaidId], exceptVisit: replacingVisitId });
  if (!p || p.status !== "open") return fail("Ese abono ya no está disponible.", 404);
  if (p.sessionsLeft <= 0) return fail(`Al abono de ${p.patient} no le quedan sesiones.`, 409);
  const lineIndex = itemIds.findIndex((x) => x === p.itemId);
  if (lineIndex < 0) return fail(`Ese abono es de ${p.itemName}.`, 409);
  const prov = providerId ? await getProvider(providerId) : undefined;
  const item = await getPriceItem(orgId, p.itemId);
  const cut = prov && item ? await commissionFor(orgId, item, prov) : { pct: 0, fixed: null };
  const commission = cut.fixed !== null ? cut.fixed : Math.round((p.unitPrice * cut.pct) / 100);
  return { ok: true, prepaid: p, lineIndex, commission };
}

export async function recordPrepaidUse(orgId: string, prepaid: Prepaid, visitId: string): Promise<void> {
  await getSql()`
    INSERT INTO prepaid_uses (id, organization_id, prepaid_id, visit_id, amount, date, created_at)
    VALUES (${`abu_${randomUUID().slice(0, 8)}`}, ${orgId}, ${prepaid.id}, ${visitId}, ${prepaid.unitPrice}, ${realNowIso().slice(0, 10)}, ${realNowIso()})`;
}

/** Al editar una atención, la sesión del abono pasa a la versión nueva. */
export async function relinkPrepaidUses(orgId: string, oldVisitId: string, newVisitId: string): Promise<void> {
  await getSql()`UPDATE prepaid_uses SET visit_id = ${newVisitId} WHERE organization_id = ${orgId} AND visit_id = ${oldVisitId}`;
}

/** Al editar una atención que deja de ser del abono (o que se reemplaza por otra sesión): se suelta la vieja. */
export async function dropPrepaidUses(orgId: string, visitId: string): Promise<void> {
  await getSql()`DELETE FROM prepaid_uses WHERE organization_id = ${orgId} AND visit_id = ${visitId}`;
}

/** Sesiones de abono de un día: qué atención (visita) es de qué abono. */
export async function prepaidUsesOn(actor: Actor, date: string): Promise<{ visitId: string; prepaidId: string; itemId: string; itemName: string; unitPrice: number }[]> {
  const c = ctx(actor);
  if (!c) return [];
  const rows = (await getSql()`
    SELECT x.visit_id, p.id, p.item_id, p.item_name, p.unit_price FROM prepaid_uses x JOIN prepaids p ON p.id = x.prepaid_id
    WHERE x.organization_id = ${c.orgId} AND p.status <> 'voided' AND EXISTS (
      SELECT 1 FROM sales s WHERE s.organization_id = x.organization_id AND s.visit_id = x.visit_id AND s.status = 'paid' AND substr(s.created_at, 1, 10) = ${date})`) as unknown as Row[];
  return rows.map((r) => ({ visitId: r.visit_id as string, prepaidId: r.id as string, itemId: r.item_id as string, itemName: r.item_name as string, unitPrice: Number(r.unit_price) }));
}

/** La práctica de un abono (para armar la sesión cuando no se escribió). */
export async function prepaidItemId(orgId: string, id: string): Promise<string | null> {
  const [r] = (await getSql()`SELECT item_id FROM prepaids WHERE id = ${id} AND organization_id = ${orgId} AND status = 'open'`) as unknown as Row[];
  return (r?.item_id as string | undefined) ?? null;
}
