"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarBlankIcon, CaretLeftIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react";
import { parseExpiry } from "@/lib/domain/expiry";
import { FIELD, fmtDate, localToday, pad } from "./shared";

/**
 * Vencimiento de un lote: se puede escribir («03/2027», «15/03/27») o elegir en el calendario.
 * Los vencimientos son de meses/años para adelante y casi siempre vienen como mes/año, así que el
 * calendario abre en meses (un toque = vence a fin de ese mes) y recién ahí deja elegir el día.
 * `value` queda en el mismo texto que acepta el servidor: `MM/AAAA` o `DD/MM/AAAA`.
 */

const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MONTHS_LONG = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const WEEK = ["L", "M", "M", "J", "V", "S", "D"];
const QUICK: [string, number][] = [
  ["6 meses", 6],
  ["1 año", 12],
  ["18 meses", 18],
  ["2 años", 24],
  ["3 años", 36],
];

const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();
/** Mes/año a `n` meses de hoy. */
function plusMonths(n: number): { y: number; m: number } {
  const t = localToday();
  const total = +t.slice(0, 4) * 12 + (+t.slice(5, 7) - 1) + n;
  return { y: Math.floor(total / 12), m: (total % 12) + 1 };
}
/** «en 1 año y 3 meses», «en 12 días», «vencido hace 2 meses». */
function fromNow(ymd: string): string {
  const today = localToday();
  const days = Math.round((Date.parse(ymd) - Date.parse(today)) / 86_400_000);
  if (days === 0) return "vence hoy";
  const abs = Math.abs(days);
  let txt: string;
  if (abs < 60) txt = `${abs} ${abs === 1 ? "día" : "días"}`;
  else {
    const months = Math.round(abs / 30.44);
    const y = Math.floor(months / 12), mm = months % 12;
    txt = [y ? `${y} ${y === 1 ? "año" : "años"}` : "", mm ? `${mm} ${mm === 1 ? "mes" : "meses"}` : ""].filter(Boolean).join(" y ");
  }
  return days > 0 ? `en ${txt}` : `ya vencido (hace ${txt})`;
}

