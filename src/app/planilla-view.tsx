"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import { CaretLeftIcon, CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { normalize, parseNote } from "@/lib/domain/quick-sale";
import { ExpenseForm, type Expense, type ExpensesResponse } from "./egresos";
import { Toast, call, fmtTime, money, usePoll, useToast, useToday, type CatalogResponse, type Payment, type SaleRow } from "./shared";

/**
 * Planilla del día: la misma hoja que la secretaria llena en papel. Ingresos y egresos extras, caja al
 * cambio, una sección por área (Médicos, Kinesiología, Auxiliares, Médicos externos) con filas que se
 * escriben directo, y el resumen diario. Cada fila es una anotación (`/api/visits`): lo que se anota acá
 * aparece en Anotar, Cierre y Ventas, y al revés.
 *
 *  · Abona: lo que entró a caja por la práctica (viene de la lista, se puede pisar; vacío = no pasó por caja).
 *  · Observaciones: lo que se vendió («contorno de ojos 50000»); los productos de la lista se cobran y
 *    descuentan stock, el resto queda como nota.
 *  · $K: la parte de la profesional (sale de su %, se puede pisar). $D = lo cobrado − $K.
 */

type Area = "medicos" | "kinesiologia" | "auxiliares" | "externos";
const AREAS: { id: Area; title: string; who: string }[] = [
  { id: "medicos", title: "Médicos", who: "Médico" },
  { id: "kinesiologia", title: "Kinesiología", who: "Kinesióloga" },
  { id: "auxiliares", title: "Auxiliares", who: "Profesional" },
  { id: "externos", title: "Médicos externos", who: "Médico" },
];

interface Seller {
  id: string;
  name: string;
  area: Area;
}
interface Item {
  id: string;
  name: string;
  price: number;
  cardPrice: number | null;
  providerIds: string[];
}

/** Una fila de la planilla = una anotación. */
interface Row {
  key: string;
  sales: SaleRow[];
  time: string;
  patient: string;
  practice: string;
  providerId: string | null;
  abona: number;
  method: Payment | null;
  obs: string;
  products: number;
  k: number;
  kManual: boolean;
  total: number;
}

const METHOD_SHORT: Record<Payment, string> = { efectivo: "Efvo.", transferencia: "Transf.", tarjeta: "Tarj." };
const GENERIC = "Atención";
const num = (s: string) => Number(s.replace(/\D/g, "") || 0);

const shift = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const shortDate = (ymd: string) => `${Number(ymd.slice(8, 10))}/${Number(ymd.slice(5, 7))}`;

function toRows(sales: SaleRow[]): Row[] {
  const byVisit = new Map<string, SaleRow[]>();
  for (const s of sales) {
    if (s.status !== "paid") continue;
    const k = s.visitId ?? s.id;
    byVisit.set(k, [...(byVisit.get(k) ?? []), s]);
  }
  return [...byVisit.entries()]
    .map(([key, g]) => {
      const practices = g.filter((s) => s.kind !== "producto");
      const products = g.filter((s) => s.kind === "producto");
      const generic = (s: SaleRow) => !s.itemId && s.kind !== "pendiente" && s.itemName === GENERIC;
      const obs =
        g[0].observations ||
        products.map((s) => `${s.itemName}${s.quantity > 1 ? ` x${s.quantity}` : ""} ${s.total.toLocaleString("es-AR")}`).join(", ");
      const total = g.reduce((n, s) => n + s.total, 0);
      const k = g.reduce((n, s) => n + s.commissionAmount, 0);
      return {
        key,
        sales: g,
        time: fmtTime(g[g.length - 1].createdAt),
        patient: g[0].patientName ?? "",
        practice: practices
          .filter((s) => !generic(s))
          .map((s) => `${s.itemName}${s.quantity > 1 ? ` x${s.quantity}` : ""}`)
          .join(", "),
        providerId: g[0].providerId,
        abona: practices.reduce((n, s) => n + s.total, 0),
        method: g[0].paymentMethod,
        obs,
        products: products.reduce((n, s) => n + s.total, 0),
        k,
        kManual: g.some((s) => s.commissionManual),
        total,
      };
    })
    .sort((a, b) => a.sales[0].createdAt.localeCompare(b.sales[0].createdAt));
}

