import { createInsurer, insurerVisitsOn, listInsurers } from "@/lib/domain/insurers";
import { actorOr401, bodyOf, respond } from "../_http";

/** Obras sociales y prepagas. Con `?date=AAAA-MM-DD`, además qué atenciones de ese día fueron por obra social (`visits`). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const r = await listInsurers(actor);
  const date = new URL(req.url).searchParams.get("date");
  if (!r.ok || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return respond(r);
  return respond({ ...r, visits: await insurerVisitsOn(actor, date) });
}

/** `{ name, fee }` (lo que se lleva la profesional por atención). Solo admin. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await createInsurer(actor, await bodyOf<{ name: string; fee: number }>(req)));
}
