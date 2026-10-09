"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Clases de la vista Sistema de Clavdia (src/app/system-shared.tsx), mismas medidas.
// Botones y campos de la paleta "Noche y champagne": esquinas redondeadas, bordes de 2px y
// el champagne (`bg-accent`) solo para la acción principal.
export const CARD = "flex w-full flex-col gap-3 rounded-2xl bg-surface p-5 shadow-sm";
export const BTN =
  "rounded-xl border-2 border-neutral-800 px-3.5 py-1.5 text-[13.5px] font-semibold text-fg transition-colors hover:border-neutral-700 hover:bg-neutral-900 disabled:opacity-40";
export const BTN_DARK =
  "rounded-xl border-2 border-accent bg-accent px-3.5 py-1.5 text-[13.5px] font-bold text-on-accent transition-[filter,opacity] hover:brightness-105 active:opacity-85 disabled:opacity-40";
export const FIELD =
  "w-full rounded-xl border-2 border-neutral-800 bg-surface px-3 py-2 text-[15px] text-fg placeholder:text-neutral-600 focus:border-accent-600 focus:outline-none";
/** Acción principal grande (se toca con el dedo). */
export const BTN_BIG =
  "inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-accent px-5 text-[18px] font-bold text-on-accent transition-[filter,opacity] hover:brightness-105 active:opacity-85 disabled:pointer-events-none disabled:opacity-40";

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

export async function call(url: string, method: "POST" | "PATCH", body: object = {}): Promise<ApiResult> {
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
      const d = (await r.json()) as T;
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
  lots: { id: string; lotCode: string; quantity: number; expiresOn: string | null; expired: boolean; receivedAt: string }[];
}

export interface CatalogPractice {
  id: string;
  name: string;
  price: number;
  cardPrice: number | null;
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
  itemName: string;
  kind: "consulta" | "tratamiento" | "producto";
  patientName: string | null;
  visitId: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
  status: "paid" | "voided";
  createdByName: string;
  createdAt: string;
  voidReason: string | null;
  providerName: string | null;
  commissionPct: number;
  commissionAmount: number;
  paymentMethod: Payment | null;
  cashTotal: number;
  cardTotal: number;
}

export type Payment = "efectivo" | "tarjeta";
export const PAYMENT_LABEL: Record<Payment, string> = { efectivo: "Efectivo / transf.", tarjeta: "Tarjeta" };

/** Precio con tarjeta efectivo (si no se cargó, es el mismo que efectivo). */
export const cardOf = (p: { price: number | null; cardPrice: number | null }) => p.cardPrice ?? p.price ?? 0;

/**
 * Importe a mostrar: con medio conocido, ese precio; sin medio y con precios distintos, los dos.
 */
export function Amount({ cash, card, method, className = "" }: { cash: number; card: number; method: Payment | null; className?: string }) {
  if (method === "tarjeta") return <span className={`tabular-nums ${className}`}>{money(card)}</span>;
  if (method === "efectivo" || card === cash) return <span className={`tabular-nums ${className}`}>{money(cash)}</span>;
  return (
    <span className={`flex flex-col items-end leading-tight tabular-nums ${className}`}>
      <span>{money(cash)}</span>
      <span className="text-[11.5px] text-neutral-500">tarjeta {money(card)}</span>
    </span>
  );
}

export const unitsLabel = (n: number, unit: string) =>
  unit === "unidad" ? `${n} ${n === 1 ? "unidad" : "unidades"}` : `${n} ${unit}`;
