import { listPending } from "@/lib/domain/pending";
import { actorOr401, respond } from "../_http";

/** Lo anotado que todavía no está en la lista de precios (admin). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await listPending(actor));
}
