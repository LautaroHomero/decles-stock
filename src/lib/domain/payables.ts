import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { realNowIso } from "@/lib/domain/clock";
import { createExpense } from "@/lib/domain/expenses";
import type { Actor } from "@/lib/domain/types";

/**
 * Lo que debe el consultorio (Decles): a un proveedor, el alquiler, un servicio. Se anota con un recordatorio:
 *  · `daily`: todos los días, al arrancar (aviso en la campanita y arriba de Anotar);
 *  · `at`: un día y una hora («el 30/10 a las 10»); desde ese momento avisa hasta que se paga.
 * Se paga todo o en partes: cada pago es un egreso del día (con su medio; en efectivo sale de la caja).
 * Lo pagado sale de esos egresos: si se anula el egreso, la deuda vuelve a estar pendiente. Saldada o anulada, no avisa más.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });
type Row = Record<string, unknown>;
type Method = "efectivo" | "transferencia" | "tarjeta";
const methodOf = (m: unknown): Method => (m === "transferencia" || m === "tarjeta" ? m : "efectivo");

export type RemindMode = "daily" | "at";
export interface Payable {
  id: string;
  creditor: string;
  concept: string;
  amount: number;
  paid: number;
  remaining: number;
  remindMode: RemindMode | null;
  /** AAAA-MM-DDTHH:MM (hora de Buenos Aires), con `remindMode` 'at'. */
  remindAt: string | null;
  /** Ya toca avisar (todos los días, o pasó la fecha y hora). */
  due: boolean;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

function ctx(actor: Actor) {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente" || actor.role === "medico") return null;
  return { orgId, isAdmin: !!actor.activeOrg?.canAdmin };
}

const clean = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const nowLocal = () => realNowIso().slice(0, 16);

function reminderOf(v: { remindMode?: unknown; remindAt?: unknown }): { mode: RemindMode | null; at: string | null } | string {
  if (v.remindMode === "daily") return { mode: "daily", at: null };
  if (v.remindMode === "at") {
    const at = typeof v.remindAt === "string" ? v.remindAt.slice(0, 16) : "";
    if (!AT.test(at) || Number.isNaN(Date.parse(`${at}:00Z`))) return "Elegí el día y la hora del aviso.";
    return { mode: "at", at };
  }
  return { mode: null, at: null };
}

