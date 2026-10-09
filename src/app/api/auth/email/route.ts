import { actorFromRequest } from "@/lib/auth/actor";
import { ownEmail, setOwnEmail } from "@/lib/domain/accounts";
import { bodyOf, respond } from "../../_http";

// El email propio (para recuperar la contraseña). Se permite aun con contraseña temporal:
// la pantalla de primer ingreso lo pide.

export async function GET(req: Request) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ ok: false, error: "No autenticado." }, { status: 401 });
  return Response.json({ ok: true, email: await ownEmail(actor) });
}

export async function POST(req: Request) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ ok: false, error: "No autenticado." }, { status: 401 });
  const b = await bodyOf<{ email: string }>(req);
  return respond(await setOwnEmail(actor, b.email ?? ""));
}
