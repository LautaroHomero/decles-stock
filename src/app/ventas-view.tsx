"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarBlankIcon, CaretDownIcon, CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { EditVisit } from "./anotar-view";
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
 * Ventas por día o por mes (semana también para admin y médica). Todos ven lo cobrado y el
 * detalle; el admin, además, la comisión de cada médica y puede anular; la médica ve solo lo suyo.
 */
export function VentasView({ actor }: { actor: Actor }) {
  const admin = !!actor.activeOrg?.canAdmin;
  const isMedico = actor.role === "medico";
  const seesCommission = admin || isMedico;
  const today = localToday();
  const periods: [Period, string][] = seesCommission
    ? [
        ["dia", "Día"],
        ["semana", "Semana"],
        ["mes", "Mes"],
      ]
    : [
        ["dia", "Día"],
        ["mes", "Mes"],
      ];

  const [period, setPeriod] = useState<Period>("dia");
  const [anchor, setAnchor] = useState(today);
  const [calOpen, setCalOpen] = useState(false);
  const { from, to } = rangeOf(period, anchor);
  const isCurrent = from <= today && today <= to;
  const canNext = !isCurrent && rangeOf(period, shift(period, anchor, 1)).from <= today;

  const [data, refresh] = usePoll<{ ok: boolean; sales: SaleRow[] }>(`/api/sales?from=${from}&to=${to}&limit=500`, 30_000);
  const [comm, refreshComm] = usePoll<{ ok: boolean; rows: CommissionRow[] }>(
    seesCommission ? `/api/commissions?from=${from}&to=${to}` : "/api/commissions?none=1",
    60_000,
  );
  const [toast, showToast] = useToast();
  const [editing, setEditing] = useState<SaleRow[] | null>(null);

  const sales = useMemo(() => data?.sales ?? [], [data]);
  const paid = sales.filter((s) => s.status === "paid");
  const visits = useMemo(() => groupVisits(sales), [sales]);
  const paidVisits = visits.filter((v) => v.sales.some((s) => s.status === "paid"));
  const patients = paidVisits.filter((v) => v.patient).length;
  const units = paid.filter((s) => s.kind === "producto").reduce((n, s) => n + s.quantity, 0);
  const practices = paid.filter((s) => s.kind !== "producto").reduce((n, s) => n + s.quantity, 0);
  const total = paid.reduce((n, s) => n + charged(s), 0);
  const cash = paid.filter((s) => s.paymentMethod === "efectivo").reduce((n, s) => n + s.cashTotal, 0);
  const card = paid.filter((s) => s.paymentMethod === "tarjeta").reduce((n, s) => n + s.cardTotal, 0);
  const unknown = paid.filter((s) => !s.paymentMethod);
  const unknownCash = unknown.reduce((n, s) => n + s.cashTotal, 0);
  const unknownCard = unknown.reduce((n, s) => n + s.cardTotal, 0);

  // Mes / semana: un renglón por día con ventas (más reciente primero).
  const days = useMemo(() => {
    const m = new Map<string, { total: number; visits: Set<string> }>();
    for (const s of sales) {
      if (s.status !== "paid") continue;
      const d = s.createdAt.slice(0, 10);
      const cur = m.get(d) ?? { total: 0, visits: new Set<string>() };
      cur.total += charged(s);
      cur.visits.add(s.visitId ?? s.id);
      m.set(d, cur);
    }
    return [...m.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [sales]);

  function pick(p: Period) {
    setPeriod(p);
    setAnchor((a) => (a > today ? today : a));
  }
  const openDay = (d: string) => {
    setPeriod("dia");
    setAnchor(d);
    window.scrollTo?.({ top: 0 });
  };

  async function setMethod(ids: string[], method: Payment) {
    for (const id of ids) {
      const r = await call(`/api/sales/${id}/payment`, "POST", { method });
      if (!r.ok) return showToast(r.error ?? "No se pudo guardar.");
    }
    refresh();
  }

  async function voidVisit(ids: string[], reason: string) {
    let units = 0;
    for (const id of ids) {
      const r = await call(`/api/sales/${id}/void`, "POST", { reason });
      if (!r.ok) {
        refresh();
        return showToast(r.error ?? "No se pudo anular.");
      }
      units += Number(r.restoredUnits ?? 0);
    }
    showToast(units ? `Anulado. Volvieron ${units} unidades al stock.` : "Anulado.");
    refresh();
    refreshComm();
  }

  const counts = [
    patients ? `${patients} ${patients === 1 ? "paciente" : "pacientes"}` : null,
    practices ? `${practices} ${practices === 1 ? "práctica" : "prácticas"}` : null,
    units ? `${units} ${units === 1 ? "producto" : "productos"}` : null,
  ].filter(Boolean);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-5 pb-20 pt-10 text-[14px] sm:px-6 sm:pt-12">
      <Toast msg={toast} />
      {editing && (
        <EditVisit
          sales={editing}
          isMedico={isMedico}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            showToast("Cambios guardados.");
            refresh();
            refreshComm();
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-4">
        <h1 className="font-display text-[23px] font-medium leading-[1.15] tracking-[-.02em] sm:text-[28px]">Ventas</h1>
        <span className="flex-1" />
        <div className="flex rounded-2xl border-2 border-neutral-800 p-1" role="tablist" aria-label="Período">
          {periods.map(([id, text]) => (
            <button
              key={id}
              role="tab"
              aria-selected={period === id}
              onClick={() => pick(id)}
              className={`min-h-11 rounded-xl px-5 text-[13.5px] font-semibold transition-colors ${
                period === id ? "bg-accent text-on-accent" : "text-neutral-400 hover:text-fg"
              }`}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {/* Moverse entre días / meses */}
      <div className="flex flex-col items-center gap-1">
        <div className="flex w-full items-center gap-2">
          <button aria-label="Anterior" onClick={() => setAnchor(shift(period, anchor, -1))} className={NAV}>
            <CaretLeftIcon size={20} weight="bold" />
          </button>
          <div className="relative min-w-0 flex-1">
            <button
              onClick={() => setCalOpen((o) => !o)}
              aria-expanded={calOpen}
              aria-label="Elegir un día en el calendario"
              className="mx-auto flex min-h-12 max-w-full items-center justify-center gap-2.5 rounded-xl px-4 text-[15px] font-semibold transition-colors hover:bg-neutral-900"
            >
              <CalendarBlankIcon size={20} className="shrink-0 text-neutral-400" />
              <span className="truncate">{label(period, from, to)}</span>
              <CaretDownIcon size={14} className={`shrink-0 text-neutral-500 transition-transform ${calOpen ? "rotate-180" : ""}`} />
            </button>
            {calOpen && (
              <Calendar
                selected={period === "dia" ? anchor : null}
                start={anchor}
                today={today}
                onPick={(d) => {
                  openDay(d);
                  setCalOpen(false);
                }}
                onClose={() => setCalOpen(false)}
              />
            )}
          </div>
          <button aria-label="Siguiente" onClick={() => setAnchor(shift(period, anchor, 1))} disabled={!canNext} className={NAV}>
            <CaretRightIcon size={20} weight="bold" />
          </button>
        </div>
        {!isCurrent && (
          <button onClick={() => setAnchor(today)} className="py-1 text-[13.5px] font-semibold text-accent underline-offset-4 hover:underline">
            Volver a {period === "dia" ? "hoy" : period === "semana" ? "esta semana" : "este mes"}
          </button>
        )}
      </div>

      {/* Lo cobrado */}
      <section className="flex flex-col gap-5 rounded-[24px] bg-surface p-6">
        <div className="flex flex-col gap-1">
          <span className="text-[14px] text-neutral-400">Cobrado</span>
          <span className="font-display text-[28px] font-medium leading-none tracking-[-.02em] tabular-nums sm:text-[32px]">
            {data ? money(total) : "…"}
          </span>
          <span className="text-[14px] text-neutral-300">{data ? (paid.length ? counts.join(" · ") : "No se anotó nada.") : " "}</span>
        </div>
        {paid.length > 0 && (
          <div className="grid grid-cols-1 gap-4 border-t border-neutral-800 pt-5 sm:grid-cols-3">
            <Stat label="Efectivo o transf." value={money(cash)} />
            <Stat label={PAYMENT_LABEL.tarjeta} value={money(card)} />
            <Stat
              label="Sin cargar cómo pagó"
              value={unknown.length ? money(unknownCash) : "—"}
              sub={unknown.length && unknownCard !== unknownCash ? `o ${money(unknownCard)} con tarjeta` : undefined}
            />
          </div>
        )}
        {period !== "dia" && paid.length > 0 && <DayBars from={from} to={to} today={today} sales={paid} onPick={openDay} />}
      </section>

      {seesCommission && comm?.rows && comm.rows.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[17px] font-bold">{admin ? "Comisiones" : "Tu comisión"}</h2>
          <div className="overflow-x-auto rounded-[20px] border-2 border-neutral-800 px-5">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="text-left text-[13px] font-bold uppercase tracking-[.06em] text-neutral-500">
                  <th className="py-3 font-bold">Médica</th>
                  <th className="py-3 text-right font-bold">Cobrado</th>
                  <th className="py-3 text-right font-bold">Comisión</th>
                </tr>
              </thead>
              <tbody>
                {comm.rows.map((r) => (
                  <tr key={r.providerId ?? "none"} className="border-t border-neutral-900">
                    <td className="py-3 font-semibold">{r.providerName}</td>
                    <td className="py-3 text-right tabular-nums">{money(r.total)}</td>
                    <td className="py-3 text-right font-bold tabular-nums">{money(r.commission)}</td>
                  </tr>
                ))}
                {admin && comm.rows.length > 1 && (
                  <tr className="border-t border-neutral-800">
                    <td className="py-3 text-neutral-400">Total</td>
                    <td className="py-3 text-right tabular-nums">{money(comm.rows.reduce((n, r) => n + r.total, 0))}</td>
                    <td className="py-3 text-right font-bold tabular-nums">{money(comm.rows.reduce((n, r) => n + r.commission, 0))}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Mes / semana: día por día */}
      {period !== "dia" && days.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[17px] font-bold">Día por día</h2>
          <div className="flex flex-col">
            {days.map(([d, x]) => (
              <button
                key={d}
                onClick={() => openDay(d)}
                className="flex min-h-[44px] items-center gap-4 border-b border-neutral-900 px-1 text-left transition-colors hover:bg-neutral-900"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold">{d === today ? "Hoy" : cap(dayName(d))}</span>
                  <span className="text-[13px] text-neutral-400">
                    {x.visits.size} {x.visits.size === 1 ? "anotación" : "anotaciones"}
                  </span>
                </span>
                <span className="text-[14px] font-semibold tabular-nums">{money(x.total)}</span>
                <CaretRightIcon size={18} className="text-neutral-500" />
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Día: el detalle */}
      {period === "dia" && data && visits.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[17px] font-bold">Detalle</h2>
          <div className="flex flex-col gap-2.5">
            {visits.map((v) => (
              <VisitCard
                key={v.key}
                v={v}
                admin={admin}
                seesCommission={seesCommission}
                canEdit={admin || v.sales[0].createdAt.slice(0, 10) === today}
                onEdit={() => setEditing(v.sales)}
                onMethod={setMethod}
                onVoid={voidVisit}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

interface Visit {
  key: string;
  time: string;
  patient: string | null;
  sales: SaleRow[];
}

/** Lo anotado junto (mismo visitId) va en una sola tarjeta; las ventas viejas, una por tarjeta. */
function groupVisits(sales: SaleRow[]): Visit[] {
  const m = new Map<string, SaleRow[]>();
  for (const s of sales) {
    const k = s.visitId ?? s.id;
    m.set(k, [...(m.get(k) ?? []), s]);
  }
  return [...m.entries()].map(([key, list]) => ({
    key,
    time: fmtTime(list[list.length - 1].createdAt),
    patient: list.find((s) => s.patientName)?.patientName ?? null,
    sales: list,
  }));
}

const itemLabel = (s: SaleRow) => `${s.kind === "producto" || s.quantity > 1 ? `${s.quantity} ` : ""}${s.itemName}${s.kind === "pendiente" ? " (sin cargar)" : ""}`;

function VisitCard({
  v,
  admin,
  seesCommission,
  canEdit,
  onEdit,
  onMethod,
  onVoid,
}: {
  v: Visit;
  admin: boolean;
  seesCommission: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onMethod: (ids: string[], m: Payment) => void;
  onVoid: (ids: string[], reason: string) => void;
}) {
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const paid = v.sales.filter((s) => s.status === "paid");
  const voided = paid.length === 0;
  const first = v.sales[0];
  const methods = [...new Set(paid.map((s) => s.paymentMethod))];
  const method = methods.length === 1 ? methods[0] : null;
  const pending = paid.filter((s) => !s.paymentMethod).map((s) => s.id);
  const cashT = paid.reduce((n, s) => n + s.cashTotal, 0);
  const cardT = paid.reduce((n, s) => n + s.cardTotal, 0);
  const commission = paid.reduce((n, s) => n + s.commissionAmount, 0);
  const items = v.sales.map(itemLabel).join(", ");

  return (
    <div className={`flex flex-col gap-3 rounded-[20px] bg-surface px-5 py-4 ${voided ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-4">
        <span className="pt-0.5 text-[13.5px] tabular-nums text-neutral-500">{v.time}</span>
        <span className="min-w-0 flex-1">
          <span className={`block text-[15px] font-semibold leading-snug ${voided ? "line-through" : ""}`}>{v.patient ?? items}</span>
          {v.patient && <span className={`block text-[13.5px] text-neutral-300 ${voided ? "line-through" : ""}`}>{items}</span>}
          <span className="mt-0.5 block text-[13px] text-neutral-400">
            {[
              first.providerName ?? "Sin médica",
              !voided && method ? PAYMENT_LABEL[method] : null,
              seesCommission && !voided && commission > 0 ? `comisión ${money(commission)}` : null,
              admin && first.createdByName !== first.providerName ? `anotó ${first.createdByName}` : null,
              voided ? `anulado: ${first.voidReason}` : paid.length < v.sales.length ? "una parte anulada" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        {!voided && <Amount cash={cashT} card={cardT} method={pending.length ? null : method} className="text-[14px] font-semibold" />}
      </div>

      {!voided && (pending.length > 0 || admin || canEdit) && !voiding && (
        <div className="flex flex-wrap items-center gap-2 sm:pl-[52px]">
          {pending.length > 0 && (
            <>
              <span className="text-[13px] text-neutral-400">¿Cómo pagó?</span>
              {(["efectivo", "tarjeta"] as Payment[]).map((m) => (
                <button key={m} className={CHIP} onClick={() => onMethod(pending, m)}>
                  {PAYMENT_LABEL[m]}
                </button>
              ))}
            </>
          )}
          <span className="flex-1" />
          {canEdit && (
            <button className={CHIP} onClick={onEdit}>
              Editar
            </button>
          )}
          {admin && (
            <button className={`${CHIP} text-neutral-400`} onClick={() => setVoiding(true)}>
              Anular
            </button>
          )}
        </div>
      )}
      {voiding && (
        <div className="flex flex-wrap gap-2 sm:pl-[52px]">
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (ej. se anotó dos veces)" className={`${FIELD} !w-auto min-w-[200px] flex-1`} />
          <button className={BTN_DARK} disabled={!reason.trim()} onClick={() => onVoid(paid.map((s) => s.id), reason)}>
            Anular
          </button>
          <button className={BTN} onClick={() => setVoiding(false)}>
            Cancelar
          </button>
        </div>
      )}
    </div>
  );
}

const NAV =
  "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-neutral-800 text-fg transition-colors hover:bg-neutral-900 disabled:opacity-25 disabled:hover:bg-transparent";
const CHIP = "rounded-full border-2 border-neutral-800 px-3.5 py-1.5 text-[13px] font-semibold transition-colors hover:border-accent-600";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-[13px] text-neutral-400">{label}</span>
      <span className="truncate text-[16px] font-semibold tabular-nums">{value}</span>
      {sub && <span className="text-[14px] leading-snug text-neutral-500">{sub}</span>}
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
      <div className="flex h-6 items-baseline justify-between text-[13px]">
        {shown ? (
          <>
            <span className="text-neutral-300">{cap(dayName(shown.d))}</span>
            <span className="tabular-nums text-fg">
              {money(shown.total)} <span className="text-neutral-500">· {shown.count} {shown.count === 1 ? "venta" : "ventas"}</span>
            </span>
          </>
        ) : (
          <span className="text-neutral-500">Tocá un día para ver el detalle</span>
        )}
      </div>
      <div className="flex h-28 items-end gap-[2px] border-b border-neutral-800" onMouseLeave={() => setHover(null)}>
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
                  x.total === 0 ? "h-0" : hover === x.d ? "bg-accent" : "bg-accent-600 group-hover:bg-accent"
                }`}
                style={x.total ? { height: `${Math.max(4, (x.total / max) * 100)}%` } : undefined}
              />
            </button>
          );
        })}
      </div>
      <div className="flex gap-[2px] text-[12px] tabular-nums text-neutral-500">
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
      className="absolute left-1/2 top-14 z-30 w-[340px] max-w-[calc(100vw-32px)] -translate-x-1/2 animate-cl-in rounded-[20px] border-2 border-neutral-800 bg-surface p-4 shadow-lg"
      role="dialog"
      aria-label="Calendario"
    >
      <div className="mb-3 flex items-center gap-2">
        <button aria-label="Mes anterior" onClick={() => move(-1)} className={CAL_NAV}>
          <CaretLeftIcon size={14} />
        </button>
        <span className="flex-1 text-center text-[14px] font-semibold">{cap(`${MONTH[f.getMonth()]} ${f.getFullYear()}`)}</span>
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
              className={`relative mx-auto flex h-10 w-10 flex-col items-center justify-center rounded-full text-[13px] tabular-nums transition-colors disabled:opacity-25 ${
                d === selected ? "bg-accent text-on-accent" : d === today ? "border border-neutral-600 text-fg hover:bg-accent-900" : "text-neutral-200 hover:bg-accent-900"
              }`}
            >
              {Number(d.slice(8))}
              {totals.has(d) && (
                <span className={`absolute bottom-1 h-1 w-1 rounded-full ${d === selected ? "bg-on-accent" : "bg-accent"}`} aria-hidden />
              )}
            </button>
          ),
        )}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-neutral-800 pt-3 text-[12px] text-neutral-400">
        <span className="flex items-center gap-1.5">
          <span className="h-1 w-1 rounded-full bg-accent" aria-hidden /> días con ventas
        </span>
        <span className="tabular-nums">{data ? `Mes: ${money(monthTotal)}` : "…"}</span>
      </div>
      <button onClick={() => onPick(today)} className="mt-2 min-h-11 w-full rounded-xl text-[13px] font-semibold text-neutral-200 transition-colors hover:bg-neutral-900">
        Ir a hoy
      </button>
    </div>
  );
}

const CAL_NAV =
  "flex h-10 w-10 items-center justify-center rounded-xl text-neutral-400 transition-colors hover:bg-accent-900 hover:text-fg disabled:opacity-25 disabled:hover:bg-transparent";
