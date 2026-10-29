import { payProviderDebts } from "@/lib/domain/payouts";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Saldar lo de otros días: `{ providerId | debtId, amount? (vacío = todo), method?, direction? ("profesional" = nos paga ella) }`. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ providerId: string; debtId: string; amount: number | string | null; method: string; direction?: string }>(req);
  return respond(await payProviderDebts(actor, b));
}
