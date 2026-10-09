"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarBlankIcon, CaretDownIcon, CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { SECTION_TITLE } from "./ui";
import {
  Amount,
  BTN,
  BTN_DARK,
  FIELD,
  PAYMENT_LABEL,
  Toast,
  call,
  fmtTime,
  localToday,
  money,
  usePoll,
  useToast,
  type Payment,
  type SaleRow,
} from "./shared";

interface CommissionRow {
  providerId: string | null;
  providerName: string;
  sales: number;
  units: number;
  total: number;
  commission: number;
}

// ---------------------------------------------------------------------------
// Períodos: día / semana (lunes a domingo) / mes, con flechas para moverse.
// ---------------------------------------------------------------------------

type Period = "dia" | "semana" | "mes";

const pad = (n: number) => String(n).padStart(2, "0");
const toYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromYmd = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const addDays = (s: string, n: number) => {
  const d = fromYmd(s);
  d.setDate(d.getDate() + n);
  return toYmd(d);
};

function rangeOf(p: Period, anchor: string): { from: string; to: string } {
  const d = fromYmd(anchor);
  if (p === "dia") return { from: anchor, to: anchor };
  if (p === "semana") {
    const monday = addDays(anchor, -((d.getDay() + 6) % 7));
    return { from: monday, to: addDays(monday, 6) };
  }
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { from: `${anchor.slice(0, 7)}-01`, to: toYmd(last) };
}

function shift(p: Period, anchor: string, dir: 1 | -1): string {
  if (p === "dia") return addDays(anchor, dir);
  if (p === "semana") return addDays(anchor, 7 * dir);
  const d = fromYmd(anchor);
  return toYmd(new Date(d.getFullYear(), d.getMonth() + dir, 1));
}

const WEEKDAY = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTH = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const dayName = (s: string) => {
  const d = fromYmd(s);
  return `${WEEKDAY[d.getDay()]} ${d.getDate()} de ${MONTH[d.getMonth()]}`;
};

