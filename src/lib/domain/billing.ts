import {
  createPriceItem as insertPriceItem,
  getPriceItem,
  getPricingRoles,
  getSale,
  insertSale,
  listPriceHistory,
  listPriceItems,
  listSales,
  markSaleVoided,
  setPricingRoles,
  updatePriceItem as persistPriceItem,
  setSalePayment,
  commissionSummary,
  getItemProviders,
  type CommissionRow,
  type BillingSource,
  type BillingWho,
  type PriceItem,
  type PriceKind,
  type Sale,
} from "@/lib/db/billing-repo";
import { realNowIso } from "@/lib/domain/clock";
import { addOwed, consumeStockFefo, getStockItem, restoreStockForSale } from "@/lib/db/stock-repo";
import { getPatient, getProvider } from "@/lib/db/repo";
import { parseExpiry } from "@/lib/domain/stock";
import type { Actor, StaffRole } from "@/lib/domain/types";

/**
 * Precios, ventas y resúmenes del consultorio. Única implementación: la usan los
 * endpoints (`src/app/api/prices|sales|finance/**`) y las tools del agente; cada caller
 * pasa el `actor` de la sesión.
 *
 * Quién puede qué:
 *  · ver precios y registrar ventas: todo el staff del consultorio;
 *  · cambiar precios y anular ventas: el admin, más los roles que el admin habilite;
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400): { ok: false; error: string; status: number } => ({ ok: false, error, status });

export type { CommissionRow, PriceItem, PriceKind, Sale };

const KINDS: PriceKind[] = ["consulta", "tratamiento", "producto"];
const cleanName = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");
const posInt = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined);
const amountOk = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100_000_000;
const ymd = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);

interface Ctx {
  orgId: string;
  actor: Actor;
  who: BillingWho;
}

function staffCtx(actor: Actor, source: BillingSource): Ctx | undefined {
  if (actor.role === "paciente" || !actor.activeOrg) return undefined;
  return { orgId: actor.activeOrg.id, actor, who: { id: actor.userId, name: actor.name, source } };
}

/** El admin siempre puede; el resto, solo si su rol está habilitado por el admin. */
export async function canEditPrices(actor: Actor): Promise<boolean> {
  if (actor.role === "paciente" || !actor.activeOrg) return false;
  if (actor.activeOrg.canAdmin) return true;
  return (await getPricingRoles(actor.activeOrg.id)).includes(actor.role as StaffRole);
}

async function editCtx(actor: Actor, source: BillingSource): Promise<Result<{ ctx: Ctx }>> {
  const ctx = staffCtx(actor, source);
  if (!ctx) return fail("Solo el equipo del consultorio puede usar precios.", 403);
  if (!(await canEditPrices(actor)))
    return fail("No tenés permiso para cambiar precios. Pedile a un administrador.", 403);
  return { ok: true, ctx };
}

// ---------------------------------------------------------------------------
// Catálogo de precios
// ---------------------------------------------------------------------------

export async function listPrices(
  actor: Actor,
  opts: { includeInactive?: boolean } = {},
): Promise<Result<{ items: PriceItem[]; canEdit: boolean; roles: StaffRole[] }>> {
  const ctx = staffCtx(actor, "manual");
  if (!ctx) return fail("Solo el equipo del consultorio puede ver los precios.", 403);
  const [items, canEdit, roles] = await Promise.all([
    listPriceItems(ctx.orgId, opts.includeInactive),
    canEditPrices(actor),
    getPricingRoles(ctx.orgId),
  ]);
  // El médico ve el general y lo suyo, no los precios propios de colegas.
  const mine = actor.role === "medico" ? actor.activeOrg?.providerId : undefined;
  return {
    ok: true,
    items: mine ? items.filter((i) => !i.providerId || i.providerId === mine) : items,
    canEdit,
    roles,
  };
}

