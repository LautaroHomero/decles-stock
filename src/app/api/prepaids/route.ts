import { createPrepaid, listPrepaids, prepaidUsesOn } from "@/lib/domain/prepaids";
import { actorOr401, bodyOf, respond } from "../_http";

/** Abonos con sesiones o saldo pendiente. Con `?date=AAAA-MM-DD`, además qué atenciones de ese día son sesiones de un abono (`uses`). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const r = await listPrepaids(actor);
  const date = new URL(req.url).searchParams.get("date");
  if (!r.ok || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return respond(r);
  return respond({ ...r, uses: await prepaidUsesOn(actor, date) });
}

/** Anotar un abono: `{ patient, itemId, sessions? (vacío = saldo en plata), amount, unitPrice?, method? }`. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ patient: string; itemId: string; sessions: number | null; amount: number; unitPrice: number | null; method: string }>(req);
  return respond(await createPrepaid(actor, b));
}
