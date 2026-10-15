import { payDebt } from "@/lib/domain/debts";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../../_http";

/** Cobrar una deuda: `{ amount? (vacío = todo lo que falta), method?, date? }`. Entra a la caja del día. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ amount: number | string | null; method: string | null; date: string }>(req);
  const r = await payDebt(actor, (await ctx.params).id, b);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