export async function createPrice(
  actor: Actor,
  v: { kind: PriceKind; name: string; amount: number; cardAmount?: number | null; providerId?: string | null; stockItemId?: string | null },
  source: BillingSource = "manual",
): Promise<Result<{ itemId: string }>> {
  const g = await editCtx(actor, source);
  if (!g.ok) return g;
  if (!KINDS.includes(v.kind)) return fail("El tipo tiene que ser consulta, tratamiento o producto.");
  const name = cleanName(v.name);
  if (!name) return fail("Falta el nombre.");
  if (!amountOk(v.amount)) return fail("El importe tiene que ser un número entero de pesos, 0 o más.");
  if (v.cardAmount !== undefined && v.cardAmount !== null && !amountOk(v.cardAmount))
    return fail("El precio con tarjeta tiene que ser un número entero de pesos, 0 o más.");

  let providerId: string | null = null;
  if (v.providerId) {
    const p = await getProvider(v.providerId);
    if (!p || p.organizationId !== g.ctx.orgId) return fail("Profesional no encontrado en este consultorio.", 404);
    providerId = p.id;
  }
  let stockItemId: string | null = null;
  if (v.stockItemId) {
    if (v.kind !== "producto") return fail("Solo un producto puede vincularse al stock.");
    const s = await getStockItem(g.ctx.orgId, v.stockItemId);
    if (!s) return fail("Producto de stock no encontrado.", 404);
    stockItemId = s.id;
  }
  try {
    const itemId = await insertPriceItem(g.ctx.orgId, { kind: v.kind, name, amount: v.amount, cardAmount: v.cardAmount ?? null, providerId, stockItemId }, g.ctx.who);
    return { ok: true, itemId };
  } catch (err) {
    if ((err as { code?: string }).code === "23505")
      return fail(`Ya existe "${name}"${providerId ? " para ese profesional" : ""}. Editá el existente.`, 409);
    throw err;
  }
}

export async function updatePrice(
  actor: Actor,
  id: string,
  v: { name?: string; amount?: number; cardAmount?: number | null; active?: boolean; stockItemId?: string | null },
  source: BillingSource = "manual",
): Promise<Result<{ item: string; oldAmount: number; amount: number }>> {
  const g = await editCtx(actor, source);
  if (!g.ok) return g;
  const cur = await getPriceItem(g.ctx.orgId, id);
  if (!cur) return fail("Precio no encontrado.", 404);
  const name = v.name === undefined ? cur.name : cleanName(v.name);
  if (!name) return fail("Falta el nombre.");
  const amount = v.amount ?? cur.amount;
  if (!amountOk(amount)) return fail("El importe tiene que ser un número entero de pesos, 0 o más.");
  const cardAmount = v.cardAmount === undefined ? cur.cardAmount : v.cardAmount;
  if (cardAmount !== null && !amountOk(cardAmount)) return fail("El precio con tarjeta tiene que ser un número entero de pesos, 0 o más.");
  let stockItemId = cur.stockItemId;
  if (v.stockItemId !== undefined) {
    if (v.stockItemId && cur.kind !== "producto") return fail("Solo un producto puede vincularse al stock.");
    if (v.stockItemId && !(await getStockItem(g.ctx.orgId, v.stockItemId))) return fail("Producto de stock no encontrado.", 404);
    stockItemId = v.stockItemId;
  }
  try {
    await persistPriceItem(g.ctx.orgId, cur, { name, amount, cardAmount, active: v.active ?? cur.active, stockItemId }, g.ctx.who);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return fail(`Ya existe otro precio llamado "${name}".`, 409);
    throw err;
  }
  return { ok: true, item: name, oldAmount: cur.amount, amount };
}

export async function priceHistory(actor: Actor, itemId: string) {
  const ctx = staffCtx(actor, "manual");
  if (!ctx) return fail("Solo el equipo del consultorio puede ver los precios.", 403);
  if (!(await getPriceItem(ctx.orgId, itemId))) return fail("Precio no encontrado.", 404);
  return { ok: true as const, history: await listPriceHistory(ctx.orgId, itemId) };
}

