import { voidSale } from "@/lib/domain/billing";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../../_http";

/** Anula una venta (admin) y devuelve el stock a sus lotes: `{ reason }`. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ reason: string }>(req);
  const r = await voidSale(actor, (await ctx.params).id, b.reason ?? "");
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
