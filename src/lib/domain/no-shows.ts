import { getSql } from "@/lib/db/connection";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";

/**
 * Ausentes (migración 0039): la paciente no vino. La atención se anota igual (paciente, práctica, profesional) y queda
 * marcada acá. Lo que paga la profesional lo arma `recordVisit` (`VisitInput.noShow`): la seña + lo que se le pidió a
 * la paciente por la hora, todo para ella; se puede bajar cambiando su parte.
 */

type Row = Record<string, unknown>;

export async function recordNoShow(orgId: string, visitId: string, paidBefore = 0): Promise<void> {
  await getSql()`
    INSERT INTO no_shows (organization_id, visit_id, paid_before, created_at) VALUES (${orgId}, ${visitId}, ${paidBefore}, ${realNowIso()})
    ON CONFLICT DO NOTHING`;
}

/** Al editar: sin decir nada sigue siendo ausente; con `noShow` ya se anotó de nuevo (o dejó de serlo). */
export async function relinkNoShow(orgId: string, oldVisitId: string, newVisitId: string): Promise<void> {
  await getSql()`UPDATE no_shows SET visit_id = ${newVisitId} WHERE organization_id = ${orgId} AND visit_id = ${oldVisitId}`;
}
export async function dropNoShow(orgId: string, visitId: string): Promise<void> {
  await getSql()`DELETE FROM no_shows WHERE organization_id = ${orgId} AND visit_id = ${visitId}`;
}

/** Qué atenciones (visit_id) fueron ausentes, entre las dadas. */
export async function noShowIds(orgId: string, visitIds: string[]): Promise<Set<string>> {
  if (!visitIds.length) return new Set();
  const rows = (await getSql()`SELECT visit_id FROM no_shows WHERE organization_id = ${orgId} AND visit_id = ANY(${visitIds})`) as unknown as Row[];
  return new Set(rows.map((r) => r.visit_id as string));
}

/** Ausentes de un día (para la Planilla), con lo que ya había pagado otro día. */
export async function noShowsOn(actor: Actor, date: string): Promise<{ visitId: string; paidBefore: number }[]> {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente") return [];
  const rows = (await getSql()`
    SELECT n.visit_id, n.paid_before FROM no_shows n WHERE n.organization_id = ${orgId} AND EXISTS (
      SELECT 1 FROM sales s WHERE s.organization_id = n.organization_id AND s.visit_id = n.visit_id AND s.status = 'paid' AND substr(s.created_at, 1, 10) = ${date})`) as unknown as Row[];
  return rows.map((r) => ({ visitId: r.visit_id as string, paidBefore: Number(r.paid_before) }));
}