/** Admin: qué roles, además del admin, pueden cambiar precios y anular ventas. */
export async function updatePricingRoles(actor: Actor, roles: StaffRole[]): Promise<Result<{ roles: StaffRole[] }>> {
  if (actor.role === "paciente" || !actor.activeOrg) return fail("No autorizado.", 403);
  if (!actor.activeOrg.canAdmin) return fail("Solo un administrador puede configurar esto.", 403);
  if (!Array.isArray(roles) || !roles.every((r) => r === "medico" || r === "recepcion")) return fail("Roles inválidos.");
  const next = [...new Set(roles)];
  await setPricingRoles(actor.activeOrg.id, next);
  return { ok: true, roles: next };
}

/** Busca ítems del catálogo por nombre (sin tildes ni mayúsculas), para que el agente no adivine. */
export async function findPrices(actor: Actor, query: string): Promise<Result<{ matches: PriceItem[] }>> {
  const r = await listPrices(actor);
  if (!r.ok) return r;
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const q = norm(query.trim());
  const exact = r.items.filter((i) => norm(i.name) === q);
  return { ok: true, matches: exact.length ? exact : r.items.filter((i) => norm(i.name).includes(q)) };
}

// ---------------------------------------------------------------------------
// Ventas
// ---------------------------------------------------------------------------

/**
 * Registra una venta al precio vigente. Un producto vinculado al stock descuenta stock por FEFO
 * (sin exigir permiso de stock: vender no es editar el inventario). Si no hay stock suficiente no se vende.
 */
export async function recordSale(
  actor: Actor,
  v: {
    itemId: string;
    quantity?: number;
    patientId?: string | null;
    providerId?: string | null;
    note?: string;
    /** Opcional: vencimiento del que se vendió (YYYY-MM-DD, DD/MM/AAAA o MM/AAAA); se descuenta primero de ese lote. */
    expiresOn?: string | null;
    /** Opcional: "efectivo" (o transferencia) | "tarjeta". Sin medio se registra a precio efectivo. */
    paymentMethod?: string | null;
    /** Decles: paciente escrito a mano y renglones anotados juntos (ver domain/visits.ts). */
    patientLabel?: string;
    visitId?: string | null;
    /** Decles: vender aunque el sistema no tenga stock cargado (queda en `owed` y se avisa al admin). */
    allowNoStock?: boolean;
  },
  source: BillingSource = "manual",
): Promise<
  Result<{
    saleId: string;
    item: string;
    quantity: number;
    unitPrice: number;
    total: number;
    cashTotal: number;
    cardTotal: number;
    paymentMethod: string | null;
    stockLeft?: number;
  }>