function label(p: Period, from: string, to: string): string {
  const today = localToday();
  if (p === "dia") return from === today ? "Hoy" : from === addDays(today, -1) ? "Ayer" : cap(dayName(from));
  if (p === "semana") {
    const f = fromYmd(from);
    const t = fromYmd(to);
    const span =
      f.getMonth() === t.getMonth()
        ? `${f.getDate()} al ${t.getDate()} de ${MONTH[t.getMonth()]}`
        : `${f.getDate()} de ${MONTH[f.getMonth()]} al ${t.getDate()} de ${MONTH[t.getMonth()]}`;
    return from <= today && today <= to ? `Esta semana · ${span}` : cap(span);
  }
  const f = fromYmd(from);
  return cap(`${MONTH[f.getMonth()]} ${f.getFullYear()}`);
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Lo cobrado por una venta: con medio, ese precio; sin medio, a precio efectivo (como se registró). */
const charged = (s: SaleRow) => (s.paymentMethod === "tarjeta" ? s.cardTotal : s.cashTotal);

/**
 * Ventas por día, semana o mes. Todos ven las ventas; el admin, además, la comisión de cada
 * médica y puede anular; la médica ve solo lo suyo y su comisión.
 */
export function VentasView({ actor }: { actor: Actor }) {
  const admin = !!actor.activeOrg?.canAdmin;
  const isMedico = actor.role === "medico";
  const seesCommission = admin || isMedico;
  const today = localToday();

  const [period, setPeriod] = useState<Period>("dia");
  const [anchor, setAnchor] = useState(today);
  const [calOpen, setCalOpen] = useState(false);
  const { from, to } = rangeOf(period, anchor);
  const isCurrent = from <= today && today <= to;
  const canNext = shift(period, anchor, 1) <= today || rangeOf(period, shift(period, anchor, 1)).from <= today;

  const [data, refresh] = usePoll<{ ok: boolean; sales: SaleRow[] }>(`/api/sales?from=${from}&to=${to}&limit=500`, 30_000);
  const [comm, refreshComm] = usePoll<{ ok: boolean; rows: CommissionRow[] }>(
    seesCommission ? `/api/commissions?from=${from}&to=${to}` : "/api/commissions?none=1",
    60_000,
  );
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [toast, showToast] = useToast();

  const sales = useMemo(() => data?.sales ?? [], [data]);
  const paid = sales.filter((s) => s.status === "paid");
  const units = paid.reduce((n, s) => n + s.quantity, 0);
  const total = paid.reduce((n, s) => n + charged(s), 0);
  const cash = paid.filter((s) => s.paymentMethod === "efectivo").reduce((n, s) => n + s.cashTotal, 0);
  const card = paid.filter((s) => s.paymentMethod === "tarjeta").reduce((n, s) => n + s.cardTotal, 0);
  const unknown = paid.filter((s) => !s.paymentMethod);
  const unknownCash = unknown.reduce((n, s) => n + s.cashTotal, 0);
  const unknownCard = unknown.reduce((n, s) => n + s.cardTotal, 0);

  // Ventas agrupadas por día (más reciente primero).
  const byDay = useMemo(() => {
    const m = new Map<string, SaleRow[]>();
    for (const s of sales) {
      const d = s.createdAt.slice(0, 10);
      m.set(d, [...(m.get(d) ?? []), s]);
    }
    return [...m.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [sales]);

  function pick(p: Period) {
    setPeriod(p);
    // Al cambiar de vista se queda en el período que contiene el día que estabas mirando (o hoy).
    setAnchor((a) => (a > today ? today : a));
  }

  async function setMethod(id: string, method: Payment) {
    const r = await call(`/api/sales/${id}/payment`, "POST", { method });
    if (!r.ok) return showToast(r.error ?? "No se pudo guardar.");
    refresh();
  }

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

      {/* Encabezado: título + Día / Semana / Mes */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-[22px] font-medium tracking-[-.01em]">Ventas</h1>
        <span className="flex-1" />
        <div className="flex rounded-lg border border-neutral-800 p-0.5" role="tablist" aria-label="Período">
          {(
            [
              ["dia", "Día"],
              ["semana", "Semana"],
              ["mes", "Mes"],
            ] as [Period, string][]
          ).map(([id, text]) => (
            <button
              key={id}
              role="tab"
              aria-selected={period === id}
              onClick={() => pick(id)}
              className={`rounded-md px-4 py-1.5 text-[13.5px] transition-colors ${
                period === id ? "bg-accent-800 text-fg" : "text-neutral-400 hover:text-fg"
              }`}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {/* Navegación entre períodos */}
      <div className="flex items-center gap-2">
        <button aria-label="Anterior" onClick={() => setAnchor(shift(period, anchor, -1))} className={NAV}>
          <CaretLeftIcon size={16} />
        </button>
        <div className="relative min-w-0 flex-1">
          <button
            onClick={() => setCalOpen((o) => !o)}
            aria-expanded={calOpen}
            aria-label="Elegir un día en el calendario"
            className="mx-auto flex max-w-full items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-[15px] font-medium transition-colors hover:bg-accent-900"
          >
            <CalendarBlankIcon size={16} className="shrink-0 text-neutral-400" />
            <span className="truncate">{label(period, from, to)}</span>
            <CaretDownIcon size={12} className={`shrink-0 text-neutral-500 transition-transform ${calOpen ? "rotate-180" : ""}`} />
          </button>
          {calOpen && (
            <Calendar
              selected={period === "dia" ? anchor : null}
              start={anchor}
              today={today}
              onPick={(d) => {
                setPeriod("dia");
                setAnchor(d);
                setCalOpen(false);
              }}
              onClose={() => setCalOpen(false)}
            />
          )}
        </div>
        <button aria-label="Siguiente" onClick={() => setAnchor(shift(period, anchor, 1))} disabled={!canNext || isCurrent} className={NAV}>
          <CaretRightIcon size={16} />
        </button>
      </div>
      {!isCurrent && (
        <button onClick={() => setAnchor(today)} className="-mt-3 self-center text-[12.5px] text-neutral-400 underline-offset-4 hover:text-fg hover:underline">
          Volver a {period === "dia" ? "hoy" : period === "semana" ? "esta semana" : "este mes"}
        </button>
      )}

      {/* Total del período */}
      <section className="flex flex-col gap-4 rounded-2xl bg-surface p-5 shadow-sm">
        <div className="flex flex-col gap-1">
          <span className="text-[12px] uppercase tracking-[.08em] text-neutral-500">Total vendido</span>
          <span className="font-display text-[34px] font-medium leading-none tracking-[-.02em] tabular-nums">{data ? money(total) : "…"}</span>
          <span className="text-[13px] text-neutral-400">
            {paid.length === 0 ? "Sin ventas." : `${paid.length} ${paid.length === 1 ? "venta" : "ventas"} · ${units} ${units === 1 ? "producto" : "productos"}`}
          </span>
        </div>
        {paid.length > 0 && (
          <div className="grid grid-cols-3 gap-3 border-t border-neutral-800 pt-4">
            <Stat label="Efectivo / transf." value={money(cash)} />
            <Stat label={PAYMENT_LABEL.tarjeta} value={money(card)} />
            <Stat
              label={`Sin medio (${unknown.length})`}
              value={unknown.length ? money(unknownCash) : "—"}
              sub={unknown.length && unknownCard !== unknownCash ? `o ${money(unknownCard)} con tarjeta` : undefined}
            />
          </div>
        )}
        {period !== "dia" && paid.length > 0 && (
          <DayBars
            from={from}
            to={to}
            today={today}
            sales={paid}
            onPick={(d) => {
              setPeriod("dia");
              setAnchor(d);
            }}
          />
        )}
      </section>

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

      {/* Detalle, agrupado por día */}
      {data && sales.length > 0 && (
        <section className="flex flex-col gap-4">
          {byDay.map(([day, list]) => {
            const dayTotal = list.filter((s) => s.status === "paid").reduce((n, s) => n + charged(s), 0);
            return (
              <div key={day} className="flex flex-col gap-2">
                {(period !== "dia" || seesCommission) && (
                  <div className="flex items-baseline gap-2 px-1">
                    <h2 className={SECTION_TITLE}>{period === "dia" ? "Detalle" : cap(dayName(day))}</h2>
                    <span className="flex-1" />
                    {period !== "dia" && <span className="text-[12.5px] tabular-nums text-neutral-400">{money(dayTotal)}</span>}
                  </div>
                )}
                <ul className="flex flex-col rounded-xl bg-surface px-4 shadow-sm">
                  {list.map((s) => (
                    <SaleItem
                      key={s.id}
                      s={s}
                      admin={admin}
                      seesCommission={seesCommission}
                      voiding={voiding === s.id}
                      reason={reason}
                      setReason={setReason}
                      onVoidStart={() => setVoiding(s.id)}
                      onVoidCancel={() => setVoiding(null)}
                      onVoid={() => voidSale(s.id)}
                      onMethod={(m) => setMethod(s.id, m)}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

const NAV =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-800 text-neutral-300 transition-colors hover:border-accent-700 hover:bg-accent-900 disabled:opacity-30 disabled:hover:bg-transparent";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-[11.5px] text-neutral-500 sm:text-[12px]">{label}</span>
      <span className="truncate text-[14.5px] font-medium tabular-nums sm:text-[16px]">{value}</span>
      {sub && <span className="text-[11.5px] leading-snug text-neutral-500">{sub}</span>}
    </div>
  );
}

/** Barras por día (semana o mes). Tocar una barra abre ese día. Un solo color: es una sola serie. */
function DayBars({ from, to, today, sales, onPick }: { from: string; to: string; today: string; sales: SaleRow[]; onPick: (d: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const days: { d: string; total: number; count: number }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push({ d, total: 0, count: 0 });
  const idx = new Map(days.map((x, i) => [x.d, i]));
  for (const s of sales) {
    const i = idx.get(s.createdAt.slice(0, 10));
    if (i !== undefined) {
      days[i].total += charged(s);
      days[i].count += 1;
    }
  }
  const max = Math.max(...days.map((x) => x.total), 1);
  const week = days.length <= 7;
  const shown = days.find((x) => x.d === hover);

  return (
    <div className="flex flex-col gap-2 border-t border-neutral-800 pt-4">
      <div className="flex h-5 items-baseline justify-between text-[12.5px]">
        {shown ? (
          <>
            <span className="text-neutral-300">{cap(dayName(shown.d))}</span>
            <span className="tabular-nums text-fg">
              {money(shown.total)} <span className="text-neutral-500">· {shown.count} {shown.count === 1 ? "venta" : "ventas"}</span>
            </span>
          </>
        ) : (
          <span className="text-neutral-500">Por día · tocá un día para ver el detalle</span>
        )}
      </div>
      <div className="flex h-24 items-end gap-[2px] border-b border-neutral-800" onMouseLeave={() => setHover(null)}>
        {days.map((x) => {
          const future = x.d > today;
          return (
            <button
              key={x.d}
              disabled={future || x.count === 0}
              onClick={() => onPick(x.d)}
              onMouseEnter={() => setHover(x.d)}
              onFocus={() => setHover(x.d)}
              aria-label={`${dayName(x.d)}: ${money(x.total)}, ${x.count} ventas`}
              className="group flex h-full min-w-0 flex-1 items-end justify-center disabled:cursor-default"
            >
              <span
                className={`w-full max-w-[28px] rounded-t-[4px] transition-colors ${
                  x.total === 0 ? "h-0" : hover === x.d ? "bg-fg" : "bg-neutral-500 group-hover:bg-fg"
                }`}
                style={x.total ? { height: `${Math.max(4, (x.total / max) * 100)}%` } : undefined}
              />
            </button>
          );
        })}
      </div>
      <div className="flex gap-[2px] text-[10.5px] tabular-nums text-neutral-500">
        {days.map((x, i) => {
          const d = fromYmd(x.d);
          const show = week || i === 0 || d.getDate() % 5 === 0;
          return (
            <span key={x.d} className={`min-w-0 flex-1 text-center ${x.d === today ? "font-medium text-fg" : ""}`}>
              {show ? (week ? WEEKDAY[d.getDay()].slice(0, 3) : d.getDate()) : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function SaleItem({
  s,
  admin,
  seesCommission,
  voiding,
  reason,
  setReason,
  onVoidStart,
  onVoidCancel,
  onVoid,
  onMethod,
}: {
  s: SaleRow;
  admin: boolean;
  seesCommission: boolean;
  voiding: boolean;
  reason: string;
  setReason: (r: string) => void;
  onVoidStart: () => void;
  onVoidCancel: () => void;
  onVoid: () => void;
  onMethod: (m: Payment) => void;
}) {
  const voided = s.status === "voided";
  return (
    <li className="flex flex-col gap-2 border-b border-neutral-900 py-3 last:border-0">
      <div className={`flex items-baseline gap-3 text-[14px] ${voided ? "opacity-45" : ""}`}>
        <span className="w-11 shrink-0 tabular-nums text-neutral-500">{fmtTime(s.createdAt)}</span>
        <span className="min-w-0 flex-1">
          <span className={voided ? "line-through" : ""}>
            {s.quantity} × {s.itemName}
          </span>
          <span className="block text-[12.5px] text-neutral-500">
            {[
              s.providerName ?? "Sin médica",
              s.status === "paid" && s.paymentMethod ? PAYMENT_LABEL[s.paymentMethod] : null,
              seesCommission && !voided && s.commissionAmount > 0 ? `comisión ${money(s.commissionAmount)}` : null,
              admin && s.createdByName !== s.providerName ? `cargó ${s.createdByName}` : null,
              voided ? `anulada: ${s.voidReason}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {!voided && !s.paymentMethod && (
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-neutral-500">
              ¿Cómo pagó?
              {(["efectivo", "tarjeta"] as Payment[]).map((m) => (
                <button key={m} className={BTN} onClick={() => onMethod(m)}>
                  {PAYMENT_LABEL[m]}
                </button>
              ))}
            </span>
          )}
        </span>
        <Amount cash={s.cashTotal} card={s.cardTotal} method={s.paymentMethod} />
        {admin && !voided && !voiding && (
          <button className={BTN} onClick={onVoidStart}>
            Anular
          </button>
        )}
      </div>
      {voiding && (
        <div className="flex flex-wrap gap-2 pl-14">
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (ej. se cargó dos veces)" className={`${FIELD} !w-auto flex-1`} />
          <button className={BTN_DARK} disabled={!reason.trim()} onClick={onVoid}>
            Anular venta
          </button>
          <button className={BTN} onClick={onVoidCancel}>
            Cancelar
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Calendario para elegir un día: un mes a la vez, con un punto en los días que tuvieron
 * ventas. Los días futuros no se pueden elegir.
 */
function Calendar({
  selected,
  start,
  today,
  onPick,
  onClose,
}: {
  selected: string | null;
  start: string;
  today: string;
  onPick: (d: string) => void;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(start.slice(0, 7)); // "YYYY-MM"
  const ref = useRef<HTMLDivElement>(null);
  const first = `${month}-01`;
  const last = rangeOf("mes", first).to;
  const [data] = usePoll<{ ok: boolean; sales: SaleRow[] }>(`/api/sales?from=${first}&to=${last}&limit=500`, 60_000);

  useEffect(() => {
    // El contenedor incluye el botón que lo abre: tocarlo de nuevo lo cierra sin reabrirlo.
    const close = (e: MouseEvent) => {
      const box = ref.current?.parentElement;
      if (box && !box.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of data?.sales ?? []) if (s.status === "paid") m.set(s.createdAt.slice(0, 10), (m.get(s.createdAt.slice(0, 10)) ?? 0) + charged(s));
    return m;
  }, [data]);

  const lead = (fromYmd(first).getDay() + 6) % 7; // lunes primero
  const cells: (string | null)[] = [...Array(lead).fill(null)];
  for (let d = first; d <= last; d = addDays(d, 1)) cells.push(d);
  const monthTotal = [...totals.values()].reduce((n, v) => n + v, 0);
  const canNext = `${month}-01` < `${today.slice(0, 7)}-01`;
  const move = (dir: 1 | -1) => setMonth(shift("mes", first, dir).slice(0, 7));
  const f = fromYmd(first);

  return (
    <div
      ref={ref}
      className="absolute left-1/2 top-11 z-30 w-[300px] -translate-x-1/2 animate-cl-in rounded-2xl bg-surface p-4 shadow-lg"
      role="dialog"
      aria-label="Calendario"
    >
      <div className="mb-3 flex items-center gap-2">
        <button aria-label="Mes anterior" onClick={() => move(-1)} className={CAL_NAV}>
          <CaretLeftIcon size={14} />
        </button>
        <span className="flex-1 text-center text-[14px] font-medium">{cap(`${MONTH[f.getMonth()]} ${f.getFullYear()}`)}</span>
        <button aria-label="Mes siguiente" onClick={() => move(1)} disabled={!canNext} className={CAL_NAV}>
          <CaretRightIcon size={14} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-[11px] text-neutral-500">
        {["lu", "ma", "mi", "ju", "vi", "sá", "do"].map((d) => (
          <span key={d} className="pb-1">
            {d}
          </span>
        ))}
        {cells.map((d, i) =>
          d === null ? (
            <span key={`x${i}`} />
          ) : (
            <button
              key={d}
              disabled={d > today}
              onClick={() => onPick(d)}
              title={totals.has(d) ? money(totals.get(d)!) : "Sin ventas"}
              className={`relative mx-auto flex h-9 w-9 flex-col items-center justify-center rounded-full text-[13px] tabular-nums transition-colors disabled:opacity-25 ${
                d === selected ? "bg-fg text-bg" : d === today ? "border border-neutral-600 text-fg hover:bg-accent-900" : "text-neutral-200 hover:bg-accent-900"
              }`}
            >
              {Number(d.slice(8))}
              {totals.has(d) && (
                <span className={`absolute bottom-1 h-1 w-1 rounded-full ${d === selected ? "bg-bg" : "bg-fg"}`} aria-hidden />
              )}
            </button>
          ),
        )}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-neutral-800 pt-3 text-[12px] text-neutral-400">
        <span className="flex items-center gap-1.5">
          <span className="h-1 w-1 rounded-full bg-fg" aria-hidden /> días con ventas
        </span>
        <span className="tabular-nums">{data ? `Mes: ${money(monthTotal)}` : "…"}</span>
      </div>
      <button onClick={() => onPick(today)} className="mt-2 w-full rounded-md py-1.5 text-[13px] text-neutral-300 transition-colors hover:bg-accent-900">
        Ir a hoy
      </button>
    </div>
  );
}

const CAL_NAV =
  "flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-accent-900 hover:text-fg disabled:opacity-25 disabled:hover:bg-transparent";
