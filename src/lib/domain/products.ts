import { createPrice, listPrices, updatePrice, canEditPrices } from "@/lib/domain/billing";
import { addStock, createItem, editItem, stockOverview, canManageStock, type StockItem } from "@/lib/domain/stock";
import { getStockItem } from "@/lib/db/stock-repo";
import { listItemProviders, setItemProviders } from "@/lib/db/billing-repo";
import { getProvider } from "@/lib/db/repo";
import type { Actor } from "@/lib/domain/types";

/**
 * "Producto vendible" = un `stock_item` + su `price_list_item` (kind producto) vinculado.
 * En Clavdia son dos pantallas (Stock y Precios); acá el admin los maneja como una sola
 * cosa. No hay tablas nuevas: solo orquesta `domain/stock.ts` y `domain/billing.ts`, así
 * que al integrar esto es opcional (o pasa tal cual como atajo de la vista Stock).
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400): { ok: false; error: string; status: number } => ({ ok: false, error, status });

export interface CatalogProduct {
  stockItemId: string;
  priceItemId: string | null;
  /** Profesionales que lo venden (vacío = cualquiera). */
  providerIds: string[];
  name: string;
  unit: string;
  category: string;
  /** Precio efectivo / transferencia (ARS enteros); null = sin precio, no se puede vender. */
  price: number | null;
  /** Precio con tarjeta; null = igual al de efectivo. */
  cardPrice: number | null;
  available: number;
  minQuantity: number;
  low: boolean;
  nextExpiry: string | null;
  /** Vencimientos vigentes con stock, para elegir "de cuál vendí". */
  expiries: { expiresOn: string; quantity: number }[];
  expiredQuantity: number;
  /** Vendido sin stock cargado (se compensa con el próximo ingreso). */
  owed: number;
  lots: StockItem["lots"];
}

/** Práctica (Decles): lo que la médica hace en la consulta. price_list_item kind 'tratamiento', sin stock. */
export interface CatalogPractice {
  id: string;
  name: string;
  price: number;
  cardPrice: number | null;
  /** Profesionales que la hacen (vacío = cualquiera). */
  providerIds: string[];
}

export async function catalog(actor: Actor): Promise<
  Result<{
    products: CatalogProduct[];
    practices: CatalogPractice[];
    alerts: { expiringSoon: number; expired: number; low: number };
    expiryDays: number;
    canAdmin: boolean;
  }>
> {
  const [ov, prices] = await Promise.all([stockOverview(actor), listPrices(actor)]);
  if (!ov.ok) return ov;
  if (!prices.ok) return prices;
  const links = await listItemProviders(actor.activeOrg!.id);
  const byStock = new Map(
    prices.items.filter((p) => p.kind === "producto" && p.stockItemId && p.active).map((p) => [p.stockItemId!, p]),
  );
  const products = ov.overview.items.map((i): CatalogProduct => {
    const price = byStock.get(i.id);
    const exp = new Map<string, number>();
    for (const l of i.lots) if (!l.expired && l.expiresOn) exp.set(l.expiresOn, (exp.get(l.expiresOn) ?? 0) + l.quantity);
    return {
      stockItemId: i.id,
      priceItemId: price?.id ?? null,
      providerIds: price ? (links.get(price.id) ?? []) : [],
      name: i.name,
      unit: i.unit,
      category: i.category,
      price: price ? price.amount : null,
      cardPrice: price ? price.cardAmount : null,
      available: i.available,
      minQuantity: i.minQuantity,
      low: i.low,
      nextExpiry: i.nextExpiry,
      expiries: [...exp.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([expiresOn, quantity]) => ({ expiresOn, quantity })),
      expiredQuantity: i.expiredQuantity,
      owed: i.owed,
      lots: i.lots,
    };
  });
  const practices = prices.items
    .filter((p) => p.kind === "tratamiento" && p.active)
    .map((p) => ({ id: p.id, name: p.name, price: p.amount, cardPrice: p.cardAmount, providerIds: links.get(p.id) ?? [] }));
  return {
    ok: true,
    products,
    practices,
    alerts: {
      expiringSoon: ov.overview.expiringSoon.length,
      expired: ov.overview.expired.length,
      low: ov.overview.low.length,
    },
    expiryDays: ov.overview.settings.expiryDays,
    canAdmin: !!actor.activeOrg?.canAdmin,
  };
}

async function adminGate(actor: Actor): Promise<Result<object>> {
  if (!(await canManageStock(actor)) || !(await canEditPrices(actor)))
    return fail("Solo un administrador puede cargar productos y precios.", 403);
  return { ok: true };
}

/** Alta de producto con su precio y, opcionalmente, el primer lote. */
export async function createProduct(
  actor: Actor,
  v: {
    name: string;
    price: number;
    cardPrice?: number | null;
    unit?: string;
    category?: string;
    minQuantity?: number;
    quantity?: number;
    expiresOn?: string | null;
    lotCode?: string;
    /** Quién lo vende (vacío = cualquiera). */
    providerIds?: string[];
  },
): Promise<Result<{ stockItemId: string; priceItemId: string; lotError?: string }>> {
  const g = await adminGate(actor);
  if (!g.ok) return g;
  if (typeof v.price !== "number" || !Number.isInteger(v.price) || v.price < 0)
    return fail("El precio tiene que ser un número entero de pesos, 0 o más.");
  const item = await createItem(actor, { name: v.name, unit: v.unit, category: v.category, minQuantity: v.minQuantity });
  if (!item.ok) return item;
  const price = await createPrice(actor, { kind: "producto", name: v.name, amount: v.price, cardAmount: v.cardPrice ?? null, stockItemId: item.itemId });
  if (!price.ok) {
    // Sin precio el producto no se puede vender: se deshace el alta para no dejarlo a medias.
    await editItem(actor, item.itemId, { active: false });
    return price;
  }
  if (v.providerIds?.length) {
    const l = await setItemLinks(actor, price.itemId, v.providerIds);
    if (!l.ok) return { ...l, error: `Producto creado, pero no se pudieron vincular los profesionales: ${l.error}` };
  }
  let lotError: string | undefined;
  if (v.quantity) {
    const lot = await addStock(actor, { itemId: item.itemId, quantity: v.quantity, expiresOn: v.expiresOn, lotCode: v.lotCode });
    if (!lot.ok) lotError = lot.error;
  }
  return { ok: true, stockItemId: item.itemId, priceItemId: price.itemId, lotError };
}

