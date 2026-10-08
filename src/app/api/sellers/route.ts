import { listSellers } from "@/lib/domain/accounts";
import { actorOr401, respond } from "../_http";

/** Médicas activas, para elegir quién vendió. */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await listSellers(actor));
}
