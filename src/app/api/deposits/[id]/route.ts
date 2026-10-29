import { setDepositDate, voidDeposit } from "@/lib/domain/deposits";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Cambiar el día del turno: `{ dueOn }`. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ dueOn: string | null }>(req);
  return respond(await setDepositDate(actor, (await ctx.params).id, b.dueOn));
}

/** Anular (si no se usó). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await voidDeposit(actor, (await ctx.params).id));
}
