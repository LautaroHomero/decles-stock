import { myNotifications } from "@/lib/domain/notifications";
import { actorOr401, respond } from "../_http";

/** Campanita: últimas notificaciones del usuario y cuántas sin leer. */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await myNotifications(actor));
}
