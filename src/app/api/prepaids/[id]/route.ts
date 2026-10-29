import { voidPrepaid } from "@/lib/domain/prepaids";
import { actorOr401, respond } from "../../_http";

/** Anular un abono mal anotado (si todavía no se usó ninguna sesión). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await voidPrepaid(actor, (await ctx.params).id));
}
