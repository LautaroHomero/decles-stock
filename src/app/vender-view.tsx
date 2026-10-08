"use client";

import { useMemo, useState } from "react";
import { MagnifyingGlassIcon, MinusIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { parseQuickSale } from "@/lib/domain/quick-sale";
import { SECTION_TITLE, firstName, greeting } from "./ui";
import {
  BTN_BIG,
  Toast,
  call,
  fmtTime,
  money,
  usePoll,
  useToast,
  type CatalogProduct,
  type CatalogResponse,
  type SaleRow,
} from "./shared";

/**
 * Vender, lo más simple posible: escribir lo vendido en la hoja ("vendí 2 cremas
 * pindonga") o tocar el producto en la lista. Solo nombre y precio: vencimientos y
 * stock son cosa del admin y la médica. El stock se descuenta solo (lote que vence primero).
 */
export function VenderView({ actor }: { actor: Actor }) {
  const [data, refresh] = usePoll<CatalogResponse>("/api/catalog", 20_000);
  const [sales, refreshSales] = usePoll<{ ok: boolean; sales: SaleRow[] }>("/api/sales", 30_000);
  const [toast, showToast] = useToast();

  const sellable = useMemo(() => (data?.products ?? []).filter((p) => p.price !== null && p.priceItemId), [data]);

  function onSold(msg: string) {
    showToast(msg);
    refresh();
    refreshSales();
  }

  const today = (sales?.sales ?? []).filter((s) => s.status === "paid");

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <Toast msg={toast} />
      <h1 className="font-display text-[22px] font-medium tracking-[-.01em]">
        {greeting()}, {firstName(actor.name)}
      </h1>

      <Hoja products={sellable} onSold={onSold} onError={showToast} />

      <ProductList products={sellable} loading={!data} onSold={onSold} onError={showToast} />

      {today.length > 0 && (
        <section className="flex flex-col gap-1">
          <h2 className={SECTION_TITLE}>Vendido hoy</h2>
          <ul className="flex flex-col">
            {today.map((s) => (
              <li key={s.id} className="flex items-baseline gap-3 border-b border-neutral-900 py-2 text-[13.5px] last:border-0">
                <span className="w-11 shrink-0 tabular-nums text-neutral-500">{fmtTime(s.createdAt)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {s.quantity} × {s.itemName}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hoja: texto libre → renglones → confirmar
// ---------------------------------------------------------------------------

type Sellable = CatalogProduct & { id: string };

function Hoja({
  products,
  onSold,
  onError,
}: {
  products: CatalogProduct[];
  onSold: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [text, setText] = useState("");
  // Elecciones de la secretaria cuando el texto es ambiguo, por renglón (clave: el texto del renglón).
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const catalog: Sellable[] = useMemo(() => products.map((p) => ({ ...p, id: p.stockItemId })), [products]);
  const lines = useMemo(
    () =>
      parseQuickSale(text, catalog)
        .filter((l) => !dropped.has(l.text))
        .map((l) => ({ ...l, match: l.match ?? catalog.find((p) => p.id === picked[l.text]) ?? null })),
    [text, catalog, picked, dropped],
  );
  const ready = lines.length > 0 && lines.every((l) => l.match);
  const total = lines.reduce((n, l) => n + (l.match?.price ?? 0) * l.quantity, 0);

  async function registrar() {
    setBusy(true);
    const done: string[] = [];
    for (const l of lines) {
      const r = await call("/api/sales", "POST", { itemId: l.match!.priceItemId, quantity: l.quantity });
      if (!r.ok) {
        setBusy(false);
        onError(`${l.match!.name}: ${r.error ?? "no se pudo registrar"}${done.length ? ` (lo anterior sí quedó registrado)` : ""}`);
        // Saca de la hoja lo que ya se registró, para no duplicarlo al reintentar.
        setDropped((d) => new Set([...d, ...lines.slice(0, done.length).map((x) => x.text)]));
        if (done.length) onSold(`Registrado: ${done.join(", ")}`);
        return;
      }
      done.push(`${l.quantity} × ${l.match!.name}`);
    }
    setBusy(false);
    setText("");
    setPicked({});
    setDropped(new Set());
    onSold(`Registrado: ${done.join(", ")}`);
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-surface p-4 shadow-sm">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDropped(new Set());
        }}
        rows={3}
        placeholder={"Escribí lo que vendiste.\nEj: vendí 2 cremas pindonga y un protector"}
        className="w-full resize-none bg-transparent text-[16px] leading-relaxed outline-none placeholder:text-neutral-600"
      />

      {lines.length > 0 && (
        <ul className="flex flex-col gap-2 border-t border-neutral-800 pt-3">
          {lines.map((l) => (
            <li key={l.text} className="flex flex-col gap-1.5">
              {l.match ? (
                <div className="flex items-center gap-3 text-[15px]">
                  <span className="w-8 shrink-0 tabular-nums text-neutral-400">{l.quantity} ×</span>
                  <span className="min-w-0 flex-1 truncate">{l.match.name}</span>
                  <span className="tabular-nums text-neutral-300">{money((l.match.price ?? 0) * l.quantity)}</span>
                  <button
                    aria-label="Quitar"
                    onClick={() => setDropped((d) => new Set([...d, l.text]))}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-accent-900 hover:text-fg"
                  >
                    <XIcon size={14} />
                  </button>
                </div>
              ) : l.candidates.length ? (
                <>
                  <span className="text-[13.5px] text-neutral-400">
                    «{l.text}»: ¿cuál?
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {l.candidates.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => setPicked((p) => ({ ...p, [l.text]: c.id }))}
                        className="rounded-pill border border-neutral-700 px-3 py-1.5 text-[13px] transition-colors hover:border-accent hover:bg-accent-900"
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-3 text-[13.5px] text-neutral-400">
                  <span className="flex-1">No encontré «{l.text}». Buscalo en la lista de abajo.</span>
                  <button aria-label="Quitar" onClick={() => setDropped((d) => new Set([...d, l.text]))} className="text-neutral-500 hover:text-fg">
                    <XIcon size={14} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {lines.length > 0 && (
        <button onClick={registrar} disabled={!ready || busy} className={BTN_BIG}>
          {busy ? "Registrando…" : ready ? `Registrar · ${money(total)}` : "Elegí los productos marcados"}
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Lista: tocar el producto → cantidad → Registrar
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function ProductList({
  products,
  loading,
  onSold,
  onError,
}: {
  products: CatalogProduct[];
  loading: boolean;
  onSold: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const list = useMemo(() => {
    const term = norm(q.trim());
    return products.filter((p) => !term || norm(p.name).includes(term));
  }, [products, q]);

  if (loading) return <p className="text-[13px] text-neutral-500">Cargando…</p>;
  if (!products.length) return <p className="text-[13.5px] text-neutral-400">Todavía no hay productos cargados.</p>;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h2 className={`${SECTION_TITLE} flex-1`}>O tocá el producto</h2>
        <label className="flex h-9 w-[180px] items-center gap-2 rounded-md border border-neutral-800 px-2.5 focus-within:border-accent-700">
          <MagnifyingGlassIcon size={14} className="text-neutral-500" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-neutral-600" />
        </label>
      </div>
      {list.map((p) => (
        <ProductRow
          key={p.stockItemId}
          p={p}
          open={open === p.stockItemId}
          onToggle={() => setOpen(open === p.stockItemId ? null : p.stockItemId)}
          onSold={(m) => {
            setOpen(null);
            onSold(m);
          }}
          onError={onError}
        />
      ))}
      {list.length === 0 && <p className="text-[13px] text-neutral-500">Nada con ese nombre.</p>}
    </section>
  );
}

function ProductRow({
  p,
  open,
  onToggle,
  onSold,
  onError,
}: {
  p: CatalogProduct;
  open: boolean;
  onToggle: () => void;
  onSold: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const out = p.available === 0;

  async function sell() {
    setBusy(true);
    const r = await call("/api/sales", "POST", { itemId: p.priceItemId, quantity: qty });
    setBusy(false);
    if (!r.ok) return onError(r.error ?? "No se pudo registrar la venta.");
    setQty(1);
    onSold(`Registrado: ${qty} × ${p.name}`);
  }

  return (
    <div className="overflow-hidden rounded-xl bg-surface shadow-sm">
      <button
        onClick={onToggle}
        disabled={out}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent-900 disabled:cursor-not-allowed disabled:opacity-45"
      >
        <span className="min-w-0 flex-1 truncate text-[15px]">{p.name}</span>
        <span className="text-[14.5px] tabular-nums text-neutral-300">{out ? "sin stock" : money(p.price ?? 0)}</span>
      </button>
      {open && !out && (
        <div className="flex animate-cl-in items-center gap-3 border-t border-neutral-800 px-4 py-3">
          <button onClick={() => setQty((n) => Math.max(1, n - 1))} aria-label="Uno menos" className={STEP}>
            <MinusIcon size={18} />
          </button>
          <span className="w-8 text-center text-[20px] tabular-nums">{qty}</span>
          <button onClick={() => setQty((n) => Math.min(p.available, n + 1))} aria-label="Uno más" className={STEP} disabled={qty >= p.available}>
            <PlusIcon size={18} />
          </button>
          <button onClick={sell} disabled={busy} className={`${BTN_BIG} !h-11 flex-1`}>
            {busy ? "…" : `Registrar · ${money((p.price ?? 0) * qty)}`}
          </button>
        </div>
      )}
    </div>
  );
}

const STEP =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-neutral-800 text-neutral-200 transition-colors hover:border-accent-700 hover:bg-accent-900 disabled:opacity-30";
