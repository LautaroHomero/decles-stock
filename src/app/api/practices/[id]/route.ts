import { updatePractice } from "@/lib/domain/products";
import { actorOr401, bodyOf, respond } from "../../_http";

/** `{ name?, price?, cardPrice?, active? }` (admin). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ name: string; price: number; cardPrice: number | null; active: boolean; providerIds: string[]; commissionPct: number | null }>(req);
  return respond(await updatePractice(actor, (await ctx.params).id, b));
}
