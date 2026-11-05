import { deleteNote, updateNote } from "@/lib/domain/notes";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Corregir una nota: `{ text, patient?, remindOn? }` (quien la escribió o el admin). `{ remindDone: true }` = «Hecho» (cualquiera del equipo). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await updateNote(actor, (await ctx.params).id, await bodyOf<{ text: string; patient: string; remindOn: string | null; remindDone: boolean }>(req)));
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await deleteNote(actor, (await ctx.params).id));
}
