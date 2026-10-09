import { getSql } from "@/lib/db/connection";
import type { Actor } from "@/lib/domain/types";

/**
 * "Primeros pasos" para el admin de un consultorio nuevo. Cada paso se marca solo,
 * mirando los datos (no hay que tildar nada a mano):
 *  1. su email (para recuperar la contraseña)  2. productos con precio  3. stock con vencimiento
 *  4. médicas con comisión  5. secretaría  6. una venta de prueba
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };

export type StepId = "email" | "productos" | "stock" | "medicas" | "secretaria" | "venta";

export interface OnboardingStatus {
  done: boolean;
  steps: { id: StepId; done: boolean }[];
}

type Row = Record<string, unknown>;

export async function onboardingStatus(actor: Actor): Promise<Result<OnboardingStatus>> {
  if (!actor.activeOrg?.canAdmin) return { ok: false, error: "Solo para el admin.", status: 403 };
  const orgId = actor.activeOrg.id;
  const [r] = (await getSql()`
    SELECT
      o.onboarding_done AS dismissed,
      (SELECT trim(email) <> '' FROM users WHERE id = ${actor.userId}) AS email,
      (SELECT count(*) FROM price_list_items p WHERE p.organization_id = o.id AND p.kind = 'producto' AND p.active)::int AS productos,
      (SELECT count(*) FROM stock_lots l WHERE l.organization_id = o.id AND l.expires_on IS NOT NULL)::int AS lotes,
      (SELECT count(*) FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = o.id AND m.role = 'medico' AND u.active)::int AS medicas,
      (SELECT count(*) FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = o.id AND m.role = 'recepcion' AND u.active AND u.id <> ${actor.userId})::int AS secretarias,
      (SELECT count(*) FROM sales s WHERE s.organization_id = o.id)::int AS ventas
    FROM organizations o WHERE o.id = ${orgId}`) as unknown as Row[];
  // Si el admin es la secretaria, el paso "secretaría" ya está cubierto por ella.
  const adminIsReception = actor.role === "recepcion";
  const steps: OnboardingStatus["steps"] = [
    { id: "email", done: Boolean(r.email) },
    { id: "productos", done: Number(r.productos) > 0 },
    { id: "stock", done: Number(r.lotes) > 0 },
    { id: "medicas", done: Number(r.medicas) > 0 },
    { id: "secretaria", done: adminIsReception || Number(r.secretarias) > 0 },
    { id: "venta", done: Number(r.ventas) > 0 },
  ];
  return { ok: true, done: Boolean(r.dismissed), steps };
}

export async function dismissOnboarding(actor: Actor, done: boolean): Promise<Result<object>> {
  if (!actor.activeOrg?.canAdmin) return { ok: false, error: "Solo para el admin.", status: 403 };
  await getSql()`UPDATE organizations SET onboarding_done = ${done} WHERE id = ${actor.activeOrg.id}`;
  return { ok: true };
}
