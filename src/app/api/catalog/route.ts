import { catalog } from "@/lib/domain/products";
import { actorOr401, respond } from "../_http";

/** Productos vendibles del consultorio activo: precio, stock vigente, vencimientos y alertas. */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await catalog(actor));
}
