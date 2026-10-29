import { randomBytes, randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { getPriceItem } from "@/lib/db/billing-repo";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";

export type GiftCardKind = "amount" | "treatment";
type Row = Record<string, unknown>;

export interface GiftCardBalance {
  code: string;
  kind: GiftCardKind;
  faceValue: number;
  balance: number;
  treatmentItemId: string | null;
  treatmentName: string | null;
  buyer: string;
  createdAt: string;
}

const fail = (error: string, status = 400) => ({ ok: false as const, error, status });
const codeOf = () => `GC-${randomBytes(8).toString("hex").toUpperCase()}`;
const context = (actor: Actor) => actor.activeOrg && actor.role !== "paciente" ? actor.activeOrg.id : null;

export async function issueGiftCard(
  actor: Actor,
  input: { saleId: string; kind: GiftCardKind; faceValue: number; treatmentItemId?: string | null; buyer?: string },
): Promise<{ ok: true; code: string } | { ok: false; error: string; status: number }> {
  const orgId = context(actor);
  if (!orgId) return fail("No autorizado.", 403);
  if (!Number.isInteger(input.faceValue) || input.faceValue <= 0 || input.faceValue > 1_000_000_000)
    return fail("El valor de la gift card debe ser mayor a cero.");
  let treatmentItemId: string | null = null;
  let treatmentName = "";
  if (input.kind === "treatment") {
    const item = input.treatmentItemId ? await getPriceItem(orgId, input.treatmentItemId) : undefined;
    if (!item || !item.active || item.kind !== "tratamiento") return fail("Elegí un tratamiento válido para el vale.");
    treatmentItemId = item.id;
    treatmentName = item.name;
  } else if (input.kind !== "amount") return fail("Tipo de gift card inválido.");

  const code = codeOf();
  await getSql()`
    INSERT INTO gift_cards (id, organization_id, code, kind, face_value, treatment_item_id, treatment_name, buyer, sale_id, created_by, created_by_name, created_at)
    VALUES (${`gc_${randomUUID().slice(0, 12)}`}, ${orgId}, ${code}, ${input.kind}, ${input.faceValue}, ${treatmentItemId}, ${treatmentName}, ${(input.buyer ?? "").trim().slice(0, 120)}, ${input.saleId}, ${actor.userId}, ${actor.name}, ${realNowIso()})`;
  return { ok: true, code };
}

export async function giftCardBalance(actor: Actor, rawCode: string): Promise<{ ok: true; giftCard: GiftCardBalance } | { ok: false; error: string; status: number }> {
  const orgId = context(actor);
  if (!orgId) return fail("No autorizado.", 403);
  const code = rawCode.trim().toUpperCase();
  if (!code) return fail("Escribí el código de la gift card.");
  const [row] = (await getSql()`
    SELECT g.*, COALESCE(SUM(u.amount), 0)::int AS used
    FROM gift_cards g
    LEFT JOIN gift_card_uses u ON u.gift_card_id = g.id AND u.organization_id = g.organization_id
      AND EXISTS (SELECT 1 FROM sales s WHERE s.organization_id = u.organization_id AND s.visit_id = u.visit_id AND s.status = 'paid')
    WHERE g.organization_id = ${orgId} AND g.code = ${code} AND g.status = 'open'
    GROUP BY g.id`) as unknown as Row[];
  if (!row) return fail("No encontré una gift card activa con ese código.", 404);
  const faceValue = Number(row.face_value);
  return {
    ok: true,
    giftCard: {
      code: row.code as string,
      kind: row.kind as GiftCardKind,
      faceValue,
      balance: Math.max(0, faceValue - Number(row.used)),
      treatmentItemId: (row.treatment_item_id as string) ?? null,
      treatmentName: (row.treatment_name as string) || null,
      buyer: (row.buyer as string) ?? "",
      createdAt: row.created_at as string,
    },
  };
}

export async function useGiftCard(
  actor: Actor,
  input: { code: string; visitId: string; amount: number; itemIds: string[]; replacingVisitId?: string },
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const orgId = context(actor);
  if (!orgId) return fail("No autorizado.", 403);
  if (!Number.isInteger(input.amount) || input.amount <= 0) return fail("El importe usado de la gift card no es válido.");
  const code = input.code.trim().toUpperCase();
  return getSql().begin(async (tx) => {
    const [card] = (await tx`
      SELECT * FROM gift_cards
      WHERE organization_id = ${orgId} AND code = ${code} AND status = 'open'
      FOR UPDATE`) as unknown as Row[];
    if (!card) return fail("No encontré una gift card activa con ese código.", 404);
    const [usage] = (await tx`
      SELECT COALESCE(SUM(u.amount), 0)::int AS used
      FROM gift_card_uses u
      WHERE u.organization_id = ${orgId} AND u.gift_card_id = ${card.id as string}
        AND (${input.replacingVisitId ?? null}::text IS NULL OR u.visit_id <> ${input.replacingVisitId ?? null})
        AND EXISTS (SELECT 1 FROM sales s WHERE s.organization_id = u.organization_id AND s.visit_id = u.visit_id AND s.status = 'paid')`) as unknown as Row[];
    const balance = Number(card.face_value) - Number(usage?.used ?? 0);
    if (input.amount > balance) return fail(`A la gift card le quedan $${Math.max(0, balance).toLocaleString("es-AR")}.`, 409);
    if (card.kind === "treatment" && !input.itemIds.includes(card.treatment_item_id as string))
      return fail(`Este vale es para ${card.treatment_name as string}.`, 409);
    await tx`
      INSERT INTO gift_card_uses (id, organization_id, gift_card_id, visit_id, amount, created_at)
      VALUES (${`gcu_${randomUUID().slice(0, 12)}`}, ${orgId}, ${card.id as string}, ${input.visitId}, ${input.amount}, ${realNowIso()})`;
    return { ok: true as const };
  });
}

export async function relinkGiftCardUses(orgId: string, oldVisitId: string, newVisitId: string): Promise<void> {
  await getSql()`UPDATE gift_card_uses SET visit_id = ${newVisitId} WHERE organization_id = ${orgId} AND visit_id = ${oldVisitId}`;
}

export async function dropGiftCardUses(orgId: string, visitId: string): Promise<void> {
  await getSql()`DELETE FROM gift_card_uses WHERE organization_id = ${orgId} AND visit_id = ${visitId}`;
}