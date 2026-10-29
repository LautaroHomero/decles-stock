import { voidProviderDebt } from "@/lib/domain/payouts";
import { actorOr401, respond } from "../../_http";

/** Anular un «le quedamos debiendo» (si todavía no se le pagó nada). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await voidProviderDebt(actor, (await ctx.params).id));
}
