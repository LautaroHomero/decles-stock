import { membershipsForUser } from "@/lib/db/repo";
import { claimsFromRequest, sessionSetCookie, signSession } from "@/lib/auth/session";
import { hydrateActor } from "@/lib/auth/actor";

/** Staff with more than one organization can switch which one is active. */
export async function POST(req: Request) {
  const claims = claimsFromRequest(req);
  if (!claims || claims.role === "paciente") {
    return Response.json({ ok: false, error: "No corresponde." }, { status: 403 });
  }
  const { organizationId } = (await req.json()) as { organizationId?: string };
  const mems = await membershipsForUser(claims.userId);
  const mem = mems.find((m) => m.organizationId === organizationId);
  if (!mem) return Response.json({ ok: false, error: "No pertenecés a esa organización." }, { status: 400 });

  const next = { ...claims, activeOrgId: mem.organizationId, role: mem.role };
  return Response.json(
    { ok: true, actor: await hydrateActor(next) },
    { headers: { "Set-Cookie": sessionSetCookie(signSession(next)) } },
  );
}
