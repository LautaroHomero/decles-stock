import { createDebt, listDebts } from "@/lib/domain/debts";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../_http";

/** Deudas abiertas (`?recent=30`: también las pagadas en los últimos 30 días). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const recent = Number(new URL(req.url).searchParams.get("recent") ?? 0);
  return respond(await listDebts(actor, Number.isFinite(recent) ? Math.min(Math.max(recent, 0), 365) : 0));
}

/** `{ debtor, amount, concept?, providerId?, share?, remindOn? (AAAA-MM-DD) }` */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ debtor: string; amount: number; concept: string; providerId: string | null; share: number | null; remindOn: string | null }>(req);
  const r = await createDebt(actor, { debtor: b.debtor, amount: b.amount, concept: b.concept, providerId: b.providerId, share: b.share, remindOn: b.remindOn });
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
