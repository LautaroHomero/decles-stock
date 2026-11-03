import { spelledToDigits } from "./spoken-numbers";
/**
 * ¿Lo escrito en Anotar es un egreso de plata? «pagué 5000 de luz», «gasto 12.500 insumos»,
 * «retiro 50 mil», «egreso: alquiler 300000». Devuelve concepto e importe (0 si no se entendió).
 * Solo palabras en primera persona o impersonales: «la paciente pagó con tarjeta» NO es un egreso.
 * También ingresos extras (plata que entra y no es de un paciente): «ingreso extra 5000 cambio»,
 * «entraron 10000 de cambio», «puse 20000 en la caja».
 */
export interface ExpenseNote {
  concept: string;
  amount: number;
  /** «por transferencia», «con tarjeta»; si no dice nada, efectivo (sale de la caja). */
  method: "efectivo" | "transferencia" | "tarjeta";
  direction: "egreso" | "ingreso";
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Palabra que marca el egreso → concepto por defecto si no se dice otro.
const CUES: [RegExp, string][] = [
  [/\begresos?\b/, ""],
  [/\bgast(?:o|os|e|amos)\b/, ""],
  [/\bpagu(?:e)\b|\bpagamos\b|\bse pago\b|\bpago (?:de|del|la|el)\b/, ""],
  [/\bretir(?:o|e|amos)\b(?! \d+ (?:crema|producto))/, "Retiro"],
  [/\b(?:saque|sacamos|saco)\b(?=.*\b(?:caja|plata|efectivo|\d))/, "Retiro"],
  [/\bcompr(?:e|amos)\b/, "Compra"],
  [/\bsalida(?: de (?:caja|plata))?\b|\bsalieron\b/, ""],
];
// Ingreso extra: «ingreso extra», «ingresaron 5000», «entraron 5000 de cambio», «puse 20000 en la caja».
const IN_CUES: RegExp[] = [
  /\bingresos? extras?\b/,
  /\bingres(?:o|os|aron|e|amos)\b/,
  /\bentr(?:o|aron)\b(?=.*\b(?:extras?|cambio|a la caja|en la caja|en caja)\b)/,
  /\b(?:puse|pusimos|puso|meti|metimos|metio)\b(?=.*\bcaja\b)/,
];
const IN_WORDS = /^(ingreso|ingresos|ingresaron|ingrese|ingresamos|extra|extras|entro|entraron|puse|pusimos|puso|meti|metimos|metio)$/;

const FILLER = new Set(["de", "del", "la", "el", "los", "las", "en", "por", "para", "un", "una", "pesos", "peso", "hoy", "se", "y", "con", "efectivo", "caja", "plata", "a", "al", "efvo", "transferencia", "transf", "transferi", "transferimos", "mp", "tarjeta", "debito", "credito"]);

function methodIn(t: string): ExpenseNote["method"] {
  if (/\b(?:transferencia|transf\w*|mp|mercado\s*pago)\b/.test(t)) return "transferencia";
  if (/\b(?:tarjeta|debito|credito)\b/.test(t)) return "tarjeta";
  return "efectivo";
}

/** «5000», «5.000», «$ 5.000», «5 mil», «5k», «1,5 millones», «1.5M». */
function amountOf(t: string): { amount: number; span: [number, number] } | null {
  const re = /\$?\s*(\d{1,3}(?:\.\d{3})+|\d+(?:[.,]\d+)?)\s*(mil(?:lones?)?|millon(?:es)?|k|m)?\b/g;
  let best: { amount: number; span: [number, number] } | null = null;
  for (const m of t.matchAll(re)) {
    const raw = m[1];
    let n = /^\d{1,3}(\.\d{3})+$/.test(raw) ? Number(raw.replace(/\./g, "")) : Number(raw.replace(",", "."));
    const unit = m[2];
    if (unit === "mil" || unit === "k") n *= 1000;
    else if (unit && /^(millon|millones|m)$/.test(unit)) n *= 1_000_000;
    n = Math.round(n);
    if (n > 0 && (!best || n > best.amount)) best = { amount: n, span: [m.index!, m.index! + m[0].length] };
  }
  return best;
}

export function parseExpense(input: string): ExpenseNote | null {
  const text = spelledToDigits(input);
  const t = norm(text.trim());
  if (!t) return null;
  const income = parseIncome(text, t);
  if (income) return income;
  const cue = CUES.find(([re]) => re.test(t));
  if (!cue) return null;
  const a = amountOf(t);
  // Sin importe, solo si la palabra no deja dudas («egreso», «gasto», «pagué»…).
  if (!a && !/\b(egresos?|gast(?:o|os|e|amos)|pague|pagamos|retir(?:o|e|amos)|saque|sacamos)\b/.test(t)) return null;

  // Concepto: el texto original sin la palabra clave, el importe ni las palabras de relleno.
  const original = text.trim();
  let rest = a ? original.slice(0, a.span[0]) + " " + original.slice(a.span[1]) : original;
  rest = rest.replace(/(?:\b(?:por|con|via)\s+)?\b(?:mercado\s*pago|transferencia|transf\w*|tarjeta(?:\s+de\s+(?:debito|d[eé]bito|credito|cr[eé]dito))?|efectivo|efvo)\b/gi, " ");
  rest = rest.replace(/[:;,.\-–]+/g, " ");
  const words = rest.split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => {
    const n = norm(w);
    if (FILLER.has(n)) return false;
    return !CUES.some(([re]) => re.test(n)) && !/^(pague|pago|pagamos|salida|salieron|egreso|egresos|gasto|gastos|gaste|gastamos|retiro|retire|retiramos|compre|compramos|saque|sacamos|saco)$/.test(n);
  });
  // Recupera «de» internos: «insumos de limpieza».
  let concept = kept.join(" ");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inner = kept.length > 1 ? original.match(new RegExp(`${esc(kept[0])}.*${esc(kept[kept.length - 1])}`, "i")) : null;
  if (kept.length > 1 && inner && !/\d/.test(inner[0])) concept = inner[0].replace(/[:;,.]+/g, " ").replace(/\s+/g, " ").trim();
  concept = concept || cue[1];
  return { concept: concept ? concept.charAt(0).toUpperCase() + concept.slice(1) : "", amount: a?.amount ?? 0, method: methodIn(t), direction: "egreso" };
}

