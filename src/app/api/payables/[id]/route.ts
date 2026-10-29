import { setPayableReminder, voidPayable } from "@/lib/domain/payables";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Cambiar el recordatorio: `{ remindMode: "daily" | "at" | null, remindAt? }`. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ remindMode: string | null; remindAt: string | null }>(req);
  const r = await setPayableReminder(actor, (await ctx.params).id, b);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}

/** Anular (si no se pagó nada). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const r = await voidPayable(actor, (await ctx.params).id);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
