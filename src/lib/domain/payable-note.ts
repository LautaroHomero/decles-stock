import { parseReminder, todayAR } from "./reminder-note";

/**
 * Lo que debe el consultorio, escrito en Anotar (Decles):
 *  · nueva: «le debemos 300000 a la distribuidora por insumos, avisame todos los días»,
 *    «tenemos que pagarle 450000 al alquiler, recordame el 30/10 a las 10», «debemos 80000 de luz, avisar mañana 9hs».
 *  · pago: «le pagamos a la distribuidora», «pagué 100000 de lo que le debíamos a la distribuidora por transferencia».
 * Una deuda con una profesional («le debemos 50000 a Marisa») no pasa por acá: es `parseProviderDebt` (va antes).
 */

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const AMOUNT = /\$?\s*(\d{1,3}(?:\.\d{3})+|\d{4,}|\d+(?:[.,]\d+)?\s*(?:mil|k|lucas|millones?|palos?))\b/g;
function pesos(raw: string): number {
  const t = raw.replace(/\$|\s/g, "");
  const m = t.match(/^(\d+(?:[.,]\d+)?)(mil|k|lucas|millones?|palos?)$/);
  if (m) return Math.round(Number(m[1].replace(",", ".")) * (/^(millon|palo)/.test(m[2]) ? 1_000_000 : 1000));
  return Number(t.replace(/\./g, ""));
}
const amountsIn = (n: string) => [...n.matchAll(AMOUNT)].map((m) => ({ v: pesos(m[1]), at: m.index!, end: m.index! + m[0].length })).filter((a) => a.v >= 100);

const OWE = /\b(?:(?:le|les)\s+)?(?:debemos|debo|adeudamos)\b|\bquedamos\s+debiendo\b|\btenemos\s+(?:una\s+)?deuda\b|\bdeuda\b(?=\s+(?:con|del\s+consultorio)\b)|\b(?:hay|tenemos|tengo)\s+que\s+pagar(?:le|les)?\b/;
const DAILY = /\b(?:todos\s+los\s+dias|cada\s+dia|diariamente|a\s+diario|todas\s+las\s+mananas|cuando\s+(?:arranco|arranque|abro|abra|llego|llegue|empiezo|empiece|entro|entre|inicio))\b/;
const TIME = /\b(?:a\s+las?\s+(\d{1,2})(?:[:.](\d{2}))?\s*(?:hs?|horas?)?|(\d{1,2})[:.](\d{2})\s*(?:hs?)?|(\d{1,2})\s*(?:hs|h|horas)\b)\s*(?:de\s+la\s+(manana|tarde|noche))?/;

export interface PayableReminder {
  remindMode: "daily" | "at" | null;
  /** AAAA-MM-DDTHH:MM */
  remindAt: string | null;
}

