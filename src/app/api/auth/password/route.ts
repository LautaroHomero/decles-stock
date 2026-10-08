import { actorFromRequest } from "@/lib/auth/actor";
import { changeOwnPassword } from "@/lib/domain/accounts";
import { bodyOf, respond } from "../../_http";

/** Cambiar la contraseña propia: `{ current, next }`. Es lo único permitido con una contraseña temporal. */
export async function POST(req: Request) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ ok: false, error: "No autenticado." }, { status: 401 });
  const b = await bodyOf<{ current: string; next: string }>(req);
  return respond(await changeOwnPassword(actor, b.current ?? "", b.next ?? ""));
}
