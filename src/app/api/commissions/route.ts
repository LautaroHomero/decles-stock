import { commissions } from "@/lib/domain/billing";
import { actorOr401, respond } from "../_http";

/** Ventas y comisión por médica: `?from=AAAA-MM-DD&to=AAAA-MM-DD` (por defecto, el mes en curso). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const q = new URL(req.url).searchParams;
  return respond(await commissions(actor, q.get("from") ?? undefined, q.get("to") ?? undefined));
}
