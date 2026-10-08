"use client";

import { useEffect, useMemo, useState } from "react";
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
  Amount,
  PAYMENT_LABEL,
  cardOf,
  type CatalogProduct,
  type CatalogResponse,
  type Payment,
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
  const isMedico = actor.role === "medico";
  const [seller, setSeller] = useSeller(!isMedico);
  const [sellersData] = usePoll<{ ok: boolean; sellers: { providerId: string; name: string; aliases: string[] }[] }>("/api/sellers", 60_000);
  const sellers = useMemo(
    () => (isMedico ? [] : (sellersData?.sellers ?? []).map((s) => ({ id: s.providerId, name: s.name, aliases: s.aliases }))),
    [sellersData, isMedico],
  );
  // La médica que registra vende a su nombre; si registra otra persona, tiene que elegir la médica.
  const sellerReady = isMedico || !!seller;
  // Medio de pago: opcional y por venta (se limpia después de registrar).
  const [payment, setPayment] = useState<Payment | null>(null);

  function onSold(msg: string) {
    setPayment(null);
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

      {!isMedico && <SellerPicker sellers={sellers} loaded={!!sellersData} seller={seller} setSeller={setSeller} />}

      <PaymentPicker payment={payment} setPayment={setPayment} />

      <Hoja products={sellable} sellers={sellers} providerId={seller} sellerReady={sellerReady} payment={payment} onSold={onSold} onError={showToast} />

      <ProductList
        products={sellable}
        providerId={seller}
        sellerReady={sellerReady}
        payment={payment}
        loading={!data}
        onSold={onSold}
        onError={showToast}
      />

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
  sellers,
  providerId,
  sellerReady,
  payment,
  onSold,
  onError,
}: {
  products: CatalogProduct[];
  sellers: { id: string; name: string; aliases?: string[] }[];
  providerId: string | null;
  sellerReady: boolean;
  payment: Payment | null;
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
      parseQuickSale(text, catalog, sellers)
        .filter((l) => !dropped.has(l.text))
        .map((l) => ({ ...l, match: l.match ?? catalog.find((p) => p.id === picked[l.text]) ?? null })),
    [text, catalog, sellers, picked, dropped],
  );
  const ready = lines.length > 0 && lines.every((l) => l.match);
  // Cada renglón necesita médica: la escrita en el texto o, si no, la elegida arriba.
  const sellersOk = lines.every((l) => l.seller || sellerReady);
  const pickedName = sellers.find((s) => s.id === providerId)?.name;
  // Medio por renglón: el escrito en el texto o el elegido arriba (o ninguno).
  const methodOf = (l: { payment: Payment | null }) => l.payment ?? payment;
  const cashTotal = lines.reduce((n, l) => n + (l.match?.price ?? 0) * l.quantity, 0);
  const cardTotal = lines.reduce((n, l) => n + (l.match ? cardOf(l.match) : 0) * l.quantity, 0);
  const chargedTotal = lines.reduce(
    (n, l) => n + (l.match ? (methodOf(l) === "tarjeta" ? cardOf(l.match) : (l.match.price ?? 0)) : 0) * l.quantity,
    0,
  );
  const allKnown = lines.every((l) => methodOf(l));
  const totalLabel = allKnown || cashTotal === cardTotal ? money(allKnown ? chargedTotal : cashTotal) : `${money(cashTotal)} · tarjeta ${money(cardTotal)}`;

  async function registrar() {
    setBusy(true);
    const done: string[] = [];
    for (const l of lines) {
      const r = await call("/api/sales", "POST", {
        itemId: l.match!.priceItemId,
        quantity: l.quantity,
        providerId: l.seller?.id ?? providerId,
        paymentMethod: methodOf(l),
      });
      if (!r.ok) {
        setBusy(false);
        onError(`${l.match!.name}: ${r.error ?? "no se pudo registrar"}${done.length ? ` (lo anterior sí quedó registrado)` : ""}`);
        // Saca de la hoja lo que ya se registró, para no duplicarlo al reintentar.
        setDropped((d) => new Set([...d, ...lines.slice(0, done.length).map((x) => x.text)]));
        if (done.length) onSold(`Registrado: ${done.join(", ")}`);
        return;
      }
      done.push(`${l.quantity} × ${l.match!.name}${l.seller ? ` (${l.seller.name})` : ""}`);
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
        placeholder={"Escribí lo que vendiste y quién.\nEj: laura vendió 2 cremas pindonga con tarjeta"}
        className="w-full resize-none bg-transparent text-[16px] leading-relaxed outline-none placeholder:text-neutral-600"
      />

      {lines.length > 0 && (
        <ul className="flex flex-col gap-2 border-t border-neutral-800 pt-3">
          {lines.map((l) => (
            <li key={l.text} className="flex flex-col gap-1.5">
              {l.match ? (
                <div className="flex items-center gap-3 text-[15px]">
                  <span className="w-8 shrink-0 tabular-nums text-neutral-400">{l.quantity} ×</span>
                  <span className="min-w-0 flex-1 truncate">
                    {l.match.name}
                    {(l.seller?.name ?? pickedName ?? methodOf(l)) && (
                      <span className="block truncate text-[12.5px] text-neutral-400">
                        {[l.seller?.name ?? pickedName, methodOf(l) && PAYMENT_LABEL[methodOf(l)!]].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </span>
                  <Amount
                    cash={(l.match.price ?? 0) * l.quantity}
                    card={cardOf(l.match) * l.quantity}
                    method={methodOf(l)}
                    className="text-neutral-300"
                  />
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
        <button onClick={registrar} disabled={!ready || !sellersOk || busy} className={BTN_BIG}>
          {busy ? "Registrando…" : !ready ? "Elegí los productos marcados" : !sellersOk ? "Falta quién vendió (escribilo o elegilo arriba)" : `Registrar · ${totalLabel}`}
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
  providerId,
  sellerReady,
  payment,
  loading,
  onSold,
  onError,
}: {
  products: CatalogProduct[];
  providerId: string | null;
  sellerReady: boolean;
  payment: Payment | null;
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
          providerId={providerId}
          sellerReady={sellerReady}
          payment={payment}
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
  providerId,
  sellerReady,
  payment,
  open,
  onToggle,
  onSold,
  onError,
}: {
  p: CatalogProduct;
  providerId: string | null;
  sellerReady: boolean;
  payment: Payment | null;
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
    const r = await call("/api/sales", "POST", { itemId: p.priceItemId, quantity: qty, providerId, paymentMethod: payment });
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
        {out ? (
          <span className="text-[14.5px] text-neutral-300">sin stock</span>
        ) : (
          <Amount cash={p.price ?? 0} card={cardOf(p)} method={payment} className="text-[14.5px] text-neutral-300" />
        )}
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
          <button onClick={sell} disabled={busy || !sellerReady} className={`${BTN_BIG} !h-11 flex-1`}>
            {busy ? "…" : !sellerReady ? "Elegí quién vendió" : `Registrar · ${
                  payment === "tarjeta"
                    ? money(cardOf(p) * qty)
                    : payment || cardOf(p) === p.price
                      ? money((p.price ?? 0) * qty)
                      : `${money((p.price ?? 0) * qty)} · tarj. ${money(cardOf(p) * qty)}`
                }`}
          </button>
        </div>
      )}
    </div>
  );
}

const STEP =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-neutral-800 text-neutral-200 transition-colors hover:border-accent-700 hover:bg-accent-900 disabled:opacity-30";

// ---------------------------------------------------------------------------
// Quién vendió (cobra comisión)
// ---------------------------------------------------------------------------

const SELLER_KEY = "decles_seller";

/** Médica elegida; se recuerda en este navegador para no elegirla en cada venta. */
function useSeller(enabled: boolean): [string | null, (id: string | null) => void] {
  const [seller, setSellerState] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    try {
      const saved = localStorage.getItem(SELLER_KEY);
      if (saved) setTimeout(() => setSellerState(saved), 0);
    } catch {
      /* sin storage: se elige cada vez */
    }
  }, [enabled]);
  function setSeller(id: string | null) {
    setSellerState(id);
    try {
      if (id) localStorage.setItem(SELLER_KEY, id);
      else localStorage.removeItem(SELLER_KEY);
    } catch {
      /* ignore */
    }
  }
  return [seller, setSeller];
}

function SellerPicker({
  sellers: list,
  loaded,
  seller,
  setSeller,
}: {
  sellers: { id: string; name: string }[];
  loaded: boolean;
  seller: string | null;
  setSeller: (id: string | null) => void;
}) {
  const sellers = useMemo(() => list.map((s) => ({ providerId: s.id, name: s.name })), [list]);

  // Si la elegida ya no está (baja) se limpia; si hay una sola médica, queda elegida sola.
  useEffect(() => {
    if (!loaded) return;
    if (seller && !sellers.some((s) => s.providerId === seller)) setSeller(null);
    else if (!seller && sellers.length === 1) setSeller(sellers[0].providerId);
  }, [loaded, sellers, seller, setSeller]);

  if (!loaded) return null;
  if (!sellers.length) return <p className="text-[13px] text-neutral-400">No hay médicas activas: el admin las da de alta en Equipo.</p>;

  return (
    <section className="flex flex-col gap-2">
      <span className="text-[13px] text-neutral-400">¿Quién vendió? <span className="text-neutral-600">— o escribilo en la hoja</span></span>
      <div className="flex flex-wrap gap-2">
        {sellers.map((s) => (
          <button
            key={s.providerId}
            onClick={() => setSeller(s.providerId)}
            aria-pressed={seller === s.providerId}
            className={`rounded-pill border px-4 py-2 text-[14px] transition-colors ${
              seller === s.providerId ? "border-accent bg-accent text-bg" : "border-neutral-700 text-neutral-200 hover:border-accent-600"
            }`}
          >
            {s.name}
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Medio de pago (opcional)
// ---------------------------------------------------------------------------

function PaymentPicker({ payment, setPayment }: { payment: Payment | null; setPayment: (p: Payment | null) => void }) {
  return (
    <section className="flex flex-col gap-2">
      <span className="text-[13px] text-neutral-400">
        ¿Cómo pagó? <span className="text-neutral-600">— opcional, o escribilo en la hoja</span>
      </span>
      <div className="flex flex-wrap gap-2">
        {(["efectivo", "tarjeta"] as Payment[]).map((m) => (
          <button
            key={m}
            onClick={() => setPayment(payment === m ? null : m)}
            aria-pressed={payment === m}
            className={`rounded-pill border px-4 py-2 text-[14px] transition-colors ${
              payment === m ? "border-accent bg-accent text-bg" : "border-neutral-700 text-neutral-200 hover:border-accent-600"
            }`}
          >
            {PAYMENT_LABEL[m]}
          </button>
        ))}
      </div>
    </section>
  );
}
