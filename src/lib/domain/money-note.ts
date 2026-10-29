import { sellerNamed, type QuickSeller } from "./quick-sale";
import { parseReminder } from "./reminder-note";

/**
 * La plata en lo que se anota (Decles). La secretaria siempre dice cuánto ingresó; el reparto
 * (la parte de la profesional y la de Decles) lo hace el sistema, salvo que el mensaje lo aclare.
 *
 *  · «peeling a carla, gabi, 45000» / «pagó 45.000» / «50 mil»  → ingresó 45.000 (pisa la lista).
 *  · «con abono» → no ingresó nada a la caja.
 *  · «le transfirieron a carmen», «pagó directo a la profesional» → medio «a la profesional» (`toProvider`): la atención
 *    vale lo que salía (o lo escrito), no entra a la caja y lo nuestro nos lo debe ella; «nos debe 36000» lo aclara (`owesUs`).
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
  /** Le pagaron directo a la profesional (no abono): medio «a la profesional». */
  toProvider: boolean;
  /** «nos debe 36000», «nos tiene que dar 36000»: lo nuestro de lo que cobró ella directo. */
  owesUs: number | null;
  /** Lo que le corresponde a la profesional, si se aclaró. */
  share: number | null;
  /**
   * Pagó con varios medios o en dólares («20000 en efectivo y 20000 con tarjeta», «100 dólares»):
   * pesos por medio y los dólares (los pasa a pesos la pantalla, con la cotización del día).
   */
  split: Split | null;
  /** Un solo medio pegado al importe («30000 con tarjeta»). */
  method: "efectivo" | "transferencia" | "tarjeta" | null;
  /** Lo que quedó debiendo («debe 40000», «quedó debiendo 40 mil»). */
  debt: number | null;
  /** «debe todo», «no pagó», «fiado»: no pagó nada y debe lo que salía. */
  debtAll: boolean;
  /** Día para acordarse de cobrar la deuda («paga el viernes», «recordar el 30/10»), AAAA-MM-DD. */
  remindOn: string | null;
  /**
   * Partes sin importe: «la mitad en efectivo y la mitad con tarjeta», «30% transferencia», «debe la otra mitad».
   * Fracciones (0–1) de lo que salía; la pantalla las pasa a pesos con el precio.
   */
  fractions: { efectivo: number; transferencia: number; tarjeta: number; usd: number; debt: number } | null;
  /**
   * «pagó en dólares» sin decir cuántos: pagó todo en dólares. La pantalla los calcula con la cotización
   * del día (lo que salía, o lo que se escribió en pesos: «45000 en dólares»).
   */
  usdAll: boolean;
}

export interface Split {
  efectivo: number;
  transferencia: number;
  tarjeta: number;
  giftcard?: number;
  usd: number;
  /** Cotización fija (al corregir algo ya guardado se respeta la que se usó). Sin esto, la del día. */
  rate?: number | null;
}

/** Pesos de un pago dividido: los tres medios + los dólares a la cotización. */
export const splitPesos = (s: Split, rate: number | null) =>
  s.efectivo + s.transferencia + s.tarjeta + (s.giftcard ?? 0) + Math.round(s.usd * (s.rate ?? rate ?? 0));

/** Partes para `/api/visits` (solo las que tienen algo). */
export function splitParts(s: Split, rate: number | null) {
  const parts: { method: "efectivo" | "transferencia" | "tarjeta" | "dolares" | "giftcard"; amount?: number; usd?: number; rate?: number }[] = [];
  for (const m of ["efectivo", "transferencia", "tarjeta"] as const) if (s[m] > 0) parts.push({ method: m, amount: s[m] });
  if ((s.giftcard ?? 0) > 0) parts.push({ method: "giftcard", amount: s.giftcard });
  const r = s.rate ?? rate;
  if (s.usd > 0 && r) parts.push({ method: "dolares", usd: s.usd, rate: r });
  return parts;
}

