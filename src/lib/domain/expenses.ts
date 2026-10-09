import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";

/**
 * Egresos de plata (Decles): luz, insumos, un retiro… Los anota el equipo (no la médica) y los ve
 * el admin y la secretaría. Lo de hoy lo corrige quien lo anotó; lo de días anteriores, el admin.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };

export type Direction = "egreso" | "ingreso";
const dirOf = (d: unknown): Direction => (d === "ingreso" ? "ingreso" : "egreso");

export interface Expense {
  id: string;
  /** "ingreso" = ingreso extra (cambio, varios…); "egreso" = gasto. */
  direction: Direction;
  concept: string;
  amount: number;
  createdByName: string;
  createdAt: string;
  updatedByName: string | null;
}

type Row = Record<string, unknown>;
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });
const toExpense = (r: Row): Expense => ({
  id: r.id as string,
  direction: dirOf(r.direction),
  concept: r.concept as string,
  amount: Number(r.amount),
  createdByName: r.created_by_name as string,
  createdAt: r.created_at as string,
  updatedByName: (r.updated_by_name as string | null) ?? null,
});
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function ctx(actor: Actor) {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente" || actor.role === "medico") return null;
  return { orgId, isAdmin: !!actor.activeOrg?.canAdmin };
}

function clean(v: { concept?: unknown; amount?: unknown }): { concept: string; amount: number } | string {
  const concept = String(v.concept ?? "").trim().replace(/\s+/g, " ");
  const amount = Number(v.amount);
  if (!concept) return "Falta el concepto.";
  if (concept.length > 120) return "El concepto es muy largo.";
  if (!Number.isInteger(amount) || amount <= 0) return "El importe tiene que ser un número entero de pesos.";
  if (amount > 1_000_000_000) return "Ese importe no parece correcto.";
  return { concept: concept.charAt(0).toUpperCase() + concept.slice(1), amount };
}

export async function listExpenses(actor: Actor, from?: string, to?: string, direction: Direction = "egreso"): Promise<Result<{ expenses: Expense[]; total: number }>> {
  const c = ctx(actor);
  if (!c) return { ok: true, expenses: [], total: 0 };
  const today = realNowIso().slice(0, 10);
  const f = from ?? today;
  const t = to ?? f;
  if (!YMD.test(f) || !YMD.test(t)) return fail("Fechas inválidas: usá AAAA-MM-DD.");
  const rows = (await getSql()`
    SELECT * FROM expenses
    WHERE organization_id = ${c.orgId} AND status = 'active' AND direction = ${direction} AND substr(created_at, 1, 10) BETWEEN ${f} AND ${t}
    ORDER BY created_at DESC, id DESC LIMIT 1000`) as unknown as Row[];
  const expenses = rows.map(toExpense);
  return { ok: true, expenses, total: expenses.reduce((n, e) => n + e.amount, 0) };
}

export async function createExpense(actor: Actor, v: { concept?: unknown; amount?: unknown; direction?: unknown }): Promise<Result<{ expense: Expense }>> {
  const c = ctx(actor);
  if (!c) return fail("Los egresos los anota la secretaría o el admin.", 403);
  const x = clean(v);
  if (typeof x === "string") return fail(x);
  const rows = (await getSql()`
    INSERT INTO expenses (id, organization_id, direction, concept, amount, created_by, created_by_name, created_at)
    VALUES (${`egr_${randomUUID().slice(0, 8)}`}, ${c.orgId}, ${dirOf(v.direction)}, ${x.concept}, ${x.amount}, ${actor.userId}, ${actor.name}, ${realNowIso()})
    RETURNING *`) as unknown as Row[];
  return { ok: true, expense: toExpense(rows[0]) };
}

async function editable(actor: Actor, id: string) {
  const c = ctx(actor);
  if (!c) return fail("No autorizado.", 403);
  const rows = (await getSql()`SELECT * FROM expenses WHERE id = ${id} AND organization_id = ${c.orgId} AND status = 'active'`) as unknown as Row[];
  if (!rows.length) return fail("Ese egreso ya no existe.", 404);
  if (!c.isAdmin && (rows[0].created_at as string).slice(0, 10) !== realNowIso().slice(0, 10))
    return fail("Lo de días anteriores lo corrige el admin.", 403);
  return { ok: true as const, orgId: c.orgId };
}

export async function updateExpense(actor: Actor, id: string, v: { concept?: unknown; amount?: unknown }): Promise<Result<{ expense: Expense }>> {
  const e = await editable(actor, id);
  if (!e.ok) return e;
  const x = clean(v);
  if (typeof x === "string") return fail(x);
  const rows = (await getSql()`
    UPDATE expenses SET concept = ${x.concept}, amount = ${x.amount}, updated_at = ${realNowIso()}, updated_by_name = ${actor.name}
    WHERE id = ${id} AND organization_id = ${e.orgId} RETURNING *`) as unknown as Row[];
  return { ok: true, expense: toExpense(rows[0]) };
}

export async function voidExpense(actor: Actor, id: string): Promise<Result<object>> {
  const e = await editable(actor, id);
  if (!e.ok) return e;
  await getSql()`UPDATE expenses SET status = 'voided', voided_at = ${realNowIso()}, voided_by = ${actor.userId} WHERE id = ${id} AND organization_id = ${e.orgId}`;
  return { ok: true };
}
