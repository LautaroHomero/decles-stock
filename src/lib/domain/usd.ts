/**
 * Plata en dólares (Decles): se guarda lo que se pagó en dólares (`usd`) y la cotización usada (`rate`). Los pesos
 * (`usd × rate`) quedan solo para las cuentas internas (descuentos, saldos, la parte de la profesional).
 */
export interface UsdAmount {
  usd: number;
  rate: number;
  /** En pesos, a esa cotización. */
  pesos: number;
}

/** `{ usd, rate }` del pedido → validado. null si no vino; string = el error. */
export function usdFrom(v: { usd?: unknown; rate?: unknown }): UsdAmount | string | null {
  if (v.usd === undefined || v.usd === null || v.usd === "") return null;
  const usd = Math.round(Number(v.usd) * 100) / 100;
  const rate = Math.round(Number(v.rate) * 100) / 100;
  if (!(usd > 0 && usd < 1_000_000)) return "¿Cuántos dólares? Tiene que ser un número mayor a 0.";
  if (!(rate > 0 && rate < 100_000)) return "Falta la cotización del dólar (arriba a la derecha).";
  return { usd, rate, pesos: Math.round(usd * rate) };
}
