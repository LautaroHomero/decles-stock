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
 */

export interface QuickProduct {
  id: string;
  name: string;
}

export interface QuickLine<P extends QuickProduct = QuickProduct> {
  /** El pedazo de texto que generó este renglón. */
  text: string;
  quantity: number;
  /** El producto elegido (único o el mejor por margen claro). */
  match: P | null;
  /** Si es ambiguo o no hubo match claro: las mejores opciones para elegir. */
  candidates: P[];
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

export function parseQuickSale<P extends QuickProduct>(text: string, products: P[]): QuickLine<P>[] {
  const lines: QuickLine<P>[] = [];
  const nameNumbers = new Set(products.flatMap((p) => normalize(p.name).split(" ").filter((w) => /^\d+$/.test(w))));
  for (const seg of splitSegments(text)) {
    const { quantity, words } = parseSegment(seg, nameNumbers);
    if (!words.length) continue; // "vendí" solo, o un número suelto
    const ranked = products
      .map((p) => ({ p, s: score(words, p.name) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    const [first, second] = ranked;
    // Match claro: hay uno solo, o el primero le saca ventaja al segundo.
    const clear = first && (!second || first.s - second.s >= 0.15);
    lines.push({
      text: seg,
      quantity,
      match: clear ? first.p : null,
      candidates: clear ? [] : ranked.slice(0, 4).map((x) => x.p),
    });
  }
  return lines;
}
