import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { getPriceItem } from "@/lib/db/billing-repo";
import { realNowIso } from "@/lib/domain/clock";
import { createExpense, voidExpense } from "@/lib/domain/expenses";
import type { Actor } from "@/lib/domain/types";

/**
 * Señas (Decles): la paciente deja una parte antes del turno, para una práctica y un día.
 *  · La seña entra a la caja el día que se deja (ingreso con su medio).
 *  · El día que viene, la atención la descuenta: paga solo el resto y no queda deuda. La profesional cobra su parte
 *    sobre el total (seña + resto), como si hubiera pagado todo ese día.
 *  · Está usada mientras su atención siga vigente; si la atención se anula, la seña vuelve a estar disponible.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });
type Row = Record<string, unknown>;
type Method = "efectivo" | "transferencia" | "tarjeta";
const methodOf = (m: unknown): Method => (m === "transferencia" || m === "tarjeta" ? m : "efectivo");
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const clean = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");

export interface Deposit {
  id: string;
  patient: string;
  itemId: string | null;
  itemName: string;
  amount: number;
  method: Method;
  /** Día del turno (AAAA-MM-DD). */
  dueOn: string | null;
  /** Ya se descontó en una atención vigente. */
  used: boolean;
  visitId: string | null;
  createdByName: string;
  createdAt: string;
}

function ctx(actor: Actor) {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente") return null;
  return { orgId, isAdmin: !!actor.activeOrg?.canAdmin, canWrite: actor.role !== "medico" };
}

