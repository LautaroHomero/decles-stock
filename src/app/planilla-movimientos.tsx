"use client";

import { useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { ExpenseForm, type Expense, type ExpensesResponse } from "./egresos";
import type { DebtCollectionRow, DebtRow } from "./deudas";
import { remindLabel } from "./debt-reminder";
import { AbonoForm, AbonosCard } from "./abonos";
import { PayablesCard } from "./deudas-consultorio";
import { SenaForm, SenasCard } from "./senas";
import { fmtSigned, type Row } from "./planilla-view";
import { call, fmtTime, methodTotals, money, outsideOf, usdFmt, usePoll, type PaymentsMap, type SaleRow } from "./shared";

/**
 * Planilla → Día, debajo de los pacientes: todo lo demás que pasó con la plata ese día, como en la hoja de papel.
 *  · Otros ingresos: ingresos extras y cobros de deudas.
 *  · Egresos: gastos y pagos a profesionales.
 *  · Quedaron debiendo: lo que se anotó como deuda ese día.
 *  · Resumen: entró, salió, queda y cómo pagaron.
 */

interface Payout {
  id: string;
  /** 'cobro' = la profesional nos dio lo nuestro (le habían pagado directo). */
  direction?: "pago" | "cobro";
  providerName: string;
  amount: number;
  method?: "efectivo" | "transferencia";
  debtId?: string | null;
  debtDate?: string | null;
  createdByName: string;
  createdAt: string;
}

const METHOD = { efectivo: "Efectivo", transferencia: "Transf.", tarjeta: "Tarjeta" } as const;
const short = (name: string) => name.replace(/^(Dra?\.|Lic\.)\s*/i, "");

export function PlanillaMovimientos({
  date,
  canEdit,
  rows,
  sales,
  payments,
  onError,
  onAbonosChange,
}: {
  date: string;
  canEdit: boolean;
  rows: Row[];
  sales: SaleRow[];
  payments?: PaymentsMap;
  onError: (m: string) => void;
  onAbonosChange?: () => void;
}) {
  const [abonoForm, setAbonoForm] = useState(false);
  const [senaForm, setSenaForm] = useState(false);
  const [abonosKey, setAbonosKey] = useState(0);
  const [egr, refreshEgr] = usePoll<ExpensesResponse>(`/api/expenses?from=${date}&to=${date}`, 30_000);
  const [ing, refreshIng] = usePoll<ExpensesResponse>(`/api/expenses?from=${date}&to=${date}&direction=ingreso`, 30_000);
  const [pay, refreshPay] = usePoll<{ ok: boolean; payouts: Payout[] }>(`/api/payouts?date=${date}`, 30_000);
  const [dd, refreshDd] = usePoll<{ ok: boolean; collections: DebtCollectionRow[]; created: DebtRow[] }>(`/api/debts/day?date=${date}`, 30_000);
  const [form, setForm] = useState<{ direction: "egreso" | "ingreso"; expense?: Expense } | null>(null);

  const egresos = egr?.ok ? egr.expenses : [];
  const ingresos = ing?.ok ? ing.expenses : [];
  const allPayouts = pay?.ok ? pay.payouts : [];
  const payouts = allPayouts.filter((p) => p.direction !== "cobro");
  const cobros = allPayouts.filter((p) => p.direction === "cobro");
  const collections = dd?.ok ? dd.collections : [];
  const created = dd?.ok ? dd.created : [];

  // Lo que le pagaron directo a la profesional (o con gift card) no entró hoy.
  const directo = rows.reduce((n, r) => n + outsideOf(r).profesional, 0);
  const pacientes = rows.reduce((n, r) => n + r.total - outsideOf(r).profesional - outsideOf(r).giftcard, 0);
  const deProfesionales = cobros.reduce((n, p) => n + p.amount, 0);
  const extras = ingresos.reduce((n, e) => n + e.amount, 0);
  const cobrosDeuda = collections.reduce((n, p) => n + p.amount, 0);
  const gastos = egresos.reduce((n, e) => n + e.amount, 0);
  const aProfesionales = payouts.reduce((n, p) => n + p.amount, 0);
  const entro = pacientes + extras + cobrosDeuda + deProfesionales;
  const salio = gastos + aProfesionales;
  // Medios: lo de los pacientes (por partes si fue con varios medios) + los cobros de deudas.
  const mt = methodTotals(sales, payments);
  const deudaPor = (m: "efectivo" | "transferencia" | "tarjeta") => collections.filter((p) => (p.method ?? "efectivo") === m).reduce((n, p) => n + p.amount, 0);
  // Ingresos extras (señas, abonos, otros) también entraron por algún medio.
  const extraPor = (m: "efectivo" | "transferencia" | "tarjeta") => ingresos.filter((e) => (e.method ?? "efectivo") === m).reduce((n, e) => n + e.amount, 0);
  const cobroPor = (m: "efectivo" | "transferencia" | "tarjeta") => cobros.filter((p) => (p.method ?? "efectivo") === m).reduce((n, p) => n + p.amount, 0);
  const porMedio = (m: "efectivo" | "transferencia" | "tarjeta") => mt[m] + deudaPor(m) + extraPor(m) + cobroPor(m);

  async function voidPayout(p: Payout) {
    const r = await call(`/api/payouts/${p.id}`, "DELETE");
    if (!r.ok) return onError(r.error ?? "No se pudo anular.");
    refreshPay();
  }
  async function voidCollection(p: DebtCollectionRow) {
    const r = await call(`/api/debts/payments/${p.id}`, "DELETE");
    if (!r.ok) return onError(r.error ?? "No se pudo deshacer.");
    refreshDd();
    refreshPay();
  }

  type Line = { key: string; time: string; who: string; what: string; amount: number; onClick?: () => void; undo?: () => void };
  const inLines: Line[] = [
    ...ingresos.map((e) => ({
      key: e.id,
      time: fmtTime(e.createdAt),
      who: /^(Abono|Seña) · /.test(e.concept) ? e.concept.replace(/^(Abono|Seña) · /, "") : e.concept,
      what: `${e.concept.startsWith("Abono · ") ? "Abono" : e.concept.startsWith("Seña · ") ? "Seña" : "Ingreso extra"} · ${METHOD[e.method ?? "efectivo"]} · ${e.createdByName}`,
      amount: e.amount,
      onClick: canEdit ? () => setForm({ direction: "ingreso", expense: e }) : undefined,
    })),
    ...collections.map((p) => ({
      key: p.id,
      time: fmtTime(p.createdAt),
      who: p.debtor,
      what: ["Cobro de deuda", p.concept, p.providerName && short(p.providerName), METHOD[p.method ?? "efectivo"]].filter(Boolean).join(" · "),
      amount: p.amount,
      undo: canEdit ? () => voidCollection(p) : undefined,
    })),
    ...cobros.map((p) => ({
      key: p.id,
      time: fmtTime(p.createdAt),
      who: short(p.providerName),
      what: `${p.debtId ? "Nos pagó lo que debía" : "Nos dio lo nuestro (le pagaron directo)"} · ${METHOD[p.method ?? "efectivo"]} · ${p.createdByName}`,
      amount: p.amount,
      undo: canEdit ? () => voidPayout(p) : undefined,
    })),
  ].sort((a, b) => a.time.localeCompare(b.time));
  const outLines: Line[] = [
    ...egresos.map((e) => ({
      key: e.id,
      time: fmtTime(e.createdAt),
      who: e.concept,
      what: `Egreso · ${METHOD[e.method ?? "efectivo"]} · ${e.createdByName}`,
      amount: e.amount,
      onClick: canEdit ? () => setForm({ direction: "egreso", expense: e }) : undefined,
    })),
    ...payouts.map((p) => ({
      key: p.id,
      time: fmtTime(p.createdAt),
      who: short(p.providerName),
      what: `${p.debtId ? `Pago de lo que se le debía${p.debtDate ? ` (del ${p.debtDate.slice(8, 10)}/${p.debtDate.slice(5, 7)})` : ""}` : "Pago a profesional"} · ${METHOD[p.method ?? "efectivo"]} · ${p.createdByName}`,
      amount: p.amount,
      undo: canEdit ? () => voidPayout(p) : undefined,
    })),
  ].sort((a, b) => a.time.localeCompare(b.time));

  const loading = !egr || !ing || !pay || !dd;

  return (
    <div className="flex flex-col gap-6">
      {form && (
        <ExpenseForm
          direction={form.direction}
          expense={form.expense}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            refreshEgr();
            refreshIng();
          }}
        />
      )}

      {senaForm && (
        <SenaForm
          onClose={() => setSenaForm(false)}
          onSaved={() => {
            setSenaForm(false);
            refreshIng();
            setAbonosKey((k) => k + 1);
            onAbonosChange?.();
          }}
        />
      )}
      {abonoForm && (
        <AbonoForm
          onClose={() => setAbonoForm(false)}
          onSaved={() => {
            setAbonoForm(false);
            refreshIng();
            setAbonosKey((k) => k + 1);
            onAbonosChange?.();
          }}
        />
      )}
      <Block
        title="Otros ingresos"
        total={extras + cobrosDeuda}
        empty="No hubo ingresos extras ni cobros de deudas."
        lines={inLines}
        loading={loading}
        action={
          canEdit && (
            <span className="flex gap-3">
              <button onClick={() => setSenaForm(true)} className={ADD}>
                <PlusIcon size={12} weight="bold" /> Seña
              </button>
              <button onClick={() => setAbonoForm(true)} className={ADD}>
                <PlusIcon size={12} weight="bold" /> Abono
              </button>
              <button onClick={() => setForm({ direction: "ingreso" })} className={ADD}>
                <PlusIcon size={12} weight="bold" /> Ingreso extra
              </button>
            </span>
          )
        }
      />
      <Block
        title="Egresos"
        total={salio}
        sign="−"
        empty="No salió plata este día."
        lines={outLines}
        loading={loading}
        action={
          canEdit && (
            <button onClick={() => setForm({ direction: "egreso" })} className={ADD}>
              <PlusIcon size={12} weight="bold" /> Egreso
            </button>
          )
        }
      />
      {created.length > 0 && (
        <Block
          title="Quedaron debiendo"
          total={created.reduce((n, d) => n + d.amount, 0)}
          note="No entra a la caja hasta que lo paguen. Se cobra en Anotar o en Cierre → Deudas."
          empty=""
          loading={false}
          lines={created.map((d) => ({
            key: d.id,
            time: fmtTime(d.createdAt),
            who: d.debtor,
            what: [
              d.concept,
              d.providerName && short(d.providerName),
              d.remaining ? (d.paid ? `ya pagó ${money(d.paid)}` : "") : "ya la pagó",
              d.remaining && d.remindOn ? `cobrar: ${remindLabel(d.remindOn)}` : "",
            ]
              .filter(Boolean)
              .join(" · "),
            amount: d.amount,
          }))}
        />
      )}

      {/* Lo que debe el consultorio (de todos los días) */}
      <PayablesCard canAnul={canEdit} showToast={onError} onChange={() => refreshEgr()} />

      {/* Señas sin usar (de todos los días) */}
      <SenasCard
        key={`s${abonosKey}`}
        canAdd={false}
        showToast={onError}
        onChange={() => {
          refreshIng();
          onAbonosChange?.();
        }}
      />

      {/* Abonos abiertos (de todos los días) */}
      <AbonosCard
        key={abonosKey}
        canAdd={false}
        showToast={onError}
        onChange={() => {
          refreshIng();
          onAbonosChange?.();
        }}
      />

      {/* Resumen del día */}
      <section className="flex flex-col gap-2">
        <h2 className="text-[14px] font-medium uppercase tracking-[.06em]">Resumen del día</h2>
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-neutral-800 p-4 sm:grid-cols-2">
          <div className="flex flex-col">
            <Sum label="Pacientes" value={money(pacientes)} />
            {extras > 0 && <Sum label="+ Ingresos extras" value={money(extras)} />}
            {cobrosDeuda > 0 && <Sum label="+ Cobros de deudas" value={money(cobrosDeuda)} />}
            {deProfesionales > 0 && <Sum label="+ Nos dieron profesionales" value={money(deProfesionales)} />}
            <Sum label="Entró" value={money(entro)} strong />
            {gastos > 0 && <Sum label="− Egresos" value={money(gastos)} />}
            {aProfesionales > 0 && <Sum label="− Pagado a profesionales" value={money(aProfesionales)} />}
            <Sum label="Salió" value={money(salio)} strong />
            <Sum label="Queda (entró − salió)" value={fmtSigned(entro - salio)} strong />
          </div>
          <div className="flex flex-col">
            <span className="pb-1 text-[12px] text-neutral-500">Cómo entró la plata</span>
            <Sum label="Efectivo" value={money(porMedio("efectivo"))} />
            <Sum label="Transferencias" value={money(porMedio("transferencia"))} />
            <Sum label="Tarjetas" value={money(porMedio("tarjeta"))} />
            {mt.usd > 0 && <Sum label={`Dólares · ${usdFmt(mt.usd)}`} value={money(mt.dolares)} />}
            {mt.sin > 0 && <Sum label="Sin medio cargado" value={money(mt.sin)} muted />}
            {directo > 0 && <Sum label="Le pagaron directo a profesionales (no entró)" value={money(directo)} muted />}
          </div>
        </div>
      </section>
    </div>
  );
}

