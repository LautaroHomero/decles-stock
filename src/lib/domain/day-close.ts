import { salesList } from "@/lib/domain/billing";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";
import { listExpenses, type Expense } from "@/lib/domain/expenses";

/**
 * Cierre del día: pacientes, prácticas y ventas de productos, total cobrado y el detalle por
 * médica. Sale de las `sales` pagas del día (las anuladas no cuentan). La médica ve solo lo suyo.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };

export interface CloseCount {
  name: string;
  quantity: number;
}

export interface CloseProvider {
  providerId: string | null;
  name: string;
  patients: number;
  practices: CloseCount[];
  products: CloseCount[];
  /** Lo cobrado (sin medio cargado cuenta a precio efectivo). */
  total: number;
}

export interface DayClose {
  date: string;
  patients: number;
  practices: number;
  /** Ventas de productos (anotaciones con al menos un producto). */
  productSales: number;
  total: number;
  /** Totales por medio de pago; `pending` = sin medio cargado (a precio efectivo; con tarjeta sería `pendingCard`). */
  byPayment: { efectivo: number; tarjeta: number; pending: number; pendingCard: number };
  providers: CloseProvider[];
  /** Egresos del día (la médica no los ve: lista vacía). */
  expenses: Expense[];
  expensesTotal: number;
  /** Cobrado − egresos. */
  net: number;
}

const add = (list: CloseCount[], name: string, q: number) => {
  const c = list.find((x) => x.name === name);
  if (c) c.quantity += q;
  else list.push({ name, quantity: q });
};

export async function dayClose(actor: Actor, date?: string): Promise<Result<{ close: DayClose }>> {
  const r = await salesList(actor, date, date, 500);
  if (!r.ok) return r;
  const sales = r.sales.filter((s) => s.status === "paid");
  const day = date ?? realNowIso().slice(0, 10);

  // Una anotación = un visitId (las ventas viejas sin visitId cuentan cada una por separado).
  const visitKey = (s: (typeof sales)[number]) => s.visitId ?? s.id;
  const patientVisits = new Set<string>();
  const productVisits = new Set<string>();
  const byPayment = { efectivo: 0, tarjeta: 0, pending: 0, pendingCard: 0 };
  const providers = new Map<string, CloseProvider & { visits: Set<string> }>();
  let practices = 0, total = 0;

  for (const s of sales) {
    const key = visitKey(s);
    if (s.patientName) patientVisits.add(key);
    if (s.kind === "producto") productVisits.add(key);
    if (s.kind === "tratamiento" || s.kind === "consulta") practices += s.quantity;
    total += s.total;
    if (s.paymentMethod === "efectivo") byPayment.efectivo += s.total;
    else if (s.paymentMethod === "tarjeta") byPayment.tarjeta += s.total;
    else {
      byPayment.pending += s.cashTotal;
      byPayment.pendingCard += s.cardTotal;
    }
    const pk = s.providerId ?? "-";
    let p = providers.get(pk);
    if (!p) {
      p = { providerId: s.providerId, name: s.providerName ?? "Sin médica", patients: 0, practices: [], products: [], total: 0, visits: new Set() };
      providers.set(pk, p);
    }
    if (s.patientName) p.visits.add(key);
    if (s.kind === "producto") add(p.products, s.itemName, s.quantity);
    else add(p.practices, s.kind === "pendiente" ? `${s.itemName} (sin cargar)` : s.itemName, s.quantity);
    p.total += s.total;
  }

  const list = [...providers.values()]
    .map(({ visits, ...p }) => ({ ...p, patients: visits.size }))
    .sort((a, b) => b.total - a.total);
  const ex = await listExpenses(actor, day, day);
  const expenses = ex.ok ? ex.expenses : [];
  const expensesTotal = ex.ok ? ex.total : 0;
  return {
    ok: true,
    close: {
      date: day,
      patients: patientVisits.size,
      practices,
      productSales: productVisits.size,
      total,
      byPayment,
      providers: list,
      expenses,
      expensesTotal,
      net: total - expensesTotal,
    },
  };
}
