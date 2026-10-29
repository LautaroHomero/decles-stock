/**
 * Fecha para acordarse de cobrar una deuda, dicha como se dice en el consultorio:
 * «paga el viernes», «recordar el 30/10», «lo trae la semana que viene», «en 15 días», «a fin de mes»,
 * «mañana», «el 5 de noviembre». Trabaja sobre el texto ya normalizado (minúsculas, sin tildes).
 *
 * `explicit` = hay una palabra de recordatorio («recordar», «avisar», «cobrar»…). Sin ella, una fecha suelta
 * solo cuenta si en el texto hay una deuda (eso lo decide `extractMoney`).
 */

const DAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const NUM: Record<string, number> = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, quince: 15, veinte: 20, treinta: 30 };

/** Hoy en Buenos Aires (AAAA-MM-DD). */
export function todayAR(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const at = (s: string) => new Date(`${s}T12:00:00Z`);
function addDays(s: string, n: number): string {
  const d = at(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
function addMonths(s: string, n: number): string {
  const d = at(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return ymd(d);
}
const endOfMonth = (s: string) => {
  const d = at(s);
  return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)));
};
/** Día y mes (sin año): este año si todavía no pasó, si no el que viene. */
function dayMonth(today: string, day: number, month: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let y = +today.slice(0, 4);
  const mk = (yy: number) => {
    const d = new Date(Date.UTC(yy, month - 1, day, 12));
    return d.getUTCMonth() === month - 1 ? ymd(d) : null;
  };
  let r = mk(y);
  if (r && r < today) r = mk(++y);
  return r;
}

// Palabras que anuncian la fecha («paga el viernes», «recordar el 30/10»); se sacan del texto junto con ella.
const LEAD =
  String.raw`(?:(?:recordar(?:le|me|lo)?|recordatorio(?:\s+para)?|avisar(?:me|le)?|acordarse|cobrar(?:le)?|que\s+pague|paga(?:ria|ra)?|pagara|viene|vuelve|lo\s+trae|la\s+trae|trae|deposita|transfiere)\s+)?`;
const EXPLICIT = /\b(?:recordar(?:le|me|lo)?|recordatorio|avisar(?:me|le)?|acordarse|cobrar(?:le)?)\b/;
const WD = String.raw`(?:el\s+)?(${DAYS.join("|")})(\s+(?:que\s+viene|proximo))?`;
const NUMW = String.raw`(\d{1,3}|${Object.keys(NUM).join("|")})`;

interface Hit {
  date: string;
  span: [number, number];
}

export function parseReminder(n: string, today: string = todayAR()): { remindOn: string; span: [number, number]; explicit: boolean } | null {
  const hits: Hit[] = [];
  const add = (m: RegExpMatchArray, date: string | null) => {
    if (date && date >= today) hits.push({ date, span: [m.index!, m.index! + m[0].length] });
  };
  let m: RegExpMatchArray | null;
  // «pasado mañana» / «mañana»
  if ((m = n.match(new RegExp(String.raw`\b${LEAD}pasado\s+manana\b`)))) add(m, addDays(today, 2));
  else if ((m = n.match(new RegExp(String.raw`\b${LEAD}manana\b`)))) add(m, addDays(today, 1));
  // «la semana que viene», «la próxima semana»
  if ((m = n.match(new RegExp(String.raw`\b${LEAD}(?:la\s+)?(?:semana\s+que\s+viene|proxima\s+semana)\b`)))) add(m, addDays(today, 7));
  // «el mes que viene», «el próximo mes»
  if ((m = n.match(new RegExp(String.raw`\b${LEAD}(?:el\s+)?(?:mes\s+que\s+viene|proximo\s+mes)\b`)))) add(m, addMonths(today, 1));
  // «a fin de mes»
  if ((m = n.match(new RegExp(String.raw`\b${LEAD}(?:a\s+|para\s+)?fin(?:al)?\s+de(?:l)?\s+mes\b`)))) add(m, endOfMonth(today));
  // «en 15 días», «en una semana», «en dos meses», «dentro de 10 días»
  if ((m = n.match(new RegExp(String.raw`\b${LEAD}(?:en|dentro\s+de)\s+${NUMW}\s+(dias?|semanas?|mes|meses)\b`)))) {
    const k = /^\d+$/.test(m[1]) ? +m[1] : NUM[m[1]];
    if (k > 0 && k <= 366) add(m, /^dia/.test(m[2]) ? addDays(today, k) : /^semana/.test(m[2]) ? addDays(today, 7 * k) : addMonths(today, k));
  }
  // «el viernes», «el lunes que viene»: el próximo (si hoy es viernes, el de la semana que viene)
  if ((m = n.match(new RegExp(String.raw`\b${LEAD}${WD}\b`)))) {
    const want = DAYS.indexOf(m[1]);
    const now = at(today).getUTCDay();
    let diff = (want - now + 7) % 7;
    if (diff === 0) diff = 7;
    add(m, addDays(today, diff));
  }
  // «el 30/10», «el 30-10-2026», «para el 5/11»
  if ((m = n.match(new RegExp(String.raw`\b${LEAD}(?:para\s+)?(?:el\s+)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b`)))) {
    const d = +m[1], mo = +m[2];
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      const dt = new Date(Date.UTC(y, mo - 1, d, 12));
      add(m, dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? ymd(dt) : null);
    } else add(m, dayMonth(today, d, mo));
  }
  // «el 5 de noviembre»
  if ((m = n.match(new RegExp(String.raw`\b${LEAD}(?:para\s+)?(?:el\s+)?(\d{1,2})\s+de\s+(${MONTHS.join("|")})\b`)))) add(m, dayMonth(today, +m[1], MONTHS.indexOf(m[2]) + 1));

  if (!hits.length) return null;
  // Si hay más de una, la que aparece primero en el texto.
  hits.sort((a, b) => a.span[0] - b.span[0]);
  return { remindOn: hits[0].date, span: hits[0].span, explicit: EXPLICIT.test(n) };
}
