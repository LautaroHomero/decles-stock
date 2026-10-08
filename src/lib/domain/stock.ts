import {
  addStockLot,
  consumeStockFefo,
  createStockItem,
  getStockItem,
  getStockSettings,
  listStockItems,
  listStockMovements,
  setStockSettings,
  todayYmd,
  updateStockItem,
  writeOffStockLot,
  type Actor4Stock,
  type StockItem,
  type StockSettings,
  type StockSource,
} from "@/lib/db/stock-repo";
import type { Actor, StaffRole } from "@/lib/domain/types";

/**
 * Stock de insumos por consultorio. Única implementación: la usan los endpoints
 * REST de la vista Sistema (`src/app/api/stock/**`) y las tools del agente. La
 * autorización se resuelve acá (`canManageStock`) pero cada caller tiene que
 * pasar el `actor` de la sesión — nunca confiar en lo que diga el modelo.
 *
 * Ver todo el stock lo puede cualquier staff del consultorio; cargar o dar de baja
 * solo los roles que habilite el admin (`organizations.stock_roles`).
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400): { ok: false; error: string; status: number } => ({ ok: false, error, status });

export type { StockItem, StockSettings };

interface Ctx {
  orgId: string;
  actor: Actor;
  who: Actor4Stock;
}

function staffCtx(actor: Actor, source: StockSource): Ctx | undefined {
  if (actor.role === "paciente" || !actor.activeOrg) return undefined;
  return { orgId: actor.activeOrg.id, actor, who: { id: actor.userId, name: actor.name, source } };
}

/** El admin siempre puede; el resto, solo si su rol está habilitado para este consultorio. */
export async function canManageStock(actor: Actor): Promise<boolean> {
  if (actor.role === "paciente" || !actor.activeOrg) return false;
  if (actor.activeOrg.canAdmin) return true;
  const { roles } = await getStockSettings(actor.activeOrg.id);
  return roles.includes(actor.role as StaffRole);
}

async function manageCtx(actor: Actor, source: StockSource): Promise<Result<{ ctx: Ctx }>> {
  const ctx = staffCtx(actor, source);
  if (!ctx) return fail("Solo el equipo del consultorio puede usar el stock.", 403);
  if (!(await canManageStock(actor)))
    return fail("Tu consultorio no habilitó a tu rol para modificar el stock. Pedile a un administrador.", 403);
  return { ok: true, ctx };
}

/**
 * Acepta `YYYY-MM-DD`, `DD/MM/YYYY` o mes/año (`03/2027`, `2027-03`; vence el último día del mes).
 * Devuelve null si está vacío (el lote no vence) y `undefined` si no se entiende.
 */