/** Edita nombre, precio, mínimo o lo da de baja (stock y precio juntos). */
export async function updateProduct(
  actor: Actor,
  stockItemId: string,
  v: { name?: string; price?: number; cardPrice?: number | null; unit?: string; category?: string; minQuantity?: number; active?: boolean; providerIds?: string[] },
): Promise<Result<object>> {
  const g = await adminGate(actor);
  if (!g.ok) return g;
  const r = await editItem(actor, stockItemId, { name: v.name, unit: v.unit, category: v.category, minQuantity: v.minQuantity, active: v.active });
  if (!r.ok) return r;
  const prices = await listPrices(actor, { includeInactive: true });
  if (!prices.ok) return prices;
  const linked = prices.items.find((p) => p.kind === "producto" && p.stockItemId === stockItemId);
  if (linked) {
    const u = await updatePrice(actor, linked.id, { name: v.name, amount: v.price, cardAmount: v.cardPrice, active: v.active });
    if (!u.ok) return u;
    if (v.providerIds !== undefined) {
      const l = await setItemLinks(actor, linked.id, v.providerIds);
      if (!l.ok) return l;
    }
  } else if (v.price !== undefined) {
    const cur = await getStockItem(actor.activeOrg!.id, stockItemId);
    const c = await createPrice(actor, { kind: "producto", name: cur?.name ?? v.name ?? "", amount: v.price, cardAmount: v.cardPrice ?? null, stockItemId });
    if (!c.ok) return c;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Prácticas (solo admin): nombre, precio efectivo y con tarjeta. Sin stock.
// ---------------------------------------------------------------------------

export async function listPractices(actor: Actor): Promise<Result<{ practices: (CatalogPractice & { active: boolean })[] }>> {
  const prices = await listPrices(actor, { includeInactive: true });
  if (!prices.ok) return prices;
  const links = await listItemProviders(actor.activeOrg!.id);
  return {
    ok: true,
    practices: prices.items
      .filter((p) => p.kind === "tratamiento")
      .map((p) => ({ id: p.id, name: p.name, price: p.amount, cardPrice: p.cardAmount, active: p.active, providerIds: links.get(p.id) ?? [] })),
  };
}

export async function createPractice(
  actor: Actor,
  v: { name: string; price: number; cardPrice?: number | null; providerIds?: string[] },
): Promise<Result<{ itemId: string }>> {
  if (!actor.activeOrg?.canAdmin) return fail("Solo un administrador puede cargar prácticas.", 403);
  const ids = await validProviders(actor, v.providerIds);
  if (!ids.ok) return ids;
  const r = await createPrice(actor, { kind: "tratamiento", name: v.name, amount: v.price, cardAmount: v.cardPrice ?? null });
  if (r.ok && ids.ids.length) await setItemProviders(actor.activeOrg.id, r.itemId, ids.ids);
  return r;
}

/** Valida que los profesionales sean del consultorio. `undefined` = no tocar. */
async function validProviders(actor: Actor, raw: unknown): Promise<Result<{ ids: string[] }>> {
  if (raw === undefined) return { ok: true, ids: [] };
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) return fail("Profesionales inválidos.");
  const ids = [...new Set(raw as string[])];
  for (const id of ids) {
    const p = await getProvider(id);
    if (!p || p.organizationId !== actor.activeOrg?.id) return fail("Profesional no encontrado en este consultorio.", 404);
  }
  return { ok: true, ids };
}

/** Admin: quién ofrece un ítem (producto o tratamiento). Lista vacía = cualquiera. */
export async function setItemLinks(actor: Actor, priceItemId: string, providerIds: string[]): Promise<Result<object>> {
  if (!actor.activeOrg?.canAdmin) return fail("Solo un administrador puede vincular profesionales.", 403);
  const prices = await listPrices(actor, { includeInactive: true });
  if (!prices.ok) return prices;
  if (!prices.items.some((p) => p.id === priceItemId)) return fail("Ítem no encontrado.", 404);
  const ids = await validProviders(actor, providerIds);
  if (!ids.ok) return ids;
  await setItemProviders(actor.activeOrg.id, priceItemId, ids.ids);
  return { ok: true };
}

export async function updatePractice(
  actor: Actor,
  id: string,
  v: { name?: string; price?: number; cardPrice?: number | null; active?: boolean; providerIds?: string[] },
): Promise<Result<object>> {
  if (!actor.activeOrg?.canAdmin) return fail("Solo un administrador puede cambiar prácticas.", 403);
  if (v.providerIds !== undefined) {
    const l = await setItemLinks(actor, id, v.providerIds);
    if (!l.ok) return l;
  }
  const cur = (await listPrices(actor, { includeInactive: true }));
  if (!cur.ok) return cur;
  if (!cur.items.some((p) => p.id === id && p.kind === "tratamiento")) return fail("Práctica no encontrada.", 404);
  const r = await updatePrice(actor, id, { name: v.name, amount: v.price, cardAmount: v.cardPrice, active: v.active });
  return r.ok ? { ok: true } : r;
}
