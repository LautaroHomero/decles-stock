import { recordVisit, type VisitInput } from "@/lib/domain/visits";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../_http";

/**
 * Anotar todo junto: `{ patientName?, providerId?, paymentMethod?, lines: [{ itemId, quantity?, expiresOn? }] }`.
 * Prácticas y productos; los productos descuentan stock. O se anota todo o nada.
 */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<VisitInput>(req);
  const r = await recordVisit(actor, { patientName: b.patientName, providerId: b.providerId, paymentMethod: b.paymentMethod, payments: b.payments, observations: b.observations, debt: b.debt, debtRemindOn: b.debtRemindOn, prepaidId: b.prepaidId, giftCardCode: b.giftCardCode, giftCardIssue: b.giftCardIssue, insurerId: b.insurerId, depositId: b.depositId, owesUs: b.owesUs, lines: b.lines ?? [] });
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
