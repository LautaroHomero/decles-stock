import { recordSale, salesList } from "@/lib/domain/billing";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { listVisitPayments } from "@/lib/db/payments-repo";
import { debtsForVisits } from "@/lib/domain/debts";
import { actorOr401, bodyOf, respond } from "../_http";

/** Ventas de un rango: `?from=AAAA-MM-DD&to=AAAA-MM-DD` (por defecto, hoy). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const q = new URL(req.url).searchParams;
  const r = await salesList(actor, q.get("from") ?? undefined, q.get("to") ?? undefined, Number(q.get("limit")) || 200);
  if (!r.ok || !actor.activeOrg) return respond(r);
  // Pagos en varios medios / dólares de cada anotación (visit_id → partes).
  const ids = [...new Set(r.sales.filter((s) => s.visitId && (s.paymentMethod === "mixto" || s.paymentMethod === "dolares")).map((s) => s.visitId!))];
  // Lo que quedó debiendo en cada anotación (visit_id → importe y lo que falta). La médica no maneja caja.
  const visits = [...new Set(r.sales.filter((s) => s.visitId).map((s) => s.visitId!))];
  const debts = actor.role === "medico" ? {} : await debtsForVisits(actor.activeOrg.id, visits);
  const debtMap = Object.fromEntries(Object.entries(debts).map(([k, d]) => [k, { amount: d.amount, remaining: d.remaining }]));
  return respond({ ...r, payments: await listVisitPayments(actor.activeOrg.id, ids), debts: debtMap });
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
