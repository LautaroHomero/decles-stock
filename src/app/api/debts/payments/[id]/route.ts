import { voidDebtPayment } from "@/lib/domain/debts";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, respond } from "../../../_http";

/** Deshacer un cobro de deuda (la deuda vuelve a quedar abierta). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const r = await voidDebtPayment(actor, (await ctx.params).id);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
