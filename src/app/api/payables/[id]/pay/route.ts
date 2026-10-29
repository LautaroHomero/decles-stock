import { payPayable } from "@/lib/domain/payables";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../../_http";

/** Pagar: `{ amount? (vacío = todo), method? }`. Es un egreso de hoy. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ amount: number | null; method: string }>(req);
  const r = await payPayable(actor, (await ctx.params).id, b);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
