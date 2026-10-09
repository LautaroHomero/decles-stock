"use client";

import { useState } from "react";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { money, usePoll, useToday } from "./shared";

interface CloseCount {
  name: string;
  quantity: number;
}
interface CloseProvider {
  providerId: string | null;
  name: string;
  patients: number;
  practices: CloseCount[];
  products: CloseCount[];
  total: number;
}
interface DayClose {
  date: string;
  patients: number;
  practices: number;
  productSales: number;
  total: number;
  byPayment: { efectivo: number; transferencia: number; tarjeta: number; pending: number; pendingCard: number };
  providers: CloseProvider[];
  expenses: { id: string; concept: string; amount: number; createdByName: string }[];
  expensesTotal: number;
  incomesTotal: number;
  net: number;
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
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const counts = (list: CloseCount[]) => list.map((c) => `${c.name} ${c.quantity}`).join(" · ");

/** Cierre del día (diseño «Cierre del día»): pacientes, prácticas, lo cobrado y el detalle por médica. Se imprime. */
export function CierreView({ onOpenSales }: { onOpenSales: () => void }) {
  const today = useToday();
  // null = «hoy»: a la medianoche pasa solo al día nuevo. Una fecha elegida a mano se respeta.
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked ?? today;
  const setDate = (d: string) => setPicked(d === today ? null : d);
  const [data] = usePoll<{ ok: boolean; close: DayClose; error?: string }>(`/api/day-close?date=${date}`, 60_000);
  const c = data?.ok && data.close.date === date ? data.close : null;
  const pay = c?.byPayment;

  return (
    <div className="cl-print-area mx-auto flex w-full max-w-[720px] flex-col gap-6 px-5 pb-20 pt-6 text-[14px] leading-[1.45] sm:px-6 sm:pt-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1.5 text-[14px] text-neutral-400">{longDate(date)}</p>
          <h1 className="font-display text-[22px] font-medium leading-[1.15] tracking-[-.02em] sm:text-[22px]">Cierre del día</h1>
        </div>
        <div className="cl-no-print flex items-center gap-1">
          <button onClick={() => setDate(shift(date, -1))} aria-label="Día anterior" className={NAV}>
            <CaretLeftIcon size={20} weight="bold" />
          </button>
          {date !== today && (
            <button onClick={() => setDate(today)} className="min-h-10 rounded-xl px-3 text-[14px] font-medium hover:bg-neutral-900">
              Hoy
            </button>
          )}
          <button onClick={() => setDate(shift(date, 1))} disabled={date >= today} aria-label="Día siguiente" className={NAV}>
            <CaretRightIcon size={20} weight="bold" />
          </button>
        </div>
      </div>

      {!c ? (
        <p className="text-neutral-500">{data && !data.ok ? data.error : "Cargando…"}</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <Stat big={String(c.patients)} label={c.patients === 1 ? "paciente" : "pacientes"} />
            <Stat big={String(c.practices)} label={c.practices === 1 ? "práctica" : "prácticas"} />
            <Stat big={money(c.total)} label={`cobrado${c.productSales ? ` · ${plural(c.productSales, "venta", "ventas")}` : ""}`} small />
          </div>

          {pay && c.total > 0 && (
            <p className="-mt-3 text-[14px] text-neutral-400">
              {[
                pay.efectivo ? `Efectivo ${money(pay.efectivo)}` : null,
                pay.transferencia ? `Transferencia ${money(pay.transferencia)}` : null,
                pay.tarjeta ? `Tarjeta ${money(pay.tarjeta)}` : null,
                pay.pending
                  ? `Sin medio cargado ${money(pay.pending)}${pay.pendingCard !== pay.pending ? ` (${money(pay.pendingCard)} si fue con tarjeta)` : ""}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}

          {(c.expenses.length > 0 || c.incomesTotal > 0) && (
            <section className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-[16px] font-medium">Egresos</h2>
                <span className="tabular-nums text-neutral-300">− {money(c.expensesTotal)}</span>
              </div>
              <ul className="flex flex-col">
                {c.expenses.map((e) => (
                  <li key={e.id} className="flex justify-between gap-3 border-b border-neutral-900 py-2 text-[14px] last:border-0">
                    <span>
                      {e.concept} <span className="text-neutral-500">· {e.createdByName}</span>
                    </span>
                    <span className="whitespace-nowrap tabular-nums text-neutral-300">− {money(e.amount)}</span>
                  </li>
                ))}
              </ul>
              <p className="flex justify-between gap-3 border-t border-neutral-800 pt-2 text-[15px] font-medium">
                <span>Queda (cobrado{c.incomesTotal ? ` + ingresos extras ${money(c.incomesTotal)}` : ""} − egresos)</span>
                <span className="tabular-nums">{money(c.net)}</span>
              </p>
            </section>
          )}

          <section className="flex flex-col gap-3">
            <h2 className="text-[16px] font-medium">Por médica</h2>
            {c.providers.map((p) => (
              <div key={p.providerId ?? "-"} className="flex flex-col gap-2.5 rounded-xl border border-neutral-800 p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[15px] font-medium sm:text-[15px]">{p.name}</span>
                  <span className="whitespace-nowrap text-[14px] font-medium sm:text-[15px]">{plural(p.patients, "paciente", "pacientes")}</span>
                </div>
                {p.practices.length > 0 && <p className="text-[14px] text-neutral-300 sm:text-[14px]">{counts(p.practices)}</p>}
                {p.products.length > 0 && <p className="text-[14px] text-neutral-300 sm:text-[14px]">Vendió: {counts(p.products)}</p>}
                <p className="text-[14px] tabular-nums text-neutral-400">{money(p.total)}</p>
              </div>
            ))}
            {!c.providers.length && <p className="text-neutral-500">No se anotó nada este día.</p>}
          </section>

          <div className="cl-no-print flex flex-wrap gap-3">
            <button onClick={() => window.print()} className={`${BIG} bg-accent text-on-accent hover:opacity-85`}>
              Imprimir
            </button>
            <button onClick={onOpenSales} className={`${BIG} border border-neutral-800 font-medium hover:bg-neutral-900`}>
              Ver la lista completa
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ big, label, small }: { big: string; label: string; small?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface p-3.5 sm:p-5">
      <div className={`font-display font-medium tabular-nums ${small ? "truncate text-[15px] leading-[1.6] sm:text-[19px]" : "text-[22px] leading-tight"}`}>{big}</div>
      <div className="truncate text-[12.5px] text-neutral-400 sm:text-[13.5px]">{label}</div>
    </div>
  );
}

const NAV = "flex h-9 w-9 items-center justify-center rounded-xl hover:bg-neutral-900 disabled:opacity-30";
const BIG = "flex min-h-11 flex-[1_1_240px] items-center justify-center rounded-xl px-6 text-[14px] font-medium transition-[filter,background]";
