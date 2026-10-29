"use client";

import { useMemo, useState } from "react";
import { CaretLeftIcon, CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { ExpenseForm, type Expense, type ExpensesResponse } from "./egresos";
import { fmtSigned, toRows } from "./planilla-view";
import { Toast, call, fmtTime, money, usePoll, useToast, useToday, type Payment, type PaymentsMap, type SaleMethod, type SaleRow, methodTotals, outsideOf, usdFmt } from "./shared";
import { DebtsCard, type DebtCollectionRow, type DebtRow } from "./deudas";
import { ProviderDebtsCard } from "./deudas-profesionales";
import { CuentasProfesionales, type Balance } from "./cuentas-profesionales";
import { AbonosCard } from "./abonos";
import { PayablesCard } from "./deudas-consultorio";
import { SenasCard } from "./senas";

/**
 * Cierre del día (secretaría y admin): todo lo que entró, todo lo que salió y a quién se le pagó.
 *  · Arriba: entró, salió y el efectivo que debería haber.
 *  · Cuentas con profesionales: sus atenciones (quién cobró, su parte) y quién le debe a quién («Pagar» / «Cobrar»).
 *  · Movimientos: cada paciente (qué, con quién, cómo pagó), ingresos y egresos extras y pagos a profesionales.
 *  · Caja y medios de pago.
 */

interface Payout {
  id: string;
  /** 'pago' = le dimos plata (sale); 'cobro' = nos dio lo que nos debía (entra). */
  direction: "pago" | "cobro";
  providerId: string;
  providerName: string;
  amount: number;
  method: "efectivo" | "transferencia";
  /** Pago de lo que se le debía de otro día. */
  debtId: string | null;
  debtDate: string | null;
  createdByName: string;
  createdAt: string;
}

const shift = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const longDate = (ymd: string) => {
  const s = new Date(`${ymd}T12:00:00`).toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const num = (s: string) => Number(s.replace(/\D/g, "") || 0);
const METHOD: Record<SaleMethod, string> = {
  efectivo: "efectivo",
  transferencia: "transferencia",
  tarjeta: "tarjeta",
  dolares: "dólares",
  giftcard: "gift card",
  profesional: "le pagaron a la profesional",
  mixto: "varios medios",
};
const short = (name: string) => name.replace(/^(Dra?\.|Lic\.)\s*/i, "");

export function CierreSheet({ actor }: { actor: Actor }) {
  const today = useToday();
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked ?? today;
  const setDate = (d: string) => setPicked(d === today ? null : d);
  const canEdit = !!actor.activeOrg?.canAdmin || date === today;

  const [sales] = usePoll<{ ok: boolean; sales: SaleRow[]; payments?: PaymentsMap }>(`/api/sales?from=${date}&to=${date}&limit=500`, 30_000);
  const [egr, refreshEgr] = usePoll<ExpensesResponse>(`/api/expenses?from=${date}&to=${date}`, 30_000);
  const [ing, refreshIng] = usePoll<ExpensesResponse>(`/api/expenses?from=${date}&to=${date}&direction=ingreso`, 30_000);
  const [cash, refreshCash] = usePoll<{ ok: boolean; cash: { opening: number | null; amount: number | null } }>(`/api/day-cash?date=${date}`, 60_000);
  const [pay, refreshPay] = usePoll<{ ok: boolean; error?: string; payouts: Payout[]; balances: Balance[] }>(`/api/payouts?date=${date}`, 30_000);
  const [dd, refreshDd] = usePoll<{ ok: boolean; collections: DebtCollectionRow[]; created: DebtRow[] }>(`/api/debts/day?date=${date}`, 30_000);
  const [toast, showToast] = useToast();
  const [form, setForm] = useState<{ direction: "egreso" | "ingreso"; expense?: Expense } | null>(null);

  const rows = useMemo(() => toRows(sales?.ok ? sales.sales : [], sales?.payments), [sales]);
  const egresos = useMemo(() => (egr?.ok ? egr.expenses : []), [egr]);
  const ingresos = useMemo(() => (ing?.ok ? ing.expenses : []), [ing]);
  const allPayouts = useMemo(() => (pay?.ok ? pay.payouts : []), [pay]);
  // Pagos (le damos plata) y cobros (nos da lo que nos debía de lo que le pagaron directo).
  const payouts = useMemo(() => allPayouts.filter((p) => p.direction !== "cobro"), [allPayouts]);
  const cobros = useMemo(() => allPayouts.filter((p) => p.direction === "cobro"), [allPayouts]);
  const balances = pay?.ok ? pay.balances : [];
  // Deudas: lo cobrado hoy entra a la caja; lo que quedó debiendo se ve en la fila de esa atención.
  const collections = useMemo(() => (dd?.ok ? dd.collections : []), [dd]);
  const debtByVisit = useMemo(() => new Map((dd?.ok ? dd.created : []).filter((d) => d.visitId).map((d) => [d.visitId!, d])), [dd]);
  const debtIn = collections.reduce((n, p) => n + p.amount, 0);
  const debtInBy = (m: Payment) => collections.filter((p) => (p.method ?? "efectivo") === m).reduce((n, p) => n + p.amount, 0);
  const debtShares = collections.reduce((n, p) => n + p.share, 0);

  const egTotal = egresos.reduce((n, e) => n + e.amount, 0);
  const inTotal = ingresos.reduce((n, e) => n + e.amount, 0);
  const paidOut = payouts.reduce((n, p) => n + p.amount, 0);
  // Lo que no entró hoy al consultorio: lo pagado directo a la profesional y con gift card.
  const outside = rows.reduce((n, r) => { const o = outsideOf(r); return { profesional: n.profesional + o.profesional, giftcard: n.giftcard + o.giftcard }; }, { profesional: 0, giftcard: 0 });
  const cobrado = rows.reduce((n, r) => n + r.total, 0) - outside.profesional - outside.giftcard;
  const cobrosTotal = cobros.reduce((n, p) => n + p.amount, 0);
  const cobroBy = (m: Payment) => cobros.filter((p) => (p.method ?? "efectivo") === m).reduce((n, p) => n + p.amount, 0);
  const kTotal = rows.reduce((n, r) => n + r.k, 0);
  // Por medio, contando las partes de lo que se pagó con varios medios o en dólares.
  const mt = useMemo(() => methodTotals(sales?.ok ? sales.sales : [], sales?.payments), [sales]);
  const byMethod = (m: Payment | null) => (m ? mt[m] : mt.sin);
  const efectivo = mt.efectivo + debtInBy("efectivo");
  const opening = cash?.ok ? cash.cash.opening : null;
  const contado = cash?.ok ? cash.cash.amount : null;
  const entro = cobrado + debtIn + inTotal + cobrosTotal;
  const salio = egTotal + paidOut;
  // A la caja solo le toca el efectivo: lo transferido (o con tarjeta) va por otro lado.
  const cashOnly = <T extends { method?: string }>(l: T[]) => l.filter((x) => (x.method ?? "efectivo") === "efectivo");
  const inBy = (m: Payment) => ingresos.filter((e) => (e.method ?? "efectivo") === m).reduce((n, e) => n + e.amount, 0);
  const inCash = cashOnly(ingresos).reduce((n, e) => n + e.amount, 0);
  const egCash = cashOnly(egresos).reduce((n, e) => n + e.amount, 0);
  const paidOutCash = cashOnly(payouts).reduce((n, p) => n + p.amount, 0);
  const paidToday = payouts.filter((p) => !p.debtId).reduce((n, p) => n + p.amount, 0);
  const paidDebts = paidOut - paidToday;
  const cobrosCash = cobroBy("efectivo");
  const esperado = (opening ?? 0) + efectivo + inCash + cobrosCash - egCash - paidOutCash;
  const pacientes = rows.filter((r) => r.patient).length;

  // Movimientos del día, en orden: cada paciente, los extras y los pagos a profesionales.
  const moves = useMemo(() => {
    type Move = {
      at: string;
      time: string;
      who: string;
      what: string;
      detail: string;
      inn: number;
      out: number;
      kind: "visita" | "ingreso" | "egreso" | "pago" | "cobro" | "deuda";
      ref?: Expense | Payout | DebtCollectionRow;
    };
    const list: Move[] = [
      ...rows.map((r) => ({
        at: r.sales[0].createdAt,
        time: r.time,
        who: r.patient || "Sin paciente",
        what: r.items.map((i) => `${i.qty > 1 ? `${i.qty} ` : ""}${i.name}`).join(", "),
        detail: [
          short(r.sales[0].providerName ?? ""),
          r.parts.length
            ? r.parts.map((p) => (p.method === "dolares" ? `${usdFmt(p.usd ?? 0)} (${money(p.amount)})` : `${METHOD[p.method]} ${money(p.amount)}`)).join(" + ")
            : r.method
              ? METHOD[r.method]
              : r.total
                ? "sin medio"
                : "no pasó por caja",
        ]
          .concat(r.sales[0].visitId && debtByVisit.get(r.sales[0].visitId) ? [`quedó debiendo ${money(debtByVisit.get(r.sales[0].visitId!)!.amount)}`] : [])
          .filter(Boolean)
          .join(" · "),
        inn: r.total - outsideOf(r).profesional - outsideOf(r).giftcard,
        out: 0,
        kind: "visita" as const,
      })),
      ...cobros.map((p) => ({
        at: p.createdAt,
        time: fmtTime(p.createdAt),
        who: short(p.providerName),
        what: p.debtId ? `Nos pagó lo que debía${p.debtDate ? ` (del ${p.debtDate.slice(8, 10)}/${p.debtDate.slice(5, 7)})` : ""}` : "Nos dio lo nuestro (le pagaron directo)",
        detail: [METHOD[p.method], p.createdByName].join(" · "),
        inn: p.amount,
        out: 0,
        kind: "cobro" as const,
        ref: p,
      })),
      ...ingresos.map((e) => ({ at: e.createdAt, time: fmtTime(e.createdAt), who: /^(Abono|Seña) · /.test(e.concept) ? e.concept.replace(/^(Abono|Seña) · /, "") : e.concept, what: e.concept.startsWith("Abono · ") ? "Abono (paga antes las sesiones)" : e.concept.startsWith("Seña · ") ? "Seña (el resto lo paga cuando viene)" : "Ingreso extra", detail: [METHOD[e.method ?? "efectivo"], e.createdByName].join(" · "), inn: e.amount, out: 0, kind: "ingreso" as const, ref: e })),
      ...egresos.map((e) => ({ at: e.createdAt, time: fmtTime(e.createdAt), who: e.concept, what: "Egreso", detail: [METHOD[e.method ?? "efectivo"], e.createdByName].join(" · "), inn: 0, out: e.amount, kind: "egreso" as const, ref: e })),
      ...payouts.map((p) => ({
        at: p.createdAt,
        time: fmtTime(p.createdAt),
        who: short(p.providerName),
        what: p.debtId ? `Pago de lo que se le debía${p.debtDate ? ` (del ${p.debtDate.slice(8, 10)}/${p.debtDate.slice(5, 7)})` : ""}` : "Pago a profesional",
        detail: [METHOD[p.method], p.createdByName].join(" · "),
        inn: 0,
        out: p.amount,
        kind: "pago" as const,
        ref: p,
      })),
      ...collections.map((p) => ({
        at: p.createdAt,
        time: fmtTime(p.createdAt),
        who: p.debtor,
        what: "Cobro de deuda",
        detail: [p.concept, short(p.providerName ?? ""), METHOD[p.method ?? "efectivo"]].filter(Boolean).join(" · "),
        inn: p.amount,
        out: 0,
        kind: "deuda" as const,
        ref: p,
      })),
    ];
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }, [rows, ingresos, egresos, payouts, cobros, collections, debtByVisit]);

  async function voidCollection(p: DebtCollectionRow) {
    const r = await call(`/api/debts/payments/${p.id}`, "DELETE");
    if (!r.ok) return showToast(r.error ?? "No se pudo deshacer.");
    showToast("Cobro deshecho: la deuda vuelve a estar abierta.");
    refreshDd();
    refreshPay();
  }
  async function voidPay(p: Payout) {
    const r = await call(`/api/payouts/${p.id}`, "DELETE");
    if (!r.ok) return showToast(r.error ?? "No se pudo anular.");
    showToast(p.direction === "cobro" ? "Cobro anulado." : "Pago anulado.");
    refreshPay();
  }

  const [provDebtsKey, setProvDebtsKey] = useState(0);
  const loading = !sales || !pay;

  return (
    <div className="cl-print-area mx-auto flex w-full max-w-[920px] flex-col gap-8 px-5 pb-20 pt-8 text-[14px] sm:px-6 sm:pt-12">
      <Toast msg={toast} />
      {form && (
        <ExpenseForm
          direction={form.direction}
          expense={form.expense}
          onClose={() => setForm(null)}
          onSaved={(msg) => {
            setForm(null);
            showToast(msg + ".");
            refreshEgr();
            refreshIng();
          }}
        />
      )}

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[13.5px] text-neutral-400">{longDate(date)}</p>
          <h1 className="font-display text-[24px] font-medium tracking-[-.02em]">Cierre del día</h1>
        </div>
        <div className="cl-no-print flex items-center gap-1">
          <button aria-label="Día anterior" onClick={() => setDate(shift(date, -1))} className={NAV}>
            <CaretLeftIcon size={16} weight="bold" />
          </button>
          {date !== today && (
            <button onClick={() => setDate(today)} className="h-9 rounded-md px-2.5 text-[13px] text-neutral-300 hover:bg-neutral-900">
              Hoy
            </button>
          )}
          <button aria-label="Día siguiente" onClick={() => setDate(shift(date, 1))} disabled={date >= today} className={NAV}>
            <CaretRightIcon size={16} weight="bold" />
          </button>
          <button onClick={() => window.print()} className="ml-2 h-9 rounded-md border border-neutral-800 px-3 text-[13px] text-neutral-300 hover:bg-accent-900">
            Imprimir
          </button>
        </div>
      </header>

      {loading ? (
        <p className="text-neutral-500">Cargando…</p>
      ) : (
        <>
          <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-neutral-800 sm:grid-cols-3">
            <Big label="Entró" value={money(entro)} sub={`${pacientes} ${pacientes === 1 ? "paciente" : "pacientes"}${debtIn ? ` + ${money(debtIn)} de deudas` : ""}${inTotal ? ` + ${money(inTotal)} extras` : ""}`} />
            <Big label="Salió" value={money(salio)} sub={`egresos ${money(egTotal)} · profesionales ${money(paidOut)}${paidOut !== paidOutCash || egTotal !== egCash ? ` · en efectivo ${money(egCash + paidOutCash)}` : ""}`} border />
            <Big
              label="Efectivo que debería haber"
              value={fmtSigned(esperado)}
              sub={opening === null ? "falta el cambio al iniciar" : contado === null ? "falta contar la caja" : diffText(contado - esperado)}
              border
            />
          </div>

          {/* Cuentas con profesionales: sus atenciones y quién le debe a quién */}
          <CuentasProfesionales
            balances={balances}
            error={pay && !pay.ok ? (pay.error ?? "No se pudieron cargar las cuentas con profesionales.") : null}
            date={date}
            canEdit={canEdit}
            showToast={showToast}
            onChange={() => {
              refreshPay();
              setProvDebtsKey((k) => k + 1);
            }}
          />
          {paidDebts > 0 && <p className="-mt-6 px-1 text-[12.5px] text-neutral-500">Además hoy se pagaron {money(paidDebts)} de deudas con profesionales de otros días.</p>}

          {/* Movimientos: todo lo que entró y salió */}
          <Card
            title="Movimientos del día"
            action={
              canEdit && (
                <span className="cl-no-print flex gap-3">
                  <button onClick={() => setForm({ direction: "ingreso" })} className="inline-flex items-center gap-1 text-[13px] text-neutral-400 hover:text-fg">
                    <PlusIcon size={12} weight="bold" /> Ingreso extra
                  </button>
                  <button onClick={() => setForm({ direction: "egreso" })} className="inline-flex items-center gap-1 text-[13px] text-neutral-400 hover:text-fg">
                    <PlusIcon size={12} weight="bold" /> Egreso
                  </button>
                </span>
              )
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse">
                <thead>
                  <tr className="text-left text-[12px] text-neutral-500">
                    <th className="w-[52px] px-4 pb-2 font-normal">Hora</th>
                    <th className="px-3 pb-2 font-normal">Paciente / concepto</th>
                    <th className="px-3 pb-2 font-normal">Qué</th>
                    <th className="px-3 pb-2 text-right font-normal">Entró</th>
                    <th className="px-4 pb-2 text-right font-normal">Salió</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m, i) => {
                    const clickable = canEdit && (m.kind === "ingreso" || m.kind === "egreso");
                    return (
                      <tr
                        key={i}
                        onClick={() => clickable && setForm({ direction: m.kind === "ingreso" ? "ingreso" : "egreso", expense: m.ref as Expense })}
                        className={`border-t border-neutral-900 align-top ${clickable ? "cursor-pointer hover:bg-neutral-900" : ""}`}
                      >
                        <td className="px-4 py-2 tabular-nums text-neutral-500">{m.time}</td>
                        <td className="px-3 py-2">
                          <span className={m.kind === "visita" && m.who === "Sin paciente" ? "text-neutral-500" : "font-medium"}>{m.who}</span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="block">{m.what}</span>
                          <span className="block text-[12.5px] text-neutral-500">
                            {m.detail}
                            {m.kind === "deuda" && canEdit && (
                              <button onClick={() => voidCollection(m.ref as DebtCollectionRow)} className="cl-no-print ml-2 underline-offset-2 hover:text-fg hover:underline">
                                deshacer
                              </button>
                            )}
                            {(m.kind === "pago" || m.kind === "cobro") && canEdit && (
                              <button onClick={() => voidPay(m.ref as Payout)} className="cl-no-print ml-2 underline-offset-2 hover:text-fg hover:underline">
                                anular
                              </button>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{m.inn ? money(m.inn) : ""}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{m.out ? money(m.out) : ""}</td>
                      </tr>
                    );
                  })}
                  {!moves.length && (
                    <tr>
                      <td colSpan={5} className="px-4 py-3 text-neutral-500">
                        No hubo movimientos este día.
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot className="tabular-nums">
                  <tr className="border-t border-neutral-800 font-medium">
                    <td colSpan={3} className="px-4 py-2.5">
                      Total
                    </td>
                    <td className="px-3 py-2.5 text-right">{money(entro)}</td>
                    <td className="px-4 py-2.5 text-right">{money(salio)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3} className="px-4 pb-3 text-neutral-400">
                      Queda (entró − salió)
                    </td>
                    <td colSpan={2} className="px-4 pb-3 text-right font-medium">
                      {fmtSigned(entro - salio)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          {/* Deudas abiertas (de todos los días) */}
          <DebtsCard
            canAnul={!!actor.activeOrg?.canAdmin}
            showToast={showToast}
            onChange={() => {
              refreshDd();
              refreshPay();
            }}
          />

          {/* Lo que debe el consultorio (de todos los días) */}
          <PayablesCard canAnul={!!actor.activeOrg?.canAdmin} showToast={showToast} onChange={() => refreshEgr()} />

          {/* Señas sin usar (de todos los días) */}
          <SenasCard showToast={showToast} onChange={() => refreshIng()} />

          {/* Abonos abiertos (de todos los días) */}
          <AbonosCard
            showToast={showToast}
            onChange={() => {
              refreshIng();
            }}
          />

          {/* Lo que el consultorio les debe a sus profesionales (de todos los días) */}
          <ProviderDebtsCard
            key={provDebtsKey}
            canAnul={!!actor.activeOrg?.canAdmin}
            showToast={showToast}
            onChange={() => refreshPay()}
          />
          {/* Lo que las profesionales nos deben (de todos los días) */}
          <ProviderDebtsCard
            key={`her:${provDebtsKey}`}
            direction="profesional"
            canAnul={!!actor.activeOrg?.canAdmin}
            showToast={showToast}
            onChange={() => refreshPay()}
          />

          {/* Caja y medios de pago */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card title="Caja (efectivo)">
              <div className="flex flex-col px-4 pb-3">
                <CashInput
                  key={`o:${date}:${opening ?? ""}`}
                  label="Cambio al iniciar"
                  amount={opening}
                  canEdit={canEdit}
                  onSave={async (v) => {
                    const r = await call("/api/day-cash", "PUT", { date, opening: v });
                    if (!r.ok) return showToast(r.error ?? "No se pudo guardar.");
                    refreshCash();
                  }}
                />
                <Line label="+ Efectivo cobrado" value={money(mt.efectivo)} />
                {debtInBy("efectivo") > 0 && <Line label="+ Deudas cobradas en efectivo" value={money(debtInBy("efectivo"))} />}
                <Line label="+ Ingresos extras en efectivo" value={money(inCash)} />
                {cobrosCash > 0 && <Line label="+ Cobrado a profesionales en efectivo" value={money(cobrosCash)} />}
                <Line label="− Egresos en efectivo" value={money(egCash)} />
                <Line label="− Pagado a profesionales en efectivo" value={money(paidOutCash)} />
                <Line label="Debería haber" value={fmtSigned(esperado)} strong />
                <CashInput
                  key={`c:${date}:${contado ?? ""}`}
                  label="Contado al cambio"
                  amount={contado}
                  canEdit={canEdit}
                  onSave={async (v) => {
                    const r = await call("/api/day-cash", "PUT", { date, amount: v });
                    if (!r.ok) return showToast(r.error ?? "No se pudo guardar.");
                    refreshCash();
                  }}
                />
                {contado !== null && <Line label="Diferencia" value={diffText(contado - esperado)} />}
                {mt.usd > 0 && <Line label="Dólares en caja (aparte)" value={usdFmt(mt.usd)} strong />}
              </div>
            </Card>
            <Card title="Cómo pagaron">
              <div className="flex flex-col px-4 pb-3">
                <Line label="Efectivo" value={money(efectivo + inBy("efectivo") + cobrosCash)} />
                <Line label="Transferencias" value={money(byMethod("transferencia") + debtInBy("transferencia") + inBy("transferencia") + cobroBy("transferencia"))} />
                <Line label="Tarjetas" value={money(byMethod("tarjeta") + debtInBy("tarjeta") + inBy("tarjeta"))} />
                {mt.usd > 0 && <Line label={`Dólares · ${usdFmt(mt.usd)}`} value={money(mt.dolares)} />}
                {byMethod(null) > 0 && <Line label="Sin medio cargado" value={money(byMethod(null))} muted />}
                {debtIn > 0 && <Line label="De eso, deudas cobradas" value={money(debtIn)} muted />}
                {inTotal > 0 && <Line label="De eso, ingresos extras (señas, abonos…)" value={money(inTotal)} muted />}
                {cobrosTotal > 0 && <Line label="De eso, lo que nos dieron profesionales" value={money(cobrosTotal)} muted />}
                <Line label="Total que entró" value={money(entro)} strong />
                {outside.profesional > 0 && <Line label="Le pagaron directo a profesionales (no entró)" value={money(outside.profesional)} muted />}
                {outside.giftcard > 0 && <Line label="Pagado con gift card (no entró hoy)" value={money(outside.giftcard)} muted />}
                <Line
                  label="Para Decles (lo de hoy − parte de profesionales)"
                  value={fmtSigned(cobrado + outside.profesional + debtIn + inTotal - kTotal - debtShares)}
                />
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

const diffText = (d: number) => (d === 0 ? "justo" : d > 0 ? `sobran ${money(d)}` : `faltan ${money(-d)}`);

function Big({ label, value, sub, border }: { label: string; value: string; sub: string; border?: boolean }) {
  return (
    <div className={`flex flex-col gap-1 px-5 py-4 ${border ? "border-t border-neutral-800 sm:border-l sm:border-t-0" : ""}`}>
      <span className="text-[12.5px] text-neutral-400">{label}</span>
      <span className="font-display text-[22px] font-medium leading-tight tabular-nums">{value}</span>
      <span className="text-[12.5px] text-neutral-500">{sub}</span>
    </div>
  );
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col rounded-xl border border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
        <h2 className="text-[14px] font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Line({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 border-t border-neutral-900 py-2 ${strong ? "font-medium" : ""} ${muted ? "text-neutral-500" : ""}`}>
      <span className={strong || muted ? "" : "text-neutral-300"}>{label}</span>
      <span className="whitespace-nowrap tabular-nums">{value}</span>
    </div>
  );
}

function CashInput({ label, amount, canEdit, onSave }: { label: string; amount: number | null; canEdit: boolean; onSave: (n: number | null) => void }) {
  const [v, setV] = useState(amount === null ? "" : String(amount));
  const save = () => {
    const n = v.trim() === "" ? null : num(v);
    if (n !== amount) onSave(n);
  };
  return (
    <label className="flex items-center justify-between gap-4 border-t border-neutral-900 py-1.5">
      <span className="text-neutral-300">{label}</span>
      <input
        value={v ? `$ ${num(v).toLocaleString("es-AR")}` : ""}
        disabled={!canEdit}
        onChange={(e) => setV(e.target.value.replace(/\D/g, ""))}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        inputMode="numeric"
        placeholder="Anotar"
        className="w-[140px] rounded-md border border-neutral-800 bg-transparent px-2.5 py-1 text-right tabular-nums text-fg outline-none placeholder:text-neutral-600 focus:border-accent-700"
      />
    </label>
  );
}

const NAV = "flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900 disabled:opacity-30";
