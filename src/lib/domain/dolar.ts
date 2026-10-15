import { getSql } from "@/lib/db/connection";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";

/**
 * Dólar del día (Decles). Cuando pagan en dólares, la secretaria los toma al **promedio del dólar oficial**
 * (compra + venta) / 2. La cotización se busca sola (dolarapi.com; si falla, bluelytics) y se muestra
 * arriba a la derecha. Si ese día se escribió otra a mano, manda esa (`day_cash.usd_rate`).
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };

export interface DolarHoy {
  compra: number | null;
  venta: number | null;
  /** La que se usa para cobrar: la escrita a mano ese día o el promedio del oficial. */
  rate: number | null;
  manual: boolean;
  updatedAt: string | null;
}

const round = (n: number) => Math.round(n * 100) / 100;

async function fetchOficial(): Promise<{ compra: number; venta: number; updatedAt: string | null } | null> {
  try {
    const r = await fetch("https://dolarapi.com/v1/dolares/oficial", { next: { revalidate: 600 }, signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = (await r.json()) as { compra?: number; venta?: number; fechaActualizacion?: string };
      if (d.compra && d.venta) return { compra: d.compra, venta: d.venta, updatedAt: d.fechaActualizacion ?? null };
    }
  } catch {
    /* sigue con la otra */
  }
  try {
    const r = await fetch("https://api.bluelytics.com.ar/v2/latest", { next: { revalidate: 600 }, signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = (await r.json()) as { oficial?: { value_buy?: number; value_sell?: number }; last_update?: string };
      if (d.oficial?.value_buy && d.oficial?.value_sell) return { compra: d.oficial.value_buy, venta: d.oficial.value_sell, updatedAt: d.last_update ?? null };
    }
  } catch {
    /* sin cotización: se escribe a mano */
  }
  return null;
}

export async function dolarHoy(actor: Actor): Promise<Result<{ dolar: DolarHoy }>> {
  const orgId = actor.activeOrg?.id;
  if (!orgId) return { ok: false, error: "No autorizado.", status: 403 };
  const today = realNowIso().slice(0, 10);
  const [row] = (await getSql()`SELECT usd_rate FROM day_cash WHERE organization_id = ${orgId} AND date = ${today}`) as unknown as { usd_rate: string | null }[];
  const oficial = await fetchOficial();
  const manual = row?.usd_rate ? Number(row.usd_rate) : null;
  const avg = oficial ? round((oficial.compra + oficial.venta) / 2) : null;
  return {
    ok: true,
    dolar: { compra: oficial?.compra ?? null, venta: oficial?.venta ?? null, rate: manual ?? avg, manual: manual !== null, updatedAt: oficial?.updatedAt ?? null },
  };
}

/** Cotización de hoy escrita a mano (null = volver al oficial). Secretaría y admin. */
export async function setDolarHoy(actor: Actor, rate: unknown): Promise<Result<{ dolar: DolarHoy }>> {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "medico" || actor.role === "paciente") return { ok: false, error: "No autorizado.", status: 403 };
  const n = rate === null || rate === "" ? null : Number(rate);
  if (n !== null && !(n > 0 && n < 100_000)) return { ok: false, error: "Cotización inválida.", status: 400 };
  const today = realNowIso().slice(0, 10);
  await getSql()`
    INSERT INTO day_cash (organization_id, date, usd_rate, updated_by_name, updated_at)
    VALUES (${orgId}, ${today}, ${n}, ${actor.name}, ${realNowIso()})
    ON CONFLICT (organization_id, date) DO UPDATE SET usd_rate = EXCLUDED.usd_rate, updated_by_name = EXCLUDED.updated_by_name, updated_at = EXCLUDED.updated_at`;
  return dolarHoy(actor);
}
