import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";

/**
 * Combos / promos (Decles, migración 0036): varias prácticas y/o productos a un precio especial. Los arma el admin en
 * Stock → Combos; al anotar se aplican solos (`combo-calc.ts`) y la atención guarda cuál se aplicó (`visit_combos`).
 * Las prácticas de un combo tienen que poder hacerlas una misma profesional.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });
type Row = Record<string, unknown>;

export interface Combo {
  id: string;
  name: string;
  price: number;
  cardPrice: number | null;
  active: boolean;
  items: { itemId: string; qty: number; name: string; kind: string }[];
}

const clean = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");

function ctx(actor: Actor) {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente") return null;
  return { orgId, isAdmin: !!actor.activeOrg?.canAdmin };
}

export async function listCombos(actor: Actor): Promise<Result<{ combos: Combo[] }>> {
  const c = ctx(actor);
  if (!c) return { ok: true, combos: [] };
  const sql = getSql();
  const rows = (await sql`SELECT * FROM combos WHERE organization_id = ${c.orgId} ORDER BY active DESC, name`) as unknown as Row[];
  const items = (await sql`
    SELECT ci.combo_id, ci.item_id, ci.quantity, p.name, p.kind FROM combo_items ci
    JOIN combos k ON k.id = ci.combo_id JOIN price_list_items p ON p.id = ci.item_id
    WHERE k.organization_id = ${c.orgId} ORDER BY p.name`) as unknown as Row[];
  return {
    ok: true,
    combos: rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      price: Number(r.amount),
      cardPrice: r.card_amount === null ? null : Number(r.card_amount),
      active: !!r.active,
      items: items
        .filter((i) => i.combo_id === r.id)
        .map((i) => ({ itemId: i.item_id as string, qty: Number(i.quantity), name: i.name as string, kind: i.kind as string })),
    })),
  };
}

const pesos = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000_000;

/** Valida los componentes: existen, están activos, son al menos 2 cosas y las prácticas las hace una misma profesional. */
async function checkItems(orgId: string, raw: unknown): Promise<{ itemId: string; qty: number }[] | string> {
  if (!Array.isArray(raw)) return "Elegí qué lleva el combo.";
  const byId = new Map<string, number>();
  for (const x of raw as { itemId?: unknown; qty?: unknown }[]) {
    const id = typeof x?.itemId === "string" ? x.itemId : "";
    const q = Number(x?.qty ?? 1);
    if (!id || !Number.isInteger(q) || q < 1 || q > 99) return "Cantidad inválida.";
    byId.set(id, (byId.get(id) ?? 0) + q);
  }
  const items = [...byId].map(([itemId, qty]) => ({ itemId, qty }));
  if (items.reduce((n, i) => n + i.qty, 0) < 2) return "Un combo lleva al menos dos cosas.";
  const sql = getSql();
  const ids = items.map((i) => i.itemId);
  const found = (await sql`SELECT id, kind, name FROM price_list_items WHERE organization_id = ${orgId} AND active AND id = ANY(${ids})`) as unknown as Row[];
  if (found.length !== ids.length) return "Algo de lo elegido ya no está en la lista.";
  const practices = found.filter((f) => f.kind !== "producto").map((f) => f.id as string);
  if (practices.length > 1) {
    const provs = (await sql`SELECT item_id, provider_id FROM price_item_providers WHERE organization_id = ${orgId} AND item_id = ANY(${practices})`) as unknown as Row[];
    // Profesionales que pueden hacer todas (una práctica sin profesionales cargadas la hace cualquiera).
    const lists = practices.map((id) => provs.filter((p) => p.item_id === id).map((p) => p.provider_id as string)).filter((l) => l.length);
    const common = lists.length ? lists.reduce((acc, l) => acc.filter((p) => l.includes(p))) : null;
    if (common && !common.length) return "Las prácticas de un combo tienen que ser de una misma profesional.";
  }
  return items;
}

async function saveItems(comboId: string, items: { itemId: string; qty: number }[]) {
  const sql = getSql();
  await sql`DELETE FROM combo_items WHERE combo_id = ${comboId}`;
  for (const i of items) await sql`INSERT INTO combo_items (combo_id, item_id, quantity) VALUES (${comboId}, ${i.itemId}, ${i.qty})`;
}

export async function createCombo(
  actor: Actor,
  v: { name?: unknown; price?: unknown; cardPrice?: unknown; items?: unknown },
): Promise<Result<{ id: string }>> {
  const c = ctx(actor);
  if (!c?.isAdmin) return fail("Los combos los arma el admin.", 403);
  const name = clean(v.name).slice(0, 80);
  if (!name) return fail("Falta el nombre del combo.");
  if (!pesos(v.price)) return fail("El precio tiene que ser un número entero de pesos.");
  if (v.cardPrice !== undefined && v.cardPrice !== null && !pesos(v.cardPrice)) return fail("El precio con tarjeta tiene que ser un número entero de pesos.");
  const items = await checkItems(c.orgId, v.items);
  if (typeof items === "string") return fail(items);
  const sql = getSql();
  const dup = (await sql`SELECT 1 FROM combos WHERE organization_id = ${c.orgId} AND active AND lower(name) = lower(${name})`) as unknown as Row[];
  if (dup.length) return fail(`Ya hay un combo «${name}».`, 409);
  const id = `cmb_${randomUUID().slice(0, 8)}`;
  await sql`
    INSERT INTO combos (id, organization_id, name, amount, card_amount, created_at)
    VALUES (${id}, ${c.orgId}, ${name}, ${v.price as number}, ${(v.cardPrice as number | null | undefined) ?? null}, ${realNowIso()})`;
  await saveItems(id, items);
  return { ok: true, id };
}

