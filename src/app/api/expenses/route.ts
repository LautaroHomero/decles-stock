import { createExpense, listExpenses } from "@/lib/domain/expenses";
import { actorOr401, bodyOf, respond } from "../_http";

/** Egresos (o ingresos extras con `direction=ingreso`): `?from=AAAA-MM-DD&to=AAAA-MM-DD` (por defecto, hoy). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const q = new URL(req.url).searchParams;
  return respond(await listExpenses(actor, q.get("from") ?? undefined, q.get("to") ?? undefined, q.get("direction") === "ingreso" ? "ingreso" : "egreso"));
}

export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ concept: string; amount: number; direction: string; method: string }>(req);
  return respond(await createExpense(actor, b));
}
