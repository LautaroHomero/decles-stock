import { completeSalePayment } from "@/lib/domain/billing";
import { actorOr401, bodyOf, respond } from "../../../_http";

/** Cargar después el medio de pago de una venta que quedó sin él: `{ method: "efectivo"|"tarjeta" }`. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ method: string }>(req);
  return respond(await completeSalePayment(actor, (await ctx.params).id, b.method ?? ""));
}
