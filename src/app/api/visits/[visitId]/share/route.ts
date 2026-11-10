import { changeShare } from "@/lib/domain/share-requests";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../../_http";

/** Lo que se lleva la profesional en esta atención: `{ share, reason? }`. Admin: queda. Otro: queda pedido para el admin. */
export async function PATCH(req: Request, ctx: { params: Promise<{ visitId: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const r = await changeShare(actor, (await ctx.params).visitId, await bodyOf<{ share: number; reason: string }>(req));
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
