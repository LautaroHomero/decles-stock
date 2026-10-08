import { updateStockSettings } from "@/lib/domain/stock";
import { refreshAfterChange } from "@/lib/domain/notifications";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Admin: `{ expiryDays }` — con cuántos días de anticipación se avisa que algo vence. */
export async function PATCH(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ expiryDays: number }>(req);
  const r = await updateStockSettings(actor, { expiryDays: b.expiryDays });
  if (r.ok) await refreshAfterChange(actor);
  return respond(r);
}
