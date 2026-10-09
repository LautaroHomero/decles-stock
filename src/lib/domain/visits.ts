import {
  insertPendingSale,
  listVisitSales,
  markSaleEdited,
  markSaleVoided,
  newVisitId,
  stampVisit,
  type PaymentMethod,
} from "@/lib/db/billing-repo";
import { realNowIso } from "@/lib/domain/clock";
import { restoreStockForSale } from "@/lib/db/stock-repo";
import { getProvider } from "@/lib/db/repo";
import { recordSale } from "@/lib/domain/billing";
import type { Actor } from "@/lib/domain/types";

/**
 * Anotar (Decles): un paciente (nombre escrito, opcional), la médica, las prácticas que se
 * hicieron y/o los productos vendidos, y el medio de pago, en un solo paso. Cada renglón es
 * una `sale` y todos comparten `visit_id`. O se anota todo o nada.
 *
 * Nada de lo que pasó en el consultorio se pierde por falta de carga:
 *  · un producto sin stock cargado se vende igual (`allowNoStock`): queda debiendo y el admin recibe el aviso;
 *  · algo que no está en la lista (`pendingName`) se guarda como **pendiente**, sin importe, y el admin
 *    lo resuelve después (`domain/pending.ts`).
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };

export interface VisitInput {
  patientName?: string;
  providerId?: string | null;
  paymentMethod?: string | null;
  /** `pendingPrice`: lo que se cobró por unidad de algo no cargado (opcional). */
  lines: { itemId?: string; pendingName?: string; pendingPrice?: number | null; quantity?: number; expiresOn?: string | null }[];
}

const clean = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");

export async function recordVisit(
  actor: Actor,
  v: VisitInput,
): Promise<Result<{ visitId: string; saleIds: string[]; total: number; cashTotal: number; cardTotal: number; pending: number }>> {
  const lines = Array.isArray(v.lines) ? v.lines.filter((l) => l && (typeof l.itemId === "string" || clean(l.pendingName))) : [];
  if (!lines.length) return { ok: false, error: "No hay nada para anotar: elegí al menos una práctica o un producto.", status: 400 };
  if (lines.length > 30) return { ok: false, error: "Demasiados renglones juntos (máximo 30).", status: 400 };
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente") return { ok: false, error: "No autorizado.", status: 403 };

  // Para los pendientes la médica se valida acá (los demás renglones los valida recordSale).
  const providerId = actor.role === "medico" ? (actor.activeOrg?.providerId ?? null) : (v.providerId ?? null);
  let commissionPct = 0;
  if (lines.some((l) => !l.itemId)) {
    if (!providerId) return { ok: false, error: "Elegí qué médica la atendió.", status: 400 };
    const p = await getProvider(providerId);
    if (!p || p.organizationId !== orgId || !p.active) return { ok: false, error: "Profesional no encontrado en este consultorio.", status: 404 };
    commissionPct = p.commissionPct;
    for (const l of lines) {
      const pp = l.pendingPrice;
      if (pp !== undefined && pp !== null && (typeof pp !== "number" || !Number.isInteger(pp) || pp < 0 || pp > 100_000_000))
        return { ok: false, error: "El precio tiene que ser un número entero de pesos.", status: 400 };
    }
  }
  const raw = v.paymentMethod === "transferencia" ? "efectivo" : v.paymentMethod;
  const method: PaymentMethod | null = raw === "efectivo" || raw === "tarjeta" ? raw : null;
  const patient = clean(v.patientName).slice(0, 120);
  const who = { id: actor.userId, name: actor.name, source: "manual" as const };

  const visitId = newVisitId();
  const saleIds: string[] = [];
  let total = 0, cashTotal = 0, cardTotal = 0, pending = 0;
  for (const l of lines) {
    if (!l.itemId) {
      const qty = typeof l.quantity === "number" && Number.isInteger(l.quantity) && l.quantity > 0 ? l.quantity : 1;
      const id = await insertPendingSale(
        orgId,
        {
          name: clean(l.pendingName).slice(0, 80),
          quantity: qty,
          providerId: providerId!,
          patientLabel: patient,
          visitId,
          paymentMethod: method,
          note: "",
          unitPrice: l.pendingPrice ?? 0,
          commissionPct,
        },
        who,
      );
      saleIds.push(id);
      pending++;
      const t = (l.pendingPrice ?? 0) * qty;
      total += t;
      cashTotal += t;
      cardTotal += t;
      continue;
    }
    const r = await recordSale(actor, {
      itemId: l.itemId,
      quantity: l.quantity,
      providerId,
      paymentMethod: v.paymentMethod,
      expiresOn: l.expiresOn,
      patientLabel: patient,
      visitId,
      allowNoStock: true,
    });
    if (!r.ok) {
      // Deshacer lo que ya se anotó (no es una anulación del usuario: no pide permiso de admin).
      for (const id of saleIds) {
        await markSaleVoided(orgId, id, "No se pudo anotar todo junto", who);
        await restoreStockForSale(orgId, id, who);
      }
      return r;
    }
    saleIds.push(r.saleId);
    total += r.total;
    cashTotal += r.cashTotal;
    cardTotal += r.cardTotal;
  }
  return { ok: true, visitId, saleIds, total, cashTotal, cardTotal, pending };
}

/**
 * Editar una anotación ya guardada: se graba la versión nueva (validada igual que al anotar) y recién
 * entonces la vieja pasa a 'edited' y devuelve su stock. Conserva la hora original.
 * Permisos: lo del día, cualquiera del equipo (la médica solo lo suyo); días anteriores, solo el admin.
 */
export async function editVisit(
  actor: Actor,
  key: string,
  v: VisitInput,
): Promise<Result<{ visitId: string }>> {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente") return { ok: false, error: "No autorizado.", status: 403 };
  const old = await listVisitSales(orgId, key);
  if (!old.length) return { ok: false, error: "Esa anotación ya no existe o fue anulada.", status: 404 };
  const isAdmin = !!actor.activeOrg?.canAdmin;
  const today = realNowIso().slice(0, 10);
  if (!isAdmin && old[0].createdAt.slice(0, 10) !== today)
    return { ok: false, error: "Lo de días anteriores lo corrige el admin.", status: 403 };
  if (!isAdmin && actor.role === "medico" && old.some((s) => s.providerId !== actor.activeOrg?.providerId))
    return { ok: false, error: "Solo podés editar lo tuyo.", status: 403 };

  const r = await recordVisit(actor, v);
  if (!r.ok) return r;
  const who = { id: actor.userId, name: actor.name, source: "manual" as const };
  for (const s of old) {
    if (await markSaleEdited(orgId, s.id, who)) await restoreStockForSale(orgId, s.id, who);
  }
  await stampVisit(orgId, r.visitId, old[0].createdAt, `Editado por ${actor.name}`);
  return { ok: true, visitId: r.visitId };
}
