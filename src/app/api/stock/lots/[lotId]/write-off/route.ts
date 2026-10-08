import { writeOffLot } from "@/lib/domain/stock";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../../../_http";

/** Baja de un lote entero (admin): `{ reason?: "vencimiento"|"perdida"|"ajuste", note? }`. */
export async function POST(req: Request, ctx: { params: Promise<{ lotId: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ reason: "vencimiento" | "perdida" | "ajuste"; note: string }>(req);
  const r = await writeOffLot(actor, (await ctx.params).lotId, b.reason, b.note);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