async function raw(orgId: string, where: { ids?: string[]; visitId?: string } = {}): Promise<Deposit[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT d.*, (d.visit_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM sales s WHERE s.organization_id = d.organization_id AND s.visit_id = d.visit_id AND s.status = 'paid')) AS used
    FROM deposits d
    WHERE d.organization_id = ${orgId} AND d.status <> 'voided'
      ${where.ids ? sql`AND d.id IN ${sql(where.ids)}` : sql``}
      ${where.visitId ? sql`AND d.visit_id = ${where.visitId}` : sql``}
    ORDER BY d.due_on NULLS LAST, d.created_at`) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    patient: r.patient_label as string,
    itemId: (r.item_id as string | null) ?? null,
    itemName: r.item_name as string,
    amount: Number(r.amount),
    method: methodOf(r.method),
    dueOn: (r.due_on as string | null) ?? null,
    used: !!r.used,
    visitId: (r.visit_id as string | null) ?? null,
    createdByName: r.created_by_name as string,
    createdAt: r.created_at as string,
  }));
}

/** Señas sin usar (de todos los días), por fecha de turno. */
export async function listDeposits(actor: Actor): Promise<Result<{ deposits: Deposit[]; total: number }>> {
  const c = ctx(actor);
  if (!c) return { ok: true, deposits: [], total: 0 };
  const deposits = (await raw(c.orgId)).filter((d) => !d.used);
  return { ok: true, deposits, total: deposits.reduce((n, d) => n + d.amount, 0) };
}

/** Señas usadas en atenciones de un día: visit_id → seña (para la Planilla). */
export async function depositsUsedOn(actor: Actor, date: string): Promise<{ visitId: string; depositId: string; amount: number; createdAt: string }[]> {
  const c = ctx(actor);
  if (!c) return [];
  const rows = (await getSql()`
    SELECT d.id, d.visit_id, d.amount, d.created_at FROM deposits d
    WHERE d.organization_id = ${c.orgId} AND d.status <> 'voided' AND d.visit_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM sales s WHERE s.organization_id = d.organization_id AND s.visit_id = d.visit_id AND s.status = 'paid' AND substr(s.created_at, 1, 10) = ${date})`) as unknown as Row[];
  return rows.map((r) => ({ visitId: r.visit_id as string, depositId: r.id as string, amount: Number(r.amount), createdAt: r.created_at as string }));
}

export async function createDeposit(
  actor: Actor,
  v: { patient?: unknown; itemId?: unknown; amount?: unknown; method?: unknown; dueOn?: unknown },
): Promise<Result<{ deposit: Deposit }>> {
  const c = ctx(actor);
  if (!c?.canWrite) return fail("Las señas las anota la secretaría o el admin.", 403);
  const patient = clean(v.patient).slice(0, 120);
  if (!patient) return fail("¿De qué paciente es la seña?");
  const amount = Number(v.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) return fail("¿De cuánto es la seña? Tiene que ser un número entero de pesos.");
  const item = typeof v.itemId === "string" && v.itemId ? await getPriceItem(c.orgId, v.itemId) : undefined;
  if (typeof v.itemId === "string" && v.itemId && !item) return fail("No encontré esa práctica.", 404);
  const dueOn = typeof v.dueOn === "string" && v.dueOn ? v.dueOn.slice(0, 10) : null;
  if (dueOn && !YMD.test(dueOn)) return fail("La fecha del turno no es válida.");
  const method = methodOf(v.method);
  const inc = await createExpense(actor, { concept: `Seña · ${patient}${item ? ` · ${item.name}` : ""}`, amount, direction: "ingreso", method });
  if (!inc.ok) return inc;
  const id = `sen_${randomUUID().slice(0, 8)}`;
  await getSql()`
    INSERT INTO deposits (id, organization_id, patient_label, item_id, item_name, amount, method, due_on, income_id, created_by, created_by_name, created_at)
    VALUES (${id}, ${c.orgId}, ${patient}, ${item?.id ?? null}, ${item?.name ?? ""}, ${amount}, ${method}, ${dueOn}, ${inc.expense.id}, ${actor.userId}, ${actor.name}, ${realNowIso()})`;
  return { ok: true, deposit: (await raw(c.orgId, { ids: [id] }))[0] };
}

/** Cambiar el día del turno (lo reprogramaron). */
export async function setDepositDate(actor: Actor, id: string, dueOn: unknown): Promise<Result<{ deposit: Deposit }>> {
  const c = ctx(actor);
  if (!c?.canWrite) return fail("No autorizado.", 403);
  const d = typeof dueOn === "string" && dueOn ? dueOn.slice(0, 10) : null;
  if (d && !YMD.test(d)) return fail("La fecha del turno no es válida.");
  const rows = (await getSql()`UPDATE deposits SET due_on = ${d} WHERE id = ${id} AND organization_id = ${c.orgId} AND status = 'open' RETURNING id`) as unknown as Row[];
  if (!rows.length) return fail("Esa seña ya no está.", 404);
  return { ok: true, deposit: (await raw(c.orgId, { ids: [id] }))[0] };
}

/** Anular una seña mal anotada (si no se usó). Saca la plata de la caja del día en que se anotó. */
export async function voidDeposit(actor: Actor, id: string): Promise<Result<object>> {
  const c = ctx(actor);
  if (!c?.canWrite) return fail("No autorizado.", 403);
  const [d] = await raw(c.orgId, { ids: [id] });
  if (!d) return fail("Esa seña ya no está.", 404);
  if (d.used) return fail("Esa seña ya se descontó en una atención: primero anulá la atención.", 409);
  if (!c.isAdmin && d.createdAt.slice(0, 10) !== realNowIso().slice(0, 10)) return fail("Lo de días anteriores lo corrige el admin.", 403);
  const [r] = (await getSql()`SELECT income_id FROM deposits WHERE id = ${id}`) as unknown as Row[];
  await getSql()`UPDATE deposits SET status = 'voided', voided_at = ${realNowIso()}, voided_by = ${actor.userId} WHERE id = ${id} AND organization_id = ${c.orgId}`;
  if (r?.income_id) await voidExpense(actor, r.income_id as string, true);
  return { ok: true };
}

/** Para `recordVisit`: la seña tiene que estar sin usar (sin contar la atención que se está reemplazando). */
export async function depositForVisit(orgId: string, id: string, replacingVisitId?: string): Promise<Result<{ deposit: Deposit }>> {
  const [d] = await raw(orgId, { ids: [id] });
  if (!d) return fail("Esa seña ya no está.", 404);
  if (d.used && d.visitId !== replacingVisitId) return fail(`La seña de ${d.patient} ya se descontó en otra atención.`, 409);
  return { ok: true, deposit: d };
}

export async function applyDeposit(orgId: string, id: string, visitId: string): Promise<void> {
  await getSql()`UPDATE deposits SET visit_id = ${visitId} WHERE id = ${id} AND organization_id = ${orgId}`;
}
/** Al editar: sin decir nada, la seña sigue en la atención nueva; con null, se suelta. */
export async function relinkDeposit(orgId: string, oldVisitId: string, newVisitId: string): Promise<void> {
  await getSql()`UPDATE deposits SET visit_id = ${newVisitId} WHERE organization_id = ${orgId} AND visit_id = ${oldVisitId}`;
}
export async function releaseDeposit(orgId: string, visitId: string): Promise<void> {
  await getSql()`UPDATE deposits SET visit_id = NULL WHERE organization_id = ${orgId} AND visit_id = ${visitId}`;
}
