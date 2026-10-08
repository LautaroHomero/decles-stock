import { getUser, membershipsForUser, patientOrgs } from "@/lib/db/repo";
import type { Actor } from "@/lib/domain/types";
import { claimsFromRequest, type SessionClaims } from "./session";

/** Turns the signed session claims into the full Actor (memberships, org names…). */
export async function hydrateActor(claims: SessionClaims | null): Promise<Actor | null> {
  if (!claims) return null;
  const user = await getUser(claims.userId);
  if (!user) return null;

  if (user.role === "paciente") {
    if (!user.patientId) return null;
    return {
      userId: user.id,
      name: user.name,
      role: "paciente",
      patientId: user.patientId,
      orgs: await patientOrgs(user.patientId),
    };
  }

  const mems = await membershipsForUser(user.id);
  if (mems.length === 0) return null;
  const active = mems.find((m) => m.organizationId === claims.activeOrgId) ?? mems[0];
  return {
    userId: user.id,
    name: user.name,
    role: active.role,
    activeOrg: {
      id: active.organizationId,
      name: active.organizationName,
      role: active.role,
      providerId: active.providerId,
      specialty: active.specialty,
      canAdmin: active.canAdmin,
    },
    orgs: mems.map((m) => ({ id: m.organizationId, name: m.organizationName })),
  };
}

export function actorFromRequest(req: Request): Promise<Actor | null> {
  return hydrateActor(claimsFromRequest(req));
}
