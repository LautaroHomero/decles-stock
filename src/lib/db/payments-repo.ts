import { randomUUID } from "node:crypto";
import { realNowIso } from "@/lib/domain/clock";
import { getSql } from "./connection";

/** Cómo se pagó una anotación cuando no es un solo medio en pesos (Decles). `amount` en pesos. */
export type PartMethod = "efectivo" | "transferencia" | "tarjeta" | "dolares" | "giftcard" | "profesional";
export interface PayPart {
  method: PartMethod;
  amount: number;
  /** Solo dólares: cuántos dólares y a qué cotización. */
  usd?: number | null;
  rate?: number | null;
}

type Row = Record<string, unknown>;

export async function insertVisitPayments(orgId: string, visitId: string, parts: PayPart[]): Promise<void> {
  const now = realNowIso();
  for (const p of parts) {
    await getSql()`
      INSERT INTO visit_payments (id, organization_id, visit_id, method, amount, usd, rate, created_at)
      VALUES (${`vp_${randomUUID().slice(0, 8)}`}, ${orgId}, ${visitId}, ${p.method}, ${p.amount}, ${p.usd ?? null}, ${p.rate ?? null}, ${now})`;
  }
}

/** visit_id → partes, para las anotaciones pedidas. */
export async function listVisitPayments(orgId: string, visitIds: string[]): Promise<Record<string, PayPart[]>> {
  if (!visitIds.length) return {};
  const rows = (await getSql()`
    SELECT visit_id, method, amount, usd, rate FROM visit_payments
    WHERE organization_id = ${orgId} AND visit_id = ANY(${visitIds}) ORDER BY created_at, id`) as unknown as Row[];
  const out: Record<string, PayPart[]> = {};
  for (const r of rows) {
    (out[r.visit_id as string] ??= []).push({
      method: r.method as PartMethod,
      amount: Number(r.amount),
      usd: r.usd === null ? null : Number(r.usd),
      rate: r.rate === null ? null : Number(r.rate),
    });
  }
  return out;
}

/** Marca el medio de toda la anotación ('mixto' cuando son varios). */
export async function setVisitMethod(orgId: string, visitId: string, method: string): Promise<void> {
  await getSql()`UPDATE sales SET payment_method = ${method} WHERE organization_id = ${orgId} AND visit_id = ${visitId}`;
}
