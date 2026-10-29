import { dueDebtReminders } from "@/lib/domain/debts";
import { actorOr401, respond } from "../../_http";

/** Deudas para cobrar hoy: abiertas con recordatorio de hoy o anterior. */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await dueDebtReminders(actor));
}
