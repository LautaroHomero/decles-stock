/**
 * "Hoja de ventas": convierte texto libre ("vendí 2 cremas pindonga y un protector")
 * en renglones { cantidad, producto } SIN IA. Es una función pura: corre en el
 * navegador sobre el catálogo ya cargado y la venta igual pasa por `recordSale`
 * (que valida precio, stock y permisos en el servidor).
 *
 * Cómo interpreta:
 *  1. Parte el texto en renglones por salto de línea, coma, ";", "+", " y ", " e ".
 *  2. En cada renglón toma la cantidad: número ("2", "x2", "2x") o palabra
 *     ("una", "dos", … "docena"). Si no hay, 1.
 *  3. Descarta muletillas ("vendí", "marca", "de", "unidades"…).
 *  4. Compara las palabras que quedan con cada producto: igual (sin tildes ni
 *     plurales) > prefijo ("prot" → protector) > un error de tipeo. Gana el de mejor
 *     puntaje; si empatan, se ofrece elegir. Nada se registra sin confirmar.
 *  5. Quién vendió: si aparece el nombre o apellido de una médica ("laura vendió…",
 *     "…, paula", "Dra. Ríos:" arriba de varias líneas) ese renglón y los siguientes
 *     quedan a su nombre; los renglones anteriores sin médica toman la primera nombrada.
 *     Un nombre que también es palabra de un producto no cuenta como médica.
 *     Entiende diminutivos ("lau", "lauri", "laurita" → Laura; "anita" → Ana) y los
 *     apodos que el admin carga en Equipo para los que no salen del nombre ("pili" → Pilar).
 */

export interface QuickProduct {
  id: string;
  name: string;
}

export interface QuickSeller {
  id: string;
  name: string;
  /** Apodos cargados por el admin ("pili", "lola"). */
  aliases?: string[];
}

export interface QuickLine<P extends QuickProduct = QuickProduct, S extends QuickSeller = QuickSeller> {
  /** El pedazo de texto que generó este renglón. */
  text: string;
  quantity: number;
  /** El producto elegido (único o el mejor por margen claro). */
  match: P | null;
  /** Si es ambiguo o no hubo match claro: las mejores opciones para elegir. */
  candidates: P[];
  /** Médica nombrada en el texto (o heredada del renglón anterior); null = usar la elegida en pantalla. */
  seller: S | null;
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, docena: 12, quince: 15, veinte: 20,
};

const FILLER = new Set([
  "vendi", "vendimos", "vendio", "vendieron", "vender", "venta", "ventas", "se", "me", "le", "les",
  "compro", "compraron", "llevo", "llevaron", "hoy", "recien", "otra", "otro", "mas",
  "de", "del", "la", "el", "los", "las", "al", "a", "con", "para", "por", "en",
  "marca", "unidad", "unidades", "u", "x", "cant", "cantidad", "producto", "productos",
  "dra", "dr", "doctora", "doctor", "lic", "licenciada",
]);

/** Minúsculas, sin tildes, sin puntuación (conserva dígitos). */
export const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim();