export async function updateCombo(
  actor: Actor,
  id: string,
  v: { name?: unknown; price?: unknown; cardPrice?: unknown; items?: unknown; active?: unknown },
): Promise<Result<{ id: string }>> {
  const c = ctx(actor);
  if (!c?.isAdmin) return fail("Los combos los arma el admin.", 403);
  const sql = getSql();
  const cur = (await sql`SELECT * FROM combos WHERE id = ${id} AND organization_id = ${c.orgId}`) as unknown as Row[];
  if (!cur.length) return fail("Ese combo no existe.", 404);
  const name = v.name === undefined ? (cur[0].name as string) : clean(v.name).slice(0, 80);
  if (!name) return fail("Falta el nombre del combo.");
  if (v.price !== undefined && !pesos(v.price)) return fail("El precio tiene que ser un número entero de pesos.");
  if (v.cardPrice !== undefined && v.cardPrice !== null && !pesos(v.cardPrice)) return fail("El precio con tarjeta tiene que ser un número entero de pesos.");
  const active = v.active === undefined ? !!cur[0].active : !!v.active;
  if (active) {
    const dup = (await sql`SELECT 1 FROM combos WHERE organization_id = ${c.orgId} AND active AND id <> ${id} AND lower(name) = lower(${name})`) as unknown as Row[];
    if (dup.length) return fail(`Ya hay un combo «${name}».`, 409);
  }
  if (v.items !== undefined) {
    const items = await checkItems(c.orgId, v.items);
    if (typeof items === "string") return fail(items);
    await saveItems(id, items);
  }
  await sql`
    UPDATE combos SET name = ${name}, active = ${active},
      amount = ${v.price === undefined ? Number(cur[0].amount) : (v.price as number)},
      card_amount = ${v.cardPrice === undefined ? (cur[0].card_amount as number | null) : (v.cardPrice as number | null)}
    WHERE id = ${id} AND organization_id = ${c.orgId}`;
  return { ok: true, id };
}

/** Qué combos se aplicaron en la atención (ids del consultorio, activos o no). */
export async function recordVisitCombos(orgId: string, visitId: string, raw: unknown): Promise<void> {
  if (!Array.isArray(raw) || !raw.length) return;
  const sql = getSql();
  for (const x of raw as { id?: unknown; times?: unknown }[]) {
    const id = typeof x?.id === "string" ? x.id : "";
    const times = Number.isInteger(x?.times) && (x.times as number) > 0 ? (x.times as number) : 1;
    if (!id) continue;
    await sql`
      INSERT INTO visit_combos (organization_id, visit_id, combo_id, times, created_at)
      SELECT ${orgId}, ${visitId}, id, ${times}, ${realNowIso()} FROM combos WHERE id = ${id} AND organization_id = ${orgId}
      ON CONFLICT DO NOTHING`;
  }
}

/** Al editar: sin decir nada, la atención conserva sus combos; con lista, ya se anotaron de nuevo. */
export async function relinkVisitCombos(orgId: string, oldVisitId: string, newVisitId: string): Promise<void> {
  await getSql()`UPDATE visit_combos SET visit_id = ${newVisitId} WHERE organization_id = ${orgId} AND visit_id = ${oldVisitId}`;
}
export async function dropVisitCombos(orgId: string, visitId: string): Promise<void> {
  await getSql()`DELETE FROM visit_combos WHERE organization_id = ${orgId} AND visit_id = ${visitId}`;
}

/** Atenciones de un día con combo: visit_id → «Promo A + B». */
export async function comboVisitsOn(actor: Actor, date: string): Promise<{ visitId: string; comboId: string; name: string; times: number }[]> {
  const c = ctx(actor);
  if (!c) return [];
  const rows = (await getSql()`
    SELECT v.visit_id, v.combo_id, v.times, k.name FROM visit_combos v JOIN combos k ON k.id = v.combo_id
    WHERE v.organization_id = ${c.orgId} AND EXISTS (
      SELECT 1 FROM sales s WHERE s.organization_id = v.organization_id AND s.visit_id = v.visit_id AND s.status = 'paid' AND substr(s.created_at, 1, 10) = ${date})`) as unknown as Row[];
  return rows.map((r) => ({ visitId: r.visit_id as string, comboId: r.combo_id as string, name: r.name as string, times: Number(r.times) }));
}
