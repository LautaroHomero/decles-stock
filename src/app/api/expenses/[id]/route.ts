import { updateExpense, voidExpense } from "@/lib/domain/expenses";
import { actorOr401, bodyOf, respond } from "../../_http";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ concept: string; amount: number }>(req);
  return respond(await updateExpense(actor, (await ctx.params).id, b));
}

/** Anular un egreso. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await voidExpense(actor, (await ctx.params).id));
}
