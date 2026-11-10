/**
 * Combos / promos: cálculo puro (lo usan Anotar y la Planilla; sin base de datos).
 * Dado lo que se anotó, busca qué combos entran y reparte el precio del combo entre sus renglones en proporción a la
 * lista (A $1 + B $3 en combo a $3 → A $0,75 y B $2,25). Lo que sobra fuera del combo va a precio de lista.
 */

export interface ComboDef {
  id: string;
  name: string;
  /** Precio efectivo / transferencia. */
  price: number;
  /** Con tarjeta (null = el mismo). */
  cardPrice: number | null;
  items: { itemId: string; qty: number }[];
}

export interface ComboLine {
  itemId: string | null;
  qty: number;
  /** Lista del renglón entero (precio × cantidad), en efectivo y con tarjeta. */
  cash: number;
  card: number;
  /** Profesional del renglón: un combo solo junta renglones de la misma. */
  group?: string | null;
}

export interface ComboApplied {
  id: string;
  name: string;
  times: number;
  /** Lo que se ahorra (efectivo). */
  saving: number;
}

export interface ComboResult {
  /** Lista de cada renglón ya con el combo (efectivo / tarjeta). */
  cash: number[];
  card: number[];
  applied: ComboApplied[];
  /** Cada vez que entró un combo: qué renglones (índice) y cuántas unidades de cada uno. */
  uses: { id: string; take: { i: number; n: number }[] }[];
}

/** Reparte `total` en proporción a `weights` (enteros; lo que sobra del redondeo va al más grande). */
export function share(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => (sum > 0 ? Math.floor((total * w) / sum) : Math.floor(total / weights.length)));
  const rest = total - out.reduce((a, b) => a + b, 0);
  let big = 0;
  weights.forEach((w, i) => (w > weights[big] ? (big = i) : 0));
  out[big] += rest;
  return out;
}

export function applyCombos(lines: ComboLine[], combos: ComboDef[]): ComboResult {
  const cash = lines.map((l) => l.cash);
  const card = lines.map((l) => l.card);
  if (!combos.length || lines.length < 1) return { cash, card, applied: [], uses: [] };
  const uses: ComboResult["uses"] = [];
  const rem = lines.map((l) => l.qty);
  const inCash = lines.map(() => 0);
  const inCard = lines.map(() => 0);
  const unitCash = lines.map((l) => (l.qty > 0 ? l.cash / l.qty : 0));
  const unitCard = lines.map((l) => (l.qty > 0 ? l.card / l.qty : 0));
  const applied = new Map<string, ComboApplied>();
  // Primero los combos más grandes (los que juntan más cosas).
  const order = combos
    .filter((c) => c.items.length && c.items.reduce((n, i) => n + i.qty, 0) >= 2)
    .sort((a, b) => b.items.reduce((n, i) => n + i.qty, 0) - a.items.reduce((n, i) => n + i.qty, 0));
  const groups = [...new Set(lines.map((l) => l.group ?? ""))];
  for (const g of groups) {
    for (const c of order) {
      for (;;) {
        // ¿Entra una vez más en esta profesional?
        const take: { i: number; n: number }[] = [];
        let ok = true;
        for (const ci of c.items) {
          let need = ci.qty;
          for (let i = 0; i < lines.length && need > 0; i++) {
            if (lines[i].itemId !== ci.itemId || (lines[i].group ?? "") !== g || rem[i] <= 0) continue;
            const already = take.filter((t) => t.i === i).reduce((n, t) => n + t.n, 0);
            const n = Math.min(need, rem[i] - already);
            if (n > 0) {
              take.push({ i, n });
              need -= n;
            }
          }
          if (need > 0) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
        const wCash = take.map((t) => unitCash[t.i] * t.n);
        const wCard = take.map((t) => unitCard[t.i] * t.n);
        const sCash = share(c.price, wCash);
        const sCard = share(c.cardPrice ?? c.price, wCard);
        take.forEach((t, k) => {
          rem[t.i] -= t.n;
          inCash[t.i] += sCash[k];
          inCard[t.i] += sCard[k];
        });
        uses.push({ id: c.id, take });
        const a = applied.get(c.id) ?? { id: c.id, name: c.name, times: 0, saving: 0 };
        a.times += 1;
        a.saving += Math.round(wCash.reduce((x, y) => x + y, 0)) - c.price;
        applied.set(c.id, a);
      }
    }
  }
  if (!applied.size) return { cash, card, applied: [], uses: [] };
  return {
    cash: lines.map((l, i) => (rem[i] === l.qty ? l.cash : inCash[i] + Math.round(unitCash[i] * rem[i]))),
    card: lines.map((l, i) => (rem[i] === l.qty ? l.card : inCard[i] + Math.round(unitCard[i] * rem[i]))),
    applied: [...applied.values()],
    uses,
  };
}

/** «Promo A + B» o «Promo A + B ×2». */
export const comboLabel = (a: { name: string; times: number }) => (a.times > 1 ? `${a.name} ×${a.times}` : a.name);