function parseIncome(text: string, t: string): ExpenseNote | null {
  if (!IN_CUES.some((re) => re.test(t))) return null;
  // «pagó», «vino», «seña»: eso es de un paciente, no un ingreso extra.
  if (/\b(?:pag(?:o|aron|ue|amos)|vino|vinieron|sena|senas|deja|dejo)\b/.test(t)) return null;
  const a = amountOf(t);
  // Sin importe, solo si dice «ingreso extra» explícito («ingresó Ana» no es plata).
  if (!a && !/\bingresos? extras?\b/.test(t)) return null;
  const original = text.trim();
  let rest = a ? original.slice(0, a.span[0]) + " " + original.slice(a.span[1]) : original;
  rest = rest.replace(/(?:\b(?:por|con|via)\s+)?\b(?:mercado\s*pago|transferencia|transf\w*|tarjeta(?:\s+de\s+(?:debito|d[eé]bito|credito|cr[eé]dito))?|efectivo|efvo)\b/gi, " ");
  rest = rest.replace(/[:;,.\-–]+/g, " ");
  const kept = rest.split(/\s+/).filter(Boolean).filter((w) => {
    const n = norm(w);
    return !FILLER.has(n) && !IN_WORDS.test(n);
  });
  let concept = kept.join(" ");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inner = kept.length > 1 ? original.match(new RegExp(`${esc(kept[0])}.*${esc(kept[kept.length - 1])}`, "i")) : null;
  if (kept.length > 1 && inner && !/\d/.test(inner[0])) concept = inner[0].replace(/[:;,.]+/g, " ").replace(/\s+/g, " ").trim();
  concept = concept || "Varios";
  return { concept: concept.charAt(0).toUpperCase() + concept.slice(1), amount: a?.amount ?? 0, method: methodIn(t), direction: "ingreso" };
}
