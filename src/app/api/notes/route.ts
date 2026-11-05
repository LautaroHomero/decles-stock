import { createNote, listNotes } from "@/lib/domain/notes";
import { actorOr401, bodyOf, respond } from "../_http";

/** Notas: `?reminders=1` (las de recordatorio pendiente), `?q=` (paciente o texto), `?from=&to=` (AAAA-MM-DD), `?visits=vis_1,vis_2` (las de esas atenciones). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const p = new URL(req.url).searchParams;
  const visits = p.get("visits");
  return respond(
    await listNotes(actor, {
      q: p.get("q"),
      from: p.get("from"),
      to: p.get("to"),
      visitIds: visits !== null ? visits.split(",").filter(Boolean).slice(0, 500) : null,
      reminders: p.get("reminders") === "1",
    }),
  );
}

/** `{ patient?, text, visitId?, date?, remindOn? }`: con `visitId`, la nota queda pegada a esa atención (su paciente y su día). */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await createNote(actor, await bodyOf<{ patient: string; text: string; visitId: string; date: string; remindOn: string | null }>(req)));
}
