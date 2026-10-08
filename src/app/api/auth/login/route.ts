import { login } from "@/lib/domain/accounts";
import { hydrateActor } from "@/lib/auth/actor";
import { sessionSetCookie, signSession, type SessionClaims } from "@/lib/auth/session";

/** Usuario + contraseña. 5 intentos fallidos bloquean la cuenta 15 min. */
export async function POST(req: Request) {
  const { username, password } = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  const r = await login(username ?? "", password ?? "");
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: r.status });
  const claims: SessionClaims = { userId: r.userId, role: r.role, activeOrgId: r.orgId, sv: r.sv };
  const actor = await hydrateActor(claims);
  return Response.json({ ok: true, actor }, { headers: { "Set-Cookie": sessionSetCookie(signSession(claims)) } });
}
