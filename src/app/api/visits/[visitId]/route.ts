import { editVisit, type VisitInput } from "@/lib/domain/visits";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Editar una anotación: mismo cuerpo que al anotar. Reemplaza la versión anterior (y su stock). */
export async function PUT(req: Request, ctx: { params: Promise<{ visitId: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<VisitInput>(req);
  const r = await editVisit(actor, (await ctx.params).visitId, {
    patientName: b.patientName,
    providerId: b.providerId,
    paymentMethod: b.paymentMethod,
    lines: b.lines ?? [],
  });
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
