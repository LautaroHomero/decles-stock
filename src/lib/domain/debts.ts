import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { getProvider } from "@/lib/db/repo";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";
import { isOwnerProvider } from "@/lib/domain/owners";

/**
 * Deudas (Decles): alguien le debe plata al consultorio. Casi siempre un paciente que pagó una parte
 * («botox a carla, gabi, pagó 80000, debe 40000»), a veces suelta («carla debe 40000»).
 * Se cobra de una vez o en partes; cada cobro entra a la caja del día en que se paga y, si la deuda
 * es de una atención, la profesional cobra su parte de ese cobro ese día (`share`).
 * El admin tiene un aviso por cada deuda abierta, que se va solo cuando se termina de pagar.
 * La anotan y la cobran la secretaría y el admin (la médica no maneja caja).
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });
const YMD = /^\d{4}-\d{2}-\d{2}$/;
type Row = Record<string, unknown>;

export type DebtMethod = "efectivo" | "transferencia" | "tarjeta";

export interface DebtPayment {
  id: string;
  debtId: string;
  date: string;
  amount: number;
  method: DebtMethod | null;
  share: number;
  createdByName: string;
  createdAt: string;
}

export interface Debt {
  id: string;
  debtor: string;
  concept: string;
  amount: number;
  /** Lo cobrado hasta ahora. */
  paid: number;
  /** Lo que falta. */
  remaining: number;
  providerId: string | null;
  providerName: string | null;
  share: number;
  visitId: string | null;
  status: "open" | "paid" | "voided";
  createdByName: string;
  createdAt: string;
  paidAt: string | null;
  payments: DebtPayment[];
}

/** Un cobro de deuda con el nombre de quién debía (para el cierre). */
export interface DebtCollection extends DebtPayment {
  debtor: string;
  concept: string;
  providerId: string | null;
  providerName: string | null;
}

function ctx(actor: Actor) {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente" || actor.role === "medico") return null;
  return { orgId, isAdmin: !!actor.activeOrg?.canAdmin };
}

const toPayment = (r: Row): DebtPayment => ({
  id: r.id as string,
  debtId: r.debt_id as string,
  date: r.date as string,
  amount: Number(r.amount),
  method: (r.method as DebtMethod | null) ?? null,
  share: Number(r.share ?? 0),
  createdByName: r.created_by_name as string,
  createdAt: r.created_at as string,
});

