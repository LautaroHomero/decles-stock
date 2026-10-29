"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Clases de la vista Sistema de Clavdia (src/app/system-shared.tsx), mismas medidas.
export const CARD = "flex w-full flex-col gap-3 rounded-xl bg-surface p-5 shadow-sm";
export const BTN =
  "rounded-md border border-neutral-800 px-2.5 py-1 text-[12px] text-neutral-300 transition-colors hover:border-accent-700 hover:bg-accent-900 disabled:opacity-40";
export const BTN_DARK =
  "rounded-md border border-accent px-2.5 py-1 text-[12px] font-medium text-accent-300 transition-colors hover:bg-accent-900 active:bg-accent-800 disabled:opacity-40";
export const FIELD =
  "w-full rounded-md border border-neutral-800 bg-transparent px-2.5 py-1.5 text-[13px] text-fg placeholder:text-neutral-600 focus:border-accent-700 focus:outline-none";
/** Acción principal grande (pantalla de venta: se toca con el dedo). */
export const BTN_BIG =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-accent bg-accent px-4 text-[15px] font-medium text-bg transition-opacity hover:opacity-85 active:opacity-70 disabled:pointer-events-none disabled:opacity-40";

export const money = (n: number) => `$\u00a0${n.toLocaleString("es-AR")}`;

/** `YYYY-MM-DD` → `DD/MM/AAAA`. */
export const fmtDate = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;

/** Hora `hh:mm` de un timestamp `YYYY-MM-DDThh:mm:ss`. */
export const fmtTime = (iso: string) => iso.slice(11, 16);

export const pad = (n: number) => String(n).padStart(2, "0");
export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Días que faltan para `ymd` (negativo = ya pasó). */
export function daysUntil(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}

export type ApiResult = { ok: boolean; error?: string } & Record<string, unknown>;

export async function call(url: string, method: "POST" | "PATCH" | "PUT" | "DELETE", body: object = {}): Promise<ApiResult> {
  try {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) {
      window.location.href = "/login";
      return { ok: false, error: "Sesión vencida." };
    }
    return await r.json();
  } catch {
    return { ok: false, error: "No se pudo conectar." };
  }
}

/** GET con refresco periódico (y al volver a la pestaña). Devuelve `[data, refresh]`. */
export function usePoll<T>(url: string, everyMs: number): [T | null, () => void] {
  const [data, setData] = useState<T | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.status === 401) {
        window.location.href = "/login";
        return;
      }
      // Un error del servidor sin JSON (p. ej. falta correr una migración) se muestra en vez de quedar «Cargando…».
      const d = (await r.json().catch(() => ({ ok: false, error: `Error del servidor (${r.status}). Revisá la terminal de next dev.` }))) as T;
      if (alive.current) setData(d);
    } catch {
      /* sin red: se reintenta en el próximo ciclo */
    }
  }, [url]);
  useEffect(() => {
    alive.current = true;
    const first = setTimeout(load, 0);
    const id = setInterval(load, everyMs);
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive.current = false;
      clearTimeout(first);
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load, everyMs]);
  return [data, load];
}

/** Mensaje efímero arriba de la pantalla. */
export function useToast(): [string | null, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 4500);
  }, []);
  return [msg, show];
}

export function Toast({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div role="status" className="fixed inset-x-0 top-16 z-50 flex justify-center px-4">
      <div className="animate-cl-in rounded-lg bg-surface px-4 py-2.5 text-[13.5px] shadow-lg">{msg}</div>
    </div>
  );
}

// Tipos que devuelve la API (espejo de src/lib/domain/products.ts).
export interface CatalogProduct {
  stockItemId: string;
  priceItemId: string | null;
  infiniteStock: boolean;
  giftCard: boolean;
  /** Médicas que lo venden (vacío = cualquiera). */
  providerIds: string[];
  /** % de comisión propio (null = el de cada médica). */
  commissionPct: number | null;
  /** Lo que se lleva cada profesional en este ítem, si es distinto. */
  providerCuts?: Record<string, Cut>;
  name: string;
  unit: string;
  category: string;
  /** Precio efectivo / transferencia. */
  price: number | null;
  /** Precio con tarjeta; null = igual al de efectivo. */
  cardPrice: number | null;
  available: number;
  minQuantity: number;
  low: boolean;
  nextExpiry: string | null;
  expiries: { expiresOn: string; quantity: number }[];
  expiredQuantity: number;
  owed: number;
  lots: { id: string; lotCode: string; quantity: number; expiresOn: string | null; expired: boolean; receivedAt: string }[];
}

