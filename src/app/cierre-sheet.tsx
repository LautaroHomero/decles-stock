"use client";

import { useMemo, useState } from "react";
import { CaretLeftIcon, CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { ExpenseForm, type Expense, type ExpensesResponse } from "./egresos";
import { AREAS, fmtSigned, toRows, type Area, type Row } from "./planilla-view";
import { Toast, call, money, usePoll, useToast, useToday, type Payment, type SaleRow } from "./shared";

/**
 * Cierre del día (secretaría y admin), con lo mismo que la planilla en papel pero ordenado:
 * los tres números del día, cada profesional (pacientes, cobrado, su parte, Decles), ingresos y egresos
 * extras, la caja (lo que debería haber contra lo contado al cambio) y los medios de pago.
 */

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

export function CierreSheet({ actor }: { actor: Actor }) {
  const today = useToday();
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked ?? today;
  const setDate = (d: string) => setPicked(d === today ? null : d);
  const canEdit = !!actor.activeOrg?.canAdmin || date === today;

  const [sales] = usePoll<{ ok: boolean; sales: SaleRow[] }>(`/api/sales?from=${date}&to=${date}&limit=500`, 30_000);
  const [sellersData] = usePoll<{ ok: boolean; sellers: { providerId: string; name: string; area: Area }[] }>("/api/sellers", 60_000);
  const [egr, refreshEgr] = usePoll<ExpensesResponse>(`/api/expenses?from=${date}&to=${date}`, 30_000);
  const [ing, refreshIng] = usePoll<ExpensesResponse>(`/api/expenses?from=${date}&to=${date}&direction=ingreso`, 30_000);
  const [cash, refreshCash] = usePoll<{ ok: boolean; cash: { opening: number | null; amount: number | null } }>(`/api/day-cash?date=${date}`, 60_000);
  const [toast, showToast] = useToast();
  const [form, setForm] = useState<{ direction: "egreso" | "ingreso"; expense?: Expense } | null>(null);

  const rows = useMemo(() => toRows(sales?.ok ? sales.sales : []), [sales]);
  const sellers = sellersData?.sellers ?? [];
  const areaOf = (id: string | null): Area => sellers.find((s) => s.providerId === id)?.area ?? "medicos";
  const nameOf = (id: string | null, r?: Row) => sellers.find((s) => s.providerId === id)?.name ?? r?.sales[0].providerName ?? "Sin profesional";

  const egresos = egr?.ok ? egr.expenses : [];
  const ingresos = ing?.ok ? ing.expenses : [];
  const egTotal = egresos.reduce((n, e) => n + e.amount, 0);
  const inTotal = ingresos.reduce((n, e) => n + e.amount, 0);
  const cobrado = rows.reduce((n, r) => n + r.total, 0);
  const kTotal = rows.reduce((n, r) => n + r.k, 0);
  const byMethod = (m: Payment | null) => rows.filter((r) => r.method === m).reduce((n, r) => n + r.total, 0);
  const efectivo = byMethod("efectivo");
  const opening = cash?.ok ? cash.cash.opening : null;
  const esperado = (opening ?? 0) + efectivo + inTotal - egTotal;
  const contado = cash?.ok ? cash.cash.amount : null;
  const decles = cobrado - kTotal + inTotal - egTotal;

  const areas = AREAS.map((a) => {
    const rs = rows.filter((r) => areaOf(r.providerId) === a.id);
    const ids = [...new Set(rs.map((r) => r.providerId))];
    return {
      ...a,
      pros: ids.map((id) => {
        const mine = rs.filter((r) => r.providerId === id);
        return { id, name: nameOf(id, mine[0]), ...sum(mine) };
      }),
      total: sum(rs),
    };
  }).filter((a) => a.pros.length);

  const loading = !sales || !sellersData;

  return (
    <div className="cl-print-area mx-auto flex w-full max-w-[860px] flex-col gap-8 px-5 pb-20 pt-8 text-[14px] sm:px-6 sm:pt-12">
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

      {/* Encabezado */}
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
          {/* Los tres números del día */}
          <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-neutral-800 sm:grid-cols-3">
            <Big label="Cobrado" value={money(cobrado)} sub={`${rows.filter((r) => r.patient).length} pacientes`} />
            <Big label="Queda para Decles" value={fmtSigned(decles)} sub="cobrado − profesionales ± extras" border />
            <Big label="Efectivo que debería haber" value={fmtSigned(esperado)} sub={opening === null ? "falta el cambio al iniciar" : contado === null ? "falta contar la caja" : diffText(contado - esperado)} border />
          </div>

          {/* Por profesional */}
          <Card title="Por profesional">
            {!areas.length ? (
              <p className="px-4 py-3 text-neutral-500">No se anotó nada este día.</p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-[12px] text-neutral-500">
                    <th className="px-4 pb-2 pt-1 font-normal" />
                    <th className="px-3 pb-2 pt-1 text-right font-normal">Pacientes</th>
                    <th className="px-3 pb-2 pt-1 text-right font-normal">Cobrado</th>
                    <th className="px-3 pb-2 pt-1 text-right font-normal">Profesional</th>
                    <th className="px-4 pb-2 pt-1 text-right font-normal">Decles</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {areas.map((a) => (
                    <AreaRows key={a.id} title={areas.length > 1 ? a.title : null} pros={a.pros} total={a.pros.length > 1 ? a.total : null} />
                  ))}
                </tbody>
                <tfoot className="tabular-nums">
                  <tr className="border-t border-neutral-800 font-medium">
                    <td className="px-4 py-2.5">Total</td>
                    <td className="px-3 py-2.5 text-right">{rows.filter((r) => r.patient).length}</td>
                    <td className="px-3 py-2.5 text-right">{money(cobrado)}</td>
                    <td className="px-3 py-2.5 text-right">{money(kTotal)}</td>
                    <td className="px-4 py-2.5 text-right">{fmtSigned(cobrado - kTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </Card>

          {/* Extras */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ExtraList title="Ingresos extras" list={ingresos} total={inTotal} canEdit={canEdit} onAdd={() => setForm({ direction: "ingreso" })} onOpen={(e) => setForm({ direction: "ingreso", expense: e })} />
            <ExtraList title="Egresos extras" list={egresos} total={egTotal} canEdit={canEdit} onAdd={() => setForm({ direction: "egreso" })} onOpen={(e) => setForm({ direction: "egreso", expense: e })} negative />
          </div>

          {/* Caja y medios de pago */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card title="Caja">
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
                <Line label="− Egresos extras" value={money(egTotal)} />
                <Line label="Debería haber" value={fmtSigned(esperado)} strong />
                <CashInput
                  key={`${date}:${contado ?? ""}`}
                  label="Contado al cambio"
                  amount={contado}
                  canEdit={canEdit}
                  onSave={async (amount) => {
                    const r = await call("/api/day-cash", "PUT", { date, amount });
                    if (!r.ok) return showToast(r.error ?? "No se pudo guardar.");
                    refreshCash();
                  }}
                />
                {contado !== null && <Line label="Diferencia" value={diffText(contado - esperado)} />}
              </div>
            </Card>
            <Card title="Medios de pago">
              <div className="flex flex-col px-4 pb-3">
                <Line label="Efectivo" value={money(efectivo)} />
                <Line label="Transferencias" value={money(byMethod("transferencia"))} />
                <Line label="Tarjetas" value={money(byMethod("tarjeta"))} />
                {byMethod(null) > 0 && <Line label="Sin medio cargado" value={money(byMethod(null))} muted />}
                <Line label="Total cobrado" value={money(cobrado)} strong />
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function sum(list: Row[]) {
  return {
    pac: list.filter((r) => r.patient).length,
    total: list.reduce((n, r) => n + r.total, 0),
    k: list.reduce((n, r) => n + r.k, 0),
  };
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
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <h2 className="text-[14px] font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function AreaRows({ title, pros, total }: { title: string | null; pros: { id: string | null; name: string; pac: number; total: number; k: number }[]; total: { pac: number; total: number; k: number } | null }) {
  return (
    <>
      {title && (
        <tr>
          <td colSpan={5} className="px-4 pb-1 pt-3 text-[12px] text-neutral-500">
            {title}
          </td>
        </tr>
      )}
      {pros.map((p) => (
        <tr key={p.id ?? "-"} className="border-t border-neutral-900">
          <td className="px-4 py-2">{p.name}</td>
          <td className="px-3 py-2 text-right text-neutral-300">{p.pac}</td>
          <td className="px-3 py-2 text-right">{money(p.total)}</td>
          <td className="px-3 py-2 text-right text-neutral-300">{p.k ? money(p.k) : "—"}</td>
          <td className="px-4 py-2 text-right">{fmtSigned(p.total - p.k)}</td>
        </tr>
      ))}
      {total && title && (
        <tr className="border-t border-neutral-900 text-neutral-400">
          <td className="px-4 py-2">Subtotal {title.toLowerCase()}</td>
          <td className="px-3 py-2 text-right">{total.pac}</td>
          <td className="px-3 py-2 text-right">{money(total.total)}</td>
          <td className="px-3 py-2 text-right">{money(total.k)}</td>
          <td className="px-4 py-2 text-right">{fmtSigned(total.total - total.k)}</td>
        </tr>
      )}
    </>
  );
}

function ExtraList({
  title,
  list,
  total,
  canEdit,
  onAdd,
  onOpen,
  negative,
}: {
  title: string;
  list: Expense[];
  total: number;
  canEdit: boolean;
  onAdd: () => void;
  onOpen: (e: Expense) => void;
  negative?: boolean;
}) {
  return (
    <Card
      title={title}
      action={
        canEdit && (
          <button onClick={onAdd} className="cl-no-print inline-flex items-center gap-1 text-[13px] text-neutral-400 hover:text-fg">
            <PlusIcon size={12} weight="bold" /> Agregar
          </button>
        )
      }
    >
      <div className="flex flex-1 flex-col px-4 pb-3">
        {list.map((e) => (
          <button
            key={e.id}
            disabled={!canEdit}
            onClick={() => onOpen(e)}
            className="-mx-2 flex items-baseline justify-between gap-4 rounded-md border-t border-neutral-900 px-2 py-2 text-left enabled:hover:bg-neutral-900"
          >
            <span className="truncate">{e.concept}</span>
            <span className="whitespace-nowrap tabular-nums text-neutral-300">{money(e.amount)}</span>
          </button>
        ))}
        {!list.length && <p className="border-t border-neutral-900 py-2 text-neutral-600">Nada anotado.</p>}
        <span className="flex-1" />
        <Line label="Total" value={negative && total ? `− ${money(total)}` : money(total)} strong />
      </div>
    </Card>
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
