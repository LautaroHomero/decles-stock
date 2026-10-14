import { sellerNamed, type QuickSeller } from "./quick-sale";

/**
 * La plata en lo que se anota (Decles). La secretaria siempre dice cuánto ingresó; el reparto
 * (la parte de la profesional y la de Decles) lo hace el sistema, salvo que el mensaje lo aclare.
 *
 *  · «peeling a carla, gabi, 45000» / «pagó 45.000» / «50 mil»  → ingresó 45.000 (pisa la lista).
 *  · «le transfirieron a carmen», «pagó directo a la profesional», «con abono» → no ingresó nada a la caja.
 *  · «a carmen le corresponden 9000», «se lleva 9000», «hay que darle 9000», «para ella 9000» → la parte
 *    de la profesional la dijo la secretaria (si no, sale de su %).
 *
 * Los números chicos sin «$» ni «mil» («2 cremas») siguen siendo cantidades.
 */

export interface MoneyNote {
  /** El texto sin la plata ni las frases de plata (para buscar paciente, médica y prácticas). */
  text: string;
  /** Lo que ingresó, si se escribió. */
  paid: number | null;
  /** Le pagaron directo a la profesional (o abono): a la caja no entró nada. */
  direct: boolean;
  /** Lo que le corresponde a la profesional, si se aclaró. */
  share: number | null;
  /**
   * Pagó con varios medios o en dólares («20000 en efectivo y 20000 con tarjeta», «100 dólares»):
   * pesos por medio y los dólares (los pasa a pesos la pantalla, con la cotización del día).
   */
  split: Split | null;
  /** Un solo medio pegado al importe («30000 con tarjeta»). */
  method: "efectivo" | "transferencia" | "tarjeta" | null;
}

export interface Split {
  efectivo: number;
  transferencia: number;
  tarjeta: number;
  usd: number;
  /** Cotización fija (al corregir algo ya guardado se respeta la que se usó). Sin esto, la del día. */
  rate?: number | null;
}

/** Pesos de un pago dividido: los tres medios + los dólares a la cotización. */
export const splitPesos = (s: Split, rate: number | null) =>
  s.efectivo + s.transferencia + s.tarjeta + Math.round(s.usd * (s.rate ?? rate ?? 0));

/** Partes para `/api/visits` (solo las que tienen algo). */
export function splitParts(s: Split, rate: number | null) {
  const parts: { method: "efectivo" | "transferencia" | "tarjeta" | "dolares"; amount?: number; usd?: number; rate?: number }[] = [];
  for (const m of ["efectivo", "transferencia", "tarjeta"] as const) if (s[m] > 0) parts.push({ method: m, amount: s[m] });
  const r = s.rate ?? rate;
  if (s.usd > 0 && r) parts.push({ method: "dolares", usd: s.usd, rate: r });
  return parts;
}

