import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";
import { applyManualAmounts } from "@/lib/db/billing-repo";
import { applyCombos, share } from "@/lib/domain/combo-calc";

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
  /** Lo que se lleva la profesional por el combo (% de lo cobrado o monto fijo); null = lo de cada práctica. */
  cut: { pct: number | null; fixed: number | null } | null;
}

/** `{ pct }` o `{ fixed }` (null = lo de cada práctica). */
function cutOf(v: unknown): { pct: number | null; fixed: number | null } | null | string {
  if (v === null || v === undefined) return null;
  const c = v as { pct?: unknown; fixed?: unknown };
  if (c.fixed !== undefined && c.fixed !== null) {
    const n = Number(c.fixed);
    return Number.isInteger(n) && n >= 0 && n <= 100_000_000 ? { pct: null, fixed: n } : "El monto de la profesional tiene que ser un número entero de pesos.";
  }
  if (c.pct !== undefined && c.pct !== null) {
    const n = Number(c.pct);
    return n >= 0 && n <= 100 ? { pct: Math.round(n * 100) / 100, fixed: null } : "El % de la profesional va de 0 a 100.";
  }
  return null;
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
      cut:
        r.commission_fixed !== null && r.commission_fixed !== undefined
          ? { pct: null, fixed: Number(r.commission_fixed) }
          : r.commission_pct !== null && r.commission_pct !== undefined
            ? { pct: Number(r.commission_pct), fixed: null }
            : null,
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
  v: { name?: unknown; price?: unknown; cardPrice?: unknown; items?: unknown; cut?: unknown },
): Promise<Result<{ id: string }>> {
  const c = ctx(actor);
  if (!c?.isAdmin) return fail("Los combos los arma el admin.", 403);
  const name = clean(v.name).slice(0, 80);
  if (!name) return fail("Falta el nombre del combo.");
  if (!pesos(v.price)) return fail("El precio tiene que ser un número entero de pesos.");
  if (v.cardPrice !== undefined && v.cardPrice !== null && !pesos(v.cardPrice)) return fail("El precio con tarjeta tiene que ser un número entero de pesos.");
  const items = await checkItems(c.orgId, v.items);
  if (typeof items === "string") return fail(items);
  const cut = cutOf(v.cut);
  if (typeof cut === "string") return fail(cut);
  const sql = getSql();
  const dup = (await sql`SELECT 1 FROM combos WHERE organization_id = ${c.orgId} AND active AND lower(name) = lower(${name})`) as unknown as Row[];
  if (dup.length) return fail(`Ya hay un combo «${name}».`, 409);
  const id = `cmb_${randomUUID().slice(0, 8)}`;
  await sql`
    INSERT INTO combos (id, organization_id, name, amount, card_amount, commission_pct, commission_fixed, created_at)
    VALUES (${id}, ${c.orgId}, ${name}, ${v.price as number}, ${(v.cardPrice as number | null | undefined) ?? null},
      ${cut?.pct ?? null}, ${cut?.fixed ?? null}, ${realNowIso()})`;
  await saveItems(id, items);
  return { ok: true, id };
}

export async function updateCombo(
  actor: Actor,
  id: string,
  v: { name?: unknown; price?: unknown; cardPrice?: unknown; items?: unknown; active?: unknown; cut?: unknown },
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
  const cut = v.cut === undefined ? undefined : cutOf(v.cut);
  if (typeof cut === "string") return fail(cut);
  if (cut !== undefined) await sql`UPDATE combos SET commission_pct = ${cut?.pct ?? null}, commission_fixed = ${cut?.fixed ?? null} WHERE id = ${id} AND organization_id = ${c.orgId}`;
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

/**
 * Lo que se lleva la profesional en los combos con parte propia: reemplaza la de las unidades que entraron en el combo
 * (las que sobran conservan la suya). No toca renglones con la parte escrita a mano ni a la dueña.
 * `saleIds[i]` es la venta de `lines[i]`.
 */
export async function applyComboCuts(
  orgId: string,
  raw: unknown,
  lines: { itemId?: string; quantity?: number; commission?: number | null }[],
  saleIds: string[],
  owner: boolean,
): Promise<void> {
  if (owner || !Array.isArray(raw) || !raw.length) return;
  const ids = (raw as { id?: unknown }[]).map((x) => x?.id).filter((x): x is string => typeof x === "string");
  if (!ids.length) return;
  const sql = getSql();
  const rows = (await sql`SELECT id, name, amount, card_amount, commission_pct, commission_fixed FROM combos WHERE organization_id = ${orgId} AND id = ANY(${ids})`) as unknown as Row[];
  if (!rows.some((r) => r.commission_pct !== null || r.commission_fixed !== null)) return;
  const its = (await sql`SELECT combo_id, item_id, quantity FROM combo_items WHERE combo_id = ANY(${ids})`) as unknown as Row[];
  const sales = (await sql`SELECT id, quantity, total, commission_amount FROM sales WHERE organization_id = ${orgId} AND id = ANY(${saleIds})`) as unknown as Row[];
  const sale = saleIds.map((id) => sales.find((s) => s.id === id));
  if (sale.some((s) => !s)) return;
  const r = applyCombos(
    lines.map((l, i) => ({ itemId: l.itemId ?? null, qty: Number(sale[i]!.quantity), cash: Number(sale[i]!.total), card: Number(sale[i]!.total) })),
    rows.map((c) => ({
      id: c.id as string,
      name: c.name as string,
      price: Number(c.amount),
      cardPrice: c.card_amount === null ? null : Number(c.card_amount),
      items: its.filter((x) => x.combo_id === c.id).map((x) => ({ itemId: x.item_id as string, qty: Number(x.quantity) })),
    })),
  );
  const extra = new Map<number, number>();
  const used = new Map<number, number>();
  for (const u of r.uses) {
    const c = rows.find((x) => x.id === u.id)!;
    if (c.commission_pct === null && c.commission_fixed === null) continue;
    // Lo cobrado por esas unidades (el renglón ya viene con el precio del combo repartido).
    const part = u.take.map((t) => (Number(sale[t.i]!.total) * t.n) / Number(sale[t.i]!.quantity));
    const base = Math.round(part.reduce((a, b) => a + b, 0));
    const total = c.commission_fixed !== null ? Number(c.commission_fixed) : Math.round((base * Number(c.commission_pct)) / 100);
    share(total, part).forEach((x, k) => {
      const i = u.take[k].i;
      extra.set(i, (extra.get(i) ?? 0) + x);
      used.set(i, (used.get(i) ?? 0) + u.take[k].n);
    });
  }
  for (const [i, x] of extra) {
    if (lines[i].commission !== undefined && lines[i].commission !== null) continue;
    const qty = Number(sale[i]!.quantity);
    const rest = Math.round((Number(sale[i]!.commission_amount) * (qty - (used.get(i) ?? 0))) / qty);
    await applyManualAmounts(orgId, saleIds[i], { commission: x + rest });
  }
}
