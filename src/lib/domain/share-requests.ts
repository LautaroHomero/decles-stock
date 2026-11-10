import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { applyManualAmounts, listVisitSales } from "@/lib/db/billing-repo";
import { realNowIso } from "@/lib/domain/clock";
import { isOwnerProvider } from "@/lib/domain/owners";
import type { Actor } from "@/lib/domain/types";

/**
 * Lo que se lleva la profesional en una atención (migración 0038). El admin lo cambia directo; cualquier otra persona
 * lo pide y queda «a consideración del admin»: la atención sigue con lo de siempre hasta que lo aprueba o lo rechaza.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });
type Row = Record<string, unknown>;

export interface ShareRequest {
  id: string;
  visitId: string;
  providerId: string | null;
  providerName: string;
  patient: string;
  what: string;
  date: string;
  share: number;
  previous: number;
  /** Lo que tiene hoy la atención (puede haber cambiado desde el pedido). */
  current: number;
  reason: string;
  requestedBy: string;
  createdAt: string;
}

const clean = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");

/**
 * Deja la parte de la profesional en toda la anotación en `share`: la primera práctica se lleva lo que falta después
 * de los demás renglones (que conservan la suya). Se marca a mano (no la pisa un recálculo).
 */
export async function setVisitShareTotal(orgId: string, visitId: string, share: number): Promise<void> {
  const sales = await listVisitSales(orgId, visitId);
  if (!sales.length) return;
  const k = sales.find((s) => s.kind !== "producto") ?? sales[0];
  const others = sales.filter((s) => s.id !== k.id).reduce((n, s) => n + s.commissionAmount, 0);
  if (others > share) {
    // Lo pedido es menos que lo de los otros renglones: todo va a la primera práctica y los demás a 0.
    for (const s of sales) if (s.id !== k.id) await applyManualAmounts(orgId, s.id, { commission: 0 });
    await applyManualAmounts(orgId, k.id, { commission: share });
    return;
  }
  await applyManualAmounts(orgId, k.id, { commission: share - others });
}

/** Un pedido abierto por atención: si ya hay uno, se actualiza. */
export async function requestShare(actor: Actor, visitId: string, share: number, reason = ""): Promise<void> {
  const orgId = actor.activeOrg!.id;
  const sql = getSql();
  const sales = await listVisitSales(orgId, visitId);
  const previous = sales.reduce((n, s) => n + s.commissionAmount, 0);
  const now = realNowIso();
  const open = (await sql`SELECT id FROM share_requests WHERE organization_id = ${orgId} AND visit_id = ${visitId} AND status = 'pending'`) as unknown as Row[];
  if (open.length) {
    await sql`
      UPDATE share_requests SET share = ${share}, previous = ${previous}, reason = ${reason}, requested_by = ${actor.userId},
        requested_by_name = ${actor.name}, created_at = ${now}
      WHERE id = ${open[0].id as string}`;
    return;
  }
  await sql`
    INSERT INTO share_requests (id, organization_id, visit_id, provider_id, share, previous, reason, requested_by, requested_by_name, created_at)
    VALUES (${`shr_${randomUUID().slice(0, 8)}`}, ${orgId}, ${visitId}, ${sales[0]?.providerId ?? null}, ${share}, ${previous}, ${reason},
      ${actor.userId}, ${actor.name}, ${now})`;
}

/**
 * Cambiar la parte de la profesional en una atención (Cierre → Cuentas con profesionales). Admin: queda. Otro: queda pedido.
 */
export async function changeShare(actor: Actor, key: string, v: { share?: unknown; reason?: unknown }): Promise<Result<{ requested: boolean }>> {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente") return fail("No autorizado.", 403);
  const share = Number(v.share);
  if (!Number.isInteger(share) || share < 0 || share > 1_000_000_000) return fail("La parte tiene que ser un número entero de pesos.");
  const sales = (await listVisitSales(orgId, key)).filter((s) => s.status === "paid");
  if (!sales.length) return fail("Esa atención ya no existe o fue anulada.", 404);
  const visitId = sales[0].visitId ?? sales[0].id;
  const providerId = sales[0].providerId;
  if (providerId && (await isOwnerProvider(orgId, providerId))) return fail("La dueña no cobra parte.");
  const isAdmin = !!actor.activeOrg?.canAdmin;
  if (actor.role === "medico" && !isAdmin && providerId !== actor.activeOrg?.providerId) return fail("Solo podés pedir cambios en lo tuyo.", 403);
  const reason = clean(v.reason).slice(0, 200);
  if (!isAdmin) {
    await requestShare(actor, visitId, share, reason);
    return { ok: true, requested: true };
  }
  await setVisitShareTotal(orgId, visitId, share);
  // Lo que hubiera pedido, ya lo decidió el admin.
  await getSql()`
    UPDATE share_requests SET status = ${"approved"}, resolved_by_name = ${actor.name}, resolved_at = ${realNowIso()}, share = ${share}
    WHERE organization_id = ${orgId} AND visit_id = ${visitId} AND status = 'pending'`;
  return { ok: true, requested: false };
}