// Dólares: «100 dólares», «100 usd», «u$s 100», «US$ 100», «100 verdes».
const USD = /(?:\b(?:usd|u\$s|us\$)\s*(\d+(?:[.,]\d+)?))|(?:\b(\d+(?:[.,]\d+)?)\s*(?:usd|u\$s|us\$|d[oó]lares?|dolar(?:es)?|verdes)\b)/gi;
// Medio de pago pegado a un importe (después: «20000 en efectivo»; antes: «efectivo 20000»).
const METHOD_AFTER = /^\s*(?:en|con|por|de|x)?\s*(efectivo|efvo|cash|contado|transferencia|transf\w*|mp|mercado\s*pago|tarjeta|tarj\w*|debito|credito|posnet)\b/;
const METHOD_BEFORE = /\b(efectivo|efvo|cash|transferencia|transf\w*|mp|tarjeta|tarj\w*|debito|credito)\s*(?:de|por|:)?\s*\$?\s*$/;
function methodWord(w: string | undefined): keyof Omit<Split, "usd"> | null {
  if (!w) return null;
  if (/^(efectivo|efvo|cash|contado)$/.test(w)) return "efectivo";
  if (/^(transf|mp|mercado)/.test(w)) return "transferencia";
  if (/^(tarj|debito|credito|posnet)/.test(w)) return "tarjeta";
  return null;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Un importe: «$ 45.000», «45000», «45 mil», «1,5 millones», «9k», «45 lucas».
const AMOUNT = /\$\s*\d[\d.,]*(?:\s*(?:mil|k|lucas|m|millones?))?|\b\d{1,3}(?:\.\d{3})+\b|\b\d{4,}\b|\b\d+(?:[.,]\d+)?\s*(?:mil|k|lucas|millones?)\b/gi;

// Lo que va antes del importe y dice que es la parte de la profesional.
const SHARE_BEFORE =
  /(?:\ba\s+(\S+)\s+)?(?:le\s+)?(?:corresponde[n]?|toca[n]?|queda[n]?|lleva[n]?|llevan?|damos|dar(?:le)?|darle|pagamos(?:le)?|comision|honorarios?|parte|para\s+(?:ella|el|la\s+profesional|la\s+medica|la\s+kine\w*))(?:\s+\S+){0,3}\s*$/;
// Lo que dice que la paciente le pagó directo a la profesional (o tiene un abono): no entra a la caja.
const DIRECT =
  /\b(?:le\s+)?transfiri(?:o|eron)\s+(?:a\s+)?(?:ella|el|la\s+\w+|\w+)|\btransferencia\s+a\s+(?:ella|el|la\s+\w+|\w+)|\bpag(?:o|aron)\s+directo(?:\s+a\s+(?:ella|el|la\s+\w+|\w+))?|\bdirecto\s+a\s+(?:ella|el|la\s+\w+|\w+)|\ble\s+pag(?:o|aron)\s+a\s+(?:ella|el|la\s+\w+)|\b(?:con|de|tiene|usa|por)\s+abono\b|\babono\b(?!\s*(?:\$|\d))/;
// Palabras de «pagó» que acompañan al importe y no son paciente ni práctica.
const PAID_WORDS = /\b(?:pago|pagaron|abono|abonaron|cobre|cobramos|cobro|ingreso|ingresaron|entro|entraron|dejo|total|son)\s*$/;

function toPesos(raw: string): number {
  const t = norm(raw).replace(/\$/g, "").trim();
  const unit = t.match(/(mil|k|lucas|millones?|m)$/)?.[1];
  let n = t.replace(/(mil|k|lucas|millones?|m)$/, "").trim();
  // «45.000» → 45000; «1,5» → 1.5
  n = /^\d{1,3}(\.\d{3})+$/.test(n) ? n.replace(/\./g, "") : n.replace(",", ".");
  let v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (unit === "mil" || unit === "k" || unit === "lucas") v *= 1000;
  else if (unit && /^(m|millon|millones)$/.test(unit)) v *= 1_000_000;
  return Math.round(v);
}

export function extractMoney(text: string): MoneyNote {
  let paid: number | null = null;
  let share: number | null = null;
  const n = norm(text);
  const direct = DIRECT.test(n);
  // Recortes a sacar del texto: [desde, hasta)
  const cuts: [number, number][] = [];
  const split: Split = { efectivo: 0, transferencia: 0, tarjeta: 0, usd: 0 };
  const methods = new Set<string>();

  // Dólares primero (no son pesos).
  const usdSpans: [number, number][] = [];
  for (const m of text.matchAll(USD)) {
    const v = Number((m[1] ?? m[2]).replace(",", "."));
    if (!(v > 0)) continue;
    split.usd += v;
    const at = m.index ?? 0;
    usdSpans.push([at, at + m[0].length]);
    const pw = norm(text.slice(Math.max(0, at - 20), at)).match(PAID_WORDS);
    cuts.push([at - (pw ? pw[0].length : 0), at + m[0].length]);
  }

  for (const m of text.matchAll(AMOUNT)) {
    const at = m.index ?? 0;
    if (usdSpans.some(([a, b]) => at < b && at + m[0].length > a)) continue;
    const v = toPesos(m[0]);
    if (v <= 0) continue;
    const before = norm(text.slice(Math.max(0, at - 48), at));
    const sm = before.match(SHARE_BEFORE);
    if (sm) {
      share = (share ?? 0) + v;
      const from = at - sm[0].length;
      if (sm[1]) {
        // «a carmen le tocan 9000»: se saca la frase pero queda «carmen» (es la profesional).
        const nameEnd = from + sm[0].indexOf(sm[1]) + sm[1].length;
        cuts.push([from, from + sm[0].indexOf(sm[1])]);
        cuts.push([nameEnd, at + m[0].length]);
      } else cuts.push([from, at + m[0].length]);
      continue;
    }
    paid = (paid ?? 0) + v;
    const pm = before.match(PAID_WORDS);
    // ¿Con qué medio? «20000 en efectivo» / «tarjeta 20000».
    const after = norm(text.slice(at + m[0].length, at + m[0].length + 30));
    const ma = after.match(METHOD_AFTER);
    const mb = before.match(METHOD_BEFORE);
    const method = methodWord(ma?.[1]) ?? methodWord(mb?.[1]);
    if (method) {
      split[method] += v;
      methods.add(method);
    } else split.efectivo += 0;
    cuts.push([at - (mb && !ma ? mb[0].length : pm ? pm[0].length : 0), at + m[0].length + (ma ? ma[0].length : 0)]);
  }
  // Es un pago dividido si hay dólares o importes con dos medios distintos. Lo que no dijo medio va a efectivo.
  const isSplit = split.usd > 0 || methods.size >= 2;
  if (isSplit && paid !== null) {
    const assigned = split.efectivo + split.transferencia + split.tarjeta;
    split.efectivo += paid - assigned;
  }
  // Las frases de «pago directo» / «abono» tampoco son paciente ni práctica.
  const dm = n.match(DIRECT);
  if (dm && dm.index !== undefined) cuts.push([dm.index, dm.index + dm[0].length]);

  let out = text;
  for (const [a, b] of cuts.sort((x, y) => y[0] - x[0])) out = `${out.slice(0, Math.max(0, a))} ${out.slice(b)}`;
  out = out.replace(/(?:^|[\s,;]+)(?:y|e|mas|más|\+)(?=\s*(?:[,;]|$))/gi, "").replace(/\s+([,;])/g, "$1").replace(/([,;])\s*([,;])+/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,;]+|[\s,;]+$/g, "");
  const single = !isSplit && methods.size === 1 ? ([...methods][0] as MoneyNote["method"]) : null;
  return { text: out, paid: direct && paid === null ? 0 : paid, direct, share, split: isSplit ? split : null, method: single };
}

