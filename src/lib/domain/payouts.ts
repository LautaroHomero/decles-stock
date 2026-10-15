import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { listSales } from "@/lib/db/billing-repo";
import { getProvider } from "@/lib/db/repo";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";
import { debtSharesOn } from "@/lib/domain/debts";
import { isOwnerProvider, ownerProviderIds } from "@/lib/domain/owners";

/**
 * Pagos a profesionales (Decles). Cada profesional tiene su parte del día ($K: su comisión o lo que
 * aclaró la secretaria, más su parte de lo que se cobró de deudas ese día). La secretaria anota lo que le pagó («ya le pagué todo a Carmen») y el cierre
 * muestra cuánto se le pagó y cuánto se le debe todavía. Lo pagado sale de la caja.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface Payout {
  id: string;
  providerId: string;
  providerName: string;
  date: string;
  amount: number;
  createdByName: string;
  createdAt: string;
}

/** Por profesional: su parte del día, lo que ya se le pagó y lo que falta. */
export interface ProviderBalance {
  providerId: string;
  name: string;
  share: number;
  paid: number;
  owed: number;
  /** Es la dueña (médica admin): no cobra comisión, no se le paga nada. */
  owner?: boolean;
}

type Row = Record<string, unknown>;

function ctx(actor: Actor) {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente" || actor.role === "medico") return null;
  return { orgId, isAdmin: !!actor.activeOrg?.canAdmin };
}

async function listRaw(orgId: string, date: string): Promise<Payout[]> {
  const rows = (await getSql()`
    SELECT p.*, pr.name AS provider_name FROM provider_payouts p JOIN providers pr ON pr.id = p.provider_id
    WHERE p.organization_id = ${orgId} AND p.date = ${date} AND p.status = 'active'
    ORDER BY p.created_at`) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    providerId: r.provider_id as string,
    providerName: r.provider_name as string,
    date: r.date as string,
    amount: Number(r.amount),
    createdByName: r.created_by_name as string,
    createdAt: r.created_at as string,
  }));
}

async function balances(orgId: string, date: string, payouts: Payout[]): Promise<ProviderBalance[]> {
  const sales = (await listSales(orgId, date, date, 2000)).filter((s) => s.status === "paid" && s.providerId);
  const map = new Map<string, ProviderBalance>();
  const get = (id: string, name: string) => {
    let b = map.get(id);
    if (!b) map.set(id, (b = { providerId: id, name, share: 0, paid: 0, owed: 0 }));
    return b;
  };
  for (const s of sales) get(s.providerId!, s.providerName ?? "—").share += s.commissionAmount;
  // Lo cobrado de deudas ese día: la profesional cobra su parte de eso ese día.
  for (const [id, d] of await debtSharesOn(orgId, date)) get(id, d.name).share += d.share;
  for (const p of payouts) get(p.providerId, p.providerName).paid += p.amount;
  const owners = await ownerProviderIds(orgId);
  for (const b of map.values()) {
    b.owner = owners.has(b.providerId);
    if (b.owner) b.share = 0;
    b.owed = Math.max(0, b.share - b.paid);
  }
  return [...map.values()].sort((a, b) => b.share - a.share);
}

export async function listPayouts(actor: Actor, date?: string): Promise<Result<{ payouts: Payout[]; balances: ProviderBalance[] }>> {
  const c = ctx(actor);
  const d = date ?? realNowIso().slice(0, 10);
  if (!YMD.test(d)) return fail("Fecha inválida.");
  if (!c) return { ok: true, payouts: [], balances: [] };
  const payouts = await listRaw(c.orgId, d);
  return { ok: true, payouts, balances: await balances(c.orgId, d, payouts) };
}

/** `amount` null / "todo" = todo lo que se le debe ese día. */
export async function createPayout(actor: Actor, v: { providerId?: unknown; amount?: unknown; date?: unknown }): Promise<Result<{ payout: Payout }>> {
  const c = ctx(actor);
  if (!c) return fail("Los pagos a profesionales los anota la secretaría o el admin.", 403);
  const today = realNowIso().slice(0, 10);
  const d = typeof v.date === "string" && v.date ? v.date : today;
  if (!YMD.test(d)) return fail("Fecha inválida.");
  if (d !== today && !c.isAdmin) return fail("Lo de días anteriores lo corrige el admin.", 403);
  const p = typeof v.providerId === "string" ? await getProvider(v.providerId) : undefined;
  if (!p || p.organizationId !== c.orgId) return fail("Elegí a qué profesional le pagaste.", 404);
  if (await isOwnerProvider(c.orgId, p.id)) return fail(`${p.name} es admin del consultorio: no cobra comisión, no hay nada que pagarle.`, 409);
  let amount: number;
  if (v.amount === null || v.amount === undefined || v.amount === "" || v.amount === "todo") {
    const b = (await balances(c.orgId, d, await listRaw(c.orgId, d))).find((x) => x.providerId === p.id);
    amount = b?.owed ?? 0;
    if (amount <= 0) return fail(`A ${p.name} no se le debe nada de este día.`, 409);
  } else {
    amount = Number(v.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) return fail("El importe tiene que ser un número entero de pesos.");
  }
  const id = `pay_${randomUUID().slice(0, 8)}`;
  const now = realNowIso();
  await getSql()`
    INSERT INTO provider_payouts (id, organization_id, provider_id, date, amount, created_by, created_by_name, created_at)
    VALUES (${id}, ${c.orgId}, ${p.id}, ${d}, ${amount}, ${actor.userId}, ${actor.name}, ${now})`;
  return { ok: true, payout: { id, providerId: p.id, providerName: p.name, date: d, amount, createdByName: actor.name, createdAt: now } };
}

export async function voidPayout(actor: Actor, id: string): Promise<Result<object>> {
  const c = ctx(actor);
  if (!c) return fail("No autorizado.", 403);
  const [r] = (await getSql()`SELECT date FROM provider_payouts WHERE id = ${id} AND organization_id = ${c.orgId} AND status = 'active'`) as unknown as Row[];
  if (!r) return fail("Ese pago ya no existe.", 404);
  if (r.date !== realNowIso().slice(0, 10) && !c.isAdmin) return fail("Lo de días anteriores lo corrige el admin.", 403);
  await getSql()`UPDATE provider_payouts SET status = 'voided', voided_at = ${realNowIso()}, voided_by = ${actor.userId} WHERE id = ${id} AND organization_id = ${c.orgId}`;
  return { ok: true };
}
