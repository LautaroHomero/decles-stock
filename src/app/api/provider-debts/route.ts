import { createProviderDebt, listProviderDebts } from "@/lib/domain/payouts";
import { actorOr401, bodyOf, respond } from "../_http";

/** Deudas abiertas con profesionales: `?direction=profesional` = lo que nos deben ellas; si no, lo que les debemos. */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const dir = new URL(req.url).searchParams.get("direction") === "profesional" ? "profesional" : "consultorio";
  return respond(await listProviderDebts(actor, dir));
}

/**
 * «Le quedamos debiendo» / «nos queda debiendo» (`direction: "profesional"`):
 * `{ providerId, amount? ("todo" o vacío = lo de ese día), date?, direction? }`.
 */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ providerId: string; amount: number | string | null; date: string; direction?: string }>(req);
  return respond(await createProviderDebt(actor, b));
}