export function ExpiryPicker({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const parsed = parseExpiry(value);
  const monthOnly = !!value.trim() && !!parsed && !/^\d{4}-\d{1,2}-\d{1,2}$|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(value.trim());
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ step: "mes" | "dia"; y: number; m: number }>(() => ({ step: "mes", y: plusMonths(0).y, m: plusMonths(0).m }));
  const box = useRef<HTMLDivElement>(null);

  // Abre donde está la fecha elegida (o en el año actual).
  function toggle() {
    if (!open) {
      const base = parsed ? { y: +parsed.slice(0, 4), m: +parsed.slice(5, 7) } : plusMonths(0);
      setView({ step: "mes", ...base });
    }
    setOpen(!open);
  }

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const pickMonth = (y: number, m: number) => {
    onChange(`${pad(m)}/${y}`);
    setView({ step: "dia", y, m });
  };
  const pickDay = (d: number) => {
    onChange(`${pad(d)}/${pad(view.m)}/${view.y}`);
    setOpen(false);
  };

  const today = localToday();
  const cur = { y: +today.slice(0, 4), m: +today.slice(5, 7), d: +today.slice(8, 10) };
  const selY = parsed ? +parsed.slice(0, 4) : null;
  const selM = parsed ? +parsed.slice(5, 7) : null;
  const selD = parsed && !monthOnly ? +parsed.slice(8, 10) : null;

  return (
    <div ref={box} className="relative flex flex-col gap-1">
      <div className="flex gap-1.5">
        <input
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="MM/AAAA o DD/MM/AAAA"
          aria-invalid={parsed === undefined}
          className={`${FIELD} ${parsed === undefined ? "!border-neutral-400" : ""}`}
        />
        <button
          type="button"
          onClick={toggle}
          aria-label="Elegir en el calendario"
          aria-expanded={open}
          className={`inline-flex shrink-0 items-center justify-center rounded-md border px-2.5 transition-colors ${
            open ? "border-accent bg-accent text-on-accent" : "border-neutral-800 text-neutral-300 hover:border-accent-700 hover:bg-accent-900"
          }`}
        >
          <CalendarBlankIcon size={16} />
        </button>
      </div>
      <span className={`text-[11.5px] ${parsed === undefined ? "text-fg" : "text-neutral-500"}`}>
        {parsed === undefined
          ? "No entiendo la fecha. Probá «03/2027» o «15/03/2027»."
          : parsed === null
            ? "Vacío = no vence."
            : `${monthOnly ? `Fin de ${MONTHS_LONG[+parsed.slice(5, 7) - 1]} ${parsed.slice(0, 4)}` : fmtDate(parsed)} · ${fromNow(parsed)}`}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="Elegir vencimiento"
          className="animate-cl-in absolute left-0 top-[calc(100%+4px)] z-30 w-[300px] max-w-[calc(100vw-32px)] rounded-xl border border-neutral-800 bg-surface p-3 shadow-lg"
        >
          {view.step === "mes" ? (
            <>
              <div className="mb-2 flex items-center justify-between">
                <NavBtn label="Año anterior" onClick={() => setView({ ...view, y: view.y - 1 })} disabled={view.y <= cur.y - 1}>
                  <CaretLeftIcon size={14} />
                </NavBtn>
                <span className="text-[14px] font-medium tabular-nums">{view.y}</span>
                <NavBtn label="Año siguiente" onClick={() => setView({ ...view, y: view.y + 1 })}>
                  <CaretRightIcon size={14} />
                </NavBtn>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {MONTHS.map((name, i) => {
                  const m = i + 1;
                  const sel = selY === view.y && selM === m;
                  const past = view.y < cur.y || (view.y === cur.y && m < cur.m);
                  return (
                    <button
                      type="button"
                      key={name}
                      onClick={() => pickMonth(view.y, m)}
                      className={`rounded-md py-2 text-[13px] transition-colors ${
                        sel ? "bg-accent font-medium text-on-accent" : past ? "text-neutral-600 hover:bg-neutral-900" : "text-fg hover:bg-neutral-900"
                      } ${view.y === cur.y && m === cur.m && !sel ? "ring-1 ring-neutral-700" : ""}`}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-neutral-800 pt-3">
                {QUICK.map(([label, n]) => (
                  <button
                    type="button"
                    key={label}
                    onClick={() => {
                      const t = plusMonths(n);
                      onChange(`${pad(t.m)}/${t.y}`);
                      setOpen(false);
                    }}
                    className="rounded-md border border-neutral-800 px-2 py-1 text-[12px] text-neutral-300 hover:border-accent-700 hover:bg-accent-900"
                  >
                    + {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11.5px] text-neutral-500">Un toque en el mes = vence a fin de mes. Después podés elegir el día.</p>
            </>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between">
                <NavBtn
                  label="Mes anterior"
                  onClick={() => setView(view.m === 1 ? { ...view, y: view.y - 1, m: 12 } : { ...view, m: view.m - 1 })}
                >
                  <CaretLeftIcon size={14} />
                </NavBtn>
                <button type="button" onClick={() => setView({ ...view, step: "mes" })} className="rounded-md px-2 py-1 text-[14px] font-medium capitalize hover:bg-neutral-900">
                  {MONTHS_LONG[view.m - 1]} {view.y}
                </button>
                <NavBtn
                  label="Mes siguiente"
                  onClick={() => setView(view.m === 12 ? { ...view, y: view.y + 1, m: 1 } : { ...view, m: view.m + 1 })}
                >
                  <CaretRightIcon size={14} />
                </NavBtn>
              </div>
              <div className="grid grid-cols-7 gap-0.5 text-center">
                {WEEK.map((w, i) => (
                  <span key={i} className="py-1 text-[11px] text-neutral-500">
                    {w}
                  </span>
                ))}
                {Array.from({ length: (new Date(view.y, view.m - 1, 1).getDay() + 6) % 7 }, (_, i) => (
                  <span key={`e${i}`} />
                ))}
                {Array.from({ length: daysIn(view.y, view.m) }, (_, i) => {
                  const d = i + 1;
                  const sel = selY === view.y && selM === view.m && selD === d;
                  const isToday = cur.y === view.y && cur.m === view.m && cur.d === d;
                  const past = `${view.y}-${pad(view.m)}-${pad(d)}` < today;
                  return (
                    <button
                      type="button"
                      key={d}
                      onClick={() => pickDay(d)}
                      className={`rounded-md py-1.5 text-[13px] tabular-nums transition-colors ${
                        sel ? "bg-accent font-medium text-on-accent" : past ? "text-neutral-600 hover:bg-neutral-900" : "hover:bg-neutral-900"
                      } ${isToday && !sel ? "ring-1 ring-neutral-700" : ""}`}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 flex items-center gap-2 border-t border-neutral-800 pt-3">
                <button
                  type="button"
                  onClick={() => {
                    onChange(`${pad(view.m)}/${view.y}`);
                    setOpen(false);
                  }}
                  className="rounded-md border border-neutral-800 px-2 py-1 text-[12px] text-neutral-300 hover:border-accent-700 hover:bg-accent-900"
                >
                  Todo el mes (fin de {MONTHS_LONG[view.m - 1]})
                </button>
                <span className="flex-1" />
                <NavBtn label="Cerrar" onClick={() => setOpen(false)}>
                  <XIcon size={14} />
                </NavBtn>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NavBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-fg disabled:opacity-30"
    >
      {children}
    </button>
  );
}
