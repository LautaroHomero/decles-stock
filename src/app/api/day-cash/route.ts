import { getDayCash, setDayCash } from "@/lib/domain/day-cash";
import { actorOr401, bodyOf, respond } from "../_http";

/** Dinero en caja al momento del cambio: `?date=AAAA-MM-DD`. */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await getDayCash(actor, new URL(req.url).searchParams.get("date") ?? undefined));
}

/** `{ date?, amount }` (amount null = borrar). */
export async function PUT(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ date: string; amount: number | null }>(req);
  return respond(await setDayCash(actor, b.date, b.amount));
}
