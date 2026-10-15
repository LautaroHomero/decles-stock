"use client";

import { useEffect, useRef, useState } from "react";
import { call, money, useDolar } from "./shared";

/**
 * El dólar del día arriba a la derecha: oficial compra / venta y a cuánto se cobra (el promedio), así la
 * secretaria no hace cuentas. Se puede escribir otra cotización para hoy (vuelve al oficial mañana).
 */
export function DolarChip({ canEdit }: { canEdit: boolean }) {
  const [d, refresh] = useDolar();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function save(rate: number | null) {
    setErr("");
    const r = await call("/api/dolar", "PUT", { rate });
    if (!r.ok) return setErr(r.error ?? "No se pudo guardar.");
    setV("");
    refresh();
  }

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Dólar del día: a cuánto se cobra (promedio del oficial)"
        className="flex items-center gap-1.5 rounded-md border border-neutral-800 px-2.5 py-1 text-[13px] tabular-nums text-neutral-200 transition-colors hover:bg-neutral-900"
      >
        <span className="text-neutral-400">US$</span>
        {d?.rate ? money(d.rate) : "—"}
        {d?.compra && d.venta && !d.manual && (
          <span className="hidden text-[11.5px] text-neutral-500 lg:inline">
            (oficial {d.compra.toLocaleString("es-AR")}–{d.venta.toLocaleString("es-AR")})
          </span>
        )}
        {d?.manual && <span className="text-[11px] text-neutral-500">a mano</span>}
      </button>
      {open && (
        <div className="cl-fade-in absolute right-0 top-[calc(100%+6px)] z-50 flex w-[290px] flex-col gap-2 rounded-xl border border-neutral-800 bg-surface p-4 text-[13.5px] shadow-lg">
          <p className="font-medium">Dólar de hoy</p>
          {d?.compra && d.venta ? (
            <>
              <Line label="Oficial compra" value={money(d.compra)} />
              <Line label="Oficial venta" value={money(d.venta)} />
              <Line label="Se cobra a (promedio)" value={money(Math.round(((d.compra + d.venta) / 2) * 100) / 100)} strong={!d.manual} />
            </>
          ) : (
            <p className="text-neutral-400">No se pudo traer el dólar oficial. Escribí la cotización de hoy.</p>
          )}
          {d?.manual && <Line label="Hoy a mano" value={money(d.rate ?? 0)} strong />}
          {canEdit && (
            <div className="flex flex-col gap-1.5 border-t border-neutral-900 pt-2">
              <label className="flex items-center gap-2">
                <span className="whitespace-nowrap text-neutral-400">Otra para hoy</span>
                <input
                  value={v}
                  onChange={(e) => setV(e.target.value.replace(/[^\d,]/g, ""))}
                  onKeyDown={(e) => e.key === "Enter" && v && save(Number(v.replace(",", ".")))}
                  inputMode="decimal"
                  placeholder="$"
                  className="w-full rounded-md border border-neutral-800 bg-transparent px-2 py-1 text-right tabular-nums outline-none focus:border-accent-700"
                />
              </label>
              <div className="flex justify-between">
                {d?.manual ? (
                  <button onClick={() => save(null)} className="text-[12.5px] text-neutral-400 underline-offset-2 hover:text-fg hover:underline">
                    Volver al oficial
                  </button>
                ) : (
                  <span />
                )}
                <button disabled={!v} onClick={() => save(Number(v.replace(",", ".")))} className="rounded-md border border-neutral-800 px-2.5 py-0.5 text-[12.5px] hover:bg-accent-900 disabled:opacity-40">
                  Usar esta
                </button>
              </div>
              {err && <p className="text-[12.5px] text-neutral-300">{err}</p>}
            </div>
          )}
          <p className="text-[11.5px] text-neutral-500">Fuente: dolarapi.com (dólar oficial). Se actualiza sola.</p>
        </div>
      )}
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <p className={`flex justify-between gap-3 ${strong ? "font-medium" : "text-neutral-300"}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </p>
  );
}
