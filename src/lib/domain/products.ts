import { createPrice, listPrices, updatePrice, canEditPrices } from "@/lib/domain/billing";
import { addStock, createItem, editItem, stockOverview, canManageStock, type StockItem } from "@/lib/domain/stock";
import { getStockItem } from "@/lib/db/stock-repo";
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
  name: string;
  unit: string;
  category: string;
  /** Precio vigente (ARS enteros); null = el admin todavía no le puso precio, no se puede vender. */
  price: number | null;
  available: number;
  minQuantity: number;
  low: boolean;
  nextExpiry: string | null;
  /** Vencimientos vigentes con stock, para elegir "de cuál vendí". */
  expiries: { expiresOn: string; quantity: number }[];
  expiredQuantity: number;
  lots: StockItem["lots"];
}

export async function catalog(actor: Actor): Promise<
  Result<{
    products: CatalogProduct[];
    alerts: { expiringSoon: number; expired: number; low: number };
    expiryDays: number;
    canAdmin: boolean;
  }>
> {
  const [ov, prices] = await Promise.all([stockOverview(actor), listPrices(actor)]);
  if (!ov.ok) return ov;
  if (!prices.ok) return prices;
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
      name: i.name,
      unit: i.unit,
      category: i.category,
      price: price ? price.amount : null,
      available: i.available,
      minQuantity: i.minQuantity,
      low: i.low,
      nextExpiry: i.nextExpiry,
      expiries: [...exp.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([expiresOn, quantity]) => ({ expiresOn, quantity })),
      expiredQuantity: i.expiredQuantity,
      lots: i.lots,
    };
  });
  return {
    ok: true,
    products,
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
    unit?: string;
    category?: string;
    minQuantity?: number;
    quantity?: number;
    expiresOn?: string | null;
    lotCode?: string;
  },
): Promise<Result<{ stockItemId: string; priceItemId: string; lotError?: string }>> {
  const g = await adminGate(actor);
  if (!g.ok) return g;
  if (typeof v.price !== "number" || !Number.isInteger(v.price) || v.price < 0)
    return fail("El precio tiene que ser un número entero de pesos, 0 o más.");
  const item = await createItem(actor, { name: v.name, unit: v.unit, category: v.category, minQuantity: v.minQuantity });
  if (!item.ok) return item;
  const price = await createPrice(actor, { kind: "producto", name: v.name, amount: v.price, stockItemId: item.itemId });
  if (!price.ok) {
    // Sin precio el producto no se puede vender: se deshace el alta para no dejarlo a medias.
    await editItem(actor, item.itemId, { active: false });
    return price;
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
  v: { name?: string; price?: number; unit?: string; category?: string; minQuantity?: number; active?: boolean },
): Promise<Result<object>> {
  const g = await adminGate(actor);
  if (!g.ok) return g;
  const r = await editItem(actor, stockItemId, { name: v.name, unit: v.unit, category: v.category, minQuantity: v.minQuantity, active: v.active });
  if (!r.ok) return r;
  const prices = await listPrices(actor, { includeInactive: true });
  if (!prices.ok) return prices;
  const linked = prices.items.find((p) => p.kind === "producto" && p.stockItemId === stockItemId);
  if (linked) {
    const u = await updatePrice(actor, linked.id, { name: v.name, amount: v.price, active: v.active });
    if (!u.ok) return u;
  } else if (v.price !== undefined) {
    const cur = await getStockItem(actor.activeOrg!.id, stockItemId);
    const c = await createPrice(actor, { kind: "producto", name: cur?.name ?? v.name ?? "", amount: v.price, stockItemId });
    if (!c.ok) return c;
  }
  return { ok: true };
}
