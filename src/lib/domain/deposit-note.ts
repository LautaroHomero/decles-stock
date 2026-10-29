import { parseReminder, todayAR } from "./reminder-note";

/**
 * Señas en Anotar (Decles):
 *  · nueva: «carla perez dejó 20000 de seña para botox, viene el 28/10», «seña de carla 20000 botox, viene el viernes»,
 *    «carla señó 15000 para limpieza facial el 5/11 por transferencia».
 *  · usarla: el día que viene se escribe la atención como siempre; si la paciente tiene seña, se descuenta sola
 *    («botox a carla, con la seña», «pagó el resto»). Eso lo resuelve la vista previa.
 */

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const AMOUNT = /\$?\s*(\d{1,3}(?:\.\d{3})+|\d{4,}|\d+(?:[.,]\d+)?\s*(?:mil|k|lucas))\b/g;
function pesos(raw: string): number {
  const t = raw.replace(/\$|\s/g, "");
  const m = t.match(/^(\d+(?:[.,]\d+)?)(mil|k|lucas)$/);
  if (m) return Math.round(Number(m[1].replace(",", ".")) * 1000);
  return Number(t.replace(/\./g, ""));
}

/** «con la seña», «tenía seña», «descontá la seña», «pagó el resto»: es la atención de alguien que ya señó. */
export const USES_DEPOSIT = /\b(?:con|tenia|tiene|usa|uso|descontar|desconta|descontale|menos)\s+(?:la\s+|su\s+|una\s+)?sena\b|\b(?:pago|pagan|paga|abono)\s+(?:el\s+)?(?:resto|saldo|restante)\b/;

export interface DepositNote {
  amount: number;
  /** Día del turno (AAAA-MM-DD). */
  dueOn: string | null;
  method: "efectivo" | "transferencia" | "tarjeta" | null;
}

export function parseDepositNote(text: string, today: string = todayAR()): DepositNote | null {
  const n = norm(text);
  if (!/\bsen(?:a|o|aron|amos)\b/.test(n) || USES_DEPOSIT.test(n)) return null;
  const amounts = [...n.matchAll(AMOUNT)].map((m) => pesos(m[1])).filter((v) => v >= 500);
  if (!amounts.length) return null;
  const date = parseReminder(n, today);
  const method = /\b(?:transferencia|transf\w*|mp|mercado\s*pago)\b/.test(n)
    ? "transferencia"
    : /\b(?:tarjeta|tarj\w*|debito|credito|posnet)\b/.test(n)
      ? "tarjeta"
      : /\b(?:efectivo|efvo|cash|contado)\b/.test(n)
        ? "efectivo"
        : null;
  const dueOn = date?.remindOn ?? (/\b(?:viene|vienen|turno|para)\s+(?:el\s+dia\s+de\s+)?hoy\b/.test(n) ? today : null);
  return { amount: Math.max(...amounts), dueOn, method };
}

const STOP = new Set(
  ("sena senas seno senaron dejo deja dejaron pago pagaron abono un una el la los las de del para por con en a al y viene vienen " +
    "turno el que proximo proxima manana pasado lunes martes miercoles jueves viernes sabado domingo semana mes fin " +
    "efectivo efvo cash contado transferencia transf mp mercado tarjeta debito credito posnet pesos mil k lucas su le se hace hacer " +
    "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre")
    .split(" "),
);

/** La paciente de «carla perez dejó 20000 de seña para botox…»: el primer tramo de palabras que no son de la seña ni la práctica. */
export function depositPatient(text: string, itemName: string | null): string {
  const item = new Set(norm(itemName ?? "").split(/[^a-z0-9]+/).filter(Boolean));
  const kept: string[] = [];
  for (const w of text.split(/[\s,;:.()]+/).filter(Boolean)) {
    const x = norm(w).replace(/[^a-z0-9$/]/g, "");
    if (!x || STOP.has(x) || item.has(x) || /\d/.test(x) || x.startsWith("$")) {
      if (kept.length) break;
      continue;
    }
    kept.push(w);
  }
  return kept.join(" ");
}
