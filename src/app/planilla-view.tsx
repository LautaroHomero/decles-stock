"use client";

import { useMemo, useRef, useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { normalize, parseNote, suggest } from "@/lib/domain/quick-sale";
import { Toast, call, fmtTime, money, usePoll, useToast, useToday, type CatalogResponse, type PayPart, type PaymentsMap, type SaleMethod, type SaleRow } from "./shared";
import { PlanillaMovimientos } from "./planilla-movimientos";
import type { PrepaidRow } from "./abonos";
import type { DepositRow } from "./senas";
import { samePatient } from "@/lib/domain/prepaid-note";

/** Abonos abiertos y qué atenciones del día son sesiones de un abono. */
interface AbonoData {
  open: PrepaidRow[];
  /** visit_id → abono */
  uses: Map<string, { prepaidId: string; itemId: string; itemName: string }>;
  /** Obras sociales / prepagas (OSMECON) y qué atenciones del día fueron por una. */
  insurers: { id: string; name: string; fee: number; active: boolean }[];
  byInsurer: Map<string, { insurerId: string; name: string }>;
  /** Señas sin usar y las que se descontaron en atenciones del día (visit_id → seña). */
  deposits: DepositRow[];
  depositUsed: Map<string, { depositId: string; amount: number; createdAt: string }>;
}
const prepaidLeft = (p: PrepaidRow) => (p.sessions !== null ? `quedan ${p.sessionsLeft} de ${p.sessions}` : `le quedan ${money(p.balance)}`);

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

export type Area = "medicos" | "kinesiologia" | "auxiliares" | "externos";
export const AREAS: { id: Area; title: string; who: string }[] = [
  { id: "medicos", title: "Médicos", who: "Médico" },
  { id: "kinesiologia", title: "Kinesiología", who: "Kinesióloga" },
  { id: "auxiliares", title: "Auxiliares", who: "Profesional" },
  { id: "externos", title: "Médicos externos", who: "Médico" },
];

export interface Seller {
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
export interface Row {
  key: string;
  sales: SaleRow[];
  time: string;
  patient: string;
  /** Lo que pagó, renglón por renglón (práctica o producto). */
  items: { name: string; qty: number; product: boolean; pending: boolean; total: number }[];
  /** Texto para editar: «Peeling, Contorno de ojos x2». */
  itemsText: string;
  providerId: string | null;
  method: SaleMethod | null;
  /** Varios medios / dólares: las partes del pago. */
  parts: PayPart[];
  k: number;
  kManual: boolean;
  total: number;
  /** Quedó debiendo (lo anotado y lo que falta). */
  debt: { amount: number; remaining: number } | null;
}

const METHOD_SHORT: Record<SaleMethod, string> = {
  efectivo: "Efvo.",
  transferencia: "Transf.",
  tarjeta: "Tarj.",
  dolares: "US$",
  giftcard: "Gift card",
  profesional: "A la prof.",
  mixto: "Varios",
};
const GENERIC = "Atención";
const num = (s: string) => Number(s.replace(/\D/g, "") || 0);


export function toRows(sales: SaleRow[], payments?: PaymentsMap, debts?: Record<string, { amount: number; remaining: number }>): Row[] {
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
        parts: payments?.[key] ?? [],
        k: g.reduce((n, s) => n + s.commissionAmount, 0),
        kManual: g.some((s) => s.commissionManual),
        total: g.reduce((n, s) => n + s.total, 0),
        debt: debts?.[key] ?? null,
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
 * Planilla → Día: las filas del día por área (paciente, qué pagó, médica, cuánto) y, abajo, todo lo demás
 * (otros ingresos, egresos, deudas y el resumen). Fecha controlada por la pantalla Planilla.
 */
export function PlanillaView({ actor, date }: { actor: Actor; date: string }) {
  const today = useToday();
  const admin = !!actor.activeOrg?.canAdmin;
  const canEdit = admin || date === today;

  const [sales, refreshSales] = usePoll<{ ok: boolean; sales: SaleRow[]; payments?: PaymentsMap; debts?: Record<string, { amount: number; remaining: number }> }>(
    `/api/sales?from=${date}&to=${date}&limit=500`,
    30_000,
  );
  const [catalog, refreshCatalog] = usePoll<CatalogResponse>("/api/catalog", 60_000);
  const [sellersData] = usePoll<{ ok: boolean; sellers: { providerId: string; name: string; area: Area }[] }>("/api/sellers", 60_000);
  const [toast, showToast] = useToast();
  const [abonosData, refreshAbonos] = usePoll<{ ok: boolean; prepaids: PrepaidRow[]; uses?: { visitId: string; prepaidId: string; itemId: string; itemName: string }[] }>(
    `/api/prepaids?date=${date}`,
    60_000,
  );
  const [insData, refreshIns] = usePoll<{ ok: boolean; insurers: AbonoData["insurers"]; visits?: { visitId: string; insurerId: string; name: string }[] }>(
    `/api/insurers?date=${date}`,
    60_000,
  );
  const [depData, refreshDep] = usePoll<{ ok: boolean; deposits: DepositRow[]; used?: { visitId: string; depositId: string; amount: number; createdAt: string }[] }>(
    `/api/deposits?date=${date}`,
    60_000,
  );
  const abonos: AbonoData = useMemo(
    () => ({
      deposits: depData?.ok ? depData.deposits : [],
      depositUsed: new Map((depData?.used ?? []).map((u) => [u.visitId, u])),
      open: abonosData?.ok ? abonosData.prepaids : [],
      uses: new Map((abonosData?.uses ?? []).map((u) => [u.visitId, u])),
      insurers: insData?.ok ? insData.insurers.filter((i) => i.active) : [],
      byInsurer: new Map((insData?.visits ?? []).map((v) => [v.visitId, v])),
    }),
    [abonosData, insData, depData],
  );

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
  const rows = useMemo(() => toRows(sales?.ok ? sales.sales : [], sales?.payments, sales?.debts), [sales]);
  const areaOf = (providerId: string | null): Area => sellers.find((s) => s.id === providerId)?.area ?? "medicos";
  const sections = AREAS.filter((a) => a.id === "medicos" || sellers.some((s) => s.area === a.id) || rows.some((r) => areaOf(r.providerId) === a.id));

  return (
    <div className="cl-print-area flex w-full flex-col gap-6 text-[13.5px]">
      <Toast msg={toast} />
      {!canEdit && <p className="cl-no-print -mt-3 text-[13px] text-neutral-500">Lo de días anteriores lo corrige el admin.</p>}
      {!sales || !catalog || !sellersData ? (
        <p className="text-neutral-500">Cargando…</p>
      ) : (
        <>
        {sections.map((a) => (
          <AreaSection
            key={a.id}
            area={a}
            rows={rows.filter((r) => areaOf(r.providerId) === a.id)}
            sellers={sellers.filter((s) => s.area === a.id)}
            allSellers={sellers}
            practices={practices}
            products={products}
            canEdit={canEdit}
            abonos={abonos}
            onSaved={() => {
              refreshSales();
              refreshCatalog();
              refreshAbonos();
              refreshIns();
              refreshDep();
            }}
            onError={showToast}
          />
        ))}
        <PlanillaMovimientos
          date={date}
          canEdit={canEdit}
          rows={rows}
          sales={sales.ok ? sales.sales : []}
          payments={sales.payments}
          onError={showToast}
          onAbonosChange={() => {
            refreshAbonos();
            refreshDep();
          }}
        />
        </>
      )}
    </div>
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
  abonos,
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
  abonos: AbonoData;
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
              <th className="w-[96px] px-3 py-2 font-medium">Medio</th>
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
                  abonos={abonos}
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
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {r.total ? money(r.total) : <span className="font-normal text-neutral-500">—</span>}
                    {abonos.depositUsed.has(r.key) && (
                      <span className="block text-[12px] font-normal text-neutral-400">+ seña {money(abonos.depositUsed.get(r.key)!.amount)}</span>
                    )}
                    {r.debt && (
                      <span className="block text-[12px] font-normal text-neutral-400">
                        {r.debt.remaining ? `debe ${money(r.debt.remaining)}` : `pagó la deuda (${money(r.debt.amount)})`}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-neutral-400">{abonos.uses.has(r.key) ? "Plan" : abonos.byInsurer.has(r.key) ? abonos.byInsurer.get(r.key)!.name : r.method ? METHOD_SHORT[r.method] : ""}</td>
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
                abonos={abonos}
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

export const fmtSigned = (n: number) => (n < 0 ? `− ${money(-n)}` : money(n));

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
  abonos,
  onCancel,
  onSaved,
  onError,
}: {
  row?: Row;
  showK: boolean;
  sellers: Seller[];
  practices: Item[];
  products: Item[];
  abonos: AbonoData;
  onCancel?: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [patient, setPatient] = useState(row?.patient ?? "");
  const [what, setWhat] = useState(row?.itemsText ?? "");
  const [providerId, setProviderId] = useState<string>(row?.providerId ?? (sellers.length === 1 ? sellers[0].id : ""));
  const [paid, setPaid] = useState(row ? String(row.total) : "");
  const [paidTouched, setPaidTouched] = useState(!!row);
  // Sesión de un abono: el medio «Abono» (no entra plata; la profesional cobra sobre el precio congelado).
  const rowUse = row ? (abonos.uses.get(row.key) ?? null) : null;
  // Obra social (OSMECON): el medio «ins:<id>»; las prácticas no pasan por caja.
  const rowIns = row ? (abonos.byInsurer.get(row.key) ?? null) : null;
  const [method, setMethod] = useState<SaleMethod | "" | "abono" | `ins:${string}`>(rowUse ? "abono" : rowIns ? `ins:${rowIns.insurerId}` : (row?.method ?? ""));
  // Varios medios / dólares (anotado en Anotar): se conservan las partes y lo pagado es su suma.
  const keepParts = !!row && (method === "mixto" || method === "dolares") && row.parts.length > 0;
  const [k, setK] = useState(row?.kManual ? String(row.k) : "");
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  // «plan» / «abonado» en Qué pagó: es una sesión del plan de la paciente (la práctica sale del plan).
  const saysPlan = /^(?:plan|abono|abonad[oa]s?|con abono|del plan|sesion del plan)$/.test(normalize(what.trim()));
  const picked = useMemo(() => (saysPlan ? [] : itemsIn(what, practices, products)), [what, practices, products, saysPlan]);
  const abono = patient.trim()
    ? (abonos.open.find((p) => samePatient(p.patient, patient) && (picked.some((x) => x.item?.id === p.itemId) || (saysPlan && !picked.length))) ?? null)
    : null;
  const abonoId = rowUse && picked.some((x) => x.item?.id === rowUse.itemId) ? rowUse.prepaidId : (abono?.id ?? null);
  const abonoItem = rowUse?.itemId ?? abono?.itemId ?? null;
  // Una fila nueva de alguien con abono arranca en «Abono» (si no se tocó el medio ni lo pagado).
  const effMethod = method === "" && abono && ((!row && !paidTouched) || saysPlan) ? "abono" : method;
  const usingAbono = effMethod === "abono" && !!abonoId;
  const insurerId = effMethod.startsWith("ins:") ? effMethod.slice(4) : null;
  // Seña: si la paciente dejó una (para esta práctica o sin definir), se descuenta de lo que paga hoy.
  const rowDep = row ? (abonos.depositUsed.get(row.key) ?? null) : null;
  const hasPracticeNow = !picked.length || picked.some((x) => !x.product);
  const depMatch =
    !rowDep && patient.trim() && hasPracticeNow
      ? (abonos.deposits.find((d) => samePatient(d.patient, patient) && (!d.itemId || picked.some((x) => x.item?.id === d.itemId))) ?? null)
      : null;
  const [useDep, setUseDep] = useState<boolean | null>(null);
  const depAmount = rowDep?.amount ?? depMatch?.amount ?? 0;
  const depActive = !!(rowDep || depMatch) && useDep !== false && !usingAbono && !insurerId;
  // Ayuda al escribir (sin importar mayúsculas, tildes ni errores): Tab o un toque completa.
  const all = useMemo(() => [...practices, ...products], [practices, products]);
  const hints = useMemo(() => (what.trim() ? suggest(what, all).filter((h) => h.kind !== "payment").slice(0, 4) : []), [what, all]);
  const whatRef = useRef<HTMLInputElement>(null);
  const accept = (t: string) => {
    setWhat(t.replace(/[\s,]+$/, ""));
    requestAnimationFrame(() => whatRef.current?.focus());
  };
  const priceOf = (p: Picked) =>
    (usingAbono && p.item?.id === abonoItem) || (insurerId && !p.product)
      ? 0
      : (p.amount ?? (p.item ? (method === "tarjeta" ? (p.item.cardPrice ?? p.item.price) : p.item.price) * p.qty : 0));
  const listTotal = picked.reduce((n, p) => n + priceOf(p), 0);
  const paidValue = keepParts
    ? row!.parts.reduce((n, p) => n + p.amount, 0)
    : paidTouched && !usingAbono && !insurerId
      ? num(paid)
      : depActive && !rowDep
        ? Math.max(0, listTotal - depAmount)
        : listTotal;
  const kValue = k.trim() === "" ? null : num(k);
  const dirty = !row ? !!(patient.trim() || what.trim() || paid || k) : true;

  async function save() {
    if (busy || !dirty) return;
    if (!providerId) return onError("Elegí quién atendió.");
    // Toda práctica (o «Atención» sin práctica) es de un paciente.
    if (!patient.trim() && (!picked.length || picked.some((p) => !p.product))) return onError("Falta el paciente.");
    // Sin nada escrito en «Qué pagó»: es una atención por el importe que se puso.
    // Sesión del plan sin práctica escrita: la pone el servidor (la del plan).
    if (usingAbono && !picked.length) {
      setBusy(true);
      const body = { patientName: patient, providerId, paymentMethod: null, lines: [], prepaidId: abonoId };
      const r = row ? await call(`/api/visits/${row.key}`, "PUT", body) : await call("/api/visits", "POST", body);
      setBusy(false);
      if (!r.ok) return onError(r.error ?? "No se pudo guardar.");
      onSaved();
      if (!row) requestAnimationFrame(() => first.current?.focus());
      return;
    }
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
    if (effMethod === "abono" && !abonoId) return onError("No encontré un abono de esa paciente para eso.");
    // Abono: con id, la sesión es de ese abono; si la fila era del abono y ya no, se suelta (null).
    const prepaid = {
      ...(usingAbono ? { prepaidId: abonoId } : rowUse ? { prepaidId: null } : {}),
      ...(insurerId ? { insurerId } : rowIns ? { insurerId: null } : {}),
      ...(depActive ? { depositId: rowDep?.depositId ?? depMatch!.id } : rowDep ? { depositId: null } : {}),
    };
    const body = keepParts
      ? { patientName: patient, providerId, payments: row!.parts, lines, ...prepaid }
      : {
          patientName: patient,
          providerId,
          paymentMethod: effMethod === "mixto" || effMethod === "dolares" || effMethod === "abono" || insurerId ? null : effMethod || null,
          lines,
          ...prepaid,
        };
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

  return (
    <tr className="border-b border-neutral-800 bg-surface align-top" onKeyDown={keys}>
      <td className="px-3 py-2 tabular-nums text-neutral-500">{row ? row.time : <PlusIcon size={12} className="mt-1" />}</td>
      <td className="px-1.5 py-1">
        <input ref={first} autoFocus={!!row} value={patient} onChange={(e) => setPatient(e.target.value)} placeholder="Paciente" className={CELL} />
      </td>
      <td className="px-1.5 py-1">
        <input
          ref={whatRef}
          value={what}
          onChange={(e) => setWhat(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Tab" && hints.length && !e.shiftKey) {
              e.preventDefault();
              accept(hints[0].text);
            }
          }}
          placeholder="Práctica o producto (separá con coma)"
          className={CELL}
        />
        {hints.length > 0 && (
          <span className="flex flex-wrap gap-1 px-1 pt-1">
            {hints.map((h, i) => (
              <button
                key={h.label + i}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => accept(h.text)}
                className={`rounded-pill border px-2 py-0.5 text-[12px] ${i === 0 ? "border-accent-700 text-fg" : "border-neutral-800 text-neutral-400 hover:text-fg"}`}
              >
                {h.label}
              </button>
            ))}
          </span>
        )}
        {(rowDep || depMatch) && !usingAbono && !insurerId && (
          <span className="block px-1.5 pt-0.5 text-[11.5px] text-neutral-400">
            Seña de {money(depAmount)}
            {depMatch ? ` (dejó el ${depMatch.createdAt.slice(8, 10)}/${depMatch.createdAt.slice(5, 7)})` : ""} ·{" "}
            {depActive ? "se descuenta, paga el resto" : "no se descuenta"}{" "}
            <button type="button" onClick={() => setUseDep(!depActive)} className="underline underline-offset-2 hover:text-fg">
              {depActive ? "no descontar" : "descontar"}
            </button>
          </span>
        )}
        {insurerId && (
          <span className="block px-1.5 pt-0.5 text-[11.5px] text-neutral-400">
            Por {abonos.insurers.find((i) => i.id === insurerId)?.name}: no entra plata · la profesional se lleva {money(abonos.insurers.find((i) => i.id === insurerId)?.fee ?? 0)}
          </span>
        )}
        {(abono || rowUse) && (
          <span className="block px-1.5 pt-0.5 text-[11.5px] text-neutral-400">
            {abono ? `Plan de ${abono.itemName}: ${prepaidLeft(abono)}` : `Sesión del plan de ${rowUse!.itemName}`}
            {usingAbono ? " · no entra plata" : " · en Medio elegí «Plan» para descontarla"}
          </span>
        )}
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
          disabled={keepParts || (usingAbono && picked.every((x) => x.item?.id === abonoItem)) || (!!insurerId && picked.every((x) => !x.product))}
          title={keepParts ? "Pagó en varios medios: se corrige desde Anotar" : undefined}
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
        <select value={effMethod} onChange={(e) => setMethod(e.target.value as SaleMethod | "" | "abono" | `ins:${string}`)} className={`${CELL} pr-1`}>
          <option value="">—</option>
          {(abono || rowUse) && <option value="abono">Plan</option>}
          {abonos.insurers.map((i) => (
            <option key={i.id} value={`ins:${i.id}`}>
              {i.name}
            </option>
          ))}
          <option value="efectivo">Efvo.</option>
          <option value="transferencia">Transf.</option>
          <option value="tarjeta">Tarj.</option>
          <option value="profesional" title="Le pagaron directo a la profesional: no entra a la caja; lo nuestro nos lo debe ella">
            A la prof.
          </option>
          {row && row.parts.length > 0 && row.method === "dolares" && <option value="dolares">US$</option>}
          {row && row.parts.length > 0 && row.method === "mixto" && <option value="mixto">Varios</option>}
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
