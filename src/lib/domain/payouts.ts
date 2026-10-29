import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { listSales } from "@/lib/db/billing-repo";
import { listVisitPayments } from "@/lib/db/payments-repo";
import { getProvider } from "@/lib/db/repo";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";
import { debtSharesOn } from "@/lib/domain/debts";
import { isOwnerProvider, ownerProviderIds } from "@/lib/domain/owners";

/**
 * Pagos a profesionales (Decles). Cada profesional tiene su parte del día ($K: su comisión o lo que
 * aclaró la secretaria, más su parte de lo que se cobró de deudas ese día). La secretaria anota lo que le pagó («ya le pagué todo a Carmen») y el cierre
 * muestra cuánto se le pagó y cuánto se le debe todavía. Lo pagado en efectivo sale de la caja.
 *
 * Si no hay efectivo para pagarle, se anota «le quedamos debiendo» (`provider_debts`): eso salda la cuenta del día
 * y queda como deuda del consultorio con ella hasta que se le paga, otro día, todo o en partes. Esos pagos son
 * `provider_payouts` con `provider_debt_id`: cuentan en la caja del día en que se pagan, no en la cuenta de ese día.
 *
 * Al revés (migración 0030): si a la profesional le pagaron directo (medio `profesional`), esa plata la tiene ella y lo
 * nuestro (importe − su parte) se descuenta de lo que le debemos ese día. Si da negativo, nos debe: «Cobrar»
 * (`provider_payouts.direction` 'cobro', entra a la caja) o «Nos queda debiendo» (`provider_debts.direction` 'profesional').
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export type PayoutMethod = "efectivo" | "transferencia";
const methodOf = (m: unknown): PayoutMethod => (m === "transferencia" ? "transferencia" : "efectivo");

/** 'pago' = le damos plata (sale de la caja); 'cobro' = nos da lo que nos debía (entra a la caja). */
export type PayoutDirection = "pago" | "cobro";
/** 'consultorio' = le quedamos debiendo; 'profesional' = nos quedó debiendo. */
export type DebtDirection = "consultorio" | "profesional";

export interface Payout {
  id: string;
  direction: PayoutDirection;
  providerId: string;
  providerName: string;
  date: string;
  amount: number;
  method: PayoutMethod;
  /** Pago de una deuda de otro día (no de la parte de este día). */
  debtId: string | null;
  /** Día de la deuda que se pagó. */
  debtDate: string | null;
  createdByName: string;
  createdAt: string;
}

/** Una atención de la profesional ese día, para el detalle del cierre. */
export interface BalanceLine {
  key: string;
  time: string;
  patient: string;
  what: string;
  /** Lo que salió la atención. */
  total: number;
  /** Su parte. */
  share: number;
  /** De eso, lo que le pagaron directo a ella. */
  direct: number;
}

/**
 * Por profesional, la cuenta del día: su parte − lo que cobró ella directo − lo pagado + lo que nos dio
 * − «le quedamos debiendo» + «nos quedó debiendo» = saldo. Positivo: le debemos (`owed`); negativo: nos debe (`owesUs`).
 */
export interface ProviderBalance {
  providerId: string;
  name: string;
  /** Su parte del día (atenciones + su parte de deudas cobradas). */
  share: number;
  /** Lo que le pagaron directo a ella (no pasó por la caja). */
  direct: number;
  /** Su parte en deudas de pacientes cobradas ese día (ya sumada en `share`). */
  debtShare: number;
  paid: number;
  /** Lo que nos dio de lo que nos debía de este día. */
  collected: number;
  /** Lo que se anotó como «le quedamos debiendo» de este día. */
  deferred: number;
  /** Lo que se anotó como «nos queda debiendo» de este día. */
  deferredHer: number;
  /** Lo que le debemos todavía de este día. */
  owed: number;
  /** Lo que nos debe todavía de este día. */
  owesUs: number;
  lines: BalanceLine[];
  /** Es la dueña (médica admin): no cobra comisión, no se le paga nada. */
  owner?: boolean;
}

