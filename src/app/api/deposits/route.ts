import { createDeposit, depositsUsedOn, listDeposits } from "@/lib/domain/deposits";
import { actorOr401, bodyOf, respond } from "../_http";

/** Señas sin usar. Con `?date=AAAA-MM-DD`, además qué atenciones de ese día descontaron una (`used`). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const r = await listDeposits(actor);
  const date = new URL(req.url).searchParams.get("date");
  if (!r.ok || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return respond(r);
  return respond({ ...r, used: await depositsUsedOn(actor, date) });
}

/** `{ patient, itemId?, amount, method?, dueOn? }`: la seña entra a la caja hoy. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await createDeposit(actor, await bodyOf<{ patient: string; itemId: string; amount: number; method: string; dueOn: string }>(req)));
}
