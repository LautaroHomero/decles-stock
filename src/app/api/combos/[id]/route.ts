import { updateCombo } from "@/lib/domain/combos";
import { actorOr401, bodyOf, respond } from "../../_http";

/** `{ name?, price?, cardPrice?, items?, active? }`. Solo admin. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await updateCombo(actor, (await ctx.params).id, await bodyOf<Record<string, unknown>>(req)));
}
