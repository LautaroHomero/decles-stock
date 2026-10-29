"use client";

import { useMemo, useState } from "react";
import { fmtTime, money, usdFmt, type PaymentsMap, type SaleRow } from "./shared";

/**
 * Ventas → «Solo productos» (admin): qué productos se vendieron en el período, cuántos, por cuánto y cómo
 * se pagaron. Las anotaciones con varios medios o en dólares se reparten entre sus renglones en proporción
 * a lo que salió cada uno (el medio es de la anotación entera, no de cada renglón).
 */

type Key = "efectivo" | "transferencia" | "tarjeta" | "dolares" | "sin";
const COLS: [Key, string][] = [
  ["efectivo", "Efectivo"],
  ["transferencia", "Transf."],
  ["tarjeta", "Tarjeta"],
  ["dolares", "Dólares"],
  ["sin", "Sin cargar"],
];
const zero = (): Record<Key, number> => ({ efectivo: 0, transferencia: 0, tarjeta: 0, dolares: 0, sin: 0 });

/** Lo cobrado por un renglón. Sin medio cargado cuenta a precio efectivo. */
const amountOf = (s: SaleRow) => (s.paymentMethod ? s.total : s.cashTotal);

interface Line {
  sale: SaleRow;
  amount: number;
  /** Pesos por medio de este renglón. */
  by: Record<Key, number>;
  usd: number;
  methodText: string;
}

function linesOf(sales: SaleRow[], payments?: PaymentsMap): Line[] {
  const paid = sales.filter((s) => s.status === "paid");
  // Total de cada anotación, para repartir los pagos con varios medios.
  const visitTotal = new Map<string, number>();
  for (const s of paid) if (s.visitId) visitTotal.set(s.visitId, (visitTotal.get(s.visitId) ?? 0) + amountOf(s));
  return paid
    .filter((s) => s.kind === "producto")
    .map((s) => {
      const amount = amountOf(s);
      const by = zero();
      let usd = 0;
      const parts = s.visitId && (s.paymentMethod === "mixto" || s.paymentMethod === "dolares") ? (payments?.[s.visitId] ?? []) : [];
      if (parts.length) {
        const vt = visitTotal.get(s.visitId!) || 1;
        const share = amount / vt;
        for (const p of parts) {
          if (p.method in by) by[p.method as Key] += Math.round(p.amount * share);
          if (p.method === "dolares") usd += (p.usd ?? 0) * share;
        }
      } else if (s.paymentMethod === "efectivo" || s.paymentMethod === "transferencia" || s.paymentMethod === "tarjeta") by[s.paymentMethod] += amount;
      else by.sin += amount;
      const used = COLS.filter(([k]) => by[k] > 0);
      const methodText =
        used.length > 1
          ? used.map(([k, l]) => `${l} ${money(by[k])}`).join(" + ")
          : used[0]?.[0] === "dolares"
            ? `Dólares ${usdFmt(Math.round(usd * 100) / 100)}`
            : (used[0]?.[1] ?? "Sin cargar");
      return { sale: s, amount, by, usd, methodText };
    })
    .sort((a, b) => b.sale.createdAt.localeCompare(a.sale.createdAt));
}