/** Singular aproximado: "cremas" → "crema", "protectores" → "protector", "ojos" → "ojo". */
export function stem(w: string): string {
  if (w.length > 4 && /[^aeiou]es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

function within1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function wordScore(q: string, p: string): number {
  if (q === p) return 1;
  if (q.length >= 3 && p.startsWith(q)) return 0.75;
  if (q.length >= 5 && within1(q, p)) return 0.7;
  return 0;
}

const productWords = (name: string) =>
  normalize(name).split(" ").filter((w) => w && !FILLER.has(w)).map(stem);

/** Puntaje de un producto para las palabras pedidas (0 = no tiene nada que ver). */
function score(queryWords: string[], name: string): number {
  const pw = productWords(name);
  if (!pw.length || !queryWords.length) return 0;
  let hit = 0;
  const used = new Set<number>();
  for (const q of queryWords) {
    let best = 0, at = -1;
    pw.forEach((p, i) => {
      const s = wordScore(q, p);
      if (s > best) [best, at] = [s, i];
    });
    hit += best;
    if (at >= 0) used.add(at);
  }
  if (hit === 0) return 0;
  // Desempate: preferir el producto que el texto "cubre" más (crema pindonga > crema hidratante facial).
  return hit + 0.5 * (used.size / pw.length);
}

function splitSegments(text: string): string[] {
  return text
    .split(/\n|,|;|\+|\s+y\s+|\s+e\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `nameNumbers`: números que forman parte de nombres de productos ("FPS 50"). Un número así,
 * escrito DESPUÉS del producto ("protector 50"), es parte del nombre y no la cantidad.
 */
function parseSegment(seg: string, nameNumbers: Set<string>): { quantity: number; words: string[] } {
  const words = normalize(seg).split(" ").filter(Boolean);
  let quantity: number | null = null;
  const rest: string[] = [];
  for (const w of words) {
    const num = w.match(/^x?(\d{1,3})x?$/);
    const partOfName = num && rest.length > 0 && w === num[1] && nameNumbers.has(w);
    if (quantity === null && num && !partOfName) {
      quantity = Number(num[1]);
      continue;
    }
    if (quantity === null && w in NUMBER_WORDS) {
      quantity = NUMBER_WORDS[w];
      continue;
    }
    if (w === "media" || w === "medio") continue; // "media docena" → docena × ½
    if (!FILLER.has(w)) rest.push(stem(w));
  }
  if (/\bmedia docena\b/.test(normalize(seg))) quantity = 6;
  return { quantity: quantity && quantity > 0 ? quantity : 1, words: rest };
}

/** Palabras propias de cada médica: nombre, apellido y apodos (sin "Dra."). */
const sellerWords = (s: QuickSeller) =>
  [s.name, ...(s.aliases ?? [])]
    .flatMap((x) => normalize(x).split(" "))
    .filter((w) => w.length >= 3 && !FILLER.has(w));

/** Terminaciones de diminutivo, de la más larga a la más corta. */
const DIMINUTIVE = ["citas", "citos", "cita", "cito", "itas", "itos", "ita", "ito", "illa", "illo", "ina", "ino", "ucha", "ie", "i", "y"];

/**
 * ¿La palabra escrita `w` nombra a `sw` (nombre, apellido o apodo)?
 *  · igual, o un error de tipeo en palabras largas;
 *  · abreviado: "lau", "pau", "sofi" (prefijo de 3+ letras);
 *  · diminutivo: "laurita", "lauri" (laur + ita/i), "anita" (an + ita → ana), "carlitos".
 */
function nameMatches(w: string, sw: string): boolean {
  if (w === sw) return true;
  if (w.length >= 5 && within1(w, sw)) return true;
  if (w.length >= 3 && sw.startsWith(w)) return true;
  for (const suf of DIMINUTIVE) {
    if (!w.endsWith(suf) || w.length - suf.length < 2) continue;
    const base = w.slice(0, -suf.length);
    if (base.length >= 3 ? sw.startsWith(base) : sw.startsWith(base) && sw.length - base.length <= 1) return true;
  }
  return false;
}

/**
 * Busca médicas nombradas en el renglón. Devuelve la médica si hay UNA sola posible y las
 * palabras que hay que sacar antes de buscar el producto.
 */
function findSeller<S extends QuickSeller>(seg: string, sellers: S[], productVocab: Set<string>): { seller: S | null; used: Set<string> } {
  const used = new Set<string>();
  const hits = new Set<S>();
  for (const w of normalize(seg).split(" ")) {
    if (w.length < 3 || FILLER.has(w) || productVocab.has(stem(w))) continue;
    // Una abreviatura que también empieza una palabra de producto ("cre" de crema) no es un nombre.
    if (w.length <= 4 && [...productVocab].some((pv) => pv.startsWith(w))) continue;
    const found = sellers.filter((s) => sellerWords(s).some((sw) => nameMatches(w, sw)));
    if (found.length) {
      used.add(w);
      found.forEach((s) => hits.add(s));
    }
  }
  return { seller: hits.size === 1 ? [...hits][0] : null, used };
}

export function parseQuickSale<P extends QuickProduct, S extends QuickSeller = QuickSeller>(
  text: string,
  products: P[],
  sellers: S[] = [],
): QuickLine<P, S>[] {
  const lines: QuickLine<P, S>[] = [];
  const nameNumbers = new Set(products.flatMap((p) => normalize(p.name).split(" ").filter((w) => /^\d+$/.test(w))));
  const productVocab = new Set(products.flatMap((p) => productWords(p.name)));
  let current: S | null = null;
  let first: S | null = null;
  for (const raw of splitSegments(text)) {
    const { seller, used } = findSeller(raw, sellers, productVocab);
    if (seller) {
      current = seller;
      first ??= seller;
    }
    const seg = used.size ? normalize(raw).split(" ").filter((w) => !used.has(w)).join(" ") : raw;
    const { quantity, words } = parseSegment(seg, nameNumbers);
    if (!words.length) continue; // "vendí", "Laura:" o un número suelto
    const ranked = products
      .map((p) => ({ p, s: score(words, p.name) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    const [best, second] = ranked;
    // Match claro: hay uno solo, o el primero le saca ventaja al segundo.
    const clear = best && (!second || best.s - second.s >= 0.15);
    lines.push({
      text: raw,
      quantity,
      match: clear ? best.p : null,
      candidates: clear ? [] : ranked.slice(0, 4).map((x) => x.p),
      seller: current,
    });
  }
  // "2 cremas pindonga, laura": lo anterior a la primera médica nombrada también es suyo.
  for (const l of lines) if (!l.seller) l.seller = first;
  return lines;
}
