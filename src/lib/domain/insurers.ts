import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";

/**
 * Obras sociales y prepagas (Decles), ej. OSMECON: la paciente se atiende por la prepaga, a la caja no entra nada y la
 * profesional que la atendió se lleva el valor de cada práctica (`fees`, o el general `fee`; lo paga el consultorio como el resto de su parte).
 * Las prácticas de esa atención van a $0; los productos se cobran igual. El monto queda congelado en la atención.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });
type Row = Record<string, unknown>;

export interface Insurer {
  id: string;
  name: string;
  /** Lo que se lleva la profesional por cada práctica que no tenga valor propio (y por una «Atención» sin práctica). */
  fee: number;
  /** Valor por práctica: item_id → monto. */
  fees: Record<string, number>;
  active: boolean;
}

const toInsurer = (r: Row, fees: Record<string, number> = {}): Insurer => ({ id: r.id as string, name: r.name as string, fee: Number(r.provider_fee), fees, active: !!r.active });

/** Lo que se lleva la profesional por esa práctica (sin práctica / no cargada: el valor general). */
export const feeFor = (i: Insurer, itemId?: string | null) => (itemId && i.fees[itemId] !== undefined ? i.fees[itemId] : i.fee);

async function feesOf(orgId: string, ids: string[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  if (!ids.length) return out;
  const rows = (await getSql()`SELECT insurer_id, item_id, fee FROM insurer_practice_fees WHERE organization_id = ${orgId} AND insurer_id = ANY(${ids})`) as unknown as Row[];
  for (const r of rows) {
    const m = out.get(r.insurer_id as string) ?? {};
    m[r.item_id as string] = Number(r.fee);
    out.set(r.insurer_id as string, m);
  }
  return out;
}
const clean = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");

function ctx(actor: Actor) {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente") return null;
  return { orgId, isAdmin: !!actor.activeOrg?.canAdmin };
}

export async function listInsurers(actor: Actor): Promise<Result<{ insurers: Insurer[] }>> {
  const c = ctx(actor);
  if (!c) return { ok: true, insurers: [] };
  const rows = (await getSql()`SELECT * FROM insurers WHERE organization_id = ${c.orgId} ORDER BY active DESC, name`) as unknown as Row[];
  const fees = await feesOf(c.orgId, rows.map((r) => r.id as string));
  return { ok: true, insurers: rows.map((r) => toInsurer(r, fees.get(r.id as string))) };
}

function feeOf(v: unknown): number | string {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100_000_000) return "El monto tiene que ser un número entero de pesos.";
  return n;
}

export async function createInsurer(actor: Actor, v: { name?: unknown; fee?: unknown }): Promise<Result<{ insurer: Insurer }>> {
  const c = ctx(actor);
  if (!c?.isAdmin) return fail("Las obras sociales las carga el admin.", 403);
  const name = clean(v.name).slice(0, 60);
  if (!name) return fail("Falta el nombre.");
  const fee = feeOf(v.fee ?? 0);
  if (typeof fee === "string") return fail(fee);
  const dup = (await getSql()`SELECT 1 FROM insurers WHERE organization_id = ${c.orgId} AND lower(name) = lower(${name})`) as unknown as Row[];
  if (dup.length) return fail(`${name} ya está cargada.`, 409);
  const rows = (await getSql()`
    INSERT INTO insurers (id, organization_id, name, provider_fee, created_at)
    VALUES (${`ins_${randomUUID().slice(0, 8)}`}, ${c.orgId}, ${name}, ${fee}, ${realNowIso()}) RETURNING *`) as unknown as Row[];
  return { ok: true, insurer: toInsurer(rows[0]) };
}

/**
 * Cambiar el monto general, el nombre, darla de baja o el valor de una práctica (`practice: { itemId, fee }`, fee null
 * = vuelve al general). Lo ya anotado no cambia (el monto quedó congelado).
 */