// Dólares: «100 dólares», «100 usd», «u$s 100», «US$ 100», «100 verdes», «100 en dólares».
const USD = /(?:\b(?:usd|u\$s|us\$)\s*(\d+(?:[.,]\d+)?))|(?:\b(\d{1,3}(?:\.\d{3})+|\d+(?:[.,]\d+)?)\s*(en\s+|con\s+)?(?:usd|u\$s|us\$|d[oó]lares?|verdes)\b)/gi;
// «pagó en dólares», «en usd», «con dólares» (sin cantidad): todo en dólares, a la cotización del día.
const USD_ALL = /\b(?:(?:pago|pagaron|abono|abonaron|cobre|cobramos|cobro)\s+)?(?:en|con)\s+(?:dolares|dolar|usd|u\$s|us\$|verdes)\b/;
/** «45000 en dólares»: desde acá es un importe en pesos que se pagó en dólares (nadie paga US$ 5000 acá). */
const USD_AS_PESOS = 5000;
// Medio de pago pegado a un importe (después: «20000 en efectivo»; antes: «efectivo 20000»).
// También con «pagó» en el medio: «50000 pagó con tarjeta», «50000 pago en efectivo».
const METHOD_AFTER = /^\s*(?:(?:pago|pagaron|abono|abonaron)\s+)?(?:en|con|por|de|x)?\s*(efectivo|efvo|cash|contado|transferencia|transf\w*|mp|mercado\s*pago|tarjeta|tarj\w*|debito|credito|posnet)\b/;
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
// Solo el «pago directo» a la profesional (sin abono).
const TO_PROVIDER =
  /\b(?:le\s+)?transfiri(?:o|eron)\s+(?:a\s+)?(?:ella|el|la\s+\w+|\w+)|\btransferencia\s+a\s+(?:ella|el|la\s+\w+|\w+)|\bpag(?:o|aron)\s+directo(?:\s+a\s+(?:ella|el|la\s+\w+|\w+))?|\bdirecto\s+a\s+(?:ella|el|la\s+\w+|\w+)|\ble\s+pag(?:o|aron)\s+a\s+(?:ella|el|la\s+\w+)/;
// Lo que va antes del importe y dice que es lo nuestro que tiene la profesional: «nos debe 36000», «nos tiene que dar 36000».
const OWES_US_BEFORE =
  /\b(?:(?:ella|el|la\s+profesional|la\s+\w+)\s+)?nos\s+(?:debe(?:n)?(?:\s+(?:dar|pasar|transferir|devolver))?|tiene\s+que\s+(?:dar|pasar|transferir|devolver)|corresponde(?:n)?|toca(?:n)?|queda(?:n)?)\s*(?:de\s+)?\$?\s*$|\b(?:para\s+(?:nosotros|el\s+consultorio|decles))\s*\$?\s*$/;
// Lo que va antes del importe y dice que es lo que quedó debiendo.
const DEBT_BEFORE =
  /\b(?:(?:le\s+)?debe[n]?|adeuda[n]?|(?:quedo|queda|quedaron|quedan)\s+debiendo|(?:le\s+)?(?:falta|faltan|resta|restan)(?:\s+(?:pagar|abonar))?|saldo|fiado|deuda(?:\s+de)?)\s*(?:de\s+)?\$?\s*$/;
// Lo que va después: «40000 de deuda», «40000 fiado», «40000 queda debiendo».
const DEBT_AFTER = /^\s*(?:de\s+deuda|fiados?|(?:queda|quedo)\s+debiendo|(?:los\s+)?debe)\b/;
// No pagó nada: debe todo lo que salía.
const DEBT_ALL = /\b(?:debe\s+todo|queda\s+debiendo\s+todo|quedo\s+debiendo\s+todo|no\s+pago(?:\s+nada)?|fiado|lo\s+debe|paga\s+(?:despues|la\s+semana\s+que\s+viene|el\s+\w+\s+que\s+viene|otro\s+dia))\b/;
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