export function parseExpiry(raw: string | null | undefined): string | null | undefined {
  const s = raw?.trim();
  if (!s) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate();
  let y: number, m: number, d: number | undefined;
  let g: RegExpMatchArray | null;
  if ((g = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [y, m, d] = [+g[1], +g[2], +g[3]];
  else if ((g = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) [y, m, d] = [+g[3], +g[2], +g[1]];
  else if ((g = s.match(/^(\d{4})-(\d{1,2})$/))) [y, m] = [+g[1], +g[2]];
  else if ((g = s.match(/^(\d{1,2})[/-](\d{4})$/))) [y, m] = [+g[2], +g[1]];
  else return undefined;
  if (m < 1 || m > 12) return undefined;
  const day = d ?? lastDay(y, m);
  if (day < 1 || day > lastDay(y, m)) return undefined;
  return `${y}-${pad(m)}-${pad(day)}`;
}

const cleanName = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");
const posInt = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined);
const normName = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// ---------------------------------------------------------------------------
// Lectura (cualquier staff)
// ---------------------------------------------------------------------------

export interface StockOverview {
  items: StockItem[];
  /** Productos por debajo de su mínimo. */
  low: StockItem[];
  /** Lotes con stock que vencen dentro de `settings.expiryDays` (aún vigentes). */
  expiringSoon: { item: string; itemId: string; lotId: string; lotCode: string; quantity: number; expiresOn: string }[];
  /** Lotes vencidos con stock: hay que darlos de baja. */
  expired: { item: string; itemId: string; lotId: string; lotCode: string; quantity: number; expiresOn: string }[];
  settings: StockSettings;
  canManage: boolean;
}

export async function stockOverview(actor: Actor): Promise<Result<{ overview: StockOverview }>> {
  const ctx = staffCtx(actor, "manual");
  if (!ctx) return fail("Solo el equipo del consultorio puede ver el stock.", 403);
  const [items, settings, canManage] = await Promise.all([
    listStockItems(ctx.orgId),
    getStockSettings(ctx.orgId),
    canManageStock(actor),
  ]);
  const limit = new Date(`${todayYmd()}T00:00:00`);
  limit.setDate(limit.getDate() + settings.expiryDays);
  const limitYmd = `${limit.getFullYear()}-${String(limit.getMonth() + 1).padStart(2, "0")}-${String(limit.getDate()).padStart(2, "0")}`;

  const expiringSoon: StockOverview["expiringSoon"] = [];
  const expired: StockOverview["expired"] = [];
  for (const i of items) {
    for (const l of i.lots) {
      if (!l.expiresOn) continue;
      const row = { item: i.name, itemId: i.id, lotId: l.id, lotCode: l.lotCode, quantity: l.quantity, expiresOn: l.expiresOn };
      if (l.expired) expired.push(row);
      else if (l.expiresOn <= limitYmd) expiringSoon.push(row);
    }
  }
  expiringSoon.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
  return { ok: true, overview: { items, low: items.filter((i) => i.low), expiringSoon, expired, settings, canManage } };
}

export async function stockHistory(actor: Actor, itemId?: string, limit = 100) {
  const ctx = staffCtx(actor, "manual");
  if (!ctx) return fail("Solo el equipo del consultorio puede ver el stock.", 403);
  return { ok: true as const, movements: await listStockMovements(ctx.orgId, itemId, Math.min(limit, 500)) };
}

/** Busca productos por nombre (sin tildes ni mayúsculas); el agente lo usa para no adivinar. */
export async function findStockItems(actor: Actor, query: string): Promise<Result<{ matches: StockItem[] }>> {
  const ctx = staffCtx(actor, "agent");
  if (!ctx) return fail("Solo el equipo del consultorio puede ver el stock.", 403);
  const q = normName(query.trim());
  const items = await listStockItems(ctx.orgId);
  const exact = items.filter((i) => normName(i.name) === q);
  return { ok: true, matches: exact.length ? exact : items.filter((i) => normName(i.name).includes(q)) };
}

// ---------------------------------------------------------------------------
// Escritura (staff habilitado)
// ---------------------------------------------------------------------------

export async function createItem(
  actor: Actor,
  v: { name: string; unit?: string; category?: string; minQuantity?: number },
  source: StockSource = "manual",
): Promise<Result<{ itemId: string }>> {
  const g = await manageCtx(actor, source);
  if (!g.ok) return g;
  const name = cleanName(v.name);
  if (!name) return fail("Falta el nombre del producto.");
  const min = v.minQuantity ?? 0;
  if (!Number.isInteger(min) || min < 0) return fail("El mínimo tiene que ser un entero mayor o igual a 0.");
  const dup = (await listStockItems(g.ctx.orgId, true)).find((i) => normName(i.name) === normName(name));
  if (dup) return fail(`Ya existe el producto "${dup.name}"${dup.active ? "" : " (dado de baja; reactivalo)"}.`, 409);
  const itemId = await createStockItem(g.ctx.orgId, {
    name,
    unit: cleanName(v.unit) || "unidad",
    category: cleanName(v.category),
    minQuantity: min,
  });
  return { ok: true, itemId };
}

export async function editItem(
  actor: Actor,
  itemId: string,
  v: { name?: string; unit?: string; category?: string; minQuantity?: number; active?: boolean },
): Promise<Result<object>> {
  const g = await manageCtx(actor, "manual");
  if (!g.ok) return g;
  const cur = await getStockItem(g.ctx.orgId, itemId);
  if (!cur) return fail("Producto no encontrado.", 404);
  const name = v.name === undefined ? cur.name : cleanName(v.name);
  if (!name) return fail("Falta el nombre del producto.");
  const min = v.minQuantity ?? cur.minQuantity;
  if (!Number.isInteger(min) || min < 0) return fail("El mínimo tiene que ser un entero mayor o igual a 0.");
  await updateStockItem(g.ctx.orgId, itemId, {
    name,
    unit: v.unit === undefined ? cur.unit : cleanName(v.unit) || "unidad",
    category: v.category === undefined ? cur.category : cleanName(v.category),
    minQuantity: min,
    active: v.active ?? cur.active,
  });
  return { ok: true };
}

/** Ingreso de un lote. `expiresOn` en cualquier formato de `parseExpiry`; vacío = no vence. */
export async function addStock(
  actor: Actor,
  v: { itemId: string; quantity: number; expiresOn?: string | null; lotCode?: string; note?: string },
  source: StockSource = "manual",
): Promise<Result<{ item: string; lotId: string; available: number }>> {
  const g = await manageCtx(actor, source);
  if (!g.ok) return g;
  const quantity = posInt(v.quantity);
  if (!quantity) return fail("La cantidad tiene que ser un entero mayor a 0.");
  const expiresOn = parseExpiry(v.expiresOn);
  if (expiresOn === undefined) return fail("No entiendo la fecha de vencimiento. Usá DD/MM/AAAA o MM/AAAA.");
  if (expiresOn && expiresOn < todayYmd())
    return fail(`Ese lote ya está vencido (${expiresOn}); no se puede ingresar como stock.`);
  const item = await getStockItem(g.ctx.orgId, v.itemId);
  if (!item) return fail("Producto no encontrado.", 404);
  if (!item.active) return fail(`"${item.name}" está dado de baja; reactivalo primero.`, 409);
  const lotId = await addStockLot(
    g.ctx.orgId,
    { itemId: item.id, quantity, expiresOn, lotCode: cleanName(v.lotCode), note: cleanName(v.note) },
    g.ctx.who,
  );
  return { ok: true, item: item.name, lotId, available: item.available + quantity };
}

/**
 * Baja por uso, pérdida o ajuste, descontando por FEFO. Si no alcanza el stock vigente,
 * descuenta lo que hay y devuelve `shortfall` para que el caller lo muestre.
 */
export async function removeStock(
  actor: Actor,
  v: {
    itemId: string;
    quantity: number;
    reason?: "uso" | "perdida" | "ajuste";
    note?: string;
    appointmentId?: string;
    consultationId?: string;
  },
  source: StockSource = "manual",
): Promise<Result<{ item: string; taken: number; shortfall: number; available: number; low: boolean }>> {
  const g = await manageCtx(actor, source);
  if (!g.ok) return g;
  const quantity = posInt(v.quantity);
  if (!quantity) return fail("La cantidad tiene que ser un entero mayor a 0.");
  const item = await getStockItem(g.ctx.orgId, v.itemId);
  if (!item) return fail("Producto no encontrado.", 404);
  if (item.available === 0) return fail(`No hay stock vigente de "${item.name}".`, 409);
  const { taken, shortfall } = await consumeStockFefo(
    g.ctx.orgId,
    {
      itemId: item.id,
      quantity,
      reason: v.reason ?? "uso",
      note: cleanName(v.note),
      appointmentId: v.appointmentId,
      consultationId: v.consultationId,
    },
    g.ctx.who,
  );
  const available = item.available - taken;
  return { ok: true, item: item.name, taken, shortfall, available, low: item.minQuantity > 0 && available < item.minQuantity };
}

/** Baja de un lote entero (típicamente vencido). */
export async function writeOffLot(
  actor: Actor,
  lotId: string,
  reason: "vencimiento" | "perdida" | "ajuste" = "vencimiento",
  note = "",
  source: StockSource = "manual",
): Promise<Result<{ quantity: number }>> {
  const g = await manageCtx(actor, source);
  if (!g.ok) return g;
  const r = await writeOffStockLot(g.ctx.orgId, lotId, reason, cleanName(note), g.ctx.who);
  if (!r) return fail("Lote no encontrado o ya sin stock.", 404);
  return { ok: true, quantity: r.quantity };
}

/** Da de baja todos los lotes vencidos del consultorio (o de un producto). */
export async function writeOffExpired(
  actor: Actor,
  itemId?: string,
  source: StockSource = "manual",
): Promise<Result<{ lots: number; units: number }>> {
  const g = await manageCtx(actor, source);
  if (!g.ok) return g;
  let lots = 0;
  let units = 0;
  for (const i of await listStockItems(g.ctx.orgId, true)) {
    if (itemId && i.id !== itemId) continue;
    for (const l of i.lots.filter((x) => x.expired)) {
      const r = await writeOffStockLot(g.ctx.orgId, l.id, "vencimiento", "Baja de lote vencido", g.ctx.who);
      if (r) {
        lots++;
        units += r.quantity;
      }
    }
  }
  return { ok: true, lots, units };
}

// ---------------------------------------------------------------------------
// Configuración (solo admin)
// ---------------------------------------------------------------------------

export async function updateStockSettings(
  actor: Actor,
  v: { roles?: StaffRole[]; expiryDays?: number },
): Promise<Result<{ settings: StockSettings }>> {
  if (actor.role === "paciente" || !actor.activeOrg) return fail("No autorizado.", 403);
  if (!actor.activeOrg.canAdmin) return fail("Solo un administrador puede configurar el stock.", 403);
  const cur = await getStockSettings(actor.activeOrg.id);
  const roles = v.roles ?? cur.roles;
  if (!roles.every((r) => r === "medico" || r === "recepcion")) return fail("Roles inválidos.");
  const expiryDays = v.expiryDays ?? cur.expiryDays;
  if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 365)
    return fail("Los días de aviso de vencimiento tienen que estar entre 1 y 365.");
  const settings = { roles: [...new Set(roles)], expiryDays };
  await setStockSettings(actor.activeOrg.id, settings);
  return { ok: true, settings };
}
