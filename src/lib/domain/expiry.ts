/** Fechas de vencimiento (sin dependencias: la usan el servidor y la pantalla). */

/**
 * Acepta `YYYY-MM-DD`, `DD/MM/YYYY` (o `DD/MM/YY`) o mes/año (`03/2027`, `03/27`, `2027-03`; vence el último día del mes).
 * Devuelve null si está vacío (el lote no vence) y `undefined` si no se entiende.
 */
export function parseExpiry(raw: string | null | undefined): string | null | undefined {
  const s = raw?.trim();
  if (!s) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate();
  let y: number, m: number, d: number | undefined;
  let g: RegExpMatchArray | null;
  // Año de 2 cifras = 20xx («03/27» como viene impreso en las cajas).
  const yr = (t: string) => (t.length === 2 ? 2000 + +t : +t);
  if ((g = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [y, m, d] = [+g[1], +g[2], +g[3]];
  else if ((g = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/))) [y, m, d] = [yr(g[3]), +g[2], +g[1]];
  else if ((g = s.match(/^(\d{4})-(\d{1,2})$/))) [y, m] = [+g[1], +g[2]];
  else if ((g = s.match(/^(\d{1,2})[/.-](\d{4}|\d{2})$/))) [y, m] = [yr(g[2]), +g[1]];
  else return undefined;
  if (m < 1 || m > 12) return undefined;
  const day = d ?? lastDay(y, m);
  if (day < 1 || day > lastDay(y, m)) return undefined;
  return `${y}-${pad(m)}-${pad(day)}`;
}
