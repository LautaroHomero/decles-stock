import { noShowsOn } from "@/lib/domain/no-shows";
import { actorOr401 } from "../_http";

/** Atenciones ausentes de un día: `?date=AAAA-MM-DD` → `{ ok, visits: [{ visitId, paidBefore }] }`. */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const date = new URL(req.url).searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ ok: false, error: "Falta la fecha." }, { status: 400 });
  return Response.json({ ok: true, visits: await noShowsOn(actor, date) });
}
