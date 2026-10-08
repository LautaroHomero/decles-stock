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

export const money = (n: number) => `$ ${n.toLocaleString("es-AR")}`;

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
  price: number | null;
  available: number;
  minQuantity: number;
  low: boolean;
  nextExpiry: string | null;
  expiries: { expiresOn: string; quantity: number }[];
  expiredQuantity: number;
  lots: { id: string; lotCode: string; quantity: number; expiresOn: string | null; expired: boolean; receivedAt: string }[];
}

export interface CatalogResponse {
  ok: boolean;
  products: CatalogProduct[];
  alerts: { expiringSoon: number; expired: number; low: number };
  expiryDays: number;
  canAdmin: boolean;
}

export interface SaleRow {
  id: string;
  itemName: string;
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
}

export const unitsLabel = (n: number, unit: string) =>
  unit === "unidad" ? `${n} ${n === 1 ? "unidad" : "unidades"}` : `${n} ${unit}`;