/** «Masaje x2» → práctica de la lista (o null = no está cargada) y cantidad. */
function matchPractice(text: string, items: Item[]): { item: Item | null; qty: number; name: string } {
  let t = text.trim();
  let qty = 1;
  const m = t.match(/\s*[x×*]\s*(\d{1,2})\s*$/i) ?? t.match(/^(\d{1,2})\s+/);
  if (m) {
    qty = Math.max(1, Number(m[1]));
    t = t.replace(m[0], " ").trim();
  }
  if (!t) return { item: null, qty, name: "" };
  const n = normalize(t);
  const exact = items.find((i) => normalize(i.name) === n) ?? items.find((i) => normalize(i.name).startsWith(n));
  if (exact) return { item: exact, qty, name: t };
  const p = parseNote(t, items);
  const l = p.lines[0];
  return { item: l?.match ?? l?.candidates[0] ?? null, qty, name: t };
}

/** Observaciones → productos de la lista (con su importe si se escribió) y el resto como nota. */
function productsIn(text: string, items: Item[]): { item: Item; qty: number; amount: number | null }[] {
  const out: { item: Item; qty: number; amount: number | null }[] = [];
  for (const seg of text.split(/[,;+\n]|\s+y\s+/i)) {
    let t = seg.trim();
    if (!t) continue;
    let amount: number | null = null;
    const a = t.match(/\$?\s*(\d{1,3}(?:\.\d{3})+|\d{3,})\b/);
    if (a) {
      amount = num(a[1]);
      t = t.replace(a[0], " ");
    }
    let qty = 1;
    const q = t.match(/\s*[x×]\s*(\d{1,2})\b/i) ?? t.match(/^\s*(\d{1,2})\s+/);
    if (q) {
      qty = Number(q[1]);
      t = t.replace(q[0], " ");
    }
    if (t.trim().length < 3) continue;
    const l = parseNote(t, items).lines[0];
    const it = l?.match ?? null;
    if (it) out.push({ item: it, qty, amount });
  }
  return out;
}

/**
 * `date` controlado (Ventas → Día) o propio. `bare`: sin el encabezado (título, fecha, Imprimir), cuando
 * la pantalla que la contiene ya los tiene.
 */