export interface CatalogPractice {
  id: string;
  name: string;
  price: number;
  cardPrice: number | null;
  providerIds: string[];
  commissionPct: number | null;
  providerCuts?: Record<string, Cut>;
}

export interface CatalogResponse {
  ok: boolean;
  products: CatalogProduct[];
  practices: CatalogPractice[];
  alerts: { expiringSoon: number; expired: number; low: number };
  expiryDays: number;
  canAdmin: boolean;
}

export interface SaleRow {
  id: string;
  itemId: string | null;
  itemName: string;
  /** "pendiente": anotado con un nombre que no está en la lista de precios (lo resuelve el admin). */
  kind: "consulta" | "tratamiento" | "producto" | "pendiente";
  patientName: string | null;
  visitId: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
  status: "paid" | "voided";
  createdByName: string;
  createdAt: string;
  voidReason: string | null;
  providerId: string | null;
  providerName: string | null;
  /** Planilla: importe / parte de la profesional escritos a mano y columna Observaciones. */
  priceManual?: boolean;
  commissionManual?: boolean;
  observations?: string;
  commissionPct: number;
  commissionAmount: number;
  /** "mixto" = varios medios (el detalle viene en `payments` de /api/sales). */
  paymentMethod: SaleMethod | null;
  cashTotal: number;
  cardTotal: number;
}

/** `profesional` = la paciente le pagó directo a la profesional: no entra a la caja; lo nuestro nos lo debe ella. */
export type Payment = "efectivo" | "transferencia" | "tarjeta" | "dolares" | "giftcard" | "profesional";
export type SaleMethod = Payment | "mixto";
export const PAYMENT_LABEL: Record<SaleMethod, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  tarjeta: "Tarjeta",
  dolares: "Dólares",
  giftcard: "Gift card",
  profesional: "A la profesional",
  mixto: "Varios medios",
};
export const PAYMENTS: [Payment, string][] = [
  ["efectivo", "Efectivo"],
  ["transferencia", "Transf."],
  ["tarjeta", "Tarjeta"],
  ["dolares", "Dólares"],
  ["profesional", "A la profesional"],
];

/** Una parte del pago (varios medios o dólares). `amount` en pesos. */
export interface PayPart {
  method: Payment;
  amount: number;
  usd?: number | null;
  rate?: number | null;
}
export type PaymentsMap = Record<string, PayPart[]>;

/** Lo cobrado por medio (las anotaciones con varios medios se cuentan por sus partes). `usd` = dólares físicos. */
/** Lo de una anotación que no entró al consultorio hoy: lo que se le pagó directo a la profesional y lo pagado con gift card. */
export function outsideOf(r: { method: SaleMethod | null; total: number; parts: PayPart[] }): { profesional: number; giftcard: number } {
  if (r.parts.length)
    return {
      profesional: r.parts.filter((p) => p.method === "profesional").reduce((n, p) => n + p.amount, 0),
      giftcard: r.parts.filter((p) => p.method === "giftcard").reduce((n, p) => n + p.amount, 0),
    };
  return { profesional: r.method === "profesional" ? r.total : 0, giftcard: r.method === "giftcard" ? r.total : 0 };
}

export function methodTotals(sales: SaleRow[], payments?: PaymentsMap) {
  const t = { efectivo: 0, transferencia: 0, tarjeta: 0, dolares: 0, giftcard: 0, profesional: 0, usd: 0, sin: 0 };
  const seen = new Set<string>();
  for (const s of sales) {
    if (s.status !== "paid") continue;
    if ((s.paymentMethod === "mixto" || s.paymentMethod === "dolares") && s.visitId) {
      if (seen.has(s.visitId)) continue;
      seen.add(s.visitId);
      for (const p of payments?.[s.visitId] ?? []) {
        t[p.method] += p.amount;
        if (p.method === "dolares") t.usd += p.usd ?? 0;
      }
    } else if (s.paymentMethod && s.paymentMethod !== "mixto") t[s.paymentMethod] += s.total;
    else t.sin += s.total;
  }
  return t;
}

