/**
 * Importes dichos en palabras → en números, para que todos los parsers de Anotar los entiendan igual:
 * «cuarenta mil» → «40000», «treinta y cinco mil» → «35000», «ciento veinte mil» → «120000»,
 * «un millón y medio» → «1500000», «mil quinientos» → «1500», «veinte lucas» → «20 lucas», «un palo» → «1 palo».
 * Solo importes: un número en palabras sin «mil», «millón», «lucas» ni «palo» («dos cremas») queda como está.
 */

const UNITS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700,
  ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};
const BIG = new Set(["mil", "millon", "millones"]);
const TENS = new Set(["treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"]);
// Lo que puede venir después y también lo hace importe: «veinte lucas», «un palo».
const UNIT_AFTER = /^\s+(?:lucas?|palos?|k)\b/;

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const WORD = String.raw`(?:${[...Object.keys(UNITS), "mil", "millon", "millones", "medio"].sort((a, b) => b.length - a.length).join("|")})`;
// Una o más palabras de número, unidas por espacios o «y».
const RUN = new RegExp(String.raw`\b${WORD}(?:\s+(?:y\s+)?${WORD})*\b`, "g");

function valueOf(words: string[]): number | null {
  let total = 0;
  let cur = 0;
  let any = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "y") continue;
    if (w in UNITS) {
      cur += UNITS[w];
      any = true;
    } else if (w === "mil") {
      total += (cur || 1) * 1000;
      cur = 0;
      any = true;
    } else if (w === "millon" || w === "millones") {
      total += (cur || 1) * 1_000_000;
      cur = 0;
      any = true;
      // «un millón y medio»
      if (words[i + 1] === "y" && words[i + 2] === "medio") {
        total += 500_000;
        i += 2;
      }
    } else if (w === "medio") {
      return null;
    }
  }
  return any ? total + cur : null;
}

/** El texto con los importes en palabras pasados a números (mismo texto si no hay ninguno). */
export function spelledToDigits(text: string): string {
  const n = norm(text);
  // `norm` no cambia el largo de un texto con tildes compuestas (lo normal al tipear): los índices sirven para `text`.
  if (n.length !== text.length) return text;
  let out = "";
  let last = 0;
  for (const m of n.matchAll(RUN)) {
    // «y» solo une decenas y unidades («treinta y cinco») o «millón y medio»: «cuarenta mil y una crema» corta antes de la «y».
    const all = m[0].split(/\s+/);
    let end = all.length;
    for (let i = 0; i < all.length; i++) {
      if (all[i] !== "y") continue;
      const ok = (TENS.has(all[i - 1]) && all[i + 1] in UNITS && UNITS[all[i + 1]] < 10) || ((all[i - 1] === "millon" || all[i - 1] === "millones") && all[i + 1] === "medio");
      if (!ok) {
        end = i;
        break;
      }
    }
    const words = all.slice(0, end);
    // Largo real de esas palabras en el texto (puede haber dos espacios).
    const pos = [...m[0].matchAll(/\S+/g)];
    const len = pos[end - 1].index! + pos[end - 1][0].length;
    // «15 mil», «1,5 millones»: ya es un número con su unidad (lo entiende cada parser).
    if (/\d[\d.,]*\s*$/.test(n.slice(0, m.index!))) continue;
    const hasBig = words.some((w) => BIG.has(w));
    const after = n.slice(m.index! + len);
    const unitAfter = UNIT_AFTER.test(after);
    if (!hasBig && !unitAfter) continue;
    const v = valueOf(words);
    if (v === null || v <= 0) continue;
    out += text.slice(last, m.index!) + String(v);
    last = m.index! + len;
  }
  return last ? out + text.slice(last) : text;
}