// «la mitad», «la otra mitad», «un tercio», «dos tercios», «un cuarto», «30%»
const FRACTION = String.raw`(?:la\s+)?(?:otra\s+)?(mitad|un\s+tercio|dos\s+tercios|un\s+cuarto|tres\s+cuartos|\d{1,3}\s*%)`;
// Primero las compuestas: «efvo en dólar», «efectivo en dólares», «dólares en efectivo» = dólares (billetes).
const FRAC_METHODS = String.raw`((?:efectivo|efvo|cash)\s+en\s+(?:dolares|dolar|usd|verdes)|(?:dolares|dolar|usd|verdes)\s+(?:en\s+)?(?:efectivo|efvo|billete)|efectivo|efvo|cash|contado|transferencia|transf\w*|mp|tarjeta|tarj\w*|debito|credito|posnet|dolares|dolar|usd|u\$s|verdes)`;
// «la mitad con tarjeta» (la parte antes del medio)…
const FRACTION_METHOD = new RegExp(
  String.raw`(?:\b(?:pago|pagaron|abono)\s+)?` + FRACTION + String.raw`\s+(?:en|con|por|de|x)?\s*` + FRAC_METHODS + String.raw`(?![\w$])`,
  "g",
);
// …o «con tarjeta la mitad» (el medio antes de la parte).
const METHOD_FRACTION = new RegExp(
  String.raw`(?:\b(?:pago|pagaron|abono)\s+)?(?:en|con|por)\s+` + FRAC_METHODS + String.raw`\s+` + FRACTION + String.raw`\b`,
  "g",
);
// «mitad y mitad, tarjeta y efectivo», «mitad y mitad entre tarjeta y efectivo».
const HALF_HALF = new RegExp(
  String.raw`(?:\b(?:pago|pagaron|abono)\s+)?\bmitad\s+y\s+mitad\s*(?:,\s*|entre\s+|en\s+|con\s+)?` + FRAC_METHODS + String.raw`\s+y\s+(?:en\s+|con\s+|por\s+)?` + FRAC_METHODS + String.raw`(?![\w$])`,
  "g",
);
// «… y la otra en efectivo», «el resto con tarjeta», «lo demás por transferencia»: lo que falta, con ese medio.
const REST_METHOD = new RegExp(
  String.raw`(?:\by\s+)?\b(?:la\s+otra|el\s+resto|lo\s+demas|lo\s+que\s+falta(?:ba)?)\s+(?:en|con|por|de)?\s*` + FRAC_METHODS + String.raw`(?![\w$])`,
  "g",
);
const fracMethod = (w: string): "efectivo" | "transferencia" | "tarjeta" | "usd" | null =>
  /(dolar|usd|u\$s|verdes)/.test(w) ? "usd" : (methodWord(w) as "efectivo" | "transferencia" | "tarjeta" | null);
const FRACTION_DEBT = new RegExp(String.raw`\b(?:(?:le\s+)?debe[n]?|(?:queda|quedo)\s+debiendo|(?:le\s+)?falta(?:n)?(?:\s+pagar)?)\s+` + FRACTION + String.raw`\b`, "g");
function fractionOf(w: string): number {
  if (w === "mitad") return 0.5;
  if (/^un\s+tercio$/.test(w)) return 1 / 3;
  if (/^dos\s+tercios$/.test(w)) return 2 / 3;
  if (/^un\s+cuarto$/.test(w)) return 0.25;
  if (/^tres\s+cuartos$/.test(w)) return 0.75;
  const p = Number(w.replace(/\D/g, ""));
  return p > 0 && p <= 100 ? p / 100 : 0;
}

