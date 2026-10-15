import { createPractice, listPractices } from "@/lib/domain/products";
import { actorOr401, bodyOf, respond } from "../_http";

/** Prácticas (atención, peeling…) con su precio. Listar: todo el equipo; cargar: admin. */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await listPractices(actor));
}

/** `{ name, price, cardPrice? }` */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ name: string; price: number; cardPrice: number | null; providerIds: string[]; commissionPct: number | null; providerCuts: Record<string, { pct?: number | null; fixed?: number | null }> }>(req);
  return respond(
    await createPractice(actor, { name: b.name ?? "", price: b.price as number, cardPrice: b.cardPrice, providerIds: b.providerIds, commissionPct: b.commissionPct, providerCuts: b.providerCuts }),
  );
}
