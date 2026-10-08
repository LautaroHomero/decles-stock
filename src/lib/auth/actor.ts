import { getAccount, membershipsForUser } from "@/lib/db/repo";
import type { Actor } from "@/lib/domain/types";
import { claimsFromRequest, type SessionClaims } from "./session";

/**
 * Cookie firmada → Actor completo. Se rehidrata en cada request, así una baja o un
 * reset de contraseña (que suben `session_version`) cortan la sesión en el acto.
 */
export async function hydrateActor(claims: SessionClaims | null): Promise<Actor | null> {
  if (!claims) return null;
  const user = await getAccount(claims.userId);
  if (!user || !user.active || user.role === "paciente") return null;
  if ((claims.sv ?? 0) !== user.sessionVersion) return null;

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
    mustChangePassword: user.mustChangePassword,
  };
}

export function actorFromRequest(req: Request): Promise<Actor | null> {
  return hydrateActor(claimsFromRequest(req));
}