> {
  const ctx = staffCtx(actor, source);
  if (!ctx) return fail("Solo el equipo del consultorio puede registrar ventas.", 403);
  const quantity = v.quantity === undefined ? 1 : posInt(v.quantity);
  if (!quantity) return fail("La cantidad tiene que ser un entero mayor a 0.");
  const item = await getPriceItem(ctx.orgId, v.itemId);
  if (!item || !item.active) return fail("Ese ítem no está en la lista de precios.", 404);
  const rawMethod = v.paymentMethod || null;
  if (rawMethod && rawMethod !== "efectivo" && rawMethod !== "transferencia" && rawMethod !== "tarjeta")
    return fail("El medio de pago tiene que ser efectivo, transferencia o tarjeta.");
  const paymentMethod = rawMethod as "efectivo" | "transferencia" | "tarjeta" | null;
  const preferExpiry = parseExpiry(v.expiresOn);
  if (preferExpiry === undefined) return fail("No entiendo la fecha de vencimiento. Usá DD/MM/AAAA o MM/AAAA.");
  // Un médico solo vende lo general o lo propio.
  if (actor.role === "medico" && item.providerId && item.providerId !== actor.activeOrg?.providerId)
    return fail("Ese precio es de otro profesional.", 403);

  if (v.patientId) {
    const p = await getPatient(v.patientId);
    if (!p) return fail("Paciente no encontrado.", 404);
  }
  // Quién vendió (cobra comisión): la médica que registra es siempre ella misma; si registra
  // la secretaría o un admin no-médico, tiene que indicar la médica (Decles).
  let providerId = actor.role === "medico" ? actor.activeOrg?.providerId ?? null : v.providerId ?? item.providerId ?? null;
  let commissionPct = 0;
  if (!providerId && item.kind === "producto") return fail("Elegí qué médica hizo la venta.");
  if (!providerId && item.kind === "tratamiento") return fail("Elegí qué médica hizo la práctica.");
  if (providerId) {
    const p = await getProvider(providerId);
    if (!p || p.organizationId !== ctx.orgId) return fail("Profesional no encontrado en este consultorio.", 404);
    if (!p.active) return fail(`${p.name} está dada de baja.`, 409);
    providerId = p.id;
    // Decles: el % propio del ítem manda; si no tiene, el de la médica.
    commissionPct = item.commissionPct ?? p.commissionPct;
    // Decles: si el ítem tiene profesionales vinculados, solo ellos lo pueden anotar.
    const allowed = await getItemProviders(ctx.orgId, item.id);
    if (allowed.length && !allowed.includes(p.id))
      return fail(`${p.name} no tiene asignado "${item.name}". El admin lo vincula en Stock.`, 409);
  }

  if (item.stockItemId) {
    const s = await getStockItem(ctx.orgId, item.stockItemId);
    if (!s) return fail("El producto de stock vinculado ya no existe.", 409);
    if (s.available < quantity && !v.allowNoStock)
      return fail(`No alcanza el stock de "${s.name}": hay ${s.available} y querés vender ${quantity}.`, 409);
  }

  const { id, total, cashTotal, cardTotal } = await insertSale(
    ctx.orgId,
    {
      item, quantity, providerId, patientId: v.patientId ?? null, note: cleanName(v.note), commissionPct, paymentMethod,
      patientLabel: cleanName(v.patientLabel).slice(0, 120), visitId: v.visitId ?? null,
    },
    ctx.who,
  );

  let stockLeft: number | undefined;
  if (item.stockItemId) {
    const r = await consumeStockFefo(
      ctx.orgId,
      { itemId: item.stockItemId, quantity, reason: "uso", note: `Venta de ${item.name}`, saleId: id, preferExpiry },
      { id: ctx.who.id, name: ctx.who.name, source },
    );
    if (r.shortfall > 0 && v.allowNoStock) {
      await addOwed(ctx.orgId, { itemId: item.stockItemId, quantity: r.shortfall, saleId: id, note: `Venta de ${item.name} sin stock cargado` }, {
        id: ctx.who.id,
        name: ctx.who.name,
        source,
      });
    } else if (r.shortfall > 0) {
      // Otro descuento se coló entre el chequeo y acá: se deshace todo para no vender de más.
      await restoreStockForSale(ctx.orgId, id, { id: ctx.who.id, name: ctx.who.name, source });
      await markSaleVoided(ctx.orgId, id, "Stock insuficiente al confirmar", ctx.who);
      return fail("Se acabó el stock mientras se registraba la venta. Probá de nuevo.", 409);
    }
    stockLeft = (await getStockItem(ctx.orgId, item.stockItemId))?.available;
  }
  return { ok: true, saleId: id, item: item.name, quantity, unitPrice: paymentMethod === "tarjeta" ? (item.cardAmount ?? item.amount) : item.amount, total, cashTotal, cardTotal, paymentMethod, stockLeft };
}

