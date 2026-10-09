import { dayClose } from "@/lib/domain/day-close";
import { actorOr401, respond } from "../_http";

/** Cierre del día: `?date=AAAA-MM-DD` (por defecto, hoy). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await dayClose(actor, new URL(req.url).searchParams.get("date") ?? undefined));
}
