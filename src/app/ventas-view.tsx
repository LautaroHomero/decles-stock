"use client";

import { useState } from "react";
import type { Actor } from "@/lib/domain/types";
import { BTN, BTN_DARK, FIELD, Toast, call, fmtTime, localToday, money, usePoll, useToast, type SaleRow } from "./shared";

/** Ventas por día. Todos las ven (la médica, las suyas); solo el admin anula y el stock vuelve a su lote. */
export function VentasView({ actor }: { actor: Actor }) {
  const [day, setDay] = useState(localToday());
  const [data, refresh] = usePoll<{ ok: boolean; sales: SaleRow[] }>(`/api/sales?from=${day}&to=${day}`, 30_000);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [toast, showToast] = useToast();
  const admin = !!actor.activeOrg?.canAdmin;

  const paid = (data?.sales ?? []).filter((s) => s.status === "paid");
  const total = paid.reduce((n, s) => n + s.total, 0);
  const units = paid.reduce((n, s) => n + s.quantity, 0);

  async function voidSale(id: string) {
    const r = await call(`/api/sales/${id}/void`, "POST", { reason });
    if (!r.ok) return showToast(r.error ?? "No se pudo anular.");
    showToast(`Venta anulada. Volvieron ${r.restoredUnits} unidades al stock.`);
    setVoiding(null);
    setReason("");
    refresh();
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <Toast msg={toast} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col">
          <h1 className="font-display text-[22px] font-medium tracking-[-.01em]">Ventas</h1>
          <p className="text-[13px] text-neutral-400">
            {paid.length ? `${units} productos · ${money(total)}` : "Sin ventas este día."}
          </p>
        </div>
        <span className="flex-1" />
        <input type="date" value={day} max={localToday()} onChange={(e) => e.target.value && setDay(e.target.value)} className={`${FIELD} !w-auto`} />
      </div>

      {!data ? (
        <p className="text-[13px] text-neutral-500">Cargando…</p>
      ) : (
        <ul className="flex flex-col rounded-xl bg-surface px-4 shadow-sm">
          {data.sales.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 border-b border-neutral-900 py-3 last:border-0">
              <div className={`flex items-baseline gap-3 text-[13.5px] ${s.status === "voided" ? "opacity-45" : ""}`}>
                <span className="w-11 shrink-0 tabular-nums text-neutral-500">{fmtTime(s.createdAt)}</span>
                <span className="min-w-0 flex-1">
                  <span className={s.status === "voided" ? "line-through" : ""}>
                    {s.quantity} × {s.itemName}
                  </span>
                  <span className="block text-[12px] text-neutral-500">
                    {s.createdByName}
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
                  <input
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Motivo (ej. se cargó dos veces)"
                    className={`${FIELD} !w-auto flex-1`}
                  />
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
    </div>
  );
}
