import { dayDebts } from "@/lib/domain/debts";
import { actorOr401, respond } from "../../_http";

/** Lo de deudas de un día: lo cobrado (entra a la caja) y lo que quedó debiendo. `?date=AAAA-MM-DD`. */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await dayDebts(actor, new URL(req.url).searchParams.get("date") ?? undefined));
}
