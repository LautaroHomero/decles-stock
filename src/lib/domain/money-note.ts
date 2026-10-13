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

  for (const m of text.matchAll(AMOUNT)) {
    const at = m.index ?? 0;
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
    cuts.push([at - (pm ? pm[0].length : 0), at + m[0].length]);
  }
  // Las frases de «pago directo» / «abono» tampoco son paciente ni práctica.
  const dm = n.match(DIRECT);
  if (dm && dm.index !== undefined) cuts.push([dm.index, dm.index + dm[0].length]);

  let out = text;
  for (const [a, b] of cuts.sort((x, y) => y[0] - x[0])) out = `${out.slice(0, Math.max(0, a))} ${out.slice(b)}`;
  out = out.replace(/\s+([,;])/g, "$1").replace(/([,;])\s*([,;])+/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,;]+|[\s,;]+$/g, "");
  return { text: out, paid: direct && paid === null ? 0 : paid, direct, share };
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