export async function voidSale(actor: Actor, saleId: string, reason: string, source: BillingSource = "manual"): Promise<Result<{ restoredUnits: number }>> {
  const g = await editCtx(actor, source);
  if (!g.ok) return g;
  const why = cleanName(reason);
  if (!why) return fail("Indicá el motivo de la anulación.");
  const sale = await getSale(g.ctx.orgId, saleId);
  if (!sale) return fail("Venta no encontrada.", 404);
  if (sale.status === "voided") return fail("Esa venta ya estaba anulada.", 409);
  if (!(await markSaleVoided(g.ctx.orgId, saleId, why, g.ctx.who))) return fail("Esa venta ya estaba anulada.", 409);
  const restoredUnits = await restoreStockForSale(g.ctx.orgId, saleId, { id: g.ctx.who.id, name: g.ctx.who.name, source });
  return { ok: true, restoredUnits };
}

/** Ventas de un rango (por defecto, hoy). El médico solo ve las suyas. */
export async function salesList(actor: Actor, from?: string, to?: string, limit = 200): Promise<Result<{ sales: Sale[] }>> {
  const ctx = staffCtx(actor, "manual");
  if (!ctx) return fail("Solo el equipo del consultorio puede ver las ventas.", 403);
  const today = realNowIso().slice(0, 10);
  const f = from === undefined ? today : ymd(from);
  const t = to === undefined ? f : ymd(to);
  if (!f || !t) return fail("Fechas inválidas: usá AAAA-MM-DD.");
  const all = await listSales(ctx.orgId, f, t, Math.min(Math.max(limit, 1), 500));
  const mine = actor.role === "medico" ? actor.activeOrg?.providerId : undefined;
  return { ok: true, sales: mine ? all.filter((s) => s.providerId === mine || s.createdByName === actor.name) : all };
}

// ---------------------------------------------------------------------------
// Comisiones (Decles): el admin ve todas; la médica, las suyas.
// ---------------------------------------------------------------------------

export async function commissions(actor: Actor, from?: string, to?: string): Promise<Result<{ from: string; to: string; rows: CommissionRow[] }>> {
  const ctx = staffCtx(actor, "manual");
  if (!ctx) return fail("No autorizado.", 403);
  const isAdmin = !!actor.activeOrg?.canAdmin;
  if (!isAdmin && actor.role !== "medico") return fail("Las comisiones las ve el admin.", 403);
  const today = realNowIso().slice(0, 10);
  const f = from === undefined ? `${today.slice(0, 7)}-01` : ymd(from);
  const t = to === undefined ? today : ymd(to);
  if (!f || !t) return fail("Fechas inválidas: usá AAAA-MM-DD.");
  if (f > t) return fail("La fecha 'desde' es posterior a 'hasta'.");
  const rows = await commissionSummary(ctx.orgId, f, t);
  const mine = actor.activeOrg?.providerId;
  return { ok: true, from: f, to: t, rows: isAdmin ? rows : rows.filter((r) => r.providerId === mine) };
}

/** Completa el medio de pago de una venta que quedó sin cargar (cualquiera del equipo). */
export async function completeSalePayment(actor: Actor, saleId: string, method: string): Promise<Result<object>> {
  const ctx = staffCtx(actor, "manual");
  if (!ctx) return fail("No autorizado.", 403);
  const m = method;
  if (m !== "efectivo" && m !== "transferencia" && m !== "tarjeta") return fail("El medio de pago tiene que ser efectivo, transferencia o tarjeta.");
  const sale = await getSale(ctx.orgId, saleId);
  if (!sale) return fail("Venta no encontrada.", 404);
  if (actor.role === "medico" && sale.providerId !== actor.activeOrg?.providerId) return fail("Esa venta no es tuya.", 403);
  if (!(await setSalePayment(ctx.orgId, saleId, m))) return fail("Esa venta ya tiene medio de pago (o está anulada).", 409);
  return { ok: true };
}