/** Deuda del consultorio con una profesional. */
export interface ProviderDebt {
  id: string;
  direction: DebtDirection;
  providerId: string;
  providerName: string;
  /** Día del que es la deuda. */
  date: string;
  amount: number;
  paid: number;
  remaining: number;
  status: "open" | "paid" | "voided";
  createdByName: string;
  createdAt: string;
  paidAt: string | null;
}

type Row = Record<string, unknown>;

function ctx(actor: Actor) {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente" || actor.role === "medico") return null;
  return { orgId, isAdmin: !!actor.activeOrg?.canAdmin };
}

const toPayout = (r: Row): Payout => ({
  id: r.id as string,
  direction: r.direction === "cobro" ? "cobro" : "pago",
  providerId: r.provider_id as string,
  providerName: r.provider_name as string,
  date: r.date as string,
  amount: Number(r.amount),
  method: methodOf(r.method),
  debtId: (r.provider_debt_id as string | null) ?? null,
  debtDate: (r.debt_date as string | null) ?? null,
  createdByName: r.created_by_name as string,
  createdAt: r.created_at as string,
});

async function listRaw(orgId: string, date: string): Promise<Payout[]> {
  const rows = (await getSql()`
    SELECT p.*, pr.name AS provider_name, d.date AS debt_date
    FROM provider_payouts p JOIN providers pr ON pr.id = p.provider_id
    LEFT JOIN provider_debts d ON d.id = p.provider_debt_id
    WHERE p.organization_id = ${orgId} AND p.date = ${date} AND p.status = 'active'
    ORDER BY p.created_at`) as unknown as Row[];
  return rows.map(toPayout);
}

async function balances(orgId: string, date: string, payouts: Payout[]): Promise<ProviderBalance[]> {
  const sales = (await listSales(orgId, date, date, 2000)).filter((s) => s.status === "paid" && s.providerId);
  const map = new Map<string, ProviderBalance>();
  const get = (id: string, name: string) => {
    let b = map.get(id);
    if (!b)
      map.set(id, (b = { providerId: id, name, share: 0, direct: 0, debtShare: 0, paid: 0, collected: 0, deferred: 0, deferredHer: 0, owed: 0, owesUs: 0, lines: [] }));
    return b;
  };
  // Lo que le pagaron directo: todo el renglón con medio 'profesional'; con varios medios, la parte 'profesional'
  // (se reparte entre los renglones de esa anotación según su importe).
  const splitIds = [...new Set(sales.filter((s) => s.visitId && (s.paymentMethod === "mixto" || s.paymentMethod === "dolares")).map((s) => s.visitId!))];
  const parts = await listVisitPayments(orgId, splitIds);
  const visitTotal = new Map<string, number>();
  for (const s of sales) if (s.visitId) visitTotal.set(s.visitId, (visitTotal.get(s.visitId) ?? 0) + s.total);
  const directOf = (s: (typeof sales)[number]) => {
    if (s.paymentMethod === "profesional") return s.total;
    if (!s.visitId || !parts[s.visitId]) return 0;
    const d = parts[s.visitId].filter((p) => p.method === "profesional").reduce((n, p) => n + p.amount, 0);
    const vt = visitTotal.get(s.visitId) || 0;
    return d && vt ? Math.round((d * s.total) / vt) : 0;
  };
  // Una línea por anotación y profesional, en orden de hora.
  const lines = new Map<string, BalanceLine & { providerId: string }>();
  for (const s of [...sales].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const b = get(s.providerId!, s.providerName ?? "—");
    const direct = directOf(s);
    b.share += s.commissionAmount;
    b.direct += direct;
    const key = `${s.visitId ?? s.id}:${s.providerId}`;
    let l = lines.get(key);
    if (!l) {
      l = { key, providerId: s.providerId!, time: s.createdAt.slice(11, 16), patient: s.patientName ?? "", what: "", total: 0, share: 0, direct: 0 };
      lines.set(key, l);
      b.lines.push(l);
    }
    l.what = [l.what, s.quantity > 1 ? `${s.quantity} ${s.itemName}` : s.itemName].filter(Boolean).join(", ");
    l.total += s.total;
    l.share += s.commissionAmount;
    l.direct += direct;
  }
  // Lo cobrado de deudas ese día: la profesional cobra su parte de eso ese día.
  for (const [id, d] of await debtSharesOn(orgId, date)) {
    const b = get(id, d.name);
    b.share += d.share;
    b.debtShare += d.share;
  }
  // Pagos y cobros de la cuenta de este día (los de deudas de otros días no cuentan acá).
  for (const p of payouts) {
    if (p.debtId) continue;
    if (p.direction === "cobro") get(p.providerId, p.providerName).collected += p.amount;
    else get(p.providerId, p.providerName).paid += p.amount;
  }
  const deferred = (await getSql()`
    SELECT d.provider_id, pr.name, d.direction, SUM(d.amount)::int AS amount FROM provider_debts d JOIN providers pr ON pr.id = d.provider_id
    WHERE d.organization_id = ${orgId} AND d.date = ${date} AND d.status <> 'voided'
    GROUP BY d.provider_id, pr.name, d.direction`) as unknown as Row[];
  for (const r of deferred) {
    const b = get(r.provider_id as string, r.name as string);
    if (r.direction === "profesional") b.deferredHer += Number(r.amount);
    else b.deferred += Number(r.amount);
  }
  const owners = await ownerProviderIds(orgId);
  for (const b of map.values()) {
    b.owner = owners.has(b.providerId);
    // La dueña no cobra comisión, y lo que cobra ella directo ya es del consultorio: no hay cuenta.
    if (b.owner) {
      b.share = 0;
      b.direct = 0;
      b.debtShare = 0;
      for (const l of b.lines) {
        l.share = 0;
        l.direct = 0;
      }
    }
    const saldo = b.share - b.direct - b.paid + b.collected - b.deferred + b.deferredHer;
    b.owed = Math.max(0, saldo);
    b.owesUs = Math.max(0, -saldo);
  }
  return [...map.values()].sort((a, b) => b.share + b.direct - (a.share + a.direct));
}

