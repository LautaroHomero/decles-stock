"use client";

import { useMemo, useState } from "react";
import { CaretLeftIcon, CaretRightIcon, CheckIcon, PlusIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { ExpenseForm, type Expense, type ExpensesResponse } from "./egresos";
import { fmtSigned, toRows } from "./planilla-view";
import { Toast, call, fmtTime, money, usePoll, useToast, useToday, type Payment, type SaleRow } from "./shared";

/**
 * Cierre del día (secretaría y admin): todo lo que entró, todo lo que salió y a quién se le pagó.
 *  · Arriba: entró, salió y el efectivo que debería haber.
 *  · Profesionales: pacientes, lo cobrado, su parte, lo que ya se le pagó y lo que se le debe («Pagar»).
 *  · Movimientos: cada paciente (qué, con quién, cómo pagó), ingresos y egresos extras y pagos a profesionales.
 *  · Caja y medios de pago.
 */

interface Payout {
  id: string;
  providerId: string;
  providerName: string;
  amount: number;
  createdByName: string;
  createdAt: string;
}
interface Balance {
  providerId: string;
  name: string;
  share: number;
  paid: number;
  owed: number;
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
const METHOD: Record<Payment, string> = { efectivo: "efectivo", transferencia: "transferencia", tarjeta: "tarjeta" };
const short = (name: string) => name.replace(/^(Dra?\.|Lic\.)\s*/i, "");

export function CierreSheet({ actor }: { actor: Actor }) {
  const today = useToday();
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked ?? today;
  const setDate = (d: string) => setPicked(d === today ? null : d);
  const canEdit = !!actor.activeOrg?.canAdmin || date === today;

  const [sales] = usePoll<{ ok: boolean; sales: SaleRow[] }>(`/api/sales?from=${date}&to=${date}&limit=500`, 30_000);
  const [egr, refreshEgr] = usePoll<ExpensesResponse>(`/api/expenses?from=${date}&to=${date}`, 30_000);
  const [ing, refreshIng] = usePoll<ExpensesResponse>(`/api/expenses?from=${date}&to=${date}&direction=ingreso`, 30_000);
  const [cash, refreshCash] = usePoll<{ ok: boolean; cash: { opening: number | null; amount: number | null } }>(`/api/day-cash?date=${date}`, 60_000);
  const [pay, refreshPay] = usePoll<{ ok: boolean; payouts: Payout[]; balances: Balance[] }>(`/api/payouts?date=${date}`, 30_000);
  const [toast, showToast] = useToast();
  const [form, setForm] = useState<{ direction: "egreso" | "ingreso"; expense?: Expense } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(() => toRows(sales?.ok ? sales.sales : []), [sales]);
  const egresos = useMemo(() => (egr?.ok ? egr.expenses : []), [egr]);
  const ingresos = useMemo(() => (ing?.ok ? ing.expenses : []), [ing]);
  const payouts = useMemo(() => (pay?.ok ? pay.payouts : []), [pay]);
  const balances = pay?.ok ? pay.balances : [];

  const egTotal = egresos.reduce((n, e) => n + e.amount, 0);
  const inTotal = ingresos.reduce((n, e) => n + e.amount, 0);
  const paidOut = payouts.reduce((n, p) => n + p.amount, 0);
  const cobrado = rows.reduce((n, r) => n + r.total, 0);
  const kTotal = rows.reduce((n, r) => n + r.k, 0);
  const owedTotal = balances.reduce((n, b) => n + b.owed, 0);
  const byMethod = (m: Payment | null) => rows.filter((r) => r.method === m).reduce((n, r) => n + r.total, 0);
  const efectivo = byMethod("efectivo");
  const opening = cash?.ok ? cash.cash.opening : null;
  const contado = cash?.ok ? cash.cash.amount : null;
  const entro = cobrado + inTotal;
  const salio = egTotal + paidOut;
  const esperado = (opening ?? 0) + efectivo + inTotal - egTotal - paidOut;
  const pacientes = rows.filter((r) => r.patient).length;

  // Movimientos del día, en orden: cada paciente, los extras y los pagos a profesionales.
  const moves = useMemo(() => {
    type Move = { at: string; time: string; who: string; what: string; detail: string; inn: number; out: number; kind: "visita" | "ingreso" | "egreso" | "pago"; ref?: Expense | Payout };
    const list: Move[] = [
      ...rows.map((r) => ({
        at: r.sales[0].createdAt,
        time: r.time,
        who: r.patient || "Sin paciente",
        what: r.items.map((i) => `${i.qty > 1 ? `${i.qty} ` : ""}${i.name}`).join(", "),
        detail: [short(r.sales[0].providerName ?? ""), r.method ? METHOD[r.method] : r.total ? "sin medio" : "no pasó por caja"].filter(Boolean).join(" · "),
        inn: r.total,
        out: 0,
        kind: "visita" as const,
      })),
      ...ingresos.map((e) => ({ at: e.createdAt, time: fmtTime(e.createdAt), who: e.concept, what: "Ingreso extra", detail: e.createdByName, inn: e.amount, out: 0, kind: "ingreso" as const, ref: e })),
      ...egresos.map((e) => ({ at: e.createdAt, time: fmtTime(e.createdAt), who: e.concept, what: "Egreso", detail: e.createdByName, inn: 0, out: e.amount, kind: "egreso" as const, ref: e })),
      ...payouts.map((p) => ({ at: p.createdAt, time: fmtTime(p.createdAt), who: short(p.providerName), what: "Pago a profesional", detail: p.createdByName, inn: 0, out: p.amount, kind: "pago" as const, ref: p })),
    ];
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }, [rows, ingresos, egresos, payouts]);

  async function payAll(providerId: string, name: string) {
    setBusy(providerId);
    const r = await call("/api/payouts", "POST", { providerId, date });
    setBusy(null);
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar el pago.");
    showToast(`Pagado a ${short(name)}: ${money((r.payout as Payout).amount)}.`);
    refreshPay();
  }
  async function voidPay(p: Payout) {
    const r = await call(`/api/payouts/${p.id}`, "DELETE");
    if (!r.ok) return showToast(r.error ?? "No se pudo anular.");
    showToast("Pago anulado.");
    refreshPay();
  }

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
            <Big label="Entró" value={money(entro)} sub={`${pacientes} ${pacientes === 1 ? "paciente" : "pacientes"}${inTotal ? ` + ${money(inTotal)} extras` : ""}`} />
            <Big label="Salió" value={money(salio)} sub={`egresos ${money(egTotal)} · profesionales ${money(paidOut)}`} border />
            <Big
              label="Efectivo que debería haber"
              value={fmtSigned(esperado)}
              sub={opening === null ? "falta el cambio al iniciar" : contado === null ? "falta contar la caja" : diffText(contado - esperado)}
              border
            />
          </div>

          {/* Profesionales: su parte, lo pagado y lo que se les debe */}
          <Card title="Profesionales" action={owedTotal > 0 ? <span className="text-[13px] text-neutral-400">Se les debe {money(owedTotal)}</span> : null}>
            {!balances.length ? (
              <p className="px-4 pb-3 text-neutral-500">No hay nada anotado con profesionales este día.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse tabular-nums">
                  <thead>
                    <tr className="text-left text-[12px] text-neutral-500">
                      <th className="px-4 pb-2 font-normal" />
                      <th className="px-3 pb-2 text-right font-normal">Pacientes</th>
                      <th className="px-3 pb-2 text-right font-normal">Cobrado</th>
                      <th className="px-3 pb-2 text-right font-normal">Se lleva</th>
                      <th className="px-3 pb-2 text-right font-normal">Pagado</th>
                      <th className="px-3 pb-2 text-right font-normal">Debe</th>
                      <th className="cl-no-print w-[1%] px-4 pb-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {balances.map((b) => {
                      const mine = rows.filter((r) => r.providerId === b.providerId);
                      return (
                        <tr key={b.providerId} className="border-t border-neutral-900">
                          <td className="px-4 py-2">{short(b.name)}</td>
                          <td className="px-3 py-2 text-right text-neutral-300">{mine.filter((r) => r.patient).length}</td>
                          <td className="px-3 py-2 text-right">{money(mine.reduce((n, r) => n + r.total, 0))}</td>
                          <td className="px-3 py-2 text-right">{money(b.share)}</td>
                          <td className="px-3 py-2 text-right text-neutral-300">{b.paid ? money(b.paid) : "—"}</td>
                          <td className={`px-3 py-2 text-right ${b.owed ? "font-medium" : "text-neutral-500"}`}>{b.owed ? money(b.owed) : "—"}</td>
                          <td className="cl-no-print whitespace-nowrap px-4 py-1.5 text-right">
                            {b.owed > 0 && canEdit ? (
                              <button
                                onClick={() => payAll(b.providerId, b.name)}
                                disabled={busy === b.providerId}
                                className="rounded-md border border-neutral-800 px-2.5 py-1 text-[12.5px] text-neutral-200 hover:bg-accent-900 disabled:opacity-40"
                              >
                                {busy === b.providerId ? "…" : "Pagar todo"}
                              </button>
                            ) : b.share > 0 && b.owed === 0 ? (
                              <span className="inline-flex items-center gap-1 text-[12.5px] text-neutral-400">
                                <CheckIcon size={12} weight="bold" /> pagado
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-neutral-800 font-medium">
                      <td className="px-4 py-2.5">Total</td>
                      <td className="px-3 py-2.5 text-right">{pacientes}</td>
                      <td className="px-3 py-2.5 text-right">{money(cobrado)}</td>
                      <td className="px-3 py-2.5 text-right">{money(kTotal)}</td>
                      <td className="px-3 py-2.5 text-right">{money(paidOut)}</td>
                      <td className="px-3 py-2.5 text-right">{money(owedTotal)}</td>
                      <td className="cl-no-print" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            <p className="px-4 pb-3 pt-1 text-[12.5px] text-neutral-500">
              «Pagar todo» anota que se le dio su parte en efectivo (sale de la caja). También se puede escribir en Anotar: «le pagué todo a Carmen» o «le pagué 18000 a Carmen».
            </p>
          </Card>

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
                            {m.kind === "pago" && canEdit && (
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
                <Line label="+ Efectivo cobrado" value={money(efectivo)} />
                <Line label="+ Ingresos extras" value={money(inTotal)} />
                <Line label="− Egresos" value={money(egTotal)} />
                <Line label="− Pagado a profesionales" value={money(paidOut)} />
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
              </div>
            </Card>
            <Card title="Cómo pagaron">
              <div className="flex flex-col px-4 pb-3">
                <Line label="Efectivo" value={money(efectivo)} />
                <Line label="Transferencias" value={money(byMethod("transferencia"))} />
                <Line label="Tarjetas" value={money(byMethod("tarjeta"))} />
                {byMethod(null) > 0 && <Line label="Sin medio cargado" value={money(byMethod(null))} muted />}
                <Line label="Total cobrado" value={money(cobrado)} strong />
                <Line label="Para Decles (cobrado − profesionales)" value={fmtSigned(cobrado - kTotal)} />
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
