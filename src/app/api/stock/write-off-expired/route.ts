import { writeOffExpired } from "@/lib/domain/stock";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Da de baja todos los lotes vencidos (admin). `{ itemId? }` para uno solo. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ itemId: string }>(req);
  const r = await writeOffExpired(actor, b.itemId);
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
