import { resolveShareRequest } from "@/lib/domain/share-requests";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../_http";

/** `{ approve: true | false }`. Solo admin. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const r = await resolveShareRequest(actor, (await ctx.params).id, (await bodyOf<{ approve: boolean }>(req)).approve);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
