import { listOrgMembers, listOrganizations } from "@/lib/db/repo";
import { getStockSettings, listStockItems, todayYmd } from "@/lib/db/stock-repo";
import { listPendingSales } from "@/lib/db/billing-repo";
import {
  clearStale,
  clearRecoveredLowStock,
  countUnread,
  insertNotifications,
  listNotifications,
  markRead,
  type AppNotification,
  type NewNotification,
} from "@/lib/db/notifications-repo";
import type { Actor } from "@/lib/domain/types";

/**
 * Avisos de stock para la campanita de las médicas y los admins del consultorio:
 *  · un lote vence dentro de `stock_expiry_days` (vence_pronto, una vez por lote);
 *  · un lote con stock ya venció (vencido, una vez por lote);
 *  · un producto quedó bajo su mínimo (stock_bajo; se re-arma cuando se repone);
 *  · se vendió sin stock cargado (sin_stock; se va cuando entra el ingreso);
 *  · solo a los admins: algo anotado que no está en la lista de precios (pendiente; se va al resolverlo).
 *
 * `refreshStockAlerts` es idempotente: lo llaman el cron diario, cada venta / ingreso
 * y la propia campanita (con throttle), así que nunca depende de una sola vía.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };

export type { AppNotification };

const fmt = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const units = (n: number, unit: string) => `${n} ${unit === "unidad" ? (n === 1 ? "unidad" : "unidades") : unit}`;

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function refreshStockAlerts(orgId: string): Promise<number> {
  const [items, settings, members] = await Promise.all([listStockItems(orgId), getStockSettings(orgId), listOrgMembers(orgId)]);
  // Reciben los avisos las médicas y los admins (activos).
  const recipients = members.filter((m) => m.active && (m.role === "medico" || m.isAdmin)).map((m) => m.userId);

  const today = todayYmd();
  const limit = addDays(today, settings.expiryDays);
  const alerts: NewNotification[] = [];
  for (const i of items) {
    for (const l of i.lots) {
      if (!l.expiresOn || l.quantity <= 0) continue;
      const lot = l.lotCode ? ` · lote ${l.lotCode}` : "";
      if (l.expired) {
        alerts.push({
          kind: "vencido",
          title: `${i.name}: lote vencido`,
          body: `Venció el ${fmt(l.expiresOn)} · ${units(l.quantity, i.unit)}${lot}. Hay que darlo de baja.`,
          refId: i.id,
          dedupeKey: `vencido:${l.id}`,
        });
      } else if (l.expiresOn <= limit) {
        alerts.push({
          kind: "vence_pronto",
          title: `${i.name} vence pronto`,
          body: `Vence el ${fmt(l.expiresOn)} · quedan ${units(l.quantity, i.unit)}${lot}.`,
          refId: i.id,
          dedupeKey: `vence_pronto:${l.id}`,
        });
      }
    }
    if (i.owed > 0) {
      alerts.push({
        kind: "sin_stock",
        title: `${i.name}: vendido sin stock cargado`,
        body: `Se vendieron ${units(i.owed, i.unit)} que el sistema no tenía. Cargá el ingreso y se compensa solo.`,
        refId: i.id,
        dedupeKey: `sin_stock:${i.id}:${i.owed}`,
      });
    }
    if (i.low && i.owed === 0) {
      alerts.push({
        kind: "stock_bajo",
        title: `${i.name}: stock bajo`,
        body: `Quedan ${units(i.available, i.unit)} (mínimo ${i.minQuantity}).`,
        refId: i.id,
        dedupeKey: `stock_bajo:${i.id}`,
      });
    }
  }

  await clearRecoveredLowStock(orgId, items.filter((i) => i.low && i.owed === 0).map((i) => i.id));
  await clearStale(orgId, "sin_stock", alerts.filter((a) => a.kind === "sin_stock").map((a) => a.dedupeKey));

  // Pendientes: solo para los admins, que son quienes los resuelven.
  const admins = members.filter((m) => m.active && m.isAdmin).map((m) => m.userId);
  const pending = (await listPendingSales(orgId)).map(
    (s): NewNotification => ({
      kind: "pendiente",
      title: `Anotado sin cargar: «${s.itemName}»`,
      body: [s.patientName, s.providerName, fmt(s.createdAt.slice(0, 10))].filter(Boolean).join(" · ") + ". Vinculalo o crealo en Stock.",
      refId: s.id,
      dedupeKey: `pendiente:${s.id}`,
    }),
  );
  await clearStale(orgId, "pendiente", pending.map((p) => p.dedupeKey));
  return (await insertNotifications(orgId, recipients, alerts)) + (await insertNotifications(orgId, admins, pending));
}

/** Para el cron: todos los consultorios. */
export async function refreshAllStockAlerts(): Promise<{ orgs: number; created: number }> {
  const orgs = await listOrganizations();
  let created = 0;
  for (const o of orgs) created += await refreshStockAlerts(o.id);
  return { orgs: orgs.length, created };
}

// Throttle en memoria para la campanita (cada instancia recalcula como mucho una vez por minuto).
const lastRefresh = new Map<string, number>();
async function refreshThrottled(orgId: string) {
  const now = Date.now();
  if (now - (lastRefresh.get(orgId) ?? 0) < 60_000) return;
  lastRefresh.set(orgId, now);
  await refreshStockAlerts(orgId);
}

/**
 * Recalcula después de vender / ingresar / dar de baja. Se espera (en Vercel una promesa
 * suelta puede cortarse al responder) pero un error acá nunca rompe la operación.
 */
export async function refreshAfterChange(actor: Actor): Promise<void> {
  const orgId = actor.activeOrg?.id;
  if (!orgId) return;
  lastRefresh.set(orgId, Date.now());
  await refreshStockAlerts(orgId).catch((err) => console.error("[notifications] refresh falló", err));
}

export async function myNotifications(actor: Actor): Promise<Result<{ items: AppNotification[]; unread: number }>> {
  if (actor.role === "paciente" || !actor.activeOrg) return { ok: false, error: "No autorizado.", status: 403 };
  const orgId = actor.activeOrg.id;
  await refreshThrottled(orgId);
  const [items, unread] = await Promise.all([listNotifications(orgId, actor.userId), countUnread(orgId, actor.userId)]);
  return { ok: true, items, unread };
}

export async function readNotifications(actor: Actor, id?: string): Promise<Result<object>> {
  if (actor.role === "paciente" || !actor.activeOrg) return { ok: false, error: "No autorizado.", status: 403 };
  await markRead(actor.activeOrg.id, actor.userId, id);
  return { ok: true };
}
