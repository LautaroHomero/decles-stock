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
 *  6. Medio de pago (opcional): "con tarjeta", "débito", "en efectivo", "transferencia", "mp".
 *     Igual que la médica: vale para ese renglón y los siguientes, y lo anterior sin medio lo hereda.
 *  7. Paciente (`parseNote`): el catálogo incluye las prácticas ("atención", "peeling"), así que
 *     "María López, la atendió laura, atención y peeling" da paciente + médica + 2 prácticas.
 *     Es paciente el primer pedazo que no es producto, práctica ni médica (1 a 4 palabras sin
 *     números), o las palabras que van ANTES del producto en el mismo pedazo ("Ana Gómez atención").
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

export type QuickPayment = "efectivo" | "tarjeta";

const PAYMENT_WORDS: Record<string, QuickPayment> = {
  tarjeta: "tarjeta", tarjetas: "tarjeta", credito: "tarjeta", debito: "tarjeta", posnet: "tarjeta", visa: "tarjeta", master: "tarjeta",
  efectivo: "efectivo", efvo: "efectivo", efe: "efectivo", cash: "efectivo", contado: "efectivo",
  transferencia: "efectivo", transf: "efectivo", transfer: "efectivo", mp: "efectivo", mercadopago: "efectivo",
};

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
  /** Medio de pago escrito en el texto; null = el elegido en pantalla o sin cargar. */
  payment: QuickPayment | null;
  /** Las palabras útiles del renglón, tal como se escribieron (sin cantidad, médica, pago ni muletillas). */
  rest: string;
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, docena: 12, quince: 15, veinte: 20,
};

/** Palabras que anuncian a la profesional ("la atendió la Dra. …"). */
const SELLER_CUES = new Set(["atendio", "atendi", "atendida", "atendido", "atiende", "dra", "dr", "doctora", "doctor", "lic", "licenciada"]);

