import { updateInsurer } from "@/lib/domain/insurers";
import { actorOr401, bodyOf, respond } from "../../_http";

/** `{ name?, fee?, active? }`. Solo admin. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await updateInsurer(actor, (await ctx.params).id, await bodyOf<{ name: string; fee: number; active: boolean }>(req)));
}
