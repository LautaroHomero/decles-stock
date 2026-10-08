import { readNotifications } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Marca leída `{ id }`, o todas si no viene `id`. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ id: string }>(req);
  return respond(await readNotifications(actor, b.id));
}