export async function updateInsurer(
  actor: Actor,
  id: string,
  v: { name?: unknown; fee?: unknown; active?: unknown; practice?: { itemId?: unknown; fee?: unknown } },
): Promise<Result<{ insurer: Insurer }>> {
  const c = ctx(actor);
  if (!c?.isAdmin) return fail("Las obras sociales las carga el admin.", 403);
  if (v.practice) {
    const itemId = typeof v.practice.itemId === "string" ? v.practice.itemId : "";
    const [own] = (await getSql()`SELECT 1 FROM insurers WHERE id = ${id} AND organization_id = ${c.orgId}`) as unknown as Row[];
    if (!own) return fail("No existe.", 404);
    const [item] = (await getSql()`SELECT kind FROM price_list_items WHERE id = ${itemId} AND organization_id = ${c.orgId}`) as unknown as Row[];
    if (!item || item.kind === "producto") return fail("Esa práctica no está en la lista de precios.");
    if (v.practice.fee === null || v.practice.fee === undefined) {
      await getSql()`DELETE FROM insurer_practice_fees WHERE insurer_id = ${id} AND item_id = ${itemId}`;
    } else {
      const pf = feeOf(v.practice.fee);
      if (typeof pf === "string") return fail(pf);
      await getSql()`
        INSERT INTO insurer_practice_fees (organization_id, insurer_id, item_id, fee) VALUES (${c.orgId}, ${id}, ${itemId}, ${pf})
        ON CONFLICT (insurer_id, item_id) DO UPDATE SET fee = EXCLUDED.fee`;
    }
  }
  const name = v.name === undefined ? null : clean(v.name).slice(0, 60);
  if (name === "") return fail("Falta el nombre.");
  const fee = v.fee === undefined ? null : feeOf(v.fee);
  if (typeof fee === "string") return fail(fee);
  const active = v.active === undefined ? null : !!v.active;
  const rows = (await getSql()`
    UPDATE insurers SET name = COALESCE(${name}, name), provider_fee = COALESCE(${fee}::int, provider_fee), active = COALESCE(${active}::boolean, active)
    WHERE id = ${id} AND organization_id = ${c.orgId} RETURNING *`) as unknown as Row[];
  if (!rows.length) return fail("No existe.", 404);
  return { ok: true, insurer: toInsurer(rows[0], (await feesOf(c.orgId, [id])).get(id)) };
}

/** Para `recordVisit`. */
export async function insurerForVisit(orgId: string, id: string): Promise<Result<{ insurer: Insurer }>> {
  const [r] = (await getSql()`SELECT * FROM insurers WHERE id = ${id} AND organization_id = ${orgId}`) as unknown as Row[];
  if (!r || !r.active) return fail("Esa obra social ya no está disponible.", 404);
  return { ok: true, insurer: toInsurer(r, (await feesOf(orgId, [id])).get(id)) };
}

export async function recordInsurerVisit(orgId: string, visitId: string, insurer: Insurer, fee: number): Promise<void> {
  await getSql()`
    INSERT INTO insurer_visits (organization_id, visit_id, insurer_id, fee, created_at)
    VALUES (${orgId}, ${visitId}, ${insurer.id}, ${fee}, ${realNowIso()}) ON CONFLICT DO NOTHING`;
}

/** Al editar: sin decir nada, la atención sigue siendo de la obra social; con null, deja de serlo. */
export async function relinkInsurerVisit(orgId: string, oldVisitId: string, newVisitId: string): Promise<void> {
  await getSql()`UPDATE insurer_visits SET visit_id = ${newVisitId} WHERE organization_id = ${orgId} AND visit_id = ${oldVisitId}`;
}
export async function dropInsurerVisit(orgId: string, visitId: string): Promise<void> {
  await getSql()`DELETE FROM insurer_visits WHERE organization_id = ${orgId} AND visit_id = ${visitId}`;
}

/** Atenciones de un día que fueron por obra social: visit_id → obra social. */
export async function insurerVisitsOn(actor: Actor, date: string): Promise<{ visitId: string; insurerId: string; name: string; fee: number }[]> {
  const c = ctx(actor);
  if (!c) return [];
  const rows = (await getSql()`
    SELECT v.visit_id, v.insurer_id, v.fee, i.name FROM insurer_visits v JOIN insurers i ON i.id = v.insurer_id
    WHERE v.organization_id = ${c.orgId} AND EXISTS (
      SELECT 1 FROM sales s WHERE s.organization_id = v.organization_id AND s.visit_id = v.visit_id AND s.status = 'paid' AND substr(s.created_at, 1, 10) = ${date})`) as unknown as Row[];
  return rows.map((r) => ({ visitId: r.visit_id as string, insurerId: r.insurer_id as string, name: r.name as string, fee: Number(r.fee) }));
}
