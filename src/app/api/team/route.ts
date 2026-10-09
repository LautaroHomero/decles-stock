import { createMember, listTeam } from "@/lib/domain/accounts";
import type { StaffRole } from "@/lib/domain/types";
import { actorOr401, bodyOf, respond } from "../_http";

/** Equipo del consultorio (admin). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await listTeam(actor));
}

/** Alta (admin): `{ name, username, role, isAdmin?, commissionPct?, aliases?, email? }` → devuelve la contraseña temporal. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ name: string; username: string; role: StaffRole; isAdmin: boolean; commissionPct: number; aliases: string; email: string; area: string }>(req);
  return respond(
    await createMember(actor, { name: b.name ?? "", username: b.username ?? "", role: b.role as StaffRole, isAdmin: b.isAdmin, commissionPct: b.commissionPct, aliases: b.aliases, email: b.email, area: b.area }),
  );
}