export const usdFmt = (n: number) => `US$\u00a0${n.toLocaleString("es-AR", { maximumFractionDigits: 2 })}`;

/** Dólar de hoy: oficial (compra/venta) y la cotización para cobrar (promedio, o la escrita a mano). */
export interface DolarHoy {
  compra: number | null;
  venta: number | null;
  rate: number | null;
  manual: boolean;
  updatedAt: string | null;
}
export function useDolar(): [DolarHoy | null, () => void] {
  const [d, refresh] = usePoll<{ ok: boolean; dolar: DolarHoy }>("/api/dolar", 10 * 60_000);
  return [d?.ok ? d.dolar : null, refresh];
}

/** Precio con tarjeta efectivo (si no se cargó, es el mismo que efectivo). */
export const cardOf = (p: { price: number | null; cardPrice: number | null }) => p.cardPrice ?? p.price ?? 0;

/**
 * Importe a mostrar: con medio conocido, ese precio; sin medio y con precios distintos, los dos.
 */
export function Amount({ cash, card, method, className = "" }: { cash: number; card: number; method: SaleMethod | null; className?: string }) {
  if (method === "tarjeta") return <span className={`tabular-nums ${className}`}>{money(card)}</span>;
  if (method || card === cash) return <span className={`tabular-nums ${className}`}>{money(cash)}</span>;
  return (
    <span className={`flex flex-col items-end leading-tight tabular-nums ${className}`}>
      <span>{money(cash)}</span>
      <span className="text-[11.5px] text-neutral-500">tarjeta {money(card)}</span>
    </span>
  );
}

export const unitsLabel = (n: number, unit: string) =>
  unit === "unidad" ? `${n} ${n === 1 ? "unidad" : "unidades"}` : `${n} ${unit}`;

/** Médicas activas del consultorio (para vincular y para elegir quién). */
export function useSellers(): { id: string; name: string; owner?: boolean }[] | null {
  const [d] = usePoll<{ ok: boolean; sellers: { providerId: string; name: string; owner?: boolean }[] }>("/api/sellers", 60_000);
  return d?.ok ? d.sellers.map((s) => ({ id: s.providerId, name: s.name, owner: !!s.owner })) : null;
}

/** Parte propia de una profesional en un ítem: un % o plata fija por unidad. */
export type Cut = { pct?: number | null; fixed?: number | null };
/** Lo que se está escribiendo en el formulario, por profesional. */
export type CutDraft = Record<string, { mode: "pct" | "fixed"; value: string }>;

export const cutDraftOf = (c: Record<string, Cut> | undefined): CutDraft =>
  Object.fromEntries(
    Object.entries(c ?? {}).map(([id, x]) =>
      x.fixed !== null && x.fixed !== undefined ? [id, { mode: "fixed", value: String(x.fixed) }] : [id, { mode: "pct", value: String(x.pct ?? "") }],
    ),
  );

/** Para la API: solo las marcadas y con algo escrito. */
export function cutsFromDraft(d: CutDraft, ids: string[]): Record<string, Cut> {
  const out: Record<string, Cut> = {};
  for (const id of ids) {
    const c = d[id];
    const raw = c?.value.trim() ?? "";
    if (!raw) continue;
    out[id] = c.mode === "fixed" ? { fixed: Number(raw.replace(/\D/g, "")) } : { pct: Number(raw.replace(",", ".")) };
  }
  return out;
}

export const cutLabel = (c: Cut | undefined) =>
  !c ? "" : c.fixed !== null && c.fixed !== undefined ? money(c.fixed) : c.pct !== null && c.pct !== undefined ? `${c.pct}%` : "";

/**
 * Elegir qué profesionales hacen / venden algo. Ninguna marcada = todas.
 * Con `onCuts`: a cada marcada se le puede poner lo que se lleva en este ítem (% o plata fija).
 */
