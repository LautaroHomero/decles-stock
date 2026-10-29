import { salesList } from "@/lib/domain/billing";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";
import { listExpenses, type Expense } from "@/lib/domain/expenses";
import { listVisitPayments } from "@/lib/db/payments-repo";
import { debtCollections, debtsCreatedOn, type Debt, type DebtCollection } from "@/lib/domain/debts";

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
  byPayment: { efectivo: number; transferencia: number; tarjeta: number; dolares: number; giftcard: number; profesional: number; usd: number; pending: number; pendingCard: number };
  providers: CloseProvider[];
  /** Egresos del día (la médica no los ve: lista vacía). */
  expenses: Expense[];
  expensesTotal: number;
  /** Ingresos extras (cambio, varios…). */
  incomes: Expense[];
  incomesTotal: number;
  /** Cobros de deudas de este día (entran a la caja; ya están sumados en `byPayment`). */
  debtCollections: DebtCollection[];
  debtCollectedTotal: number;
  /** Lo que quedó debiendo la gente este día. */
  debtsCreated: Debt[];
  debtsCreatedTotal: number;
  /** Cobrado + cobros de deudas + ingresos extras − egresos. */
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
  const byPayment = { efectivo: 0, transferencia: 0, tarjeta: 0, dolares: 0, giftcard: 0, profesional: 0, usd: 0, pending: 0, pendingCard: 0 };
  const splitIds = [...new Set(sales.filter((s) => s.visitId && (s.paymentMethod === "mixto" || s.paymentMethod === "dolares")).map((s) => s.visitId!))];
  const split = actor.activeOrg ? await listVisitPayments(actor.activeOrg.id, splitIds) : {};
  const counted = new Set<string>();
  const providers = new Map<string, CloseProvider & { visits: Set<string> }>();
  let practices = 0, total = 0;

  for (const s of sales) {
    const key = visitKey(s);
    if (s.patientName) patientVisits.add(key);
    if (s.kind === "producto") productVisits.add(key);
    if (s.kind === "tratamiento" || s.kind === "consulta") practices += s.quantity;
    total += s.total;
    if ((s.paymentMethod === "mixto" || s.paymentMethod === "dolares") && s.visitId) {
      // Varios medios: se cuentan las partes una sola vez por anotación.
      if (!counted.has(s.visitId)) {
        counted.add(s.visitId);
        for (const p of split[s.visitId] ?? []) {
          byPayment[p.method] += p.amount;
          if (p.method === "dolares") byPayment.usd += p.usd ?? 0;
        }
      }
    } else if (s.paymentMethod === "efectivo") byPayment.efectivo += s.total;
    else if (s.paymentMethod === "transferencia") byPayment.transferencia += s.total;
    else if (s.paymentMethod === "tarjeta") byPayment.tarjeta += s.total;
    else if (s.paymentMethod === "giftcard" || s.paymentMethod === "profesional") byPayment[s.paymentMethod] += s.total;
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
  // Deudas: la médica no maneja caja (no las ve).
  const orgId = actor.role !== "medico" ? actor.activeOrg?.id : undefined;
  const collections = orgId ? await debtCollections(orgId, day) : [];
  const created = orgId ? await debtsCreatedOn(orgId, day) : [];
  for (const p of collections) byPayment[p.method ?? "efectivo"] += p.amount;
  const debtCollectedTotal = collections.reduce((n, p) => n + p.amount, 0);
  const inc = await listExpenses(actor, day, day, "ingreso");
  const incomes = inc.ok ? inc.expenses : [];
  const incomesTotal = inc.ok ? inc.total : 0;
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
      incomes,
      incomesTotal,
      debtCollections: collections,
      debtCollectedTotal,
      debtsCreated: created,
      debtsCreatedTotal: created.reduce((n, d) => n + d.amount, 0),
      net: total + debtCollectedTotal + incomesTotal - expensesTotal,
    },
  };
}