export function ProductosVendidos({ sales, payments, multiDay }: { sales: SaleRow[]; payments?: PaymentsMap; multiDay: boolean }) {
  const [method, setMethod] = useState<Key | null>(null);
  const all = useMemo(() => linesOf(sales, payments), [sales, payments]);
  // Filtro por medio: los renglones que tienen algo pagado con ese medio.
  const lines = method ? all.filter((l) => l.by[method] > 0) : all;

  const totals = useMemo(() => {
    const t = zero();
    let usd = 0;
    for (const l of all) {
      for (const [k] of COLS) t[k] += l.by[k];
      usd += l.usd;
    }
    return { by: t, usd, total: all.reduce((n, l) => n + l.amount, 0), units: all.reduce((n, l) => n + l.sale.quantity, 0) };
  }, [all]);

  // Por producto: unidades, total y por medio (con el filtro aplicado).
  const products = useMemo(() => {
    const m = new Map<string, { name: string; units: number; total: number; by: Record<Key, number> }>();
    for (const l of lines) {
      const k = l.sale.itemId ?? l.sale.itemName;
      const cur = m.get(k) ?? { name: l.sale.itemName, units: 0, total: 0, by: zero() };
      cur.units += l.sale.quantity;
      cur.total += method ? l.by[method] : l.amount;
      for (const [c] of COLS) cur.by[c] += l.by[c];
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [lines, method]);
  const shownCols = COLS.filter(([k]) => totals.by[k] > 0);

  if (!all.length) return <p className="rounded-xl bg-surface p-6 text-[14px] text-neutral-400">No se vendieron productos en este período.</p>;

  return (
    <div className="flex flex-col gap-6">
      {/* Resumen: total, unidades y por medio (tocar un medio filtra) */}
      <section className="flex flex-col gap-5 rounded-xl bg-surface p-6">
        <div className="flex flex-col gap-1">
          <span className="text-[14px] text-neutral-400">Productos vendidos</span>
          <span className="font-display text-[22px] font-medium leading-none tracking-[-.02em] tabular-nums sm:text-[24px]">{money(totals.total)}</span>
          <span className="text-[14px] text-neutral-300">
            {totals.units} {totals.units === 1 ? "unidad" : "unidades"} de {new Set(all.map((l) => l.sale.itemName)).size}{" "}
            {new Set(all.map((l) => l.sale.itemName)).size === 1 ? "producto" : "productos"}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-neutral-800 pt-5" role="group" aria-label="Filtrar por cómo se pagó">
          <button onClick={() => setMethod(null)} aria-pressed={!method} className={!method ? CHIP_ON : CHIP}>
            Todos
          </button>
          {shownCols.map(([k, label]) => (
            <button key={k} onClick={() => setMethod(method === k ? null : k)} aria-pressed={method === k} className={method === k ? CHIP_ON : CHIP}>
              {label} <span className="tabular-nums opacity-70">{money(totals.by[k])}</span>
              {k === "dolares" && totals.usd > 0 && <span className="opacity-70"> · {usdFmt(Math.round(totals.usd * 100) / 100)}</span>}
            </button>
          ))}
        </div>
      </section>

      {/* Por producto */}
      <section className="flex flex-col gap-3">
        <h2 className="text-[15px] font-medium">Por producto{method ? ` · ${COLS.find(([k]) => k === method)![1]}` : ""}</h2>
        <div className="overflow-x-auto rounded-xl border border-neutral-800">
          <table className="w-full min-w-[520px] border-collapse text-[13.5px] tabular-nums">
            <thead>
              <tr className="text-left text-[12px] text-neutral-500">
                <th className="px-4 py-2.5 font-normal">Producto</th>
                <th className="px-3 py-2.5 text-right font-normal">Unid.</th>
                {!method && shownCols.map(([k, l]) => <th key={k} className="px-3 py-2.5 text-right font-normal">{l}</th>)}
                <th className="px-4 py-2.5 text-right font-normal">Total</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.name} className="border-t border-neutral-900">
                  <td className="px-4 py-2.5 font-medium">{p.name}</td>
                  <td className="px-3 py-2.5 text-right text-neutral-300">{p.units}</td>
                  {!method &&
                    shownCols.map(([k]) => (
                      <td key={k} className="px-3 py-2.5 text-right text-neutral-300">
                        {p.by[k] ? money(p.by[k]) : "—"}
                      </td>
                    ))}
                  <td className="px-4 py-2.5 text-right font-medium">{money(p.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-neutral-800 font-medium">
                <td className="px-4 py-2.5">Total</td>
                <td className="px-3 py-2.5 text-right">{products.reduce((n, p) => n + p.units, 0)}</td>
                {!method && shownCols.map(([k]) => <td key={k} className="px-3 py-2.5 text-right">{money(totals.by[k])}</td>)}
                <td className="px-4 py-2.5 text-right">{money(products.reduce((n, p) => n + p.total, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* Cada venta */}
      <section className="flex flex-col gap-3">
        <h2 className="text-[15px] font-medium">Cada venta</h2>
        <div className="flex flex-col">
          {lines.map((l) => (
            <div key={l.sale.id} className="flex items-baseline gap-4 border-b border-neutral-900 px-1 py-2.5">
              <span className="w-[86px] shrink-0 tabular-nums text-neutral-500">
                {multiDay ? `${l.sale.createdAt.slice(8, 10)}/${l.sale.createdAt.slice(5, 7)} ` : ""}
                {fmtTime(l.sale.createdAt)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">
                  {l.sale.quantity > 1 && <span className="tabular-nums text-neutral-400">{l.sale.quantity} × </span>}
                  {l.sale.itemName}
                </span>
                <span className="block text-[12.5px] text-neutral-500">
                  {[l.sale.patientName, l.sale.providerName, l.methodText].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="whitespace-nowrap font-medium tabular-nums">{money(method ? l.by[method] : l.amount)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const CHIP = "rounded-pill border border-neutral-700 px-3 py-1.5 text-[13px] transition-colors hover:border-accent hover:bg-accent-900";
const CHIP_ON = "rounded-pill border border-accent bg-accent px-3 py-1.5 text-[13px] text-on-accent";
