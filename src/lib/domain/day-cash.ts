import { getSql } from "@/lib/db/connection";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";

/**
 * Caja del día (Decles), un registro por día:
 *  · opening: el cambio que había al iniciar (se le pregunta a la secretaria al entrar);
 *  · amount: «Dinero en caja al momento del cambio» (lo contado).
 * Lo cargan secretaría y admin; días anteriores, solo el admin.
 */
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });

export interface DayCash {
  date: string;
  opening: number | null;
  amount: number | null;
  updatedByName: string | null;
}

const orgOf = (actor: Actor) => (actor.activeOrg && actor.role !== "medico" && actor.role !== "paciente" ? actor.activeOrg.id : null);
const empty = (date: string): DayCash => ({ date, opening: null, amount: null, updatedByName: null });

export async function getDayCash(actor: Actor, date?: string): Promise<Result<{ cash: DayCash }>> {
  const orgId = orgOf(actor);
  const d = date ?? realNowIso().slice(0, 10);
  if (!YMD.test(d)) return fail("Fecha inválida.");
  if (!orgId) return { ok: true, cash: empty(d) };
  const [r] = (await getSql()`SELECT opening, amount, updated_by_name FROM day_cash WHERE organization_id = ${orgId} AND date = ${d}`) as unknown as Record<string, unknown>[];
  if (!r) return { ok: true, cash: empty(d) };
  return {
    ok: true,
    cash: {
      date: d,
      opening: r.opening === null ? null : Number(r.opening),
      amount: r.amount === null ? null : Number(r.amount),
      updatedByName: (r.updated_by_name as string) ?? null,
    },
  };
}

const pesos = (v: unknown): number | null | string => {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000_000 ? n : "El importe tiene que ser un número entero de pesos.";
};

/** Carga `opening` y/o `amount` (null = borrar ese dato; ausente = no se toca). */
export async function setDayCash(actor: Actor, date: string | undefined, v: { opening?: unknown; amount?: unknown }): Promise<Result<{ cash: DayCash }>> {
  const orgId = orgOf(actor);
  if (!orgId) return fail("No autorizado.", 403);
  const today = realNowIso().slice(0, 10);
  const d = date ?? today;
  if (!YMD.test(d)) return fail("Fecha inválida.");
  if (d !== today && !actor.activeOrg?.canAdmin) return fail("Lo de días anteriores lo corrige el admin.", 403);
  const cur = (await getDayCash(actor, d)) as { ok: true; cash: DayCash };
  const opening = v.opening === undefined ? cur.cash.opening : pesos(v.opening);
  const amount = v.amount === undefined ? cur.cash.amount : pesos(v.amount);
  if (typeof opening === "string") return fail(opening);
  if (typeof amount === "string") return fail(amount);
  await getSql()`
    INSERT INTO day_cash (organization_id, date, opening, amount, updated_by_name, updated_at)
    VALUES (${orgId}, ${d}, ${opening}, ${amount}, ${actor.name}, ${realNowIso()})
    ON CONFLICT (organization_id, date) DO UPDATE
      SET opening = EXCLUDED.opening, amount = EXCLUDED.amount, updated_by_name = EXCLUDED.updated_by_name, updated_at = EXCLUDED.updated_at`;
  return { ok: true, cash: { date: d, opening, amount, updatedByName: actor.name } };
}
