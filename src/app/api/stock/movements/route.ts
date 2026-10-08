import { stockHistory } from "@/lib/domain/stock";
import { actorOr401, respond } from "../../_http";

/** Historial de movimientos: `?itemId=…&limit=…`. */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const q = new URL(req.url).searchParams;
  return respond(await stockHistory(actor, q.get("itemId") ?? undefined, Number(q.get("limit")) || 100));
}
