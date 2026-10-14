import { connection } from "next/server";
import { needsSetup, setupFirstRun } from "@/lib/domain/accounts";
import { hydrateActor } from "@/lib/auth/actor";
import { sessionSetCookie, signSession, type SessionClaims } from "@/lib/auth/session";
import type { StaffRole } from "@/lib/domain/types";
import { bodyOf } from "../_http";

/** ¿Hay que configurar? (base sin usuarios) */
export async function GET() {
  await connection(); // siempre en el momento (nunca armado en el build)
  return Response.json({ ok: true, needsSetup: await needsSetup() });
}

/** Primer arranque: crea el consultorio y su admin, y deja la sesión iniciada. */
export async function POST(req: Request) {
  const b = await bodyOf<{ orgName: string; name: string; username: string; password: string; role: StaffRole; commissionPct: number; email: string }>(req);
  const r = await setupFirstRun({
    orgName: b.orgName ?? "",
    name: b.name ?? "",
    username: b.username ?? "",
    password: b.password ?? "",
    role: b.role as StaffRole,
    commissionPct: b.commissionPct,
    email: b.email,
  });
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: r.status });
  const claims: SessionClaims = { userId: r.userId, role: b.role as StaffRole, activeOrgId: r.orgId, sv: 0 };
  return Response.json(
    { ok: true, actor: await hydrateActor(claims) },
    { headers: { "Set-Cookie": sessionSetCookie(signSession(claims)) } },
  );
}
