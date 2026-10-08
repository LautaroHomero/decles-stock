"use client";

import { useState } from "react";
import type { Actor } from "@/lib/domain/types";
import { SECTION_TITLE } from "./ui";
import { BTN, BTN_DARK, FIELD, Toast, call, fmtDate, fmtTime, localToday, money, usePoll, useToast, type SaleRow } from "./shared";

interface CommissionRow {
  providerId: string | null;
  providerName: string;
  sales: number;
  units: number;
  total: number;
  commission: number;
}

type Period = "hoy" | "mes" | "mes-pasado" | "rango";

function range(p: Period, custom: { from: string; to: string }): { from: string; to: string } {
  const today = localToday();
  if (p === "hoy") return { from: today, to: today };
  if (p === "mes") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (p === "mes-pasado") {
    const d = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return { from: `${ym}-01`, to: `${ym}-${String(last.getDate()).padStart(2, "0")}` };
  }
  return custom;
}

/**
 * Ventas por período con la médica que vendió. El admin ve todo y la comisión de cada
 * médica; la médica ve sus ventas y su comisión; la secretaría, las ventas sin montos de comisión.
 */
export function VentasView({ actor }: { actor: Actor }) {
  const admin = !!actor.activeOrg?.canAdmin;
  const isMedico = actor.role === "medico";
  const seesCommission = admin || isMedico;
  const [period, setPeriod] = useState<Period>("hoy");
  const [custom, setCustom] = useState({ from: localToday(), to: localToday() });
  const { from, to } = range(period, custom);
  const [data, refresh] = usePoll<{ ok: boolean; sales: SaleRow[] }>(`/api/sales?from=${from}&to=${to}&limit=500`, 30_000);
  const [comm, refreshComm] = usePoll<{ ok: boolean; rows: CommissionRow[] }>(
    seesCommission ? `/api/commissions?from=${from}&to=${to}` : "/api/commissions?none=1",
    60_000,
  );
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [toast, showToast] = useToast();

  const paid = (data?.sales ?? []).filter((s) => s.status === "paid");
  const total = paid.reduce((n, s) => n + s.total, 0);
  const multiDay = from !== to;

  async function voidSale(id: string) {
    const r = await call(`/api/sales/${id}/void`, "POST", { reason });
    if (!r.ok) return showToast(r.error ?? "No se pudo anular.");
    showToast(`Venta anulada. Volvieron ${r.restoredUnits} unidades al stock.`);
    setVoiding(null);
    setReason("");
    refresh();
    refreshComm();
  }

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <Toast msg={toast} />
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-3">
          <div className="flex flex-col">
            <h1 className="font-display text-[22px] font-medium tracking-[-.01em]">Ventas</h1>
            <p className="text-[13px] text-neutral-400">{paid.length ? `${paid.length} ventas · ${money(total)}` : "Sin ventas en el período."}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              ["hoy", "Hoy"],
              ["mes", "Este mes"],
              ["mes-pasado", "Mes pasado"],
              ["rango", "Fechas…"],
            ] as [Period, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setPeriod(id)}
              className={`rounded-pill border px-3 py-1 text-[12.5px] transition-colors ${
                period === id ? "border-accent text-accent-300" : "border-neutral-800 text-neutral-400 hover:border-accent-700"
              }`}
            >
              {label}
            </button>
          ))}
          {period === "rango" && (
            <span className="flex items-center gap-2 text-[12.5px] text-neutral-400">
              <input type="date" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} className={`${FIELD} !w-auto`} />
              a
              <input type="date" value={custom.to} min={custom.from} max={localToday()} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} className={`${FIELD} !w-auto`} />
            </span>
          )}
        </div>
      </div>

      {seesCommission && comm?.rows && comm.rows.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className={SECTION_TITLE}>{admin ? "Comisiones por médica" : "Tu comisión"}</h2>
          <div className="overflow-x-auto rounded-xl bg-surface px-4 shadow-sm">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[.06em] text-neutral-500">
                  <th className="py-2.5 font-normal">Médica</th>
                  <th className="py-2.5 text-right font-normal">Ventas</th>
                  <th className="py-2.5 text-right font-normal">Vendido</th>
                  <th className="py-2.5 text-right font-normal">Comisión</th>
                </tr>
              </thead>
              <tbody>
                {comm.rows.map((r) => (
                  <tr key={r.providerId ?? "none"} className="border-t border-neutral-900">
                    <td className="py-2.5">{r.providerName}</td>
                    <td className="py-2.5 text-right tabular-nums text-neutral-400">{r.sales}</td>
                    <td className="py-2.5 text-right tabular-nums">{money(r.total)}</td>
                    <td className="py-2.5 text-right font-medium tabular-nums">{money(r.commission)}</td>
                  </tr>
                ))}
                {admin && comm.rows.length > 1 && (
                  <tr className="border-t border-neutral-800">
                    <td className="py-2.5 text-neutral-400">Total</td>
                    <td className="py-2.5 text-right tabular-nums text-neutral-400">{comm.rows.reduce((n, r) => n + r.sales, 0)}</td>
                    <td className="py-2.5 text-right tabular-nums">{money(comm.rows.reduce((n, r) => n + r.total, 0))}</td>
                    <td className="py-2.5 text-right font-medium tabular-nums">{money(comm.rows.reduce((n, r) => n + r.commission, 0))}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        {seesCommission && <h2 className={SECTION_TITLE}>Detalle</h2>}
        {!data ? (
          <p className="text-[13px] text-neutral-500">Cargando…</p>
        ) : (
          <ul className="flex flex-col rounded-xl bg-surface px-4 shadow-sm">
            {data.sales.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 border-b border-neutral-900 py-3 last:border-0">
                <div className={`flex items-baseline gap-3 text-[13.5px] ${s.status === "voided" ? "opacity-45" : ""}`}>
                  <span className="w-11 shrink-0 tabular-nums text-neutral-500">
                    {multiDay ? fmtDate(s.createdAt.slice(0, 10)).slice(0, 5) : fmtTime(s.createdAt)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={s.status === "voided" ? "line-through" : ""}>
                      {s.quantity} × {s.itemName}
                    </span>
                    <span className="block text-[12px] text-neutral-500">
                      {s.providerName ?? "Sin médica"}
                      {s.createdByName !== s.providerName && ` · cargó ${s.createdByName}`}
                      {seesCommission && s.status === "paid" && s.commissionAmount > 0 && ` · comisión ${money(s.commissionAmount)} (${s.commissionPct}%)`}
                      {s.status === "voided" && ` · anulada: ${s.voidReason}`}
                    </span>
                  </span>
                  <span className="tabular-nums">{money(s.total)}</span>
                  {admin && s.status === "paid" && voiding !== s.id && (
                    <button className={BTN} onClick={() => setVoiding(s.id)}>
                      Anular
                    </button>
                  )}
                </div>
                {voiding === s.id && (
                  <div className="flex flex-wrap gap-2 pl-14">
                    <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (ej. se cargó dos veces)" className={`${FIELD} !w-auto flex-1`} />
                    <button className={BTN_DARK} disabled={!reason.trim()} onClick={() => voidSale(s.id)}>
                      Anular venta
                    </button>
                    <button className={BTN} onClick={() => setVoiding(null)}>
                      Cancelar
                    </button>
                  </div>
                )}
              </li>
            ))}
            {data.sales.length === 0 && <li className="py-4 text-[13px] text-neutral-500">Nada para mostrar.</li>}
          </ul>
        )}
      </section>
    </div>
  );
}
