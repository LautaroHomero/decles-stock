/**
 * Abonos en Anotar (Decles). Dos cosas distintas:
 *  · uno nuevo: «carla dejó un abono de 5 sesiones de venus freeze, pagó 250000 en efectivo»,
 *    «abono de carla: 200000 para venus freeze por transferencia», «5 sesiones de venus a 50000 c/u, abono de carla».
 *  · usar uno: «venus freeze a carla, gabi, con abono» → eso lo resuelve la vista previa (busca el abono abierto).
 * Acá solo se reconoce el nuevo: dice «abono» y hay plata. El paciente y el tratamiento los saca la vista previa.
 */

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const NUM: Record<string, number> = { una: 1, un: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12, quince: 15, veinte: 20 };
const AMOUNT = /\$?\s*(\d{1,3}(?:\.\d{3})+|\d{4,}|\d+(?:[.,]\d+)?\s*(?:mil|k|lucas))\b/g;

function pesos(raw: string): number {
  const t = raw.replace(/\$|\s/g, "");
  const m = t.match(/^(\d+(?:[.,]\d+)?)(mil|k|lucas)$/);
  if (m) return Math.round(Number(m[1].replace(",", ".")) * 1000);
  return Number(t.replace(/\./g, ""));
}

export interface PrepaidNote {
  /** Sesiones compradas (null = saldo en plata). */
  sessions: number | null;
  /** Lo que pagó (null = no se dijo; con sesiones y precio por sesión se calcula). */
  amount: number | null;
  /** Precio congelado por sesión, si se dijo («a 50000 c/u»). */
  unitPrice: number | null;
  method: "efectivo" | "transferencia" | "tarjeta" | null;
}

/** «con abono», «tiene abono», «usa el abono»: es una sesión de un abono que ya existe. */
export const USES_PREPAID = /\b(?:con|tiene|usa|uso|usando|del|de\s+su|por|descontar\s+del?)\s+(?:el\s+|un\s+|su\s+)?(?:abono|plan)\b|\babonad[oa]s?\b/;
/** «plan» / «abono» sueltos, sin plata: también es una sesión («carla, plan»). */
export const SAYS_PREPAID = /\b(?:abono|plan|abonad[oa]s?)\b/;

export function parsePrepaidNote(text: string): PrepaidNote | null {
  const n = norm(text);
  if (!/\b(?:abono|plan)\b/.test(n) || USES_PREPAID.test(n)) return null;
  // «abonó 50000 con tarjeta» es un pago común; un abono se nombra («un abono», «abono de/para») o trae sesiones.
  const named = /\b(?:un|el|de|como|nuevo|otro)\s+(?:abono|plan)\b|\b(?:abono|plan)\s*(?:de|para|por|:)|\b(?:dej[oa]|pag[oa]|compr[oa]|sac[oa])\b[^.]*\b(?:abono|plan)\b/.test(n);
  if (!named && !/\bsesion(?:es)?\b/.test(n)) return null;
  const amounts = [...n.matchAll(AMOUNT)].map((m) => ({ v: pesos(m[1]), at: m.index!, end: m.index! + m[0].length })).filter((a) => a.v >= 1000);
  if (!amounts.length) return null;
  const s = n.match(/\b(\d{1,2}|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|quince|veinte)\s+(?:sesiones|sesion|ses\.?)\b/) ?? n.match(/\bx\s*(\d{1,2})\b/);
  const sessions = s ? (/^\d+$/.test(s[1]) ? Number(s[1]) : NUM[s[1]]) : null;
  // «a 50000 c/u», «50000 cada una», «50000 por sesión», «la sesión a 50000».
  const unitAt = amounts.find((a) => /^\s*(?:c\/u|cada\s+una|c\/una|por\s+sesion|la\s+sesion)\b/.test(n.slice(a.end)) || /\bla\s+sesion\s+(?:a|de)\s*$/.test(n.slice(0, a.at)));
  const rest = amounts.filter((a) => a !== unitAt);
  const unitPrice = unitAt?.v ?? null;
  let amount = rest.length ? Math.max(...rest.map((a) => a.v)) : null;
  if (amount === null && unitPrice && sessions) amount = unitPrice * sessions;
  const method = /\b(?:transferencia|transf\w*|mp|mercado\s*pago)\b/.test(n)
    ? "transferencia"
    : /\b(?:tarjeta|tarj\w*|debito|credito|posnet)\b/.test(n)
      ? "tarjeta"
      : /\b(?:efectivo|efvo|cash|contado)\b/.test(n)
        ? "efectivo"
        : null;
  return { sessions, amount, unitPrice, method };
}

/** ¿El nombre del abono es el mismo paciente? («Carla» ↔ «Carla Pérez»). */
export function samePatient(a: string, b: string): boolean {
  const t = (s: string) => norm(s).split(/[^a-zñ]+/).filter((w) => w.length >= 3);
  const x = t(a), y = t(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every((w) => long.includes(w));
}

const STOP = new Set(
  ("abono abonos plan planes dejo deja dejaron pago pagaron abono abonaron compro saco un una el la los las de del para por con en a al y " +
    "sesion sesiones ses c u cu cada x precio congelado nuevo otro efectivo efvo cash contado transferencia transf mp mercado tarjeta debito credito posnet " +
    "pesos mil k lucas total le se hizo hace va paciente su")
    .split(" "),
);

/**
 * El paciente de «carla perez dejó un abono de 3 sesiones de limpieza facial, pagó 90000»: lo que queda sacando
 * las palabras del abono, los importes y el tratamiento (`itemName`).
 */
export function prepaidPatient(text: string, itemName: string | null): string {
  const item = new Set(norm(itemName ?? "").split(/[^a-z0-9ñ]+/).filter(Boolean));
  const words = text.split(/[\s,;:.()]+/).filter(Boolean);
  const kept: string[] = [];
  for (const w of words) {
    const n = norm(w).replace(/[^a-z0-9ñ$]/g, "");
    if (!n || STOP.has(n) || item.has(n) || /\d/.test(n) || n.startsWith("$")) {
      if (kept.length) break; // el nombre es un tramo seguido
      continue;
    }
    kept.push(w);
  }
  return kept.join(" ");
}