async function raw(orgId: string, where: { ids?: string[]; open?: boolean } = {}): Promise<Payable[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT p.*,
      COALESCE((SELECT SUM(e.amount) FROM payable_payments x JOIN expenses e ON e.id = x.expense_id
                WHERE x.payable_id = p.id AND e.status = 'active'), 0)::int AS paid
    FROM payables p
    WHERE p.organization_id = ${orgId} AND p.status <> 'voided'
      ${where.ids ? sql`AND p.id IN ${sql(where.ids)}` : sql``}
    ORDER BY p.created_at`) as unknown as Row[];
  const now = nowLocal();
  const list = rows.map((r): Payable => {
    const amount = Number(r.amount);
    const paid = Number(r.paid);
    const remindMode = (r.remind_mode as RemindMode | null) ?? null;
    const remindAt = (r.remind_at as string | null) ?? null;
    const remaining = Math.max(0, amount - paid);
    return {
      id: r.id as string,
      creditor: r.creditor as string,
      concept: r.concept as string,
      amount,
      paid,
      remaining,
      remindMode,
      remindAt,
      due: remaining > 0 && (remindMode === "daily" || (remindMode === "at" && !!remindAt && remindAt <= now)),
      createdBy: r.created_by as string,
      createdByName: r.created_by_name as string,
      createdAt: r.created_at as string,
    };
  });
  return where.open ? list.filter((p) => p.remaining > 0) : list;
}

/** Lo que debemos (pendiente), con los que ya toca avisar primero. */
export async function listPayables(actor: Actor): Promise<Result<{ payables: Payable[]; total: number }>> {
  const c = ctx(actor);
  if (!c) return { ok: true, payables: [], total: 0 };
  const payables = (await raw(c.orgId, { open: true })).sort((a, b) => Number(b.due) - Number(a.due));
  return { ok: true, payables, total: payables.reduce((n, p) => n + p.remaining, 0) };
}

/** Para la campanita y «Para pagar» en Anotar. */
export async function duePayables(orgId: string): Promise<Payable[]> {
  return (await raw(orgId, { open: true })).filter((p) => p.due);
}

export async function createPayable(
  actor: Actor,
  v: { creditor?: unknown; concept?: unknown; amount?: unknown; remindMode?: unknown; remindAt?: unknown },
): Promise<Result<{ payable: Payable }>> {
  const c = ctx(actor);
  if (!c) return fail("Lo que debe el consultorio lo anota la secretaría o el admin.", 403);
  const creditor = clean(v.creditor).slice(0, 80);
  if (!creditor) return fail("¿A quién se le debe?");
  const concept = clean(v.concept).slice(0, 120);
  const amount = Number(v.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) return fail("¿Cuánto se debe? Tiene que ser un número entero de pesos.");
  const rem = reminderOf(v);
  if (typeof rem === "string") return fail(rem);
  const id = `pyb_${randomUUID().slice(0, 8)}`;
  await getSql()`
    INSERT INTO payables (id, organization_id, creditor, concept, amount, remind_mode, remind_at, created_by, created_by_name, created_at)
    VALUES (${id}, ${c.orgId}, ${creditor.charAt(0).toUpperCase() + creditor.slice(1)}, ${concept}, ${amount}, ${rem.mode}, ${rem.at}, ${actor.userId}, ${actor.name}, ${realNowIso()})`;
  return { ok: true, payable: (await raw(c.orgId, { ids: [id] }))[0] };
}

/** Cambiar (o sacar) el recordatorio. */
export async function setPayableReminder(actor: Actor, id: string, v: { remindMode?: unknown; remindAt?: unknown }): Promise<Result<{ payable: Payable }>> {
  const c = ctx(actor);
  if (!c) return fail("No autorizado.", 403);
  const rem = reminderOf(v);
  if (typeof rem === "string") return fail(rem);
  const rows = (await getSql()`
    UPDATE payables SET remind_mode = ${rem.mode}, remind_at = ${rem.at}
    WHERE id = ${id} AND organization_id = ${c.orgId} AND status = 'open' RETURNING id`) as unknown as Row[];
  if (!rows.length) return fail("Esa deuda ya no está.", 404);
  return { ok: true, payable: (await raw(c.orgId, { ids: [id] }))[0] };
}

/** Pagar (todo si no se dice cuánto). Es un egreso de hoy con su medio. */
export async function payPayable(actor: Actor, id: string, v: { amount?: unknown; method?: unknown }): Promise<Result<{ payable: Payable; paid: number }>> {
  const c = ctx(actor);
  if (!c) return fail("No autorizado.", 403);
  const [p] = await raw(c.orgId, { ids: [id] });
  if (!p || p.remaining <= 0) return fail("Esa deuda ya está saldada.", 404);
  const amount = v.amount === null || v.amount === undefined || v.amount === "" ? p.remaining : Number(v.amount);
  if (!Number.isInteger(amount) || amount <= 0) return fail("El importe tiene que ser un número entero de pesos.");
  if (amount > p.remaining) return fail(`Se deben ${p.remaining.toLocaleString("es-AR")} pesos; no se puede pagar más que eso.`, 409);
  const e = await createExpense(actor, { concept: `Pago a ${p.creditor}${p.concept ? ` · ${p.concept}` : ""}`, amount, direction: "egreso", method: methodOf(v.method) });
  if (!e.ok) return e;
  await getSql()`
    INSERT INTO payable_payments (id, organization_id, payable_id, expense_id, amount, created_at)
    VALUES (${`pyp_${randomUUID().slice(0, 8)}`}, ${c.orgId}, ${p.id}, ${e.expense.id}, ${amount}, ${realNowIso()})`;
  const [after] = await raw(c.orgId, { ids: [id] });
  if (after.remaining === 0) await getSql()`UPDATE payables SET paid_at = ${realNowIso()} WHERE id = ${id}`;
  return { ok: true, payable: after, paid: amount };
}

/** Anular una deuda mal anotada (si todavía no se pagó nada). */
export async function voidPayable(actor: Actor, id: string): Promise<Result<object>> {
  const c = ctx(actor);
  if (!c) return fail("No autorizado.", 403);
  const [p] = await raw(c.orgId, { ids: [id] });
  if (!p) return fail("Esa deuda ya no está.", 404);
  if (p.paid > 0) return fail("Ya se pagó una parte: anulá primero ese egreso.", 409);
  await getSql()`UPDATE payables SET status = 'voided', voided_at = ${realNowIso()}, voided_by = ${actor.userId} WHERE id = ${id} AND organization_id = ${c.orgId}`;
  return { ok: true };
}
