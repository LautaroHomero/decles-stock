import { resetMemberPassword } from "@/lib/domain/accounts";
import { actorOr401, respond } from "../../../_http";

/** Contraseña temporal nueva para esa persona (admin). Cierra sus sesiones abiertas. */
export async function POST(req: Request, ctx: { params: Promise<{ userId: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await resetMemberPassword(actor, (await ctx.params).userId));
}