/** «la mitad en efectivo y la mitad con tarjeta» → fracciones por medio (y lo que se debe), con los tramos a sacar del texto. */
function extractFractions(n: string): { f: NonNullable<MoneyNote["fractions"]>; cuts: [number, number][] } | null {
  const f = { efectivo: 0, transferencia: 0, tarjeta: 0, usd: 0, debt: 0 };
  const cuts: [number, number][] = [];
  for (const m of n.matchAll(FRACTION_DEBT)) {
    f.debt += fractionOf(m[1]);
    cuts.push([m.index!, m.index! + m[0].length]);
  }
  const taken = (a: number, b: number) => cuts.some(([x, y]) => a < y && b > x);
  for (const m of n.matchAll(HALF_HALF)) {
    const a = fracMethod(m[1]), b = fracMethod(m[2]);
    if (!a || !b || a === b) continue;
    f[a] += 0.5;
    f[b] += 0.5;
    cuts.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of n.matchAll(METHOD_FRACTION)) {
    if (taken(m.index!, m.index! + m[0].length)) continue;
    const method = fracMethod(m[1]);
    if (!method) continue;
    f[method] += fractionOf(m[2]);
    cuts.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of n.matchAll(FRACTION_METHOD)) {
    const method = fracMethod(m[2]);
    if (!method || taken(m.index!, m.index! + m[0].length)) continue;
    f[method] += fractionOf(m[1]);
    cuts.push([m.index!, m.index! + m[0].length]);
  }
  // «la otra en efectivo» / «el resto con tarjeta»: lo que no se nombró, con ese medio.
  for (const m of n.matchAll(REST_METHOD)) {
    const method = fracMethod(m[1]);
    const used = f.efectivo + f.transferencia + f.tarjeta + f.usd + f.debt;
    if (!method || taken(m.index!, m.index! + m[0].length) || used <= 0 || used >= 0.999) continue;
    f[method] += 1 - used;
    cuts.push([m.index!, m.index! + m[0].length]);
  }
  if (!cuts.length || f.efectivo + f.transferencia + f.tarjeta + f.usd + f.debt > 1.001) return null;
  return { f, cuts };
}

/**
 * Pasa las fracciones a pesos sobre `total` (lo que salía). El redondeo queda en la última parte.
 * La parte en dólares se pasa a dólares con `rate` (la cotización del día); sin cotización queda en 0.
 */
export function fractionsToPesos(fr: NonNullable<MoneyNote["fractions"]>, total: number, rate?: number | null): { split: Split; debt: number } {
  const debt = Math.round(total * fr.debt);
  const split: Split = { efectivo: 0, transferencia: 0, tarjeta: 0, usd: 0 };
  // Dólares: lo que se pagó así, en dólares (redondeado a centavos).
  const usdPesos = fr.usd > 0 ? Math.round(total * fr.usd) : 0;
  if (usdPesos && rate) split.usd = Math.round((usdPesos / rate) * 100) / 100;
  const methods = (["efectivo", "transferencia", "tarjeta"] as const).filter((m) => fr[m] > 0);
  const paidShare = methods.reduce((a, m) => a + fr[m], 0) + fr.usd;
  // Si solo se dijeron las partes pagadas y suman todo menos la deuda, la última se lleva el redondeo.
  const paidTotal = (paidShare + fr.debt > 0.999 ? total - debt : Math.round(total * paidShare)) - usdPesos;
  let left = paidTotal;
  methods.forEach((m, i) => {
    const v = i === methods.length - 1 ? left : Math.round(total * fr[m]);
    split[m] = v;
    left -= v;
  });
  // Los dólares a centavos no dan justo en pesos («US$ 38,96 = $ 59.998»): la diferencia va a la última parte en pesos.
  if (split.usd && rate && methods.length) split[methods[methods.length - 1]] += usdPesos - Math.round(split.usd * rate);
  return { split, debt };
}