async function balanceOf(orgId: string, date: string, providerId: string) {
  return (await balances(orgId, date, await listRaw(orgId, date))).find((x) => x.providerId === providerId);
}

export async function listPayouts(actor: Actor, date?: string): Promise<Result<{ payouts: Payout[]; balances: ProviderBalance[] }>> {
  const c = ctx(actor);
  const d = date ?? realNowIso().slice(0, 10);
  if (!YMD.test(d)) return fail("Fecha inválida.");
  if (!c) return { ok: true, payouts: [], balances: [] };
  const payouts = await listRaw(c.orgId, d);
  return { ok: true, payouts, balances: await balances(c.orgId, d, payouts) };
}

async function providerFor(orgId: string, providerId: unknown) {
  const p = typeof providerId === "string" ? await getProvider(providerId) : undefined;
  if (!p || p.organizationId !== orgId) return fail("Elegí a qué profesional.", 404);
  if (await isOwnerProvider(orgId, p.id)) return fail(`${p.name} es admin del consultorio: no cobra comisión, no hay nada que pagarle.`, 409);
  return { ok: true as const, p };
}

function dayOf(c: { isAdmin: boolean }, v: unknown) {
  const today = realNowIso().slice(0, 10);
  const d = typeof v === "string" && v ? v : today;
  if (!YMD.test(d)) return fail("Fecha inválida.");
  if (d !== today && !c.isAdmin) return fail("Lo de días anteriores lo corrige el admin.", 403);
  return { ok: true as const, d };
}

function pesos(v: unknown): number | null | string {
  if (v === null || v === undefined || v === "" || v === "todo") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 1_000_000_000) return "El importe tiene que ser un número entero de pesos.";
  return n;
}

async function insertPayout(
  orgId: string,
  actor: Actor,
  v: { providerId: string; date: string; amount: number; method: PayoutMethod; debtId?: string | null; direction?: PayoutDirection },
) {
  const id = `pay_${randomUUID().slice(0, 8)}`;
  const now = realNowIso();
  await getSql()`
    INSERT INTO provider_payouts (id, organization_id, provider_id, date, amount, method, provider_debt_id, direction, created_by, created_by_name, created_at)
    VALUES (${id}, ${orgId}, ${v.providerId}, ${v.date}, ${v.amount}, ${v.method}, ${v.debtId ?? null}, ${v.direction ?? "pago"}, ${actor.userId}, ${actor.name}, ${now})`;
  return { id, now };
}