export function PlanillaView({ actor, date: dateProp, bare }: { actor: Actor; date?: string; bare?: boolean }) {
  const today = useToday();
  const [picked, setPicked] = useState<string | null>(null);
  const date = dateProp ?? picked ?? today;
  const setDate = (d: string) => setPicked(d === today ? null : d);
  const admin = !!actor.activeOrg?.canAdmin;
  const canEdit = admin || date === today;

  const [sales, refreshSales] = usePoll<{ ok: boolean; sales: SaleRow[] }>(`/api/sales?from=${date}&to=${date}&limit=500`, 30_000);
  const [catalog, refreshCatalog] = usePoll<CatalogResponse>("/api/catalog", 60_000);
  const [sellersData] = usePoll<{ ok: boolean; sellers: { providerId: string; name: string; area: Area }[] }>("/api/sellers", 60_000);
  const [egr, refreshEgr] = usePoll<ExpensesResponse>(`/api/expenses?from=${date}&to=${date}`, 30_000);
  const [ing, refreshIng] = usePoll<ExpensesResponse>(`/api/expenses?from=${date}&to=${date}&direction=ingreso`, 30_000);
  const [cash, refreshCash] = usePoll<{ ok: boolean; cash: { amount: number | null } }>(`/api/day-cash?date=${date}`, 60_000);
  const [toast, showToast] = useToast();
  const [form, setForm] = useState<{ direction: "egreso" | "ingreso"; expense?: Expense } | null>(null);

  const sellers: Seller[] = useMemo(() => (sellersData?.sellers ?? []).map((s) => ({ id: s.providerId, name: s.name, area: s.area ?? "medicos" })), [sellersData]);
  const practices: Item[] = useMemo(
    () => (catalog?.practices ?? []).map((p) => ({ id: p.id, name: p.name, price: p.price, cardPrice: p.cardPrice, providerIds: p.providerIds ?? [] })),
    [catalog],
  );
  const products: Item[] = useMemo(
    () =>
      (catalog?.products ?? [])
        .filter((p) => p.priceItemId && p.price !== null)
        .map((p) => ({ id: p.priceItemId!, name: p.name, price: p.price!, cardPrice: p.cardPrice, providerIds: p.providerIds ?? [] })),
    [catalog],
  );
  const rows = useMemo(() => toRows(sales?.ok ? sales.sales : []), [sales]);
  const areaOf = (providerId: string | null): Area => sellers.find((s) => s.id === providerId)?.area ?? "medicos";

  const egresos = egr?.ok ? egr.expenses : [];
  const ingresos = ing?.ok ? ing.expenses : [];
  const egTotal = egresos.reduce((n, e) => n + e.amount, 0);
  const inTotal = ingresos.reduce((n, e) => n + e.amount, 0);
  const sections = AREAS.filter((a) => a.id === "medicos" || sellers.some((s) => s.area === a.id) || rows.some((r) => areaOf(r.providerId) === a.id));

  const byMethod = (m: Payment | null) => rows.filter((r) => r.method === m).reduce((n, r) => n + r.total, 0);
  const collected = rows.reduce((n, r) => n + r.total, 0);
  const kTotal = rows.reduce((n, r) => n + r.k, 0);
  const declesTotal = collected - kTotal;
  const efectivo = byMethod("efectivo");
  const sinMedio = byMethod(null);

  function refreshAll() {
    refreshSales();
    refreshCatalog();
  }

  return (
    <div className={`cl-print-area flex w-full flex-col gap-6 text-[13.5px] ${bare ? "" : "mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-6 sm:pt-8"}`}>
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

      {!bare && (
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-[22px] font-medium tracking-[-.01em]">Planilla</h1>
        <div className="flex items-center gap-1 text-[14px]">
          <span className="text-neutral-400">Fecha:</span>
          <button aria-label="Día anterior" onClick={() => setDate(shift(date, -1))} className={`${NAV} cl-no-print`}>
            <CaretLeftIcon size={16} weight="bold" />
          </button>
          <span className="min-w-[48px] text-center font-medium tabular-nums">{shortDate(date)}</span>
          <button aria-label="Día siguiente" onClick={() => setDate(shift(date, 1))} disabled={date >= today} className={`${NAV} cl-no-print`}>
            <CaretRightIcon size={16} weight="bold" />
          </button>
          {date !== today && (
            <button onClick={() => setDate(today)} className="cl-no-print ml-1 text-[13px] text-neutral-400 underline-offset-4 hover:text-fg hover:underline">
              Hoy
            </button>
          )}
        </div>
        <span className="flex-1" />
        <button onClick={() => window.print()} className={`${BTN} cl-no-print`}>
          Imprimir
        </button>
      </div>
      )}
      {!canEdit && <p className="cl-no-print -mt-3 text-[13px] text-neutral-500">Lo de días anteriores lo corrige el admin.</p>}

      {/* Ingresos extras · Egresos extras · Caja */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1fr_220px]">
        <MoneyList
          title="Ingresos extras"
          list={ingresos}
          total={inTotal}
          canEdit={canEdit}
          onAdd={() => setForm({ direction: "ingreso" })}
          onOpen={(e) => setForm({ direction: "ingreso", expense: e })}
        />
        <MoneyList
          title="Egresos extras"
          list={egresos}
          total={egTotal}
          canEdit={canEdit}
          onAdd={() => setForm({ direction: "egreso" })}
          onOpen={(e) => setForm({ direction: "egreso", expense: e })}
        />
        <CashBox
          key={`${date}:${cash?.cash?.amount ?? ""}`}
          amount={cash?.ok ? cash.cash.amount : null}
          canEdit={canEdit}
          onSave={async (amount) => {
            const r = await call("/api/day-cash", "PUT", { date, amount });
            if (!r.ok) return showToast(r.error ?? "No se pudo guardar.");
            refreshCash();
          }}
        />
      </div>

      {!sales || !catalog || !sellersData ? (
        <p className="text-neutral-500">Cargando…</p>
      ) : (
        sections.map((a) => (
          <AreaSection
            key={a.id}
            area={a}
            rows={rows.filter((r) => areaOf(r.providerId) === a.id)}
            sellers={sellers.filter((s) => s.area === a.id)}
            allSellers={sellers}
            practices={practices}
            products={products}
            canEdit={canEdit}
            onSaved={refreshAll}
            onError={showToast}
          />
        ))
      )}

      {/* Resumen diario */}
      <section className="flex flex-col gap-2 rounded-xl border border-neutral-800 p-4">
        <h2 className="text-[12px] font-medium uppercase tracking-[.08em] text-neutral-400">Resumen diario</h2>
        <div className="grid grid-cols-1 gap-x-10 gap-y-1 md:grid-cols-2">
          <div className="flex flex-col">
            <Line label="Ingresos extras" value={inTotal} />
            {sections.map((a) => {
              const rs = rows.filter((r) => areaOf(r.providerId) === a.id);
              const d = rs.reduce((n, r) => n + r.total - r.k, 0);
              return <Line key={a.id} label={`Total Decles ${a.title.toLowerCase()}`} value={d} />;
            })}
            <Line label="Egresos extras" value={-egTotal} />
            <Line label="Subtotal Decles" value={declesTotal + inTotal - egTotal} strong />
          </div>
          <div className="flex flex-col">
            <Line label="Efectivo" value={efectivo} />
            <Line label="Transferencias" value={byMethod("transferencia")} />
            <Line label="Tarjetas" value={byMethod("tarjeta")} />
            {sinMedio > 0 && <Line label="Sin medio cargado" value={sinMedio} />}
            <Line label="Profesionales ($K)" value={-kTotal} />
            <Line
              label="Efectivo que debería haber (efectivo + ingresos − egresos)"
              value={efectivo + inTotal - egTotal}
              strong
            />
            {cash?.ok && cash.cash.amount !== null && (
              <Line label="Contado en caja al cambio" value={cash.cash.amount} hint={cash.cash.amount - (efectivo + inTotal - egTotal)} />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Line({ label, value, strong, hint }: { label: string; value: number; strong?: boolean; hint?: number }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 border-b border-neutral-900 py-1.5 ${strong ? "font-medium" : ""}`}>
      <span className={strong ? "" : "text-neutral-300"}>{label}</span>
      <span className="whitespace-nowrap tabular-nums">
        {value < 0 ? `− ${money(-value)}` : money(value)}
        {hint !== undefined && hint !== 0 && (
          <span className="ml-2 text-[12px] text-neutral-500">({hint > 0 ? "sobran" : "faltan"} {money(Math.abs(hint))})</span>
        )}
      </span>
    </div>
  );
}

function MoneyList({
  title,
  list,
  total,
  canEdit,
  onAdd,
  onOpen,
}: {
  title: string;
  list: Expense[];
  total: number;
  canEdit: boolean;
  onAdd: () => void;
  onOpen: (e: Expense) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-[12px] font-medium uppercase tracking-[.08em] text-neutral-400">{title}</span>
        {canEdit && (
          <button onClick={onAdd} className="cl-no-print inline-flex items-center gap-1 text-[12.5px] text-neutral-300 hover:text-fg">
            <PlusIcon size={12} weight="bold" /> Agregar
          </button>
        )}
      </div>
      <div className="grid grid-cols-[1fr_auto] text-[13px]">
        <span className="border-b border-neutral-900 px-3 py-1 text-[11.5px] text-neutral-500">en concepto de</span>
        <span className="border-b border-neutral-900 px-3 py-1 text-right text-[11.5px] text-neutral-500">monto $</span>
        {list.map((e) => (
          <Fragment key={e.id}>
            <button disabled={!canEdit} onClick={() => onOpen(e)} className="truncate border-b border-neutral-900 px-3 py-1.5 text-left enabled:hover:bg-neutral-900">
              {e.concept}
            </button>
            <button disabled={!canEdit} onClick={() => onOpen(e)} className="border-b border-neutral-900 px-3 py-1.5 text-right tabular-nums enabled:hover:bg-neutral-900">
              {money(e.amount)}
            </button>
          </Fragment>
        ))}
        {!list.length && <span className="col-span-2 px-3 py-1.5 text-neutral-600">—</span>}
        <span className="px-3 py-1.5 text-right text-neutral-500">total</span>
        <span className="px-3 py-1.5 text-right font-medium tabular-nums">{money(total)}</span>
      </div>
    </div>
  );
}

function CashBox({ amount, canEdit, onSave }: { amount: number | null; canEdit: boolean; onSave: (n: number | null) => void }) {
  const [v, setV] = useState(amount === null ? "" : String(amount));
  const save = () => {
    const n = v.trim() === "" ? null : num(v);
    if (n !== amount) onSave(n);
  };
  return (
    <label className="flex flex-col justify-between gap-2 rounded-xl border border-neutral-800 p-3">
      <span className="text-[12px] font-medium uppercase leading-snug tracking-[.08em] text-neutral-400">Dinero en caja al momento del cambio</span>
      <input
        value={v ? `$ ${num(v).toLocaleString("es-AR")}` : ""}
        disabled={!canEdit}
        onChange={(e) => setV(e.target.value.replace(/\D/g, ""))}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        inputMode="numeric"
        placeholder="$"
        className={`${CELL} rounded-md border border-neutral-800 text-[16px] tabular-nums`}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Una sección (área) de la planilla
// ---------------------------------------------------------------------------

function AreaSection({
  area,
  rows,
  sellers,
  allSellers,
  practices,
  products,
  canEdit,
  onSaved,
  onError,
}: {
  area: (typeof AREAS)[number];
  rows: Row[];
  sellers: Seller[];
  allSellers: Seller[];
  practices: Item[];
  products: Item[];
  canEdit: boolean;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [newKey, setNewKey] = useState(0);
  const total = rows.reduce((n, r) => n + r.abona, 0);
  const byPro = sellers
    .map((s) => ({ s, k: rows.filter((r) => r.providerId === s.id).reduce((n, r) => n + r.k, 0) }))
    .filter((x) => x.k > 0 || sellers.length > 1);
  const decles = rows.reduce((n, r) => n + r.total - r.k, 0);
  const pickable = sellers.length ? sellers : allSellers;
  const areaPractices = practices.filter((p) => !p.providerIds.length || p.providerIds.some((id) => pickable.some((s) => s.id === id)));

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[14px] font-medium uppercase tracking-[.06em]">
        {area.title}
        {sellers.length > 0 && <span className="ml-2 text-[12.5px] font-normal normal-case tracking-normal text-neutral-500">({sellers.map((s) => s.name).join(" · ")})</span>}
      </h2>
      {!sellers.length && area.id !== "medicos" && (
        <p className="cl-no-print text-[12.5px] text-neutral-500">No hay profesionales en esta área. Se asignan en Equipo.</p>
      )}
      <div className="overflow-x-auto rounded-xl border border-neutral-800">
        <table className="w-full min-w-[960px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-neutral-800 text-left text-[11.5px] uppercase tracking-[.06em] text-neutral-500">
              <th className="w-[44px] px-2 py-2 font-medium">Hora</th>
              <th className="w-[17%] px-2 py-2 font-medium">Paciente</th>
              <th className="w-[17%] px-2 py-2 font-medium">Práctica</th>
              <th className="w-[13%] px-2 py-2 font-medium">{area.who}</th>
              <th className="w-[10%] px-2 py-2 text-right font-medium">Abona $</th>
              <th className="w-[72px] px-2 py-2 font-medium">Medio</th>
              <th className="px-2 py-2 font-medium">Observaciones</th>
              <th className="w-[9%] px-2 py-2 text-right font-medium">$K</th>
              <th className="w-[9%] px-2 py-2 text-right font-medium">$D</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) =>
              editing === r.key ? (
                <RowEditor
                  key={r.key}
                  row={r}
                  sellers={pickable}
                  practices={areaPractices}
                  products={products}
                  onCancel={() => setEditing(null)}
                  onSaved={() => {
                    setEditing(null);
                    onSaved();
                  }}
                  onError={onError}
                />
              ) : (
                <tr
                  key={r.key}
                  onClick={() => canEdit && setEditing(r.key)}
                  className={`border-b border-neutral-900 ${canEdit ? "cursor-pointer hover:bg-neutral-900" : ""}`}
                >
                  <td className="px-2 py-1.5 tabular-nums text-neutral-500">{r.time}</td>
                  <td className="truncate px-2 py-1.5">{r.patient || <span className="text-neutral-600">—</span>}</td>
                  <td className="truncate px-2 py-1.5">{r.practice}</td>
                  <td className="truncate px-2 py-1.5 text-neutral-300">{allSellers.find((s) => s.id === r.providerId)?.name ?? r.sales[0].providerName ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.abona ? money(r.abona) : <span className="text-neutral-500">—</span>}</td>
                  <td className="px-2 py-1.5 text-neutral-400">{r.method ? METHOD_SHORT[r.method] : ""}</td>
                  <td className="truncate px-2 py-1.5 text-neutral-300">{r.obs}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.k ? money(r.k) : <span className="text-neutral-500">—</span>}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${r.total - r.k < 0 ? "text-neutral-400" : ""}`}>{fmtSigned(r.total - r.k)}</td>
                </tr>
              ),
            )}
            {canEdit && editing === null && (
              <RowEditor
                key={`new${newKey}`}
                sellers={pickable}
                practices={areaPractices}
                products={products}
                onSaved={() => {
                  setNewKey((n) => n + 1);
                  onSaved();
                }}
                onError={onError}
              />
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-neutral-800 text-[13px]">
              <td colSpan={4} className="px-2 py-2 text-right text-neutral-500">
                total
              </td>
              <td className="px-2 py-2 text-right font-medium tabular-nums">{money(total)}</td>
              <td colSpan={2} className="px-2 py-2 text-right text-neutral-500">
                {byPro.map((x) => (
                  <span key={x.s.id} className="ml-4 whitespace-nowrap">
                    total {x.s.name.replace(/^(Dra?\.|Lic\.|Klga\.)\s*/i, "").split(" ")[0]} <b className="font-medium tabular-nums text-fg">{money(x.k)}</b>
                  </span>
                ))}
              </td>
              <td className="px-2 py-2 text-right font-medium tabular-nums">{money(rows.reduce((n, r) => n + r.k, 0))}</td>
              <td className="px-2 py-2 text-right font-medium tabular-nums" title="total Decles = cobrado − profesionales">
                {fmtSigned(decles)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

const fmtSigned = (n: number) => (n < 0 ? `− ${money(-n)}` : money(n));

/** Una fila que se escribe. Enter guarda; Escape cancela. */
function RowEditor({
  row,
  sellers,
  practices,
  products,
  onCancel,
  onSaved,
  onError,
}: {
  row?: Row;
  sellers: Seller[];
  practices: Item[];
  products: Item[];
  onCancel?: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [patient, setPatient] = useState(row?.patient ?? "");
  const [practice, setPractice] = useState(row?.practice ?? "");
  const [providerId, setProviderId] = useState<string>(row?.providerId ?? (sellers.length === 1 ? sellers[0].id : ""));
  const [abona, setAbona] = useState(row ? (row.abona ? String(row.abona) : "") : "");
  const [abonaTouched, setAbonaTouched] = useState(!!row);
  const [method, setMethod] = useState<Payment | "">(row?.method ?? "");
  const [obs, setObs] = useState(row?.obs ?? "");
  const [k, setK] = useState(row?.kManual ? String(row.k) : "");
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  const match = useMemo(() => matchPractice(practice, practices), [practice, practices]);
  const sold = useMemo(() => productsIn(obs, products), [obs, products]);
  const priceOf = (it: Item, qty: number) => (method === "tarjeta" ? (it.cardPrice ?? it.price) : it.price) * qty;
  // Abona: el precio de lista hasta que se escriba otro.
  const abonaValue = !abonaTouched && match.item ? priceOf(match.item, match.qty) : num(abona);
  const productsTotal = sold.reduce((n, p) => n + (p.amount ?? priceOf(p.item, p.qty)), 0);
  // Una fila con varias prácticas (anotada desde Anotar): esas prácticas se conservan tal cual.
  const kept = row ? row.sales.filter((s) => s.kind !== "producto") : [];
  const multi = kept.length > 1;
  const kValue = k.trim() === "" ? null : num(k);
  const dirty = !row ? !!(patient.trim() || practice.trim() || abona || obs.trim() || k) : true;

  async function save() {
    if (busy) return;
    if (!dirty) return;
    if (!providerId) return onError("Elegí la profesional.");
    const lines: object[] = [];
    if (multi) {
      kept.forEach((s, i) => {
        const commission = i === 0 ? kValue : null;
        if (s.itemId) lines.push({ itemId: s.itemId, quantity: s.quantity, amount: s.priceManual ? s.total : undefined, commission });
        else if (s.kind === "pendiente") lines.push({ pendingName: s.itemName, pendingPrice: s.unitPrice || null, quantity: s.quantity, commission });
        else lines.push({ generic: true, amount: s.total, commission });
      });
    } else if (practice.trim()) {
      if (match.item) lines.push({ itemId: match.item.id, quantity: match.qty, amount: abonaValue, commission: kValue });
      else lines.push({ pendingName: match.name || practice.trim(), pendingPrice: abonaValue || null, quantity: match.qty, amount: abonaValue, commission: kValue });
    } else if (abonaValue > 0 || kValue !== null || !sold.length) {
      lines.push({ generic: true, amount: abonaValue, commission: kValue });
    }
    for (const p of sold) lines.push({ itemId: p.item.id, quantity: p.qty, amount: p.amount ?? undefined });
    const body = { patientName: patient, providerId, paymentMethod: method || null, observations: obs, lines };
    setBusy(true);
    const r = row ? await call(`/api/visits/${row.key}`, "PUT", body) : await call("/api/visits", "POST", body);
    setBusy(false);
    if (!r.ok) return onError(r.error ?? "No se pudo guardar.");
    onSaved();
    if (!row) requestAnimationFrame(() => first.current?.focus());
  }

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") onCancel?.();
  };
  const listId = `pr-${row?.key ?? "new"}`;

  return (
    <tr className="border-b border-neutral-800 bg-surface align-top" onKeyDown={keys}>
      <td className="px-2 py-1.5 tabular-nums text-neutral-500">{row ? row.time : <PlusIcon size={12} className="mt-2" />}</td>
      <td className="px-1 py-1">
        <input ref={first} autoFocus={!!row} value={patient} onChange={(e) => setPatient(e.target.value)} placeholder="Paciente" className={CELL} />
      </td>
      <td className="px-1 py-1">
        <input list={listId} value={practice} disabled={multi} onChange={(e) => setPractice(e.target.value)} placeholder="Práctica" className={CELL} />
        <datalist id={listId}>
          {practices.map((p) => (
            <option key={p.id} value={p.name} />
          ))}
        </datalist>
        {practice.trim() && !multi && (
          <span className="block px-1.5 text-[11.5px] text-neutral-500">{match.item ? `${match.item.name}${match.qty > 1 ? ` ×${match.qty}` : ""}` : "no está en la lista: va como pendiente"}</span>
        )}
      </td>
      <td className="px-1 py-1">
        <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={`${CELL} pr-1`}>
          {sellers.length !== 1 && <option value="">Elegí…</option>}
          {sellers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </td>
      <td className="px-1 py-1">
        <input
          value={multi ? (row?.abona ?? 0).toLocaleString("es-AR") : abonaValue ? abonaValue.toLocaleString("es-AR") : ""}
          disabled={multi}
          onChange={(e) => {
            setAbonaTouched(true);
            setAbona(e.target.value.replace(/\D/g, ""));
          }}
          inputMode="numeric"
          placeholder="—"
          className={`${CELL} text-right tabular-nums`}
        />
      </td>
      <td className="px-1 py-1">
        <select value={method} onChange={(e) => setMethod(e.target.value as Payment | "")} className={`${CELL} pr-1`}>
          <option value="">—</option>
          <option value="efectivo">Efvo.</option>
          <option value="transferencia">Transf.</option>
          <option value="tarjeta">Tarj.</option>
        </select>
      </td>
      <td className="px-1 py-1">
        <input value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Productos vendidos, notas…" className={CELL} />
        {sold.length > 0 && (
          <span className="block px-1.5 text-[11.5px] text-neutral-500">
            {sold.map((p) => `${p.item.name}${p.qty > 1 ? ` ×${p.qty}` : ""} ${money(p.amount ?? priceOf(p.item, p.qty))}`).join(" · ")} · descuenta stock
          </span>
        )}
      </td>
      <td className="px-1 py-1">
        <input
          value={k ? num(k).toLocaleString("es-AR") : ""}
          onChange={(e) => setK(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder={row && !row.kManual && row.k ? money(row.k) : "auto"}
          title="La parte de la profesional. Vacío = según su comisión."
          className={`${CELL} text-right tabular-nums`}
        />
      </td>
      <td className="px-2 py-1.5 text-right">
        <div className="flex flex-col items-end gap-1">
          <span className="tabular-nums text-neutral-400">{kValue !== null ? fmtSigned(abonaValue + productsTotal - kValue) : ""}</span>
          <span className="flex gap-1">
            {row && (
              <button onClick={onCancel} className="rounded-md px-1.5 py-0.5 text-[12px] text-neutral-400 hover:text-fg">
                Cancelar
              </button>
            )}
            <button
              onClick={save}
              disabled={busy || !dirty}
              className="rounded-md border border-accent bg-accent px-2 py-0.5 text-[12px] font-medium text-on-accent disabled:border-neutral-800 disabled:bg-transparent disabled:text-neutral-600"
            >
              {busy ? "…" : "Guardar"}
            </button>
          </span>
        </div>
      </td>
    </tr>
  );
}

const CELL =
  "w-full min-w-0 rounded-sm border border-transparent bg-transparent px-1.5 py-1 text-[13px] text-fg outline-none placeholder:text-neutral-600 focus:border-accent-700 focus:bg-bg";
const NAV = "flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900 disabled:opacity-30";
const BTN = "rounded-md border border-neutral-800 px-3 py-1.5 text-[13px] text-neutral-300 transition-colors hover:border-accent-700 hover:bg-accent-900";