/** Pedidos abiertos (los de un día, o todos). Los ve todo el equipo; aprueba el admin. */
export async function listShareRequests(actor: Actor, date?: string | null): Promise<Result<{ requests: ShareRequest[] }>> {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente") return { ok: true, requests: [] };
  const rows = (await getSql()`
    SELECT r.*, p.name AS provider_name,
      (SELECT min(s.created_at) FROM sales s WHERE s.organization_id = r.organization_id AND s.visit_id = r.visit_id AND s.status = 'paid') AS visit_at,
      (SELECT coalesce(max(s.patient_label), '') FROM sales s WHERE s.organization_id = r.organization_id AND s.visit_id = r.visit_id AND s.status = 'paid') AS patient,
      (SELECT string_agg(s.item_name, ', ') FROM sales s WHERE s.organization_id = r.organization_id AND s.visit_id = r.visit_id AND s.status = 'paid') AS what,
      (SELECT coalesce(sum(s.commission_amount), 0) FROM sales s WHERE s.organization_id = r.organization_id AND s.visit_id = r.visit_id AND s.status = 'paid') AS current
    FROM share_requests r LEFT JOIN providers p ON p.id = r.provider_id
    WHERE r.organization_id = ${orgId} AND r.status = 'pending'
    ORDER BY r.created_at`) as unknown as Row[];
  const requests = rows
    .filter((r) => r.visit_at)
    .map((r) => ({
      id: r.id as string,
      visitId: r.visit_id as string,
      providerId: (r.provider_id as string | null) ?? null,
      providerName: (r.provider_name as string | null) ?? "",
      patient: r.patient as string,
      what: (r.what as string | null) ?? "",
      date: (r.visit_at as string).slice(0, 10),
      share: Number(r.share),
      previous: Number(r.previous),
      current: Number(r.current),
      reason: r.reason as string,
      requestedBy: r.requested_by_name as string,
      createdAt: r.created_at as string,
    }))
    .filter((r) => !date || r.date === date);
  return { ok: true, requests };
}

/** El admin aprueba (queda esa parte) o rechaza (queda la que había). */
export async function resolveShareRequest(actor: Actor, id: string, approve: unknown): Promise<Result<object>> {
  const orgId = actor.activeOrg?.id;
  if (!orgId || !actor.activeOrg?.canAdmin) return fail("Lo aprueba el admin.", 403);
  const sql = getSql();
  const rows = (await sql`SELECT * FROM share_requests WHERE id = ${id} AND organization_id = ${orgId} AND status = 'pending'`) as unknown as Row[];
  if (!rows.length) return fail("Ese pedido ya no está abierto.", 404);
  const r = rows[0];
  if (approve === true) {
    const sales = (await listVisitSales(orgId, r.visit_id as string)).filter((s) => s.status === "paid");
    if (!sales.length) return fail("Esa atención ya no existe o fue anulada.", 404);
    await setVisitShareTotal(orgId, r.visit_id as string, Number(r.share));
  }
  await sql`
    UPDATE share_requests SET status = ${approve === true ? "approved" : "rejected"}, resolved_by_name = ${actor.name}, resolved_at = ${realNowIso()}
    WHERE id = ${id}`;
  return { ok: true };
}

/** Al editar la atención (cambia su visit_id): el pedido abierto la sigue. */
export async function relinkShareRequests(orgId: string, oldVisitId: string, newVisitId: string): Promise<void> {
  await getSql()`UPDATE share_requests SET visit_id = ${newVisitId} WHERE organization_id = ${orgId} AND visit_id = ${oldVisitId}`;
}

/** Para los avisos de los admins. */
export async function openShareRequests(orgId: string): Promise<{ id: string; visitId: string; share: number; previous: number; providerName: string; requestedBy: string; createdAt: string }[]> {
  const rows = (await getSql()`
    SELECT r.id, r.visit_id, r.share, r.previous, r.requested_by_name, r.created_at, coalesce(p.name, '') AS provider_name
    FROM share_requests r LEFT JOIN providers p ON p.id = r.provider_id
    WHERE r.organization_id = ${orgId} AND r.status = 'pending'`) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    visitId: r.visit_id as string,
    share: Number(r.share),
    previous: Number(r.previous),
    providerName: r.provider_name as string,
    requestedBy: r.requested_by_name as string,
    createdAt: r.created_at as string,
  }));
}
