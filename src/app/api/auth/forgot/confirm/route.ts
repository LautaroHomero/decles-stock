import { confirmPasswordReset } from "@/lib/domain/accounts";
import { hydrateActor } from "@/lib/auth/actor";
import { sessionSetCookie, signSession, type SessionClaims } from "@/lib/auth/session";
import { bodyOf } from "../../../_http";

/** `{ identifier, code, password }` → contraseña nueva y queda la sesión iniciada. */
export async function POST(req: Request) {
  const b = await bodyOf<{ identifier: string; code: string; password: string }>(req);
  const r = await confirmPasswordReset(b.identifier ?? "", b.code ?? "", b.password ?? "");
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: r.status });
  const claims: SessionClaims = { userId: r.userId, role: r.role, activeOrgId: r.orgId, sv: r.sv };
  return Response.json({ ok: true, actor: await hydrateActor(claims) }, { headers: { "Set-Cookie": sessionSetCookie(signSession(claims)) } });
}