/** `amount` null / "todo" = todo lo que se le debe ese día. `method`: efectivo (sale de la caja) o transferencia. */
export async function createPayout(
  actor: Actor,
  v: { providerId?: unknown; amount?: unknown; date?: unknown; method?: unknown },
): Promise<Result<{ payout: Payout }>> {
  const c = ctx(actor);
  if (!c) return fail("Los pagos a profesionales los anota la secretaría o el admin.", 403);
  const day = dayOf(c, v.date);
  if (!day.ok) return day;
  const pv = await providerFor(c.orgId, v.providerId);
  if (!pv.ok) return pv;
  const { p } = pv;
  let amount = pesos(v.amount);
  if (typeof amount === "string") return fail(amount);
  if (amount === null) {
    amount = (await balanceOf(c.orgId, day.d, p.id))?.owed ?? 0;
    if (amount <= 0) return fail(`A ${p.name} no se le debe nada de este día.`, 409);
  }
  const method = methodOf(v.method);
  const { id, now } = await insertPayout(c.orgId, actor, { providerId: p.id, date: day.d, amount, method });
  return {
    ok: true,
    payout: { id, direction: "pago", providerId: p.id, providerName: p.name, date: day.d, amount, method, debtId: null, debtDate: null, createdByName: actor.name, createdAt: now },
  };
}

/**
 * La profesional nos da lo que nos debe de ese día (le pagaron directo y lo nuestro lo tenía ella).
 * `amount` null / "todo" = todo lo que nos debe de ese día. En efectivo entra a la caja.
 */
export async function createCollection(
  actor: Actor,
  v: { providerId?: unknown; amount?: unknown; date?: unknown; method?: unknown },
): Promise<Result<{ payout: Payout }>> {
  const c = ctx(actor);
  if (!c) return fail("Lo que nos dan las profesionales lo anota la secretaría o el admin.", 403);
  const day = dayOf(c, v.date);
  if (!day.ok) return day;
  const pv = await providerFor(c.orgId, v.providerId);
  if (!pv.ok) return pv;
  const { p } = pv;
  const owes = (await balanceOf(c.orgId, day.d, p.id))?.owesUs ?? 0;
  if (owes <= 0) return fail(`${p.name} no nos debe nada de este día.`, 409);
  let amount = pesos(v.amount);
  if (typeof amount === "string") return fail(amount);
  if (amount === null) amount = owes;
  if (amount > owes) return fail(`De este día ${p.name} nos debe ${owes.toLocaleString("es-AR")} pesos; no se le puede cobrar más.`, 409);
  const method = methodOf(v.method);
  const { id, now } = await insertPayout(c.orgId, actor, { providerId: p.id, date: day.d, amount, method, direction: "cobro" });
  return {
    ok: true,
    payout: { id, direction: "cobro", providerId: p.id, providerName: p.name, date: day.d, amount, method, debtId: null, debtDate: null, createdByName: actor.name, createdAt: now },
  };
}

/** Anular un pago. Si era de una deuda, la deuda vuelve a quedar abierta. */
export async function voidPayout(actor: Actor, id: string): Promise<Result<object>> {
  const c = ctx(actor);
  if (!c) return fail("No autorizado.", 403);
  const [r] = (await getSql()`SELECT date, provider_debt_id FROM provider_payouts WHERE id = ${id} AND organization_id = ${c.orgId} AND status = 'active'`) as unknown as Row[];
  if (!r) return fail("Ese pago ya no existe.", 404);
  if (r.date !== realNowIso().slice(0, 10) && !c.isAdmin) return fail("Lo de días anteriores lo corrige el admin.", 403);
  await getSql()`UPDATE provider_payouts SET status = 'voided', voided_at = ${realNowIso()}, voided_by = ${actor.userId} WHERE id = ${id} AND organization_id = ${c.orgId}`;
  if (r.provider_debt_id)
    await getSql()`UPDATE provider_debts SET status = 'open', paid_at = NULL WHERE id = ${r.provider_debt_id as string} AND organization_id = ${c.orgId} AND status = 'paid'`;
  return { ok: true };
}

