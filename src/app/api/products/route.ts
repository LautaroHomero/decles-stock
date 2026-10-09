import { createProduct } from "@/lib/domain/products";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../_http";

/** Alta (admin): `{ name, price, unit?, category?, minQuantity?, quantity?, expiresOn?, lotCode?, providerIds? }`. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{
    name: string;
    price: number;
    cardPrice: number | null;
    unit: string;
    category: string;
    minQuantity: number;
    quantity: number;
    expiresOn: string;
    lotCode: string;
    providerIds: string[];
    commissionPct: number | null;
  }>(req);
  const r = await createProduct(actor, { ...b, name: b.name ?? "", price: b.price as number });
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
