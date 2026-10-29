import {
  applyManualAmounts,
  getPriceItem,
  insertPendingSale,
  setVisitObservations,
  listVisitSales,
  markSaleEdited,
  markSaleVoided,
  newVisitId,
  stampVisit,
  type PaymentMethod,
} from "@/lib/db/billing-repo";
import { realNowIso } from "@/lib/domain/clock";
import { getStockItem, restoreStockForSale } from "@/lib/db/stock-repo";
import { getProvider } from "@/lib/db/repo";
import { recordSale } from "@/lib/domain/billing";
import { insertVisitPayments, setVisitMethod, type PayPart } from "@/lib/db/payments-repo";
import type { Actor } from "@/lib/domain/types";
import { createDebt, relinkDebts } from "@/lib/domain/debts";
import { isOwnerProvider } from "@/lib/domain/owners";
import { depositForVisit, relinkDeposit, releaseDeposit, applyDeposit, type Deposit } from "@/lib/domain/deposits";
import { commissionFor } from "@/lib/domain/billing";
import { dropInsurerVisit, insurerForVisit, recordInsurerVisit, relinkInsurerVisit, type Insurer } from "@/lib/domain/insurers";
import { dropPrepaidUses, prepaidItemId, prepaidForVisit, recordPrepaidUse, relinkPrepaidUses, type Prepaid } from "@/lib/domain/prepaids";
import { dropGiftCardUses, issueGiftCard, relinkGiftCardUses, useGiftCard as redeemGiftCard } from "@/lib/domain/gift-cards";

/**
 * Anotar (Decles): un paciente (nombre escrito; obligatorio si hay una práctica), la médica, las prácticas que se
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
  /**
   * Pago en varios medios o en dólares: «mitad efectivo, mitad tarjeta», «100 dólares». `amount` en pesos
   * (en dólares lo calcula el servidor: usd × rate). Con esto, `paymentMethod` se ignora.
   */
  payments?: { method?: string; amount?: number; usd?: number | null; rate?: number | null }[];
  /** Planilla: columna Observaciones (texto libre, se guarda tal cual). */
  observations?: string;
  /**
   * Lo que quedó debiendo (Decles): «pagó 80000, debe 40000». Se anota una deuda a nombre del paciente,
   * con la parte de la profesional (su % sobre lo que debe), que se le paga a medida que se cobra.
   */
  debt?: number | null;
  /** Día para acordarse de cobrar esa deuda (AAAA-MM-DD). */
  debtRemindOn?: string | null;
  /**
   * Sesión de un abono (`domain/prepaids.ts`): el renglón de ese tratamiento no pasa por caja (ya se pagó) y la
   * profesional cobra su parte sobre el precio congelado.
   */
  prepaidId?: string | null;
  giftCardCode?: string | null;
  giftCardIssue?: { kind: "amount" | "treatment"; treatmentItemId?: string | null; buyer?: string };
  /**
   * Atención por obra social / prepaga (`domain/insurers.ts`, ej. OSMECON): las prácticas van a $0 y la profesional se lleva
   * el monto fijo de la obra social por la atención. Sin práctica escrita, es una «Atención».
   */
  insurerId?: string | null;
  /**
   * Seña (`domain/deposits.ts`): se descuenta del renglón de su práctica (o de la primera práctica). Si no se dice
   * cuánto pagó ese renglón, paga el precio menos la seña. La profesional cobra sobre el total (lo de hoy + la seña).
   */
  depositId?: string | null;
  /**
   * Le pagaron directo a la profesional (medio `profesional`) y se aclaró cuánto nos debe ella de eso
   * («nos debe 36000»): su parte del total queda en lo que cobró directo − `owesUs`.
   */
  owesUs?: number | null;
  /**
   * `pendingPrice`: lo que se cobró por unidad de algo no cargado (opcional).
   * Planilla: `generic` = renglón sin práctica elegida («Atención»); `amount` = lo que abonó por el renglón
   * (pisa la lista de precios; 0 = no pasó por caja); `commission` = la parte de la profesional ($K).
   */
  lines: {
    itemId?: string;
    pendingName?: string;
    pendingPrice?: number | null;
    quantity?: number;
    expiresOn?: string | null;
    generic?: boolean;
    amount?: number | null;
    commission?: number | null;
  }[];
}

export const GENERIC_PRACTICE = "Atención";
const pesos = (n: unknown) => n === undefined || n === null || (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1_000_000_000);

const clean = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");