/**
 * Reparte lo que ingresó entre los renglones: los productos a su precio de lista (o el que se escribió)
 * y el resto a la primera práctica. Sin práctica, la diferencia va al primer renglón.
 */
export function splitPaid(lines: { list: number; product: boolean }[], paid: number | null): number[] {
  const amounts = lines.map((l) => l.list);
  if (paid === null || !lines.length) return amounts;
  const diff = paid - amounts.reduce((a, b) => a + b, 0);
  if (diff === 0) return amounts;
  if (paid === 0) return amounts.map(() => 0);
  const i = Math.max(0, lines.findIndex((l) => !l.product));
  amounts[i] = Math.max(0, amounts[i] + diff);
  return amounts;
}

/**
 * «ya le pagué todo a carmen», «le pagué 18000 a gabi», «liquidé a laura»: un pago a una profesional
 * (sale de la caja). `amount` null = todo lo que se le debe del día.
 */
export function parsePayout<S extends QuickSeller>(text: string, sellers: S[]): { seller: S; amount: number | null } | null {
  const n = norm(text);
  if (!/\b(?:pague|pagamos|le di|le dimos|liquide|liquidamos|se le pago|ya le pague|le pague|le pagamos|pagado a)\b/.test(n)) return null;
  const seller = sellerNamed(text, sellers);
  if (!seller) return null;
  const amounts = [...text.matchAll(AMOUNT)].map((m) => toPesos(m[0])).filter((v) => v > 0);
  return { seller, amount: amounts.length && !/\btodo\b/.test(n) ? amounts.reduce((a, b) => a + b, 0) : null };
}