async function load(orgId: string, where: { status?: "open"; ids?: string[]; visitIds?: string[]; since?: string }): Promise<Debt[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT d.*, pr.name AS provider_name FROM debts d LEFT JOIN providers pr ON pr.id = d.provider_id
    WHERE d.organization_id = ${orgId} AND d.status <> 'voided'
      ${where.status ? sql`AND d.status = ${where.status}` : sql``}
      ${where.ids ? sql`AND d.id = ANY(${where.ids}::text[])` : sql``}
      ${where.visitIds ? sql`AND d.visit_id = ANY(${where.visitIds}::text[])` : sql``}
      ${where.since ? sql`AND (d.status = 'open' OR d.paid_at >= ${where.since})` : sql``}
    ORDER BY d.created_at DESC, d.id`) as unknown as Row[];
  if (!rows.length) return [];
  const pays = (await sql`
    SELECT * FROM debt_payments WHERE organization_id = ${orgId} AND status = 'active'
      AND debt_id = ANY(${rows.map((r) => r.id as string)}::text[])
    ORDER BY created_at`) as unknown as Row[];
  return rows.map((r) => {
    const payments = pays.filter((p) => p.debt_id === r.id).map(toPayment);
    const paid = payments.reduce((n, p) => n + p.amount, 0);
    const amount = Number(r.amount);
    return {
      id: r.id as string,
      debtor: r.debtor as string,
      concept: (r.concept as string) ?? "",
      amount,
      paid,
      remaining: Math.max(0, amount - paid),
      providerId: (r.provider_id as string) ?? null,
      providerName: (r.provider_name as string) ?? null,
      share: Number(r.share ?? 0),
      visitId: (r.visit_id as string) ?? null,
      status: r.status as Debt["status"],
      createdByName: r.created_by_name as string,
      createdAt: r.created_at as string,
      paidAt: (r.paid_at as string) ?? null,
      payments,
    };
  });
}

/** Las abiertas (y, con `recentDays`, las que se terminaron de pagar hace poco). */
export async function listDebts(actor: Actor, recentDays = 0): Promise<Result<{ debts: Debt[]; total: number }>> {
  const c = ctx(actor);
  if (!c) return { ok: true, debts: [], total: 0 };
  const since = recentDays > 0 ? new Date(Date.now() - recentDays * 86_400_000).toISOString().slice(0, 10) : undefined;
  const debts = await load(c.orgId, since ? { since } : { status: "open" });
  return { ok: true, debts, total: debts.filter((d) => d.status === "open").reduce((n, d) => n + d.remaining, 0) };
}

/** Las deudas que salieron de estas anotaciones (para mostrarlas en la planilla). */
export async function debtsForVisits(orgId: string, visitIds: string[]): Promise<Record<string, Debt>> {
  if (!visitIds.length) return {};
  const out: Record<string, Debt> = {};
  for (const d of await load(orgId, { visitIds })) if (d.visitId) out[d.visitId] = d;
  return out;
}

/** Cobros de deudas de un día (entran a la caja ese día). */
export async function debtCollections(orgId: string, date: string): Promise<DebtCollection[]> {
  const rows = (await getSql()`
    SELECT p.*, d.debtor, d.concept, d.provider_id, pr.name AS provider_name
    FROM debt_payments p JOIN debts d ON d.id = p.debt_id LEFT JOIN providers pr ON pr.id = d.provider_id
    WHERE p.organization_id = ${orgId} AND p.date = ${date} AND p.status = 'active'
    ORDER BY p.created_at`) as unknown as Row[];
  return rows.map((r) => ({
    ...toPayment(r),
    debtor: r.debtor as string,
    concept: (r.concept as string) ?? "",
    providerId: (r.provider_id as string) ?? null,
    providerName: (r.provider_name as string) ?? null,
  }));
}

/** Deudas que se anotaron ese día (lo que «quedó debiendo»). */
export async function debtsCreatedOn(orgId: string, date: string): Promise<Debt[]> {
  const rows = (await getSql()`
    SELECT id FROM debts WHERE organization_id = ${orgId} AND status <> 'voided' AND substr(created_at, 1, 10) = ${date}`) as unknown as Row[];
  return rows.length ? load(orgId, { ids: rows.map((r) => r.id as string) }) : [];
}

const clean = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");
const pesos = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 1_000_000_000;

/**
 * Anotar una deuda. `share` = la parte de la profesional en lo que se debe; sin aclarar, su % sobre el
 * importe (o 0 si no hay profesional).
 */
export async function createDebt(
  actor: Actor,
  v: { debtor?: unknown; amount?: unknown; concept?: unknown; providerId?: unknown; share?: unknown; visitId?: unknown },
): Promise<Result<{ debt: Debt }>> {
  // La médica no maneja caja, pero sí puede anotar que su paciente quedó debiendo (desde una atención).
  const c = ctx(actor) ?? (actor.role === "medico" && actor.activeOrg && typeof v.visitId === "string" ? { orgId: actor.activeOrg.id, isAdmin: false } : null);
  if (!c) return fail("Las deudas las anota la secretaría o el admin.", 403);
  const debtor = clean(v.debtor).slice(0, 120);
  if (!debtor) return fail("¿Quién debe?");
  if (!pesos(v.amount)) return fail("Lo que debe tiene que ser un número entero de pesos.");
  const amount = v.amount as number;
  let providerId: string | null = null;
  let share = 0;
  let owner = false;
  if (typeof v.providerId === "string" && v.providerId) {
    const p = await getProvider(v.providerId);
    if (!p || p.organizationId !== c.orgId) return fail("Profesional no encontrado en este consultorio.", 404);
    providerId = p.id;
    owner = await isOwnerProvider(c.orgId, p.id);
    share = owner ? 0 : Math.round((amount * p.commissionPct) / 100);
  }
  if (v.share !== undefined && v.share !== null && !owner) {
    if (typeof v.share !== "number" || !Number.isInteger(v.share) || v.share < 0 || v.share > amount)
      return fail("La parte de la profesional tiene que ser entre $0 y lo que se debe.");
    share = v.share;
  }
  const id = `debt_${randomUUID().slice(0, 10)}`;
  await getSql()`
    INSERT INTO debts (id, organization_id, debtor, concept, amount, provider_id, share, visit_id, created_by, created_by_name, created_at)
    VALUES (${id}, ${c.orgId}, ${debtor}, ${clean(v.concept).slice(0, 200)}, ${amount}, ${providerId}, ${share},
            ${typeof v.visitId === "string" && v.visitId ? v.visitId : null}, ${actor.userId}, ${actor.name}, ${realNowIso()})`;
  const [debt] = await load(c.orgId, { ids: [id] });
  return { ok: true, debt };
}

/** Cobrar una deuda (toda o una parte). `amount` vacío = todo lo que falta. Entra a la caja del día. */
export async function payDebt(actor: Actor, id: string, v: { amount?: unknown; method?: unknown; date?: unknown }): Promise<Result<{ debt: Debt; payment: DebtPayment }>> {
  const c = ctx(actor);
  if (!c) return fail("Las deudas las cobra la secretaría o el admin.", 403);
  const today = realNowIso().slice(0, 10);
  const date = typeof v.date === "string" && v.date ? v.date : today;
  if (!YMD.test(date)) return fail("Fecha inválida.");
  if (date !== today && !c.isAdmin) return fail("Lo de días anteriores lo corrige el admin.", 403);
  const method = v.method === "efectivo" || v.method === "transferencia" || v.method === "tarjeta" ? v.method : null;
  if (v.method !== undefined && v.method !== null && v.method !== "" && !method) return fail("Medio de pago inválido.");

  const sql = getSql();
  const payId = `dpay_${randomUUID().slice(0, 10)}`;
  const r = await sql.begin(async (tx) => {
    const [d] = (await tx`SELECT * FROM debts WHERE id = ${id} AND organization_id = ${c.orgId} FOR UPDATE`) as unknown as Row[];
    if (!d || d.status === "voided") return fail("Esa deuda ya no existe.", 404);
    if (d.status === "paid") return fail(`${d.debtor} ya no debe nada.`, 409);
    const [s] = (await tx`
      SELECT coalesce(sum(amount), 0)::int AS paid, coalesce(sum(share), 0)::int AS shared
      FROM debt_payments WHERE debt_id = ${id} AND status = 'active'`) as unknown as Row[];
    const total = Number(d.amount), share = Number(d.share);
    const remaining = total - Number(s.paid);
    const amount = v.amount === undefined || v.amount === null || v.amount === "" || v.amount === "todo" ? remaining : Number(v.amount);
    if (!Number.isInteger(amount) || amount <= 0) return fail("El importe tiene que ser un número entero de pesos.");
    if (amount > remaining) return fail(`${d.debtor} debe $ ${remaining.toLocaleString("es-AR")}: no puede pagar más que eso.`, 409);
    // La parte de la profesional en este cobro (al terminar de pagar, lo que falte de su parte, sin redondeos perdidos).
    const last = amount === remaining;
    const payShare = last ? share - Number(s.shared) : Math.round((share * amount) / total);
    await tx`
      INSERT INTO debt_payments (id, organization_id, debt_id, date, amount, method, share, created_by, created_by_name, created_at)
      VALUES (${payId}, ${c.orgId}, ${id}, ${date}, ${amount}, ${method}, ${Math.max(0, payShare)}, ${actor.userId}, ${actor.name}, ${realNowIso()})`;
    if (last) await tx`UPDATE debts SET status = 'paid', paid_at = ${realNowIso()} WHERE id = ${id}`;
    return { ok: true as const };
  });
  if (!r.ok) return r;
  const [debt] = await load(c.orgId, { ids: [id] });
  return { ok: true, debt, payment: debt.payments.find((p) => p.id === payId)! };
}

/** Deshacer un cobro (lo de hoy, quien sea del equipo; días anteriores, el admin). La deuda vuelve a estar abierta. */
export async function voidDebtPayment(actor: Actor, paymentId: string): Promise<Result<object>> {
  const c = ctx(actor);
  if (!c) return fail("No autorizado.", 403);
  const [p] = (await getSql()`
    SELECT debt_id, date FROM debt_payments WHERE id = ${paymentId} AND organization_id = ${c.orgId} AND status = 'active'`) as unknown as Row[];
  if (!p) return fail("Ese cobro ya no existe.", 404);
  if (p.date !== realNowIso().slice(0, 10) && !c.isAdmin) return fail("Lo de días anteriores lo corrige el admin.", 403);
  await getSql().begin(async (tx) => {
    await tx`UPDATE debt_payments SET status = 'voided', voided_at = ${realNowIso()}, voided_by = ${actor.userId} WHERE id = ${paymentId}`;
    await tx`UPDATE debts SET status = 'open', paid_at = NULL WHERE id = ${p.debt_id as string} AND status = 'paid'`;
  });
  return { ok: true };
}

/** Anular una deuda mal anotada (sin cobros). La anula quien la anotó en el día o el admin. */
export async function voidDebt(actor: Actor, id: string): Promise<Result<object>> {
  const c = ctx(actor);
  if (!c) return fail("No autorizado.", 403);
  const [d] = (await getSql()`SELECT created_at, created_by FROM debts WHERE id = ${id} AND organization_id = ${c.orgId} AND status <> 'voided'`) as unknown as Row[];
  if (!d) return fail("Esa deuda ya no existe.", 404);
  const today = realNowIso().slice(0, 10);
  if (!c.isAdmin && ((d.created_at as string).slice(0, 10) !== today || d.created_by !== actor.userId))
    return fail("Solo el admin puede anular una deuda de otro día o de otra persona.", 403);
  const [n] = (await getSql()`SELECT count(*)::int AS n FROM debt_payments WHERE debt_id = ${id} AND status = 'active'`) as unknown as Row[];
  if (Number(n.n) > 0) return fail("Esa deuda ya tiene cobros: anulá los cobros primero.", 409);
  await getSql()`UPDATE debts SET status = 'voided', voided_at = ${realNowIso()}, voided_by = ${actor.userId} WHERE id = ${id}`;
  return { ok: true };
}

/** Al editar una anotación (que pasa a tener otro `visit_id`), su deuda la sigue. */
export async function relinkDebts(orgId: string, fromVisit: string, toVisit: string): Promise<void> {
  await getSql()`UPDATE debts SET visit_id = ${toVisit} WHERE organization_id = ${orgId} AND visit_id = ${fromVisit}`;
}

/** Para la campanita de los admins: las deudas abiertas. */
export async function openDebtsForAlerts(orgId: string): Promise<Debt[]> {
  return load(orgId, { status: "open" });
}

/** Lo que se cobró ese día, por profesional (su parte). Para lo que se le debe en el día (payouts). */
export async function debtSharesOn(orgId: string, date: string): Promise<Map<string, { name: string; share: number }>> {
  const map = new Map<string, { name: string; share: number }>();
  for (const p of await debtCollections(orgId, date)) {
    if (!p.providerId || !p.share) continue;
    const cur = map.get(p.providerId) ?? { name: p.providerName ?? "—", share: 0 };
    cur.share += p.share;
    map.set(p.providerId, cur);
  }
  return map;
}

/** Para el cierre: lo cobrado de deudas ese día y lo que se anotó como deuda ese día. */
export async function dayDebts(actor: Actor, date?: string): Promise<Result<{ collections: DebtCollection[]; created: Debt[] }>> {
  const c = ctx(actor);
  const d = date ?? realNowIso().slice(0, 10);
  if (!YMD.test(d)) return fail("Fecha inválida.");
  if (!c) return { ok: true, collections: [], created: [] };
  const [collections, created] = await Promise.all([debtCollections(c.orgId, d), debtsCreatedOn(c.orgId, d)]);
  return { ok: true, collections, created };
}