export function ProviderPicker({
  value,
  onChange,
  cuts,
  onCuts,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  cuts?: CutDraft;
  onCuts?: (c: CutDraft) => void;
}) {
  const sellers = useSellers();
  if (!sellers) return null;
  if (!sellers.length) return <p className="text-[13px] text-neutral-500">Todavía no hay médicas: se dan de alta en Equipo.</p>;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const marked = sellers.filter((s) => value.includes(s.id));
  const setCut = (id: string, c: { mode: "pct" | "fixed"; value: string }) => onCuts?.({ ...cuts, [id]: c });
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] text-neutral-400">¿Quién lo hace o lo vende?</span>
      <div className="flex flex-wrap gap-2">
        {sellers.map((s) => {
          const on = value.includes(s.id);
          return (
            <button
              type="button"
              key={s.id}
              aria-pressed={on}
              onClick={() => toggle(s.id)}
              className={`rounded-md border px-2.5 py-1 text-[12.5px] transition-colors ${
                on ? "border-accent bg-accent text-on-accent" : "border-neutral-800 text-neutral-300 hover:border-accent-700 hover:bg-accent-900"
              }`}
            >
              {s.name}
            </button>
          );
        })}
      </div>
      <span className="text-[11.5px] text-neutral-500">
        {value.length ? "Solo las marcadas lo pueden anotar." : "Sin marcar = cualquiera de las médicas."}
        {onCuts && !value.length && " Para que alguna se lleve distinto, marcala."}
      </span>
      {onCuts && marked.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1.5 rounded-lg border border-neutral-800 p-3">
          <span className="text-[12px] text-neutral-400">Cuánto se lleva cada una en esto</span>
          {marked.map((s) => {
            const c = cuts?.[s.id] ?? { mode: "pct" as const, value: "" };
            if (s.owner)
              return (
                <div key={s.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{s.name}</span>
                  <span className="text-[12.5px] text-neutral-500">admin · sin comisión</span>
                </div>
              );
            return (
              <div key={s.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{s.name}</span>
                <input
                  value={c.value}
                  onChange={(e) => setCut(s.id, { ...c, value: e.target.value.replace(c.mode === "pct" ? /[^\d.,]/g : /[^\d.]/g, "") })}
                  inputMode={c.mode === "pct" ? "decimal" : "numeric"}
                  placeholder="la general"
                  aria-label={`Lo que se lleva ${s.name}`}
                  className={`${FIELD} !w-[110px] shrink-0 text-right tabular-nums`}
                />
                <div role="radiogroup" aria-label="% o plata fija" className="inline-flex rounded-md border border-neutral-800 p-0.5">
                  {(
                    [
                      ["pct", "%"],
                      ["fixed", "$"],
                    ] as const
                  ).map(([m, label]) => (
                    <button
                      type="button"
                      key={m}
                      role="radio"
                      aria-checked={c.mode === m}
                      onClick={() => setCut(s.id, { mode: m, value: c.mode === m ? c.value : "" })}
                      className={`min-w-8 rounded px-2 py-1 text-[12.5px] ${c.mode === m ? "bg-accent text-on-accent" : "text-neutral-400 hover:text-fg"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <span className="text-[11.5px] text-neutral-500">
            % sobre lo que se cobra, o $ fijos por cada una. Vacío = la regla general (la del ítem o la de la médica). Al anotar se puede cambiar igual.
          </span>
        </div>
      )}
    </div>
  );
}

/** "Laura, Paula" a partir de ids; vacío = "Todas". Con `cuts`: "Laura 40%, Paula $ 9.000". */
export function providerNames(ids: string[], sellers: { id: string; name: string }[] | null, cuts?: Record<string, Cut>): string {
  if (!ids.length) return "Todas las médicas";
  return ids
    .map((id) => {
      const n = sellers?.find((s) => s.id === id)?.name ?? "—";
      const c = cutLabel(cuts?.[id]);
      return c ? `${n} ${c}` : n;
    })
    .join(", ");
}

/** "12,5" → 12.5 · "" → null (se usa el % de cada médica). */
export const parsePct = (s: string): number | null => (s.trim() === "" ? null : Number(s.replace(",", ".")));

/** Campo "% comisión de la médica" de un ítem. Vacío = el % de cada médica (Equipo). */
export function CommissionField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-neutral-400">Comisión de la médica (%)</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ""))}
        inputMode="decimal"
        placeholder="Vacío = el % de cada médica"
        className={FIELD}
      />
    </label>
  );
}

/** Fecha de hoy que cambia sola a la medianoche (la pantalla puede quedar abierta toda la noche). */
export function useToday(): string {
  const [today, setToday] = useState(localToday);
  useEffect(() => {
    const id = setInterval(() => setToday((t) => (t === localToday() ? t : localToday())), 30_000);
    return () => clearInterval(id);
  }, []);
  return today;
}
