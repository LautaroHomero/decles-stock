import { updateMember } from "@/lib/domain/accounts";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Editar (admin): `{ name?, isAdmin?, commissionPct?, active?, aliases?, email? }`. `active: false` = baja. */
export async function PATCH(req: Request, ctx: { params: Promise<{ userId: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ name: string; isAdmin: boolean; commissionPct: number; active: boolean; aliases: string; email: string; area: string }>(req);
  return respond(await updateMember(actor, (await ctx.params).userId, b));
}
