import { createPayable, listPayables } from "@/lib/domain/payables";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../_http";

/** Lo que debe el consultorio (pendiente). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await listPayables(actor));
}

/** `{ creditor, concept?, amount, remindMode? ("daily" | "at"), remindAt? (AAAA-MM-DDTHH:MM) }`. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ creditor: string; concept: string; amount: number; remindMode: string | null; remindAt: string | null }>(req);
  const r = await createPayable(actor, b);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
