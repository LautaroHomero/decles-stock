import { resolvePending } from "@/lib/domain/pending";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Resolver (admin): `{ itemId }` o `{ create: { kind: "tratamiento"|"producto", name, price, cardPrice? } }`. */
export async function POST(req: Request, ctx: { params: Promise<{ saleId: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ itemId: string; create: { kind: "tratamiento" | "producto"; name: string; price: number; cardPrice: number | null } }>(req);
  const r = await resolvePending(actor, (await ctx.params).saleId, { itemId: b.itemId, create: b.create });
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
