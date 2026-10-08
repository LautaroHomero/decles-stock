import { updateProduct } from "@/lib/domain/products";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Edita (admin): `{ name?, price?, cardPrice?, unit?, category?, minQuantity?, active? }`. `cardPrice: null` = igual a efectivo. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ name: string; price: number; cardPrice: number | null; unit: string; category: string; minQuantity: number; active: boolean }>(req);
  const r = await updateProduct(actor, (await ctx.params).id, b);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
