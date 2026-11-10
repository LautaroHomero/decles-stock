import { editVisit, voidVisit, type VisitInput } from "@/lib/domain/visits";
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
    payments: b.payments,
    observations: b.observations,
    // Abono: sin la clave, la sesión sigue igual; con un id, es de ese abono; con null, deja de serlo.
    ...("prepaidId" in b ? { prepaidId: b.prepaidId ?? null } : {}),
    ...("insurerId" in b ? { insurerId: b.insurerId ?? null } : {}),
    ...("depositId" in b ? { depositId: b.depositId ?? null } : {}),
    ...("combos" in b ? { combos: b.combos ?? [] } : {}),
    lines: b.lines ?? [],
  });
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}

/** Borrar (anular) una atención entera: solo el admin, `{ reason }`. Queda tachada en Ventas con el motivo. */
export async function DELETE(req: Request, ctx: { params: Promise<{ visitId: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ reason: string }>(req);
  const r = await voidVisit(actor, (await ctx.params).visitId, b.reason);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