const FILLER = new Set([
  "vendi", "vendimos", "vendio", "vendieron", "vender", "venta", "ventas", "se", "me", "le", "les",
  "compro", "compraron", "llevo", "llevaron", "hoy", "recien", "otra", "otro", "mas",
  "de", "del", "la", "el", "los", "las", "al", "a", "con", "para", "por", "en",
  "marca", "unidad", "unidades", "u", "x", "cant", "cantidad", "producto", "productos",
  "dra", "dr", "doctora", "doctor", "lic", "licenciada",
  "pago", "pagaron", "pagado", "abono", "abonaron", "medio",
  "atendio", "atendi", "atendida", "atendido", "atiende", "atendieron", "vino", "vinieron", "paciente", "pacienta",
  "hizo", "hice", "hicimos", "hicieron", "se", "le", "lo", "su", "sesion", "turno", "y",
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

/** Cómo suena en castellano rioplatense: v=b, z/ce/ci=s, ll=y, qu/c/k igual, h muda, sin letras dobles. */
export function phon(w: string): string {
  return w
    .replace(/h/g, "")
    .replace(/qu/g, "k")
    .replace(/c([ei])/g, "s$1")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/v/g, "b")
    .replace(/ll/g, "y")
    .replace(/(.)\1+/g, "$1");
}

/** Distancia de edición (Levenshtein) cortada en `max` (para no gastar en palabras muy distintas). */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Qué tanto la palabra escrita `q` se parece a la palabra `p` de un producto:
 * igual > suena igual («bótox»/«votox», «limpiesa») > prefijo («prot») > una letra de más/menos/cambiada
 * (desde 4 letras: «botx», «peling») > dos letras (palabras de 8+: «mesoterapya»).
 */
function wordScore(q: string, p: string): number {
  if (q === p) return 1;
  if (q.length >= 4 && phon(q) === phon(p)) return 0.85;
  if (q.length >= 3 && p.startsWith(q)) return 0.75;
  if (q.length >= 4 && within1(q, p)) return 0.7;
  if (q.length >= 4 && within1(phon(q), phon(p))) return 0.65;
  if (q.length >= 8 && editDistance(q, p, 2) <= 2) return 0.6;
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

const NAME_TOKEN = /^[a-zñ]{2,}$/;
const capitalize = (w: string) => (w ? w[0].toLocaleUpperCase("es") + w.slice(1) : w);

/** Palabras del texto original (con tildes y mayúsculas) junto a su forma normalizada. */
function tokens(seg: string): { raw: string; n: string }[] {
  return seg
    .split(/\s+/)
    .map((raw) => ({ raw: raw.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, ""), n: normalize(raw).replace(/ /g, "") }))
    .filter((t) => t.n);
}

const asName = (ts: { raw: string }[]) => ts.map((t) => capitalize(t.raw)).join(" ");

export interface QuickNote<P extends QuickProduct = QuickProduct, S extends QuickSeller = QuickSeller> {
  lines: QuickLine<P, S>[];
  /** Nombre del paciente escrito en el texto (null = no se nombró a nadie). */
  patient: string | null;
  /**
   * false = no es seguro que sea un nombre (una sola palabra suelta, que también podría ser algo
   * que no está cargado, como «radiofrecuencia»): la pantalla pregunta antes de guardar.
   */
  patientSure: boolean;
  /** La primera médica nombrada en el texto (aunque no haya renglones), y el medio de pago. */
  seller: S | null;
  payment: QuickPayment | null;
}

export function parseNote<P extends QuickProduct, S extends QuickSeller = QuickSeller>(
  text: string,
  products: P[],
  sellers: S[] = [],
): QuickNote<P, S> {
  const lines: QuickLine<P, S>[] = [];
  const nameNumbers = new Set(products.flatMap((p) => normalize(p.name).split(" ").filter((w) => /^\d+$/.test(w))));
  const productVocab = new Set(products.flatMap((p) => productWords(p.name)));
  let current: S | null = null;
  let first: S | null = null;
  let pay: QuickPayment | null = null;
  let firstPay: QuickPayment | null = null;
  let patient: string | null = null;
  let patientSure = true;
  for (const raw of splitSegments(text)) {
    const { seller, used } = findSeller(raw, sellers, productVocab);
    if (seller) {
      current = seller;
      first ??= seller;
    }
    for (const w of normalize(raw).split(" ")) {
      if (PAYMENT_WORDS[w]) {
        pay = PAYMENT_WORDS[w];
        firstPay ??= pay;
        used.add(w);
      }
    }
    const toks = tokens(raw).filter((t) => !used.has(t.n));
    const { quantity, words } = parseSegment(toks.map((t) => t.n).join(" "), nameNumbers);
    if (!words.length) continue; // "vendí", "Laura:" o un número suelto
    const restToks = toks.filter((t) => !FILLER.has(t.n) && !(t.n in NUMBER_WORDS) && !/^x?\d{1,3}x?$/.test(t.n));
    const rest = restToks.map((t) => t.raw).join(" ");
    const ranked = products
      .map((p) => ({ p, s: score(words, p.name) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    const [best, second] = ranked;

    if (!best) {
      // Nada del catálogo: si parece un nombre ("María López"), es el paciente.
      const nameToks = toks.filter((t) => !FILLER.has(t.n));
      if (!patient && seller === null && nameToks.length >= 1 && nameToks.length <= 4 && nameToks.every((t) => NAME_TOKEN.test(t.n))) {
        patient = asName(nameToks);
        patientSure = nameToks.length >= 2;
        continue;
      }
      // «la atendió la Dra. Fernández» con una médica que no existe: no es algo que se hizo.
      if (normalize(raw).split(" ").some((w) => SELLER_CUES.has(w))) continue;
    } else if (!patient) {
      // "Ana Gómez atención": lo que va antes del producto/práctica, si son palabras sueltas, es el paciente.
      const pw = productWords(best.p.name);
      const at = toks.findIndex((t) => pw.some((w) => wordScore(stem(t.n), w) > 0));
      const lead = toks.slice(0, Math.max(at, 0)).filter((t) => !FILLER.has(t.n) && !(t.n in NUMBER_WORDS));
      if (lead.length && lead.length <= 4 && lead.every((t) => NAME_TOKEN.test(t.n))) patient = asName(lead);
    }
    // Match claro: hay uno solo, o el primero le saca ventaja al segundo.
    const clear = best && (!second || best.s - second.s >= 0.15);
    lines.push({
      text: raw,
      quantity,
      match: clear ? best.p : null,
      candidates: clear ? [] : ranked.slice(0, 4).map((x) => x.p),
      seller: current,
      payment: pay,
      rest,
    });
  }
  // "2 cremas pindonga, laura": lo anterior a la primera médica nombrada también es suyo. Igual el pago.
  for (const l of lines) {
    if (!l.seller) l.seller = first;
    if (!l.payment) l.payment = firstPay;
  }
  // Si no se anotó nada más, el «nombre» puede ser justo lo que no está cargado («hilos tensores»).
  return { lines, patient, patientSure: patientSure && lines.length > 0, seller: first, payment: firstPay };
}

/** Solo los renglones (compatibilidad con la hoja de ventas original). */
export function parseQuickSale<P extends QuickProduct, S extends QuickSeller = QuickSeller>(
  text: string,
  products: P[],
  sellers: S[] = [],
): QuickLine<P, S>[] {
  return parseNote(text, products, sellers).lines;
}