export async function recordVisit(
  actor: Actor,
  v: VisitInput,
  /** Al editar: la atención que esta reemplaza (su sesión de abono no cuenta para validar). */
  replacingVisitId?: string,
): Promise<Result<{ visitId: string; saleIds: string[]; total: number; cashTotal: number; cardTotal: number; pending: number; giftCardCode?: string }>> {
  let lines = Array.isArray(v.lines) ? v.lines.filter((l) => l && (typeof l.itemId === "string" || clean(l.pendingName) || l.generic)) : [];
  // Por obra social sin decir qué se hizo: es una atención.
  if (v.insurerId && !lines.length) lines = [{ generic: true, amount: 0 }];
  // Sesión de un plan / abono sin decir la práctica («carla, plan»): es la del abono.
  if (v.prepaidId && typeof v.prepaidId === "string" && actor.activeOrg?.id) {
    const pi = await prepaidItemId(actor.activeOrg.id, v.prepaidId);
    if (pi && !lines.some((l) => l.itemId === pi)) lines = [...lines.filter((l) => l.itemId), { itemId: pi }];
  }
  if (!lines.length) return { ok: false, error: "No hay nada para anotar: elegí al menos una práctica o un producto.", status: 400 };
  if (lines.length > 30) return { ok: false, error: "Demasiados renglones juntos (máximo 30).", status: 400 };
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente") return { ok: false, error: "No autorizado.", status: 403 };
  if (lines.some((l) => !pesos(l.amount) || !pesos(l.commission)))
    return { ok: false, error: "Los importes tienen que ser números enteros de pesos.", status: 400 };

  // Para los pendientes la médica se valida acá (los demás renglones los valida recordSale).
  const providerId = actor.role === "medico" ? (actor.activeOrg?.providerId ?? null) : (v.providerId ?? null);
  let commissionPct = 0;
  if (lines.some((l) => !l.itemId)) {
    if (!providerId) return { ok: false, error: "Elegí qué médica la atendió.", status: 400 };
    const p = await getProvider(providerId);
    if (!p || p.organizationId !== orgId || !p.active) return { ok: false, error: "Profesional no encontrado en este consultorio.", status: 404 };
    commissionPct = (await isOwnerProvider(orgId, p.id)) ? 0 : p.commissionPct;
    for (const l of lines) {
      const pp = l.pendingPrice;
      if (pp !== undefined && pp !== null && (typeof pp !== "number" || !Number.isInteger(pp) || pp < 0 || pp > 100_000_000))
        return { ok: false, error: "El precio tiene que ser un número entero de pesos.", status: 400 };
    }
  }
  // Partes del pago (varios medios o dólares).
  const parts: PayPart[] = [];
  for (const p of Array.isArray(v.payments) ? v.payments : []) {
    const m = p?.method;
    if (m !== "efectivo" && m !== "transferencia" && m !== "tarjeta" && m !== "dolares" && m !== "giftcard" && m !== "profesional")
      return { ok: false, error: "Medio de pago inválido.", status: 400 };
    if (m === "dolares") {
      const usd = Number(p.usd), rate = Number(p.rate);
      if (!(usd > 0 && usd < 1_000_000) || !(rate > 0 && rate < 100_000)) return { ok: false, error: "Faltan los dólares o la cotización.", status: 400 };
      parts.push({ method: m, usd: Math.round(usd * 100) / 100, rate: Math.round(rate * 100) / 100, amount: Math.round(usd * rate) });
    } else {
      if (!pesos(p.amount) || !p.amount) continue;
      parts.push({ method: m, amount: p.amount as number });
    }
  }
  const visitMethod = parts.length === 1 ? parts[0].method : parts.length > 1 ? "mixto" : null;
  const raw = parts.length ? (parts.length === 1 && parts[0].method !== "dolares" ? parts[0].method : null) : v.paymentMethod;
  const method: PaymentMethod | null =
    raw === "efectivo" || raw === "transferencia" || raw === "tarjeta" || raw === "giftcard" || raw === "profesional" ? raw : null;
  // Gift card y «a la profesional» no son medios de la lista de precios: se cobra a precio efectivo y el medio se marca al final.
  const saleMethod = method === "giftcard" || method === "profesional" ? null : method;
  const debt = v.debt ?? null;
  if (v.owesUs !== undefined && v.owesUs !== null && !pesos(v.owesUs)) return { ok: false, error: "Lo que nos debe la profesional tiene que ser un número entero de pesos.", status: 400 };
  if (debt !== null && (!pesos(debt) || debt <= 0)) return { ok: false, error: "Lo que debe tiene que ser un número entero de pesos.", status: 400 };
  const patient = clean(v.patientName).slice(0, 120);
  if (debt && !patient) return { ok: false, error: "¿Quién quedó debiendo? Escribí el nombre del paciente.", status: 400 };
  // Toda práctica es de un paciente: «Atención» genérica o un ítem de la lista que no es producto.
  if (!patient) {
    for (const l of lines) {
      const practice = l.generic || (l.itemId ? (await getPriceItem(orgId, l.itemId))?.kind !== "producto" : false);
      if (practice) return { ok: false, error: "Falta el paciente: toda práctica es de un paciente.", status: 400 };
    }
  }
  const who = { id: actor.userId, name: actor.name, source: "manual" as const };
  const giftCardPaid = parts.filter((p) => p.method === "giftcard").reduce((n, p) => n + p.amount, 0);
  if (giftCardPaid > 0 && !clean(v.giftCardCode)) return { ok: false, error: "Consultá el código de la gift card antes de guardar.", status: 400 };
  if (clean(v.giftCardCode) && giftCardPaid <= 0) return { ok: false, error: "Indicá cuánto se usa de la gift card.", status: 400 };
  if (v.giftCardIssue && lines.length !== 1) return { ok: false, error: "La gift card se registra como una venta individual.", status: 400 };
  // La dueña (médica admin) no cobra comisión: una parte escrita a mano para ella no corre.
  const owner = await isOwnerProvider(orgId, providerId);
  let prepaid: Prepaid | null = null;
  if (v.prepaidId) {
    const pp = await prepaidForVisit(orgId, v.prepaidId, lines.map((l) => l.itemId), providerId, replacingVisitId);
    if (!pp.ok) return pp;
    prepaid = pp.prepaid;
    lines[pp.lineIndex] = { ...lines[pp.lineIndex], quantity: 1, amount: 0, commission: owner ? null : pp.commission };
  }
  let deposit: Deposit | null = null;
  let depositLine = -1;
  if (v.depositId) {
    const dr = await depositForVisit(orgId, v.depositId, replacingVisitId);
    if (!dr.ok) return dr;
    deposit = dr.deposit;
    depositLine = deposit.itemId ? lines.findIndex((l) => l.itemId === deposit!.itemId) : -1;
    if (depositLine < 0) {
      for (let i = 0; i < lines.length && depositLine < 0; i++) {
        const l = lines[i];
        if (l.generic || !l.itemId || (await getPriceItem(orgId, l.itemId))?.kind !== "producto") depositLine = i;
      }
    }
    if (depositLine < 0) return { ok: false, error: "La seña es de una práctica: falta qué se hizo.", status: 400 };
    const l = lines[depositLine];
    if (l.amount === undefined || l.amount === null) {
      const item = l.itemId ? await getPriceItem(orgId, l.itemId) : undefined;
      const qty = typeof l.quantity === "number" && l.quantity > 0 ? l.quantity : 1;
      const list = item ? (method === "tarjeta" ? (item.cardAmount ?? item.amount) : item.amount) * qty : (l.pendingPrice ?? 0) * qty;
      lines[depositLine] = { ...l, amount: Math.max(0, list - deposit.amount) };
    }
  }
  let insurer: Insurer | null = null;
  if (v.insurerId) {
    if (prepaid) return { ok: false, error: "Es por abono o por obra social, no las dos cosas.", status: 400 };
    const ir = await insurerForVisit(orgId, v.insurerId);
    if (!ir.ok) return ir;
    insurer = ir.insurer;
    // Las prácticas no pasan por caja; la profesional se lleva el monto de la obra social (una vez por atención).
    let first = true;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const practice = l.generic || !l.itemId || (await getPriceItem(orgId, l.itemId))?.kind !== "producto";
      if (!practice) continue;
      lines[i] = { ...l, amount: 0, commission: owner ? null : first ? insurer.fee : 0 };
      first = false;
    }
  }

  const visitId = newVisitId();
  const saleIds: string[] = [];
  let giftCardSale: { saleId: string; faceValue: number } | null = null;
  let total = 0, cashTotal = 0, cardTotal = 0, pending = 0;
  for (const l of lines) {
    if (!l.itemId) {
      const qty = typeof l.quantity === "number" && Number.isInteger(l.quantity) && l.quantity > 0 ? l.quantity : 1;
      const id = await insertPendingSale(
        orgId,
        {
          name: l.generic ? GENERIC_PRACTICE : clean(l.pendingName).slice(0, 80),
          kind: l.generic ? "tratamiento" : "pendiente",
          quantity: qty,
          providerId: providerId!,
          patientLabel: patient,
          visitId,
          paymentMethod: method,
          note: "",
          unitPrice: l.generic ? Math.round((l.amount ?? 0) / qty) : (l.pendingPrice ?? 0),
          commissionPct,
        },
        who,
      );
      saleIds.push(id);
      if (!l.generic) pending++;
      await applyManualAmounts(orgId, id, { amount: l.amount, commission: owner ? null : l.commission });
      const t = l.amount ?? (l.pendingPrice ?? 0) * qty;
      total += t;
      cashTotal += t;
      cardTotal += t;
      continue;
    }
    const priceItem = await getPriceItem(orgId, l.itemId);
    const stockItem = priceItem?.stockItemId ? await getStockItem(orgId, priceItem.stockItemId) : undefined;
    const isGiftCard = !!stockItem?.giftCard;
    if (v.giftCardIssue && !isGiftCard) return { ok: false, error: "Configurá un producto como gift card para emitir tarjetas.", status: 400 };
    if (isGiftCard && !v.giftCardIssue) return { ok: false, error: "Completá los datos de la gift card antes de guardar.", status: 400 };
    if (isGiftCard && (lines.length !== 1 || (l.quantity ?? 1) !== 1))
      return { ok: false, error: "Vendé una gift card por vez y sin otros productos en la misma anotación.", status: 400 };
    const r = await recordSale(actor, {
      itemId: l.itemId,
      quantity: l.quantity,
      providerId,
      paymentMethod: saleMethod,
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
    const manual = typeof l.amount === "number" && l.amount !== r.total;
    if (isGiftCard && v.giftCardIssue) {
      const faceValue = manual ? l.amount! : r.total;
      if (faceValue <= 0) return { ok: false, error: "El valor de la gift card debe ser mayor a cero.", status: 400 };
      giftCardSale = { saleId: r.saleId, faceValue };
    }
    let customCommission = l.commission ?? null;
    if (isGiftCard && manual && !owner && providerId && priceItem && customCommission === null) {
      const provider = await getProvider(providerId);
      const cut = await commissionFor(orgId, priceItem, provider);
      customCommission = cut.fixed !== null ? cut.fixed * (l.quantity ?? 1) : Math.round((l.amount! * cut.pct) / 100);
    }
    await applyManualAmounts(orgId, r.saleId, { amount: manual ? l.amount : null, commission: owner ? null : customCommission });
    total += manual ? l.amount! : r.total;
    cashTotal += manual ? l.amount! : r.cashTotal;
    cardTotal += manual ? l.amount! : r.cardTotal;
  }
  if (prepaid) await recordPrepaidUse(orgId, prepaid, visitId);
  if (giftCardPaid > 0) {
    const used = await redeemGiftCard(actor, {
      code: clean(v.giftCardCode),
      visitId,
      amount: giftCardPaid,
      itemIds: lines.map((l) => l.itemId).filter((id): id is string => !!id),
      replacingVisitId,
    });
    if (!used.ok) {
      for (const id of saleIds) {
        await markSaleVoided(orgId, id, "No se pudo canjear la gift card", who);
        await restoreStockForSale(orgId, id, who);
      }
      return used;
    }
  }
  if (insurer) await recordInsurerVisit(orgId, visitId, insurer, owner ? 0 : insurer.fee);
  if (deposit) {
    // La parte de la profesional sobre el total de la práctica (lo de hoy + la seña), salvo que se haya escrito a mano.
    const l = lines[depositLine];
    if (!owner && (l.commission === undefined || l.commission === null) && providerId) {
      const base = (l.amount ?? 0) + deposit.amount;
      const prov = await getProvider(providerId);
      const item = l.itemId ? await getPriceItem(orgId, l.itemId) : undefined;
      const cut = prov ? (item ? await commissionFor(orgId, item, prov) : { pct: prov.commissionPct, fixed: null }) : { pct: 0, fixed: null };
      await applyManualAmounts(orgId, saleIds[depositLine], { commission: cut.fixed !== null ? cut.fixed : Math.round((base * cut.pct) / 100) });
    }
    await applyDeposit(orgId, deposit.id, visitId);
  }
  const obs = clean(v.observations).slice(0, 300);
  if (obs) await setVisitObservations(orgId, visitId, obs);
  if (parts.length) await insertVisitPayments(orgId, visitId, parts);
  const finalMethod = parts.length ? visitMethod : method;
  if (finalMethod && finalMethod !== saleMethod) await setVisitMethod(orgId, visitId, finalMethod);
  // Le pagaron directo a la profesional y se dijo cuánto nos debe ella: su parte es lo que cobró menos eso.
  if (!owner && v.owesUs !== undefined && v.owesUs !== null) {
    const direct = parts.length ? parts.filter((p) => p.method === "profesional").reduce((n, p) => n + p.amount, 0) : method === "profesional" ? total : 0;
    if (direct > 0) await setVisitShareTotal(orgId, visitId, Math.max(0, direct - v.owesUs));
  }
  if (debt) {
    // La parte de la profesional en lo que se debe: su % del renglón donde va la diferencia (la primera
    // práctica, o el primer renglón). Si su parte era plata fija o la aclaró la secretaria, ya la cobra
    // entera con la anotación: la deuda va toda para el consultorio.
    const sales = await listVisitSales(orgId, visitId);
    const k = sales.find((s) => s.kind !== "producto") ?? sales[0];
    const share = !k || k.commissionManual || k.commissionFixed !== null ? 0 : Math.round((debt * k.commissionPct) / 100);
    const concept = sales.map((s) => (s.quantity > 1 ? `${s.quantity} ${s.itemName}` : s.itemName)).join(", ");
    const d = await createDebt(actor, { debtor: patient, amount: debt, concept, providerId: k?.providerId ?? providerId, share, visitId, remindOn: v.debtRemindOn });
    if (!d.ok) {
      for (const id of saleIds) {
        await markSaleVoided(orgId, id, "No se pudo anotar todo junto", who);
        await restoreStockForSale(orgId, id, who);
      }
      return d;
    }
  }
  let giftCardCode: string | undefined;
  if (giftCardSale && v.giftCardIssue) {
    const issued = await issueGiftCard(actor, {
      saleId: giftCardSale.saleId,
      kind: v.giftCardIssue.kind,
      faceValue: giftCardSale.faceValue,
      treatmentItemId: v.giftCardIssue.treatmentItemId,
      buyer: v.giftCardIssue.buyer,
    });
    if (!issued.ok) return issued;
    giftCardCode = issued.code;
  }
  return { ok: true, visitId, saleIds, total, cashTotal, cardTotal, pending, ...(giftCardCode ? { giftCardCode } : {}) };
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

  const r = await recordVisit(actor, v, old[0].visitId ?? undefined);
  if (!r.ok) return r;
  const who = { id: actor.userId, name: actor.name, source: "manual" as const };
  for (const s of old) {
    if (await markSaleEdited(orgId, s.id, who)) await restoreStockForSale(orgId, s.id, who);
  }
  await stampVisit(orgId, r.visitId, old[0].createdAt, `Editado por ${actor.name}`);
  if (old[0].visitId) {
    await relinkDebts(orgId, old[0].visitId, r.visitId);
    // Abono: sin decir nada, la sesión pasa a la versión nueva; con `prepaidId` ya se anotó de nuevo; con null, se suelta.
    if (v.prepaidId === undefined) await relinkPrepaidUses(orgId, old[0].visitId, r.visitId);
    else await dropPrepaidUses(orgId, old[0].visitId);
    // Obra social, igual: sin la clave sigue; con id ya se anotó de nuevo; con null deja de serlo.
    if (v.insurerId === undefined) await relinkInsurerVisit(orgId, old[0].visitId, r.visitId);
    else await dropInsurerVisit(orgId, old[0].visitId);
    // Seña: sin la clave sigue en la atención nueva; con id ya quedó en la nueva; con null se suelta.
    if (v.depositId === undefined) await relinkDeposit(orgId, old[0].visitId, r.visitId);
    else if (v.depositId === null) await releaseDeposit(orgId, old[0].visitId);
    if (v.giftCardCode === undefined) await relinkGiftCardUses(orgId, old[0].visitId, r.visitId);
    else if (v.giftCardCode === null) await dropGiftCardUses(orgId, old[0].visitId);
  }
  return { ok: true, visitId: r.visitId };
}

/**
 * Deja la parte de la profesional en toda la anotación en `share`: la primera práctica se lleva lo que falta después
 * de los demás renglones (que conservan la suya). Se marca a mano (no la pisa un recálculo).
 */
async function setVisitShareTotal(orgId: string, visitId: string, share: number): Promise<void> {
  const sales = await listVisitSales(orgId, visitId);
  if (!sales.length) return;
  const k = sales.find((s) => s.kind !== "producto") ?? sales[0];
  const others = sales.filter((s) => s.id !== k.id).reduce((n, s) => n + s.commissionAmount, 0);
  await applyManualAmounts(orgId, k.id, { commission: Math.max(0, share - others) });
}
