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
 *  · Cada fila: a quién se atendió, qué pagó (prácticas y productos, con su tipo), qué médica y cuánto pagó.
 *  · Los productos de la lista descuentan stock; lo que no está en la lista va como pendiente.
 *  · $K (kinesiología, auxiliares, externos): la parte de la profesional (sale de su %, se puede pisar).
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

/** Una fila de la planilla = una anotación: a quién se atendió, qué pagó, qué médica y cuánto. */
interface Row {
  key: string;
  sales: SaleRow[];
  time: string;
  patient: string;
  /** Lo que pagó, renglón por renglón (práctica o producto). */
  items: { name: string; qty: number; product: boolean; pending: boolean; total: number }[];
  /** Texto para editar: «Peeling, Contorno de ojos x2». */
  itemsText: string;
  providerId: string | null;
  method: Payment | null;
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
      // Prácticas primero, después productos.
      const sorted = [...g].sort((a, b) => Number(a.kind === "producto") - Number(b.kind === "producto"));
      const items = sorted.map((s) => ({ name: s.itemName, qty: s.quantity, product: s.kind === "producto", pending: s.kind === "pendiente", total: s.total }));
      return {
        key,
        sales: g,
        time: fmtTime(g[g.length - 1].createdAt),
        patient: g[0].patientName ?? "",
        items,
        itemsText: items.map((i) => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ""}`).join(", "),
        providerId: g[0].providerId,
        method: g[0].paymentMethod,
        k: g.reduce((n, s) => n + s.commissionAmount, 0),
        kManual: g.some((s) => s.commissionManual),
        total: g.reduce((n, s) => n + s.total, 0),
      };
    })
    .sort((a, b) => a.sales[0].createdAt.localeCompare(b.sales[0].createdAt));
}

interface Picked {
  /** null = no está en la lista (va como pendiente) o «Atención» sin práctica. */
  item: Item | null;
  product: boolean;
  name: string;
  qty: number;
  /** Importe escrito en el pedazo («contorno de ojos 50000»). */
  amount: number | null;
}

/** «peeling, contorno de ojos 50000, masaje x2» → prácticas y productos de la lista (o pendientes). */
function itemsIn(text: string, practices: Item[], products: Item[]): Picked[] {
  const out: Picked[] = [];
  const all = [...practices.map((i) => ({ ...i, product: false })), ...products.map((i) => ({ ...i, product: true }))];
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
    const q = t.match(/\s*[x×*]\s*(\d{1,2})\b/i) ?? t.match(/^\s*(\d{1,2})\s+/);
    if (q) {
      qty = Math.max(1, Number(q[1]));
      t = t.replace(q[0], " ");
    }
    t = t.trim();
    if (!t) continue;
    const n = normalize(t);
    let it = all.find((i) => normalize(i.name) === n) ?? all.find((i) => normalize(i.name).startsWith(n)) ?? null;
    if (!it && t.length >= 3) {
      const l = parseNote(t, all).lines[0];
      it = l?.match ?? null;
    }
    if (it) out.push({ item: it, product: it.product, name: it.name, qty, amount });
    else if (normalize(t) === normalize(GENERIC)) out.push({ item: null, product: false, name: GENERIC, qty, amount });
    else out.push({ item: null, product: false, name: t.charAt(0).toUpperCase() + t.slice(1), qty, amount });
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
  const total = rows.reduce((n, r) => n + r.total, 0);
  // $K (lo de la profesional) solo donde la planilla en papel lo lleva: kinesiología, auxiliares y externos.
  const showK = area.id !== "medicos";
  const byPro = sellers.map((s) => ({ s, k: rows.filter((r) => r.providerId === s.id).reduce((n, r) => n + r.k, 0) })).filter((x) => x.k > 0);
  const pickable = sellers.length ? sellers : allSellers;
  const areaPractices = practices.filter((p) => !p.providerIds.length || p.providerIds.some((id) => pickable.some((s) => s.id === id)));
  const cols = showK ? 8 : 7;

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
        <table className="w-full min-w-[760px] border-collapse text-[13.5px]">
          <thead>
            <tr className="border-b border-neutral-800 text-left text-[11.5px] uppercase tracking-[.06em] text-neutral-500">
              <th className="w-[52px] px-3 py-2 font-medium">Hora</th>
              <th className="w-[22%] px-3 py-2 font-medium">Paciente</th>
              <th className="px-3 py-2 font-medium">Qué pagó</th>
              <th className="w-[18%] px-3 py-2 font-medium">{area.who}</th>
              <th className="w-[12%] px-3 py-2 text-right font-medium">Pagó $</th>
              <th className="w-[70px] px-3 py-2 font-medium">Medio</th>
              {showK && <th className="w-[10%] px-3 py-2 text-right font-medium">$K</th>}
              <th className="w-[1%] cl-no-print" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) =>
              editing === r.key ? (
                <RowEditor
                  key={r.key}
                  row={r}
                  showK={showK}
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
                  className={`border-b border-neutral-900 align-top ${canEdit ? "cursor-pointer hover:bg-neutral-900" : ""}`}
                >
                  <td className="px-3 py-2 tabular-nums text-neutral-500">{r.time}</td>
                  <td className="px-3 py-2">{r.patient || <span className="text-neutral-600">—</span>}</td>
                  <td className="px-3 py-2">
                    <ul className="flex flex-col gap-0.5">
                      {r.items.map((it, i) => (
                        <li key={i} className="flex items-baseline gap-2">
                          <span className="w-[62px] shrink-0 text-[11px] uppercase tracking-[.05em] text-neutral-500">{it.product ? "producto" : "práctica"}</span>
                          <span className="min-w-0 flex-1">
                            {it.qty > 1 && <span className="tabular-nums text-neutral-400">{it.qty} × </span>}
                            {it.name}
                            {it.pending && <span className="text-[12px] text-neutral-500"> (sin cargar)</span>}
                          </span>
                          {r.items.length > 1 && <span className="tabular-nums text-[12.5px] text-neutral-500">{money(it.total)}</span>}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-3 py-2 text-neutral-300">{allSellers.find((s) => s.id === r.providerId)?.name ?? r.sales[0].providerName ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{r.total ? money(r.total) : <span className="font-normal text-neutral-500">—</span>}</td>
                  <td className="px-3 py-2 text-neutral-400">{r.method ? METHOD_SHORT[r.method] : ""}</td>
                  {showK && <td className="px-3 py-2 text-right tabular-nums">{r.k ? money(r.k) : <span className="text-neutral-500">—</span>}</td>}
                  <td className="cl-no-print" />
                </tr>
              ),
            )}
            {canEdit && editing === null && (
              <RowEditor
                key={`new${newKey}`}
                showK={showK}
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
            {!rows.length && !canEdit && (
              <tr>
                <td colSpan={cols} className="px-3 py-3 text-neutral-500">
                  No se anotó nada.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-neutral-800">
              <td colSpan={4} className="px-3 py-2 text-right text-neutral-500">
                total
              </td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">{money(total)}</td>
              <td />
              {showK && <td className="px-3 py-2 text-right font-medium tabular-nums">{money(rows.reduce((n, r) => n + r.k, 0))}</td>}
              <td className="cl-no-print" />
            </tr>
            {showK && byPro.length > 0 && (
              <tr>
                <td colSpan={cols} className="px-3 pb-2 text-right text-neutral-500">
                  {byPro.map((x) => (
                    <span key={x.s.id} className="ml-5 whitespace-nowrap">
                      total {x.s.name} <b className="font-medium tabular-nums text-fg">{money(x.k)}</b>
                    </span>
                  ))}
                  <span className="ml-5 whitespace-nowrap">
                    total Decles <b className="font-medium tabular-nums text-fg">{fmtSigned(total - rows.reduce((n, r) => n + r.k, 0))}</b>
                  </span>
                </td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>
    </section>
  );
}

const fmtSigned = (n: number) => (n < 0 ? `− ${money(-n)}` : money(n));

/**
 * Una fila que se escribe: paciente, qué pagó (prácticas y productos juntos: «peeling, contorno de ojos»),
 * médica, cuánto pagó y medio. Enter guarda; Escape cancela.
 * «Pagó $» arranca con la suma de la lista; si se escribe otro importe, la diferencia va a la práctica.
 */
function RowEditor({
  row,
  showK,
  sellers,
  practices,
  products,
  onCancel,
  onSaved,
  onError,
}: {
  row?: Row;
  showK: boolean;
  sellers: Seller[];
  practices: Item[];
  products: Item[];
  onCancel?: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [patient, setPatient] = useState(row?.patient ?? "");
  const [what, setWhat] = useState(row?.itemsText ?? "");
  const [providerId, setProviderId] = useState<string>(row?.providerId ?? (sellers.length === 1 ? sellers[0].id : ""));
  const [paid, setPaid] = useState(row ? String(row.total) : "");
  const [paidTouched, setPaidTouched] = useState(!!row);
  const [method, setMethod] = useState<Payment | "">(row?.method ?? "");
  const [k, setK] = useState(row?.kManual ? String(row.k) : "");
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  const picked = useMemo(() => itemsIn(what, practices, products), [what, practices, products]);
  const priceOf = (p: Picked) => p.amount ?? (p.item ? (method === "tarjeta" ? (p.item.cardPrice ?? p.item.price) : p.item.price) * p.qty : 0);
  const listTotal = picked.reduce((n, p) => n + priceOf(p), 0);
  const paidValue = paidTouched ? num(paid) : listTotal;
  const kValue = k.trim() === "" ? null : num(k);
  const dirty = !row ? !!(patient.trim() || what.trim() || paid || k) : true;

  async function save() {
    if (busy || !dirty) return;
    if (!providerId) return onError("Elegí quién atendió.");
    // Sin nada escrito en «Qué pagó»: es una atención por el importe que se puso.
    const parts: Picked[] = picked.length ? picked : [{ item: null, product: false, name: GENERIC, qty: 1, amount: null }];
    const amounts = parts.map(priceOf);
    // La diferencia con lo que pagó va a la primera práctica (o al único renglón).
    const diff = paidValue - amounts.reduce((n, a) => n + a, 0);
    if (diff !== 0) {
      const i = Math.max(0, parts.findIndex((p) => !p.product));
      amounts[i] = Math.max(0, amounts[i] + diff);
    }
    const kAt = Math.max(0, parts.findIndex((p) => !p.product));
    const lines = parts.map((p, i) => {
      const commission = i === kAt ? kValue : null;
      if (p.item) return { itemId: p.item.id, quantity: p.qty, amount: amounts[i], commission };
      if (p.name === GENERIC) return { generic: true, amount: amounts[i], commission };
      return { pendingName: p.name, pendingPrice: amounts[i] ? Math.round(amounts[i] / p.qty) : null, quantity: p.qty, amount: amounts[i], commission };
    });
    const body = { patientName: patient, providerId, paymentMethod: method || null, lines };
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
  const listId = `it-${row?.key ?? "new"}`;

  return (
    <tr className="border-b border-neutral-800 bg-surface align-top" onKeyDown={keys}>
      <td className="px-3 py-2 tabular-nums text-neutral-500">{row ? row.time : <PlusIcon size={12} className="mt-1" />}</td>
      <td className="px-1.5 py-1">
        <input ref={first} autoFocus={!!row} value={patient} onChange={(e) => setPatient(e.target.value)} placeholder="Paciente" className={CELL} />
      </td>
      <td className="px-1.5 py-1">
        <input list={listId} value={what} onChange={(e) => setWhat(e.target.value)} placeholder="Práctica o producto (separá con coma)" className={CELL} />
        <datalist id={listId}>
          {[...practices, ...products].map((p) => (
            <option key={p.id} value={p.name} />
          ))}
        </datalist>
        {picked.length > 0 && (
          <span className="block px-1.5 pt-0.5 text-[11.5px] text-neutral-500">
            {picked
              .map((p) => `${p.product ? "producto" : "práctica"}: ${p.qty > 1 ? `${p.qty} × ` : ""}${p.name}${p.item || p.name === GENERIC ? "" : " (sin cargar)"}${priceOf(p) ? ` ${money(priceOf(p))}` : ""}`)
              .join(" · ")}
          </span>
        )}
      </td>
      <td className="px-1.5 py-1">
        <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={`${CELL} pr-1`}>
          {sellers.length !== 1 && <option value="">Elegí…</option>}
          {sellers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </td>
      <td className="px-1.5 py-1">
        <input
          value={paidValue ? paidValue.toLocaleString("es-AR") : ""}
          onChange={(e) => {
            setPaidTouched(true);
            setPaid(e.target.value.replace(/\D/g, ""));
          }}
          inputMode="numeric"
          placeholder="$"
          className={`${CELL} text-right tabular-nums`}
        />
      </td>
      <td className="px-1.5 py-1">
        <select value={method} onChange={(e) => setMethod(e.target.value as Payment | "")} className={`${CELL} pr-1`}>
          <option value="">—</option>
          <option value="efectivo">Efvo.</option>
          <option value="transferencia">Transf.</option>
          <option value="tarjeta">Tarj.</option>
        </select>
      </td>
      {showK && (
        <td className="px-1.5 py-1">
          <input
            value={k ? num(k).toLocaleString("es-AR") : ""}
            onChange={(e) => setK(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            placeholder={row && !row.kManual && row.k ? money(row.k) : "auto"}
            title="Lo que le corresponde a la profesional. Vacío = según su comisión."
            className={`${CELL} text-right tabular-nums`}
          />
        </td>
      )}
      <td className="whitespace-nowrap px-2 py-1.5 text-right">
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
      </td>
    </tr>
  );
}

const CELL =
  "w-full min-w-0 rounded-sm border border-transparent bg-transparent px-1.5 py-1 text-[13px] text-fg outline-none placeholder:text-neutral-600 focus:border-accent-700 focus:bg-bg";
const NAV = "flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900 disabled:opacity-30";
const BTN = "rounded-md border border-neutral-800 px-3 py-1.5 text-[13px] text-neutral-300 transition-colors hover:border-accent-700 hover:bg-accent-900";
