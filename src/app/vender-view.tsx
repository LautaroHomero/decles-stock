"use client";

import { useMemo, useState } from "react";
import { MagnifyingGlassIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { Pill, SECTION_TITLE, firstName, greeting } from "./ui";
import {
  BTN_BIG,
  Toast,
  call,
  daysUntil,
  fmtDate,
  fmtTime,
  money,
  unitsLabel,
  usePoll,
  useToast,
  type CatalogProduct,
  type CatalogResponse,
  type SaleRow,
} from "./shared";

/**
 * Vender: buscar → tocar el producto → (cantidad / vencimiento, opcionales) → Registrar.
 * El precio lo pone el admin; el stock se descuenta solo, del lote que vence primero
 * salvo que se indique de cuál se vendió.
 */
export function VenderView({ actor }: { actor: Actor }) {
  const [data, refresh] = usePoll<CatalogResponse>("/api/catalog", 20_000);
  const [sales, refreshSales] = usePoll<{ ok: boolean; sales: SaleRow[] }>("/api/sales", 30_000);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [toast, showToast] = useToast();

  const products = useMemo(() => {
    const term = norm(q.trim());
    const list = (data?.products ?? []).filter((p) => !term || norm(`${p.name} ${p.category}`).includes(term));
    // Lo vendible primero.
    return list.sort((a, b) => Number(sellable(b)) - Number(sellable(a)) || a.name.localeCompare(b.name));
  }, [data, q]);

  const today = (sales?.sales ?? []).filter((s) => s.status === "paid");
  const todayTotal = today.reduce((n, s) => n + s.total, 0);

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <Toast msg={toast} />
      <div>
        <h1 className="font-display text-[22px] font-medium tracking-[-.01em]">
          {greeting()}, {firstName(actor.name)}
        </h1>
        <p className="mt-1 text-[13.5px] text-neutral-400">Tocá el producto que vendiste.</p>
      </div>

      <label className="flex h-12 items-center gap-2.5 rounded-lg border border-neutral-800 px-3.5 transition-colors focus-within:border-accent-700">
        <MagnifyingGlassIcon size={18} className="text-neutral-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar producto"
          className="h-full flex-1 bg-transparent text-[15px] outline-none placeholder:text-neutral-600"
        />
      </label>

      {!data ? (
        <p className="text-[13px] text-neutral-500">Cargando…</p>
      ) : products.length === 0 ? (
        <p className="text-[13.5px] text-neutral-400">
          {data.products.length === 0 ? "Todavía no hay productos cargados. El admin los carga desde Stock." : "Nada coincide con esa búsqueda."}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {products.map((p) => (
            <ProductCard
              key={p.stockItemId}
              p={p}
              open={open === p.stockItemId}
              onToggle={() => setOpen(open === p.stockItemId ? null : p.stockItemId)}
              onSold={(m) => {
                setOpen(null);
                setQ("");
                showToast(m);
                refresh();
                refreshSales();
              }}
              onError={showToast}
            />
          ))}
        </div>
      )}

      <section className="mt-2 flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className={SECTION_TITLE}>{actor.role === "medico" ? "Tus ventas de hoy" : "Ventas de hoy"}</h2>
          <span className="flex-1" />
          {today.length > 0 && <span className="text-[13px] tabular-nums text-neutral-300">{money(todayTotal)}</span>}
        </div>
        {today.length === 0 ? (
          <p className="text-[13px] text-neutral-500">Ninguna todavía.</p>
        ) : (
          <ul className="flex flex-col">
            {today.map((s) => (
              <li key={s.id} className="flex items-baseline gap-3 border-b border-neutral-900 py-2 text-[13.5px] last:border-0">
                <span className="w-11 shrink-0 tabular-nums text-neutral-500">{fmtTime(s.createdAt)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {s.quantity} × {s.itemName}
                </span>
                <span className="tabular-nums text-neutral-300">{money(s.total)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const sellable = (p: CatalogProduct) => p.price !== null && p.available > 0;

function ProductCard({
  p,
  open,
  onToggle,
  onSold,
  onError,
}: {
  p: CatalogProduct;
  open: boolean;
  onToggle: () => void;
  onSold: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [qty, setQty] = useState(1);
  const [expiry, setExpiry] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const can = sellable(p);
  const soon = p.nextExpiry !== null && daysUntil(p.nextExpiry) <= 30;

  async function sell() {
    setBusy(true);
    const r = await call("/api/sales", "POST", { itemId: p.priceItemId, quantity: qty, expiresOn: expiry });
    setBusy(false);
    if (!r.ok) return onError(r.error ?? "No se pudo registrar la venta.");
    setQty(1);
    setExpiry(null);
    const left = typeof r.stockLeft === "number" ? ` · quedan ${r.stockLeft}` : "";
    onSold(`Listo: ${qty} × ${p.name}${left}`);
  }

  return (
    <div className={`overflow-hidden rounded-xl bg-surface shadow-sm transition-shadow ${open ? "shadow-md" : ""}`}>
      <button
        onClick={onToggle}
        disabled={!can}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent-900 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium">{p.name}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-neutral-400">
            {p.available > 0 ? <span>{unitsLabel(p.available, p.unit)}</span> : <span>Sin stock</span>}
            {soon && p.nextExpiry && <Pill className="!py-0 !text-[11px]">vence {fmtDate(p.nextExpiry)}</Pill>}
            {p.low && p.available > 0 && <Pill className="!py-0 !text-[11px]">quedan pocos</Pill>}
          </span>
        </span>
        <span className="text-[15px] tabular-nums">{p.price === null ? <span className="text-[12.5px] text-neutral-500">sin precio</span> : money(p.price)}</span>
      </button>

      {open && can && (
        <div className="flex animate-cl-in flex-col gap-4 border-t border-neutral-800 px-4 py-4">
          <div className="flex items-center gap-3">
            <span className="flex-1 text-[13.5px] text-neutral-300">Cantidad</span>
            <button onClick={() => setQty((n) => Math.max(1, n - 1))} aria-label="Uno menos" className={STEP}>
              <MinusIcon size={18} />
            </button>
            <span className="w-8 text-center text-[20px] tabular-nums">{qty}</span>
            <button onClick={() => setQty((n) => Math.min(p.available, n + 1))} aria-label="Uno más" className={STEP} disabled={qty >= p.available}>
              <PlusIcon size={18} />
            </button>
          </div>

          {p.expiries.length > 1 && (
            <div className="flex flex-col gap-2">
              <span className="text-[12.5px] text-neutral-400">¿De qué vencimiento? (opcional)</span>
              <div className="flex flex-wrap gap-2">
                <Chip active={expiry === null} onClick={() => setExpiry(null)}>
                  El que vence primero
                </Chip>
                {p.expiries.map((e) => (
                  <Chip key={e.expiresOn} active={expiry === e.expiresOn} onClick={() => setExpiry(e.expiresOn)}>
                    {fmtDate(e.expiresOn)} <span className="text-neutral-500">· {e.quantity}</span>
                  </Chip>
                ))}
              </div>
            </div>
          )}

          <button onClick={sell} disabled={busy} className={BTN_BIG}>
            {busy ? "Registrando…" : `Registrar venta · ${money((p.price ?? 0) * qty)}`}
          </button>
        </div>
      )}
    </div>
  );
}

const STEP =
  "flex h-11 w-11 items-center justify-center rounded-lg border border-neutral-800 text-neutral-200 transition-colors hover:border-accent-700 hover:bg-accent-900 disabled:opacity-30";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-pill border px-3 py-1.5 text-[12.5px] tabular-nums transition-colors ${
        active ? "border-accent bg-accent-900 text-accent-200" : "border-neutral-800 text-neutral-300 hover:border-accent-700"
      }`}
    >
      {children}
    </button>
  );
}
