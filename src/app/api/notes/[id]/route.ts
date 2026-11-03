import { deleteNote, updateNote } from "@/lib/domain/notes";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Corregir una nota: `{ text, patient? }` (quien la escribió o el admin). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await updateNote(actor, (await ctx.params).id, await bodyOf<{ text: string; patient: string }>(req)));
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await deleteNote(actor, (await ctx.params).id));
}