export function extractMoney(text: string, today?: string): MoneyNote {
  let paid: number | null = null;
  let share: number | null = null;
  let debt: number | null = null;
  let owesUs: number | null = null;
  const n = norm(text);
  const direct = DIRECT.test(n);
  const toProvider = TO_PROVIDER.test(n);
  // Recortes a sacar del texto: [desde, hasta)
  const cuts: [number, number][] = [];
  const split: Split = { efectivo: 0, transferencia: 0, tarjeta: 0, usd: 0 };
  const methods = new Set<string>();

  // Dólares primero (no son pesos).
  const usdSpans: [number, number][] = [];
  let usdAll = false;
  for (const m of text.matchAll(USD)) {
    const raw = m[1] ?? m[2];
    const v = /^\d{1,3}(?:\.\d{3})+$/.test(raw) ? Number(raw.replace(/\./g, "")) : Number(raw.replace(",", "."));
    if (!(v > 0)) continue;
    if (m[3] && v >= USD_AS_PESOS) {
      // «45000 en dólares»: el número son pesos (lo toma el paso de importes) y se pagó en dólares.
      usdAll = true;
      const at = (m.index ?? 0) + m[0].indexOf(m[3]);
      cuts.push([at, (m.index ?? 0) + m[0].length]);
      continue;
    }
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
    // ¿Es lo nuestro que tiene la profesional? («nos debe 36000») Va antes que la deuda de la paciente.
    const ou = before.match(OWES_US_BEFORE);
    if (ou) {
      owesUs = (owesUs ?? 0) + v;
      cuts.push([at - ou[0].length, at + m[0].length]);
      continue;
    }
    // ¿Es lo que quedó debiendo? («debe 40000», «40000 de deuda»)
    const db = before.match(DEBT_BEFORE);
    const da = norm(text.slice(at + m[0].length, at + m[0].length + 30)).match(DEBT_AFTER);
    if (db || da) {
      debt = (debt ?? 0) + v;
      cuts.push([at - (db ? db[0].length : 0), at + m[0].length + (da ? da[0].length : 0)]);
      continue;
    }
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
  // Partes sin importe («la mitad en efectivo y la mitad con tarjeta»): el mismo largo de texto (norm no cambia índices).
  // Van antes que «pagó en dólares»: «la otra mitad en dólares» es media parte, no todo en dólares.
  const fx = extractFractions(n);
  if (fx) cuts.push(...fx.cuts);
  // «pagó en dólares» sin cantidad.
  const ua = split.usd === 0 && !usdAll && !fx?.f.usd ? n.match(USD_ALL) : null;
  if (ua && ua.index !== undefined) {
    usdAll = true;
    cuts.push([ua.index, ua.index + ua[0].length]);
  }
  if (usdAll) split.usd = 0;
  // Es un pago dividido si hay dólares o importes con dos medios distintos. Lo que no dijo medio va a efectivo.
  const isSplit = split.usd > 0 || methods.size >= 2;
  if (isSplit && paid !== null) {
    const assigned = split.efectivo + split.transferencia + split.tarjeta;
    split.efectivo += paid - assigned;
  }
  // Las frases de «pago directo» / «abono» tampoco son paciente ni práctica.
  const dm = n.match(DIRECT);
  if (dm && dm.index !== undefined) {
    // «le transfirieron a carmen»: se saca la frase pero queda «carmen» (es la profesional).
    const last = dm[0].match(/(\w+)$/)?.[1] ?? "";
    const keep = toProvider && !/^(?:ella|el|profesional|medica|doctora|kine\w*|abono)$/.test(last) && dm[0].length > last.length ? last.length : 0;
    cuts.push([dm.index, dm.index + dm[0].length - keep]);
  }
  const debtAll = debt === null && !fx?.f.debt && DEBT_ALL.test(n);
  const am = debtAll ? n.match(DEBT_ALL) : null;
  if (am && am.index !== undefined) cuts.push([am.index, am.index + am[0].length]);
  // Fecha para cobrarla: cuenta si hay una deuda en el texto o si se pidió un recordatorio («recordar el viernes»).
  const rm = parseReminder(n, today);
  const remindOn = rm && (debt !== null || debtAll || !!fx?.f.debt || rm.explicit) ? rm.remindOn : null;
  if (remindOn && rm) cuts.push(rm.span);

  // Los tramos a sacar pueden pisarse («paga la semana que viene» es deuda y fecha): se juntan antes de cortar.
  const merged: [number, number][] = [];
  for (const [a, b] of [...cuts].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let out = text;
  for (const [a, b] of merged.reverse()) out = `${out.slice(0, Math.max(0, a))} ${out.slice(b)}`;
  out = out.replace(/(?:^|[\s,;]+)(?:y|e|mas|más|\+)(?=\s*(?:[,;]|$))/gi, "").replace(/\s+([,;])/g, "$1").replace(/([,;])\s*([,;])+/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,;]+|[\s,;]+$/g, "");
  const single = !isSplit && methods.size === 1 ? ([...methods][0] as MoneyNote["method"]) : null;
  return {
    text: out,
    // Pagado directo a la profesional: vale lo que salía (o lo escrito). Abono / «debe todo»: no ingresó nada.
    paid: ((direct && !toProvider) || debtAll) && paid === null ? 0 : paid,
    direct,
    toProvider,
    owesUs,
    share,
    split: isSplit ? split : null,
    method: single,
    debt,
    debtAll,
    remindOn,
    fractions: fx ? fx.f : null,
    usdAll,
  };
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
 * (en efectivo sale de la caja). `amount` null = todo lo que se le debe del día.
 * «le pagué la deuda a marisa», «le pagué 30000 de lo que le debíamos»: `debt` = es de lo que se le debía de otros días.
 * «por transferencia» → `method`. Si dice «le quedamos debiendo», es `parseProviderDebt`.
 */
export function parsePayout<S extends QuickSeller>(
  text: string,
  sellers: S[],
): { seller: S; amount: number | null; debt: boolean; method: "efectivo" | "transferencia" | null } | null {
  const n = norm(text);
  if (!/\b(?:pague|pagamos|le di|le dimos|liquide|liquidamos|se le pago|ya le pague|le pague|le pagamos|pagado a|le transferi|le transferimos)\b/.test(n)) return null;
  if (PROV_DEBT.test(stripOwedClause(n))) return null;
  const seller = sellerNamed(text, sellers);
  if (!seller) return null;
  const amounts = [...text.matchAll(AMOUNT)].map((m) => toPesos(m[0])).filter((v) => v > 0);
  const debt = /\b(?:deudas?|debiamos|debia|debemos|adeudado|atrasado|pendiente|lo\s+de\s+(?:ayer|antes|la\s+semana|otros?\s+dias?))\b/.test(n);
  return { seller, amount: amounts.length && !/\btodo\b/.test(n) ? amounts.reduce((a, b) => a + b, 0) : null, debt, method: payoutMethod(n) };
}

const PROV_DEBT = /\b(?:(?:le\s+)?(?:quedamos|quedo|queda|quedaron|quedan|dejamos)\s+(?:debiendo|a\s+deber|pendientes?)|le\s+debemos|le\s+debo|le\s+adeudamos|se\s+le\s+debe)\b/;
// «lo que le debemos» es de qué se habla («le pagué lo que le debemos»), no una deuda nueva.
const stripOwedClause = (n: string) => n.replace(/\b(?:de\s+)?lo\s+que\s+(?:le\s+|se\s+le\s+)?deb\w*/g, " ");
function payoutMethod(n: string): "efectivo" | "transferencia" | null {
  if (/\b(?:transferencia|transf\w*|transferi|transferimos|mp|mercado\s*pago)\b/.test(n)) return "transferencia";
  if (/\b(?:efectivo|efvo|cash)\b/.test(n)) return "efectivo";
  return null;
}

/**
 * «le quedamos debiendo 50000 a marisa», «le debemos todo a marisa», «a marisa le quedamos debiendo lo de hoy»:
 * el consultorio no tiene para pagarle y lo deja como deuda con ella. `amount` null = todo lo de hoy (o el resto).
 * «le pagué 20000 a marisa y le quedamos debiendo el resto»: `paidNow` = lo que sí se le pagó ahora.
 */
export function parseProviderDebt<S extends QuickSeller>(
  text: string,
  sellers: S[],
): { seller: S; amount: number | null; paidNow: number | null; method: "efectivo" | "transferencia" | null } | null {
  const n = norm(text);
  if (!PROV_DEBT.test(stripOwedClause(n))) return null;
  const seller = sellerNamed(text, sellers);
  if (!seller) return null;
  const amounts = [...text.matchAll(AMOUNT)].map((m) => ({ v: toPesos(m[0]), at: m.index! })).filter((x) => x.v > 0);
  const pays = /\b(?:le\s+pague|le\s+pagamos|ya\s+le\s+pague|le\s+di|le\s+dimos|le\s+transferi|le\s+transferimos)\b/.test(n);
  const cue = stripOwedClause(n).search(PROV_DEBT);
  // Con pago: el importe antes de «quedamos debiendo» es lo que se pagó; el de después, lo que se debe.
  const before = pays ? amounts.filter((a) => a.at < cue) : [];
  const after = amounts.filter((a) => !before.includes(a));
  const rest = /\b(?:resto|todo|lo\s+que\s+falta|lo\s+demas|el\s+saldo)\b/.test(n);
  return {
    seller,
    paidNow: before.length ? before.reduce((a, b) => a + b.v, 0) : null,
    amount: after.length && !rest ? after.reduce((a, b) => a + b.v, 0) : null,
    method: payoutMethod(n),
  };
}

/**
 * «carla pagó la deuda», «carla trajo 20000 de lo que debía», «cobré lo que debía carla», «carla canceló el saldo»:
 * un cobro de una deuda abierta. `amount` null = todo lo que falta. Si hay varias deudas posibles, `debts` las trae
 * a todas (se elige en la pantalla).
 */
export function parseDebtPayment<D extends { id: string; debtor: string; remaining: number }>(
  text: string,
  open: D[],
): { debts: D[]; amount: number | null; method: "efectivo" | "transferencia" | "tarjeta" | null } | null {
  const n = norm(text);
  if (!open.length) return null;
  // «pagó 80000, debe 40000» es una deuda nueva, no un cobro.
  const m = extractMoney(text);
  if (m.debt !== null || m.debtAll) return null;
  const pays = /\b(?:pag[oóa]|pagaron|abon[oó]|trajo|cancel[oó]|cobr[eéo]|cobramos|salda|sald[oó]|dej[oó])\b/.test(n);
  const owed = /\b(?:deuda|debia|debian|debe|adeudado|adeudaba|saldo|resto|lo\s+que\s+(?:le\s+)?faltaba|lo\s+que\s+debia|fiado)\b/.test(n);
  if (!pays || !owed) return null;
  const words = new Set(n.split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 3));
  const scored = open
    .map((d) => ({ d, hits: norm(d.debtor).split(/\s+/).filter((t) => t.length >= 3 && words.has(t)).length }))
    .filter((x) => x.hits > 0);
  if (!scored.length) return null;
  const best = Math.max(...scored.map((x) => x.hits));
  const debts = scored.filter((x) => x.hits === best).map((x) => x.d);
  const amounts = [...text.matchAll(AMOUNT)].map((m) => toPesos(m[0])).filter((v) => v > 0);
  const total = amounts.length && !/\btodo\b|\btoda\b/.test(n) ? amounts.reduce((a, b) => a + b, 0) : null;
  const method = methodWord(n.match(/\b(efectivo|efvo|cash|transferencia|transf\w*|mp|mercado\s*pago|tarjeta|tarj\w*|debito|credito|posnet)\b/)?.[1]?.split(/\s/)[0]) as "efectivo" | "transferencia" | "tarjeta" | null;
  return { debts, amount: total, method };
}

/**
 * Quién debe, de lo que queda del texto de una deuda («marisa me debe 5000» → «marisa»): saca los pronombres
 * («me», «nos», «le»…) y «al consultorio» / «a nosotros», que no son parte del nombre.
 */
export function debtorName(rest: string): string {
  return rest
    .replace(/[,;:.]+/g, " ")
    .replace(/\b(?:a|al|con|para)\s+(?:el\s+|la\s+)?(?:consultorio|nosotros|nosotras|mi|m[ií]|clinica|clínica|decles)\b/gi, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(?:me|nos|te|le|les|se|yo|nosotros|consultorio|che|ella|el|él|la|que|y)$/i.test(w))
    .join(" ");
}
