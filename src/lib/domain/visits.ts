import { getPriceItem, markSaleVoided, newVisitId } from "@/lib/db/billing-repo";
import { getStockItem, restoreStockForSale } from "@/lib/db/stock-repo";
import { recordSale } from "@/lib/domain/billing";
import type { Actor } from "@/lib/domain/types";

/**
 * Anotar (Decles): un paciente (nombre escrito, opcional), la médica, las prácticas que se
 * hicieron y/o los productos vendidos, y el medio de pago, en un solo paso. Cada renglón es
 * una `sale` (vía `recordSale`, que valida precio, stock y comisión) y todos comparten
 * `visit_id`. Si un renglón falla, los anteriores se anulan (devuelven el stock): o se
 * anota todo o nada.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };

export interface VisitInput {
  patientName?: string;
  providerId?: string | null;
  paymentMethod?: string | null;
  lines: { itemId: string; quantity?: number; expiresOn?: string | null }[];
}

export async function recordVisit(
  actor: Actor,
  v: VisitInput,
): Promise<Result<{ visitId: string; saleIds: string[]; total: number; cashTotal: number; cardTotal: number }>> {
  const lines = Array.isArray(v.lines) ? v.lines.filter((l) => l && typeof l.itemId === "string") : [];
  if (!lines.length) return { ok: false, error: "No hay nada para anotar: elegí al menos una práctica o un producto.", status: 400 };
  if (lines.length > 30) return { ok: false, error: "Demasiados renglones juntos (máximo 30).", status: 400 };

  // Antes de anotar nada: que alcance el stock de todos los productos (sumando renglones repetidos).
  const orgId = actor.activeOrg?.id;
  if (!orgId) return { ok: false, error: "No autorizado.", status: 403 };
  const need = new Map<string, { name: string; qty: number }>();
  for (const l of lines) {
    const item = await getPriceItem(orgId, l.itemId);
    if (!item?.stockItemId) continue; // prácticas o ítems inválidos: los valida recordSale
    const cur = need.get(item.stockItemId) ?? { name: item.name, qty: 0 };
    cur.qty += typeof l.quantity === "number" ? l.quantity : 1;
    need.set(item.stockItemId, cur);
  }
  for (const [stockItemId, n] of need) {
    const s = await getStockItem(orgId, stockItemId);
    if (s && s.available < n.qty)
      return { ok: false, error: `No alcanza el stock de "${n.name}": hay ${s.available} y querés anotar ${n.qty}.`, status: 409 };
  }

  const visitId = newVisitId();
  const saleIds: string[] = [];
  let total = 0, cashTotal = 0, cardTotal = 0;
  for (const l of lines) {
    const r = await recordSale(actor, {
      itemId: l.itemId,
      quantity: l.quantity,
      providerId: v.providerId,
      paymentMethod: v.paymentMethod,
      expiresOn: l.expiresOn,
      patientLabel: v.patientName,
      visitId,
    });
    if (!r.ok) {
      // Deshacer lo que ya se anotó (no es una anulación del usuario: no pide permiso de admin).
      const who = { id: actor.userId, name: actor.name, source: "manual" as const };
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
  return { ok: true, visitId, saleIds, total, cashTotal, cardTotal };
}
