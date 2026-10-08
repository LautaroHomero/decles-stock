import { recordSale, salesList } from "@/lib/domain/billing";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../_http";

/** Ventas de un rango: `?from=AAAA-MM-DD&to=AAAA-MM-DD` (por defecto, hoy). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const q = new URL(req.url).searchParams;
  return respond(await salesList(actor, q.get("from") ?? undefined, q.get("to") ?? undefined, Number(q.get("limit")) || 200));
}

/** Registra una venta: `{ itemId, quantity, providerId, paymentMethod?, expiresOn?, note? }`. Descuenta stock. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ itemId: string; quantity: number; providerId: string; paymentMethod: string; expiresOn: string; note: string }>(req);
  const r = await recordSale(actor, { itemId: b.itemId ?? "", quantity: b.quantity, providerId: b.providerId, paymentMethod: b.paymentMethod, expiresOn: b.expiresOn, note: b.note });
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
