import { getSql } from "@/lib/db/connection";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";

/** «Dinero en caja al momento del cambio» (Decles): un número por día. Lo cargan secretaría y admin. */
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });

export interface DayCash {
  date: string;
  amount: number | null;
  updatedByName: string | null;
}

const orgOf = (actor: Actor) => (actor.activeOrg && actor.role !== "medico" && actor.role !== "paciente" ? actor.activeOrg.id : null);

export async function getDayCash(actor: Actor, date?: string): Promise<Result<{ cash: DayCash }>> {
  const orgId = orgOf(actor);
  const d = date ?? realNowIso().slice(0, 10);
  if (!YMD.test(d)) return fail("Fecha inválida.");
  if (!orgId) return { ok: true, cash: { date: d, amount: null, updatedByName: null } };
  const [r] = (await getSql()`SELECT amount, updated_by_name FROM day_cash WHERE organization_id = ${orgId} AND date = ${d}`) as unknown as Record<string, unknown>[];
  return { ok: true, cash: { date: d, amount: r ? Number(r.amount) : null, updatedByName: r ? (r.updated_by_name as string) : null } };
}

/** `amount: null` borra el dato. Días anteriores: solo el admin. */
export async function setDayCash(actor: Actor, date: string | undefined, amount: unknown): Promise<Result<{ cash: DayCash }>> {
  const orgId = orgOf(actor);
  if (!orgId) return fail("No autorizado.", 403);
  const today = realNowIso().slice(0, 10);
  const d = date ?? today;
  if (!YMD.test(d)) return fail("Fecha inválida.");
  if (d !== today && !actor.activeOrg?.canAdmin) return fail("Lo de días anteriores lo corrige el admin.", 403);
  if (amount === null || amount === "") {
    await getSql()`DELETE FROM day_cash WHERE organization_id = ${orgId} AND date = ${d}`;
    return { ok: true, cash: { date: d, amount: null, updatedByName: null } };
  }
  const n = Number(amount);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) return fail("El importe tiene que ser un número entero de pesos.");
  await getSql()`
    INSERT INTO day_cash (organization_id, date, amount, updated_by_name, updated_at)
    VALUES (${orgId}, ${d}, ${n}, ${actor.name}, ${realNowIso()})
    ON CONFLICT (organization_id, date) DO UPDATE SET amount = EXCLUDED.amount, updated_by_name = EXCLUDED.updated_by_name, updated_at = EXCLUDED.updated_at`;
  return { ok: true, cash: { date: d, amount: n, updatedByName: actor.name } };
}