/** «todos los días», «el 30/10 a las 10», «mañana 9hs», «a las 18» (hoy, o mañana si ya pasó). */
export function parsePayableReminder(n: string, now: string): PayableReminder & { spans: [number, number][] } {
  const spans: [number, number][] = [];
  const d = n.match(DAILY);
  if (d) return { remindMode: "daily", remindAt: null, spans: [[d.index!, d.index! + d[0].length]] };
  const today = now.slice(0, 10);
  const date = parseReminder(n, today);
  if (date) spans.push(date.span);
  const t = n.match(TIME);
  let hhmm: string | null = null;
  if (t) {
    let h = Number(t[1] ?? t[3] ?? t[5]);
    const m = Number(t[2] ?? t[4] ?? 0);
    if (t[6] && t[6] !== "manana" && h < 12) h += 12;
    if (h <= 23 && m <= 59) {
      hhmm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      spans.push([t.index!, t.index! + t[0].length]);
    }
  }
  if (!date && !hhmm) return { remindMode: null, remindAt: null, spans };
  let day = date?.remindOn ?? today;
  const time = hhmm ?? "09:00";
  // Solo la hora y ya pasó: mañana.
  if (!date && `${day}T${time}` <= now) {
    const x = new Date(`${day}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + 1);
    day = x.toISOString().slice(0, 10);
  }
  return { remindMode: "at", remindAt: `${day}T${time}`, spans };
}

export interface PayableNote extends PayableReminder {
  creditor: string;
  concept: string;
  amount: number | null;
}

// Palabras que no son ni a quién ni por qué.
const FILLER = /\b(?:avisame|avisarme|avisar|avisa|recordame|recordar|recordarme|recordatorio|acordarme|que|me|nos|le|les|lo|la|el|y|para|pagar|pagarle|pagarles|pesos|hoy|todo|todos|antes)\b/g;

/** Una deuda nueva del consultorio, o null si el texto no dice eso. */
export function parsePayable(text: string, now: string = `${todayAR()}T00:00`): PayableNote | null {
  const n = norm(text);
  const owe = n.match(OWE);
  if (!owe) return null;
  const rem = parsePayableReminder(n, now);
  // Lo que queda del texto sin el recordatorio, para sacar a quién y por qué.
  let rest = n;
  for (const [a, b] of [...rem.spans].sort((x, y) => y[0] - x[0])) rest = rest.slice(0, a) + " ".repeat(b - a) + rest.slice(b);
  rest = rest.replace(/\b(?:avisame|avisarme|avisar|recordame|recordarme|recordar|acordarme)\b[^,.;]*/g, (m) => " ".repeat(m.length));
  const amounts = amountsIn(rest);
  const amount = amounts.length ? Math.max(...amounts.map((a) => a.v)) : null;
  for (const a of amounts.sort((x, y) => y.at - x.at)) rest = rest.slice(0, a.at) + " ".repeat(a.end - a.at) + rest.slice(a.end);
  const afterOwe = rest.slice(owe.index! + owe[0].length);
  // A quién: «a la distribuidora», «al alquiler», «con el proveedor»; por qué: «por insumos», «de luz».
  const who = afterOwe.match(/\b(?:a|al|a\s+la|a\s+los|a\s+las|con|con\s+el|con\s+la)\s+([^,.;]+?)(?=\s+(?:por|de|del)\s|[,.;]|$)/);
  const why = afterOwe.match(/\b(?:por|de|del)\s+([^,.;]+?)(?=\s+(?:a|al|con)\s|[,.;]|$)/);
  const tidy = (s: string | undefined) =>
    (s ?? "")
      .replace(FILLER, " ")
      .replace(/\s+/g, " ")
      .trim();
  // Se devuelven con las mayúsculas y tildes del original (mismas posiciones: `norm` no cambia el largo).
  const orig = (s: string) => {
    if (!s) return "";
    const i = norm(text).indexOf(s);
    return i >= 0 ? text.slice(i, i + s.length) : s;
  };
  const creditor = orig(tidy(who?.[1])) || orig(tidy(why?.[1]));
  const concept = who ? orig(tidy(why?.[1])) : "";
  return { creditor, concept, amount, remindMode: rem.remindMode, remindAt: rem.remindAt };
}

/**
 * «le pagamos a la distribuidora», «pagué 100000 a la distribuidora por transferencia», «cancelamos la deuda con el alquiler»:
 * un pago de algo que debe el consultorio. Busca la deuda por el nombre de a quién se le debe.
 */
export function parsePayablePayment<P extends { id: string; creditor: string; concept: string; remaining: number }>(
  text: string,
  open: P[],
): { payables: P[]; amount: number | null; method: "efectivo" | "transferencia" | "tarjeta" | null } | null {
  if (!open.length) return null;
  const n = norm(text);
  if (!/\b(?:pague|pagamos|le\s+pague|le\s+pagamos|les\s+pagamos|cancele|cancelamos|salde|saldamos|transferi|transferimos|abone|abonamos)\b/.test(n)) return null;
  if (OWE.test(n.replace(/\b(?:de\s+)?lo\s+que\s+(?:le\s+|les\s+)?deb\w*/g, " "))) return null;
  const words = new Set(n.split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 3));
  const scored = open
    .map((p) => ({ p, hits: norm(`${p.creditor} ${p.concept}`).split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 3 && words.has(w)).length }))
    .filter((x) => x.hits > 0);
  if (!scored.length) return null;
  const best = Math.max(...scored.map((x) => x.hits));
  const amounts = amountsIn(n);
  const method = /\b(?:transferencia|transf\w*|transferi|transferimos|mp|mercado\s*pago)\b/.test(n)
    ? "transferencia"
    : /\b(?:tarjeta|debito|credito)\b/.test(n)
      ? "tarjeta"
      : /\b(?:efectivo|efvo|cash)\b/.test(n)
        ? "efectivo"
        : null;
  return {
    payables: scored.filter((x) => x.hits === best).map((x) => x.p),
    amount: amounts.length && !/\btodo\b/.test(n) ? amounts.reduce((a, b) => a + b.v, 0) : null,
    method,
  };
}
