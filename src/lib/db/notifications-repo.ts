import { randomUUID } from "node:crypto";
import { realNowIso } from "@/lib/domain/clock";
import { getSql } from "./connection";

/** Campanita in-app. Autorización y armado de los avisos: `src/lib/domain/notifications.ts`. */

type Row = Record<string, unknown>;

export type NotificationKind = "vence_pronto" | "vencido" | "stock_bajo" | "sin_stock" | "pendiente" | "deuda" | "deuda_cobrar" | "pagar";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  refId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NewNotification {
  kind: NotificationKind;
  title: string;
  body: string;
  refId: string;
  dedupeKey: string;
}

/** Inserta para cada destinatario; lo ya avisado (misma `dedupe_key`) se ignora. Devuelve cuántas son nuevas. */
export async function insertNotifications(orgId: string, userIds: string[], items: NewNotification[]): Promise<number> {
  if (userIds.length === 0 || items.length === 0) return 0;
  const now = realNowIso();
  const rows = userIds.flatMap((userId) =>
    items.map((n) => ({
      id: `ntf_${randomUUID().slice(0, 12)}`,
      organization_id: orgId,
      user_id: userId,
      kind: n.kind,
      title: n.title,
      body: n.body,
      ref_id: n.refId,
      dedupe_key: n.dedupeKey,
      created_at: now,
    })),
  );
  const sql = getSql();
  const inserted = (await sql`
    INSERT INTO notifications ${sql(rows)}
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
    RETURNING id`) as unknown as Row[];
  return inserted.length;
}

/** Borra avisos de stock bajo de productos que ya se repusieron, para que puedan volver a avisar. */
export async function clearRecoveredLowStock(orgId: string, stillLowItemIds: string[]): Promise<void> {
  await getSql()`
    DELETE FROM notifications
    WHERE organization_id = ${orgId} AND kind = 'stock_bajo'
      AND NOT (ref_id = ANY(${stillLowItemIds}::text[]))`;
}

export async function listNotifications(orgId: string, userId: string, limit = 30): Promise<AppNotification[]> {
  const rows = (await getSql()`
    SELECT * FROM notifications
    WHERE organization_id = ${orgId} AND user_id = ${userId}
    ORDER BY (read_at IS NULL) DESC, created_at DESC, id DESC
    LIMIT ${limit}`) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as NotificationKind,
    title: r.title as string,
    body: (r.body as string) ?? "",
    refId: (r.ref_id as string) ?? null,
    readAt: (r.read_at as string) ?? null,
    createdAt: r.created_at as string,
  }));
}

export async function countUnread(orgId: string, userId: string): Promise<number> {
  const [r] = (await getSql()`
    SELECT count(*)::int AS n FROM notifications
    WHERE organization_id = ${orgId} AND user_id = ${userId} AND read_at IS NULL`) as unknown as Row[];
  return Number(r?.n ?? 0);
}

/** Marca leída una notificación del usuario, o todas si `id` es undefined. */
export async function markRead(orgId: string, userId: string, id?: string): Promise<void> {
  await getSql()`
    UPDATE notifications SET read_at = ${realNowIso()}
    WHERE organization_id = ${orgId} AND user_id = ${userId} AND read_at IS NULL
      AND (${id ?? null}::text IS NULL OR id = ${id ?? null})`;
}

/** Borra los avisos de un tipo que ya no corresponden (lo resuelto deja de mostrarse y puede volver a avisar). */
export async function clearStale(orgId: string, kind: NotificationKind, keepKeys: string[]): Promise<void> {
  await getSql()`
    DELETE FROM notifications
    WHERE organization_id = ${orgId} AND kind = ${kind} AND NOT (dedupe_key = ANY(${keepKeys}::text[]))`;
}