const ADD = "cl-no-print inline-flex items-center gap-1 text-[13px] text-neutral-400 hover:text-fg";

function Block({
  title,
  total,
  sign,
  lines,
  empty,
  note,
  loading,
  action,
}: {
  title: string;
  total: number;
  sign?: string;
  lines: { key: string; time: string; who: string; what: string; amount: number; onClick?: () => void; undo?: () => void }[];
  empty: string;
  note?: string;
  loading: boolean;
  action?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-medium uppercase tracking-[.06em]">{title}</h2>
        {action}
      </div>
      {note && <p className="-mt-1 text-[12.5px] text-neutral-500">{note}</p>}
      <div className="overflow-x-auto rounded-xl border border-neutral-800">
        <table className="w-full min-w-[560px] border-collapse text-[13.5px]">
          <tbody>
            {loading ? (
              <tr>
                <td className="px-3 py-2.5 text-neutral-500">Cargando…</td>
              </tr>
            ) : !lines.length ? (
              <tr>
                <td className="px-3 py-2.5 text-neutral-500">{empty}</td>
              </tr>
            ) : (
              lines.map((l) => (
                <tr
                  key={l.key}
                  onClick={l.onClick}
                  className={`border-b border-neutral-900 align-top last:border-0 ${l.onClick ? "cursor-pointer hover:bg-neutral-900" : ""}`}
                >
                  <td className="w-[52px] px-3 py-2 tabular-nums text-neutral-500">{l.time}</td>
                  <td className="w-[26%] px-3 py-2 font-medium">{l.who}</td>
                  <td className="px-3 py-2 text-neutral-400">
                    {l.what}
                    {l.undo && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          l.undo!();
                        }}
                        className="cl-no-print ml-2 text-[12.5px] text-neutral-500 underline-offset-2 hover:text-fg hover:underline"
                      >
                        deshacer
                      </button>
                    )}
                  </td>
                  <td className="w-[14%] px-3 py-2 text-right tabular-nums">
                    {sign ? `${sign} ` : ""}
                    {money(l.amount)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {!loading && lines.length > 1 && (
            <tfoot>
              <tr className="border-t border-neutral-800 font-medium">
                <td colSpan={3} className="px-3 py-2">
                  Total
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {sign ? `${sign} ` : ""}
                  {money(total)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}

function Sum({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 border-b border-neutral-900 py-1.5 last:border-0 ${strong ? "font-medium" : ""} ${muted ? "text-neutral-500" : ""}`}>
      <span className={strong || muted ? "" : "text-neutral-300"}>{label}</span>
      <span className="whitespace-nowrap tabular-nums">{value}</span>
    </div>
  );
}