// ─── Deudas con profesionales ─────────────────────────────────────────────────────────────────────────

async function debtsRaw(orgId: string, where: { status?: "open"; ids?: string[]; providerId?: string; direction?: DebtDirection } = {}): Promise<ProviderDebt[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT d.*, pr.name AS provider_name,
      COALESCE((SELECT SUM(p.amount) FROM provider_payouts p WHERE p.provider_debt_id = d.id AND p.status = 'active'), 0)::int AS paid
    FROM provider_debts d JOIN providers pr ON pr.id = d.provider_id
    WHERE d.organization_id = ${orgId}
      ${where.status ? sql`AND d.status = ${where.status}` : sql``}
      ${where.ids ? sql`AND d.id IN ${sql(where.ids)}` : sql``}
      ${where.providerId ? sql`AND d.provider_id = ${where.providerId}` : sql``}
      ${where.direction ? sql`AND d.direction = ${where.direction}` : sql``}
    ORDER BY d.date, d.created_at`) as unknown as Row[];
  return rows.map((r) => {
    const amount = Number(r.amount);
    const paid = Number(r.paid);
    return {
      id: r.id as string,
      direction: (r.direction === "profesional" ? "profesional" : "consultorio") as DebtDirection,
      providerId: r.provider_id as string,
      providerName: r.provider_name as string,
      date: r.date as string,
      amount,
      paid,
      remaining: Math.max(0, amount - paid),
      status: r.status as ProviderDebt["status"],
      createdByName: r.created_by_name as string,
      createdAt: r.created_at as string,
      paidAt: (r.paid_at as string | null) ?? null,
    };
  });
}

const dirOf = (v: unknown): DebtDirection => (v === "profesional" ? "profesional" : "consultorio");

/**
 * Deudas abiertas de todos los días: `consultorio` = lo que les debemos a las profesionales;
 * `profesional` = lo que ellas nos deben (les pagaron directo y no nos dieron lo nuestro).
 */
export async function listProviderDebts(actor: Actor, direction: DebtDirection = "consultorio"): Promise<Result<{ debts: ProviderDebt[]; total: number }>> {
  const c = ctx(actor);
  if (!c) return { ok: true, debts: [], total: 0 };
  const debts = await debtsRaw(c.orgId, { status: "open", direction });
  return { ok: true, debts, total: debts.reduce((n, d) => n + d.remaining, 0) };
}

/**
 * «Le quedamos debiendo a Marisa» (`direction` 'consultorio') o «Marisa nos queda debiendo» ('profesional'):
 * `amount` null / "todo" = todo lo de ese día.
 */
export async function createProviderDebt(
  actor: Actor,
  v: { providerId?: unknown; amount?: unknown; date?: unknown; direction?: unknown },
): Promise<Result<{ debt: ProviderDebt }>> {
  const c = ctx(actor);
  if (!c) return fail("Lo que se les debe a las profesionales lo anota la secretaría o el admin.", 403);
  const day = dayOf(c, v.date);
  if (!day.ok) return day;
  const pv = await providerFor(c.orgId, v.providerId);
  if (!pv.ok) return pv;
  const { p } = pv;
  const direction = dirOf(v.direction);
  const b = await balanceOf(c.orgId, day.d, p.id);
  const owed = (direction === "profesional" ? b?.owesUs : b?.owed) ?? 0;
  if (owed <= 0) return fail(direction === "profesional" ? `${p.name} no nos debe nada de este día.` : `A ${p.name} no se le debe nada de este día.`, 409);
  let amount = pesos(v.amount);
  if (typeof amount === "string") return fail(amount);
  if (amount === null) amount = owed;
  if (amount > owed)
    return fail(
      direction === "profesional"
        ? `De este día ${p.name} nos debe ${owed.toLocaleString("es-AR")} pesos; no puede quedar debiendo más.`
        : `De este día a ${p.name} se le deben ${owed.toLocaleString("es-AR")} pesos; no se puede dejar debiendo más.`,
      409,
    );
  const id = `pdb_${randomUUID().slice(0, 8)}`;
  await getSql()`
    INSERT INTO provider_debts (id, organization_id, provider_id, date, amount, direction, created_by, created_by_name, created_at)
    VALUES (${id}, ${c.orgId}, ${p.id}, ${day.d}, ${amount}, ${direction}, ${actor.userId}, ${actor.name}, ${realNowIso()})`;
  return { ok: true, debt: (await debtsRaw(c.orgId, { ids: [id] }))[0] };
}

/**
 * Saldar deudas de otros días. Con `debtId`, esa deuda; si no, las abiertas de esa profesional (en `direction`) de la más
 * vieja a la más nueva. `amount` null / "todo" = todo. Cuenta en la caja de hoy: lo que le pagamos sale; lo que nos da, entra.
 */
export async function payProviderDebts(
  actor: Actor,
  v: { providerId?: unknown; debtId?: unknown; amount?: unknown; method?: unknown; direction?: unknown },
): Promise<Result<{ paid: number; remaining: number; providerName: string }>> {
  const c = ctx(actor);
  if (!c) return fail("Los pagos a profesionales los anota la secretaría o el admin.", 403);
  const byId = typeof v.debtId === "string" && v.debtId;
  const open = (
    byId
      ? await debtsRaw(c.orgId, { status: "open", ids: [v.debtId as string] })
      : typeof v.providerId === "string"
        ? await debtsRaw(c.orgId, { status: "open", providerId: v.providerId, direction: dirOf(v.direction) })
        : []
  ).filter((d) => d.remaining > 0);
  if (!open.length) return fail(dirOf(v.direction) === "profesional" ? "No nos debe nada de otros días." : "No hay nada que se le deba de otros días.", 404);
  const direction: PayoutDirection = open[0].direction === "profesional" ? "cobro" : "pago";
  const total = open.reduce((n, d) => n + d.remaining, 0);
  let amount = pesos(v.amount);
  if (typeof amount === "string") return fail(amount);
  if (amount === null) amount = total;
  if (amount > total)
    return fail(
      direction === "cobro" ? `Nos debe ${total.toLocaleString("es-AR")} pesos; no se le puede cobrar más que eso.` : `Se le deben ${total.toLocaleString("es-AR")} pesos; no se le puede pagar más que eso.`,
      409,
    );
  const today = realNowIso().slice(0, 10);
  const method = methodOf(v.method);
  let left = amount;
  for (const d of open) {
    if (left <= 0) break;
    const part = Math.min(left, d.remaining);
    await insertPayout(c.orgId, actor, { providerId: d.providerId, date: today, amount: part, method, debtId: d.id, direction });
    if (part === d.remaining) await getSql()`UPDATE provider_debts SET status = 'paid', paid_at = ${realNowIso()} WHERE id = ${d.id} AND organization_id = ${c.orgId}`;
    left -= part;
  }
  return { ok: true, paid: amount, remaining: total - amount, providerName: open[0].providerName };
}

/** Anular un «le quedamos debiendo» (solo si todavía no se le pagó nada de eso). */
export async function voidProviderDebt(actor: Actor, id: string): Promise<Result<object>> {
  const c = ctx(actor);
  if (!c) return fail("No autorizado.", 403);
  const [d] = await debtsRaw(c.orgId, { ids: [id] });
  if (!d || d.status === "voided") return fail("Esa deuda ya no existe.", 404);
  if (d.paid > 0) return fail("Ya se le pagó una parte: primero anulá esos pagos.", 409);
  if (d.createdAt.slice(0, 10) !== realNowIso().slice(0, 10) && !c.isAdmin) return fail("Lo de días anteriores lo corrige el admin.", 403);
  await getSql()`UPDATE provider_debts SET status = 'voided', voided_at = ${realNowIso()}, voided_by = ${actor.userId} WHERE id = ${id} AND organization_id = ${c.orgId}`;
  return { ok: true };
}
