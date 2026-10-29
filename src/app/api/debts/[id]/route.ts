import { setDebtReminder, voidDebt } from "@/lib/domain/debts";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../_http";

/** `{ remindOn }`: la fecha para acordarse de cobrarla (AAAA-MM-DD; null = sin recordatorio). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ remindOn: string | null }>(req);
  const r = await setDebtReminder(actor, (await ctx.params).id, b.remindOn ?? null);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}

/** Anular una deuda mal anotada (sin cobros). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const r = await voidDebt(actor, (await ctx.params).id);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
