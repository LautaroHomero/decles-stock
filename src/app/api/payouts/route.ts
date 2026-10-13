import { createPayout, listPayouts } from "@/lib/domain/payouts";
import { actorOr401, bodyOf, respond } from "../_http";

/** Pagos a profesionales del día y lo que se le debe a cada una: `?date=AAAA-MM-DD`. */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await listPayouts(actor, new URL(req.url).searchParams.get("date") ?? undefined));
}

/** `{ providerId, amount? ("todo" o vacío = lo que se le debe), date? }`. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ providerId: string; amount: number | string | null; date: string }>(req);
  return respond(await createPayout(actor, b));
}
