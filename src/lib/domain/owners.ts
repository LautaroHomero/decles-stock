import { getSql } from "@/lib/db/connection";

/**
 * Profesionales dueñas (Decles): una médica que además es admin del consultorio no cobra comisión, porque
 * su plata y la del consultorio son la misma. Todo lo que anota va entero para el consultorio (parte 0).
 * Se decide al anotar y queda congelado en la venta como siempre (si deja de ser admin, lo nuevo sí lleva comisión).
 */
export async function ownerProviderIds(orgId: string): Promise<Set<string>> {
  const rows = (await getSql()`
    SELECT m.provider_id FROM memberships m JOIN organizations o ON o.id = m.organization_id
    WHERE m.organization_id = ${orgId} AND m.provider_id IS NOT NULL AND o.admin_ids::jsonb ? m.user_id`) as unknown as { provider_id: string }[];
  return new Set(rows.map((r) => r.provider_id));
}

export async function isOwnerProvider(orgId: string, providerId: string | null | undefined): Promise<boolean> {
  if (!providerId) return false;
  return (await ownerProviderIds(orgId)).has(providerId);
}
