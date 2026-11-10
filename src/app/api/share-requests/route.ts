import { listShareRequests } from "@/lib/domain/share-requests";
import { actorOr401, respond } from "../_http";

/** Pedidos abiertos de cambio de la parte de la profesional (`?date=AAAA-MM-DD`: los de las atenciones de ese día). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await listShareRequests(actor, new URL(req.url).searchParams.get("date")));
}
