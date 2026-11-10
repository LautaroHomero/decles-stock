import { comboVisitsOn, createCombo, listCombos } from "@/lib/domain/combos";
import { actorOr401, bodyOf, respond } from "../_http";

/** Combos / promos. Con `?date=AAAA-MM-DD`, además qué atenciones de ese día tuvieron combo (`visits`). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const r = await listCombos(actor);
  const date = new URL(req.url).searchParams.get("date");
  if (!r.ok || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return respond(r);
  return respond({ ...r, visits: await comboVisitsOn(actor, date) });
}

/** `{ name, price, cardPrice?, items: [{ itemId, qty }] }`. Solo admin. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await createCombo(actor, await bodyOf<Record<string, unknown>>(req)));
}
