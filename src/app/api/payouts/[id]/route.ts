import { voidPayout } from "@/lib/domain/payouts";
import { actorOr401, respond } from "../../_http";

/** Anular un pago a profesional. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await voidPayout(actor, (await ctx.params).id));
}
