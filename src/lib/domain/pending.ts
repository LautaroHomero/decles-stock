import { getPriceItem, listPendingSales, listPriceItems, resolvePendingSale, type PriceItem, type Sale } from "@/lib/db/billing-repo";
import { addOwed, consumeStockFefo } from "@/lib/db/stock-repo";
import { getProvider } from "@/lib/db/repo";
import { createPractice, createProduct } from "@/lib/domain/products";
import { commissionFor } from "@/lib/domain/billing";
import type { Actor } from "@/lib/domain/types";

/**
 * Pendientes (Decles): lo que se anotó con un nombre que no estaba en la lista de precios
 * («radiofrecuencia»). El admin lo resuelve: lo vincula a un ítem existente o lo crea con
 * precio. Ahí la venta toma precio y comisión (con el % actual de la médica) y, si es un
 * producto, descuenta stock (o queda debiendo si no hay cargado).
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400): { ok: false; error: string; status: number } => ({ ok: false, error, status });

export async function listPending(actor: Actor): Promise<Result<{ pending: Sale[] }>> {
  if (!actor.activeOrg?.canAdmin) return fail("Solo el admin resuelve lo pendiente.", 403);
  return { ok: true, pending: await listPendingSales(actor.activeOrg.id) };
}

export async function resolvePending(
  actor: Actor,
  saleId: string,
  v: { itemId?: string; create?: { kind: "tratamiento" | "producto"; name: string; price: number; cardPrice?: number | null } },
): Promise<Result<{ item: string }>> {
  if (!actor.activeOrg?.canAdmin) return fail("Solo el admin resuelve lo pendiente.", 403);
  const orgId = actor.activeOrg.id;
  const sale = (await listPendingSales(orgId)).find((s) => s.id === saleId);
  if (!sale) return fail("Eso ya no está pendiente.", 404);

  let itemId = v.itemId;
  if (!itemId && v.create) {
    const c = v.create;
    if (c.kind === "tratamiento") {
      const r = await createPractice(actor, { name: c.name, price: c.price, cardPrice: c.cardPrice ?? null });
      if (!r.ok) return r;
      itemId = r.itemId;
    } else {
      const r = await createProduct(actor, { name: c.name, price: c.price, cardPrice: c.cardPrice ?? null });
      if (!r.ok) return r;
      itemId = r.priceItemId;
    }
  }
  if (!itemId) return fail("Elegí qué es o crealo.");
  const item = await getPriceItem(orgId, itemId);
  if (!item || !item.active) return fail("Ese ítem no está en la lista de precios.", 404);
  if (!(await resolveWith(actor, orgId, sale, item))) return fail("Eso ya no está pendiente.", 409);
  return { ok: true, item: item.name };
}

/** Vincula un pendiente a `item`: toma la parte de la profesional de ese ítem y, si es producto, descuenta stock. */
async function resolveWith(actor: Actor, orgId: string, sale: Sale, item: PriceItem): Promise<boolean> {
  const prov = sale.providerId ? await getProvider(sale.providerId) : undefined;
  const cut = await commissionFor(orgId, item, prov);
  if (!(await resolvePendingSale(orgId, sale.id, { item, commissionPct: cut.pct, commissionFixed: cut.fixed }))) return false;
  if (item.stockItemId) {
    const who = { id: actor.userId, name: actor.name, source: "manual" as const };
    const r = await consumeStockFefo(orgId, { itemId: item.stockItemId, quantity: sale.quantity, reason: "uso", note: `Venta de ${item.name}`, saleId: sale.id }, who);
    if (r.shortfall > 0) await addOwed(orgId, { itemId: item.stockItemId, quantity: r.shortfall, saleId: sale.id, note: `Venta de ${item.name} sin stock cargado` }, who);
  }
  return true;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * Al cargar o editar algo en la lista de precios: los pendientes que se anotaron con ese mismo nombre
 * («glicolico» → «Glicólico») se resuelven solos, con su precio escrito y la parte de la profesional de ese ítem.
 * Así el cierre (lo que se le debe a cada una) queda al día sin pasar por Pendientes. Devuelve cuántos resolvió.
 */
export async function resolvePendingByName(actor: Actor): Promise<number> {
  if (!actor.activeOrg?.canAdmin) return 0;
  const orgId = actor.activeOrg.id;
  const pending = await listPendingSales(orgId);
  if (!pending.length) return 0;
  const byName = new Map<string, PriceItem>();
  for (const i of await listPriceItems(orgId)) if (i.active) byName.set(norm(i.name), i);
  let n = 0;
  for (const s of pending) {
    const item = byName.get(norm(s.itemName));
    if (item && (await resolveWith(actor, orgId, s, item))) n++;
  }
  return n;
}
