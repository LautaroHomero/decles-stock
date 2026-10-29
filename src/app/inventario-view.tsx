"use client";

import { useMemo, useState } from "react";
import { searchScore } from "@/lib/domain/quick-sale";
import { CaretDownIcon, PlusIcon } from "@phosphor-icons/react";
import { Pill, SECTION_TITLE } from "./ui";
import { ExpiryPicker } from "./expiry-picker";
import {
  BTN,
  BTN_DARK,
  CARD,
  FIELD,
  ProviderPicker,
  CommissionField,
  parsePct,
  cutDraftOf,
  cutsFromDraft,
  type Cut,
  type CutDraft,
  Toast,
  providerNames,
  useSellers,
  call,
  daysUntil,
  fmtDate,
  money,
  unitsLabel,
  usePoll,
  useToast,
  type ApiResult,
  type CatalogProduct,
  type CatalogResponse,
} from "./shared";

type Filter = "todos" | "vence" | "vencido" | "bajo";
type Panel = { kind: "lote" | "editar"; id: string } | { kind: "nuevo" } | null;

interface Movement {
  id: string;
  itemName: string;
  delta: number;
  reason: string;
  note: string;
  actorName: string;
  createdAt: string;
}

const REASON_LABEL: Record<string, string> = {
  ingreso: "Ingreso",
  uso: "Venta / uso",
  vencimiento: "Baja por vencimiento",
  perdida: "Pérdida",
  ajuste: "Ajuste",
};

/**
 * Inventario. El admin (quien hace el conteo) da de alta productos con su precio, ingresa
 * lotes con su vencimiento y da de baja lo vencido. El resto del equipo lo ve sin editar.
 */
export function InventarioView() {
  const [raw, refresh] = usePoll<CatalogResponse & { error?: string }>("/api/catalog", 20_000);
  // Si el servidor responde con error (p. ej. falta correr una migración), se muestra en vez de romper la pantalla.
  const data = raw?.ok && Array.isArray(raw.products) ? raw : null;
  const loadError = raw && !data ? (raw.error ?? "No se pudo cargar el stock.") : null;
  const [filter, setFilter] = useState<Filter>("todos");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [history, setHistory] = useState(false);
  const [toast, showToast] = useToast();
  const admin = data?.canAdmin ?? false;
  const days = data?.expiryDays ?? 30;
  const sellers = useSellers();

  const flags = (p: CatalogProduct) => ({
    vencido: p.expiredQuantity > 0,
    vence: p.expiries.some((e) => daysUntil(e.expiresOn) <= days),
    bajo: p.low,
  });

  const items = useMemo(() => {
    // Buscador tolerante: mayúsculas, tildes y errores de tipeo no importan; lo más parecido primero.
    const term = q.trim();
    const scored = (data?.products ?? [])
      .map((p) => ({ p, s: term ? Math.max(searchScore(term, p.name), searchScore(term, `${p.name} ${p.category}`)) : 1 }))
      .filter((x) => x.s > 0 && (filter === "todos" || flags(x.p)[filter]));
    if (term) scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, q, filter]);

  async function act(url: string, method: "POST" | "PATCH", body: object, ok: (r: ApiResult) => string) {
    const r = await call(url, method, body);
    if (!r.ok) {
      showToast(r.error ?? "No se pudo completar.");
      return false;
    }
    showToast(ok(r));
    setPanel(null);
    refresh();
    return true;
  }

  const counts = {
    todos: data?.products.length ?? 0,
    vence: data?.products.filter((p) => flags(p).vence).length ?? 0,
    vencido: data?.products.filter((p) => flags(p).vencido).length ?? 0,
    bajo: data?.products.filter((p) => p.low).length ?? 0,
  };
  const expiredLots = (data?.products ?? []).flatMap((p) => p.lots.filter((l) => l.expired).map((l) => ({ ...l, item: p.name })));

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <Toast msg={toast} />
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <h1 className="font-display text-[22px] font-medium tracking-[-.01em]">Stock</h1>
          <p className="text-[13px] text-neutral-400">
            {admin ? "Cargá lo que entra con su vencimiento. Las ventas descuentan solas." : "Lo que hay en el consultorio. Lo carga el admin."}
          </p>
        </div>
        <span className="flex-1" />
        <button className={BTN} onClick={() => setHistory((h) => !h)}>
          {history ? "Ver productos" : "Historial"}
        </button>
        {admin && (
          <button className={`${BTN_DARK} inline-flex items-center gap-1`} onClick={() => setPanel({ kind: "nuevo" })}>
            <PlusIcon size={13} /> Nuevo producto
          </button>
        )}
      </div>

      {panel?.kind === "nuevo" && (
        <NewProductForm
          onCancel={() => setPanel(null)}
          onSubmit={(v) =>
            act("/api/products", "POST", v, (r) => (r.lotError ? `Producto creado, pero el lote no: ${r.lotError}` : "Producto creado."))
          }
        />
      )}

      {expiredLots.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface px-4 py-3 shadow-sm">
          <span className="min-w-[220px] flex-1 text-[13px]">
            <b className="font-medium">{expiredLots.length === 1 ? "1 lote vencido" : `${expiredLots.length} lotes vencidos`}</b>{" "}
            <span className="text-neutral-400">
              ({expiredLots.map((l) => `${l.item} ${fmtDate(l.expiresOn!)}`).join(" · ")}). No se venden; hay que darlos de baja.
            </span>
          </span>
          {admin && (
            <button
              className={BTN_DARK}
              onClick={() => act("/api/stock/write-off-expired", "POST", {}, (r) => `Se dieron de baja ${r.lots} lote(s), ${r.units} unidades.`)}
            >
              Dar de baja vencidos
            </button>
          )}
        </div>
      )}

      {history ? (
        <History />
      ) : loadError ? (
        <p className="rounded-lg bg-surface px-4 py-3 text-[13.5px] text-fg">
          {loadError} Si estás en tu computadora, corré <code>npm run db:migrate</code> y recargá.
        </p>
      ) : !data ? (
        <p className="text-[13px] text-neutral-500">Cargando…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ["todos", "Todos"],
                ["vence", `Vence en ${days} días`],
                ["vencido", "Vencidos"],
                ["bajo", "Stock bajo"],
              ] as [Filter, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setFilter(id)}
                className={`rounded-pill border px-3 py-1 text-[12px] transition-colors ${
                  filter === id ? "border-accent text-accent-300" : "border-neutral-800 text-neutral-400 hover:border-accent-700"
                }`}
              >
                {label} <span className="tabular-nums text-neutral-500">{counts[id]}</span>
              </button>
            ))}
            <span className="flex-1" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar" className={`${FIELD} !w-full sm:!w-[200px]`} />
          </div>

          {data.products.length === 0 ? (
            <p className="text-[13.5px] text-neutral-400">
              Todavía no hay productos. {admin ? "Creá el primero con «Nuevo producto»." : "Los carga el admin."}
            </p>
          ) : items.length === 0 ? (
            <p className="text-[13px] text-neutral-400">Nada coincide con ese filtro.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {items.map((p) => (
                <ProductRow
                  key={p.stockItemId}
                  p={p}
                  days={days}
                  admin={admin}
                  expanded={open === p.stockItemId}
                  onToggle={() => setOpen(open === p.stockItemId ? null : p.stockItemId)}
                  panel={panel && panel.kind !== "nuevo" && panel.id === p.stockItemId ? panel.kind : null}
                  setPanel={(k) => setPanel(k ? { kind: k, id: p.stockItemId } : null)}
                  sellers={sellers}
                  act={act}
                />
              ))}
            </div>
          )}

          {admin && <ExpirySetting days={days} onSave={(d) => act("/api/stock/settings", "PATCH", { expiryDays: d }, () => "Guardado.")} />}
        </>
      )}
    </div>
  );
}

function ProductRow({
  p,
  days,
  admin,
  expanded,
  onToggle,
  panel,
  setPanel,
  act,
  sellers,
}: {
  sellers: { id: string; name: string }[] | null;
  p: CatalogProduct;
  days: number;
  admin: boolean;
  expanded: boolean;
  onToggle: () => void;
  panel: "lote" | "editar" | null;
  setPanel: (k: "lote" | "editar" | null) => void;
  act: (url: string, method: "POST" | "PATCH", body: object, ok: (r: ApiResult) => string) => Promise<boolean>;
}) {
  const next = p.nextExpiry;
  const soon = next !== null && daysUntil(next) <= days;
  return (
    <div className="overflow-hidden rounded-xl bg-surface shadow-sm">
      <button onClick={onToggle} aria-expanded={expanded} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent-900">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-medium">{p.name}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-neutral-400">
            <span className="tabular-nums">
              {p.giftCard ? "Gift card · stock infinito" : p.infiniteStock ? "∞ · stock infinito" : unitsLabel(p.available, p.unit)}
              {p.minQuantity > 0 && <span className="text-neutral-600"> / mín. {p.minQuantity}</span>}
            </span>
            {next && <span>· vence {fmtDate(next)}</span>}
            {soon && <Pill className="!py-0 !text-[11px]">por vencer</Pill>}
            {p.expiredQuantity > 0 && <Pill className="!py-0 !text-[11px]">{p.expiredQuantity} vencidas</Pill>}
            {p.low && <Pill className="!py-0 !text-[11px]">stock bajo</Pill>}
            {p.owed > 0 && <Pill className="!py-0 !text-[11px]">vendido sin stock: {p.owed} · cargá el ingreso</Pill>}
            {p.providerIds.length > 0 && <span>· {providerNames(p.providerIds, sellers, p.providerCuts)}</span>}
            {p.commissionPct !== null && <span>· comisión {p.commissionPct}%</span>}
          </span>
        </span>
        <span className="flex flex-col items-end text-[14px] leading-tight tabular-nums text-neutral-300">
          {p.price === null ? "sin precio" : money(p.price)}
          {p.cardPrice !== null && p.cardPrice !== p.price && <span className="text-[11.5px] text-neutral-500">tarjeta {money(p.cardPrice)}</span>}
        </span>
        <CaretDownIcon size={14} className={`text-neutral-500 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="flex animate-cl-in flex-col gap-3 border-t border-neutral-800 px-4 py-3.5">
          {p.lots.length === 0 ? (
            <p className="text-[13px] text-neutral-500">Sin lotes con stock.</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[.06em] text-neutral-500">
                  <th className="pb-1.5 font-normal">Vence</th>
                  <th className="pb-1.5 font-normal">Cantidad</th>
                  <th className="pb-1.5 font-normal">Lote</th>
                  {admin && <th />}
                </tr>
              </thead>
              <tbody>
                {p.lots.map((l) => (
                  <tr key={l.id} className="border-t border-neutral-900">
                    <td className="py-1.5 tabular-nums">
                      {l.expiresOn ? fmtDate(l.expiresOn) : "No vence"}
                      {l.expired && <span className="ml-1.5 text-neutral-400">(vencido)</span>}
                    </td>
                    <td className="py-1.5 tabular-nums">{l.quantity}</td>
                    <td className="py-1.5 text-neutral-400">{l.lotCode || "—"}</td>
                    {admin && (
                      <td className="py-1.5 text-right">
                        <button
                          className={BTN}
                          onClick={() =>
                            act(`/api/stock/lots/${l.id}/write-off`, "POST", { reason: l.expired ? "vencimiento" : "perdida" }, (r) => `Lote dado de baja (${r.quantity} u.).`)
                          }
                        >
                          Dar de baja
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {admin && panel === null && (
            <div className="flex flex-wrap gap-2">
              <button className={BTN_DARK} onClick={() => setPanel("lote")}>
                Ingresar lote
              </button>
              <button className={BTN} onClick={() => setPanel("editar")}>
                Editar precio, médicas y comisión
              </button>
            </div>
          )}

          {admin && panel === "lote" && (
            <LotForm
              unit={p.unit}
              onCancel={() => setPanel(null)}
              onSubmit={(v) => act(`/api/stock/${p.stockItemId}/lots`, "POST", v, (r) => `Ingresado. Disponibles: ${r.available}.`)}
            />
          )}
          {admin && panel === "editar" && (
            <EditForm
              p={p}
              onCancel={() => setPanel(null)}
              onSubmit={(v) => act(`/api/products/${p.stockItemId}`, "PATCH", v, () => (v.active === false ? "Producto dado de baja." : "Guardado."))}
            />
          )}
        </div>
      )}
    </div>
  );
}

const toInt = (s: string) => (s.trim() === "" ? undefined : Number(s.replace(/\D/g, "")));
const Label = ({ children }: { children: React.ReactNode }) => <span className="text-[12px] text-neutral-400">{children}</span>;

function NewProductForm({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (v: object) => Promise<boolean> }) {
  const [f, setF] = useState({ name: "", price: "", cardPrice: "", minQuantity: "", quantity: "", expiresOn: "", lotCode: "" });
  const [infiniteStock, setInfiniteStock] = useState(false);
  const [giftCard, setGiftCard] = useState(false);
  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [cuts, setCuts] = useState<CutDraft>({});
  const [commission, setCommission] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const ok = f.name.trim() && f.price.trim();
  return (
    <div className={CARD}>
      <p className="text-[14px] font-medium">Nuevo producto</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 sm:col-span-2">
          <Label>Nombre</Label>
          <input autoFocus value={f.name} onChange={set("name")} placeholder="Ej. Crema hidratante facial" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <Label>Precio efectivo / transferencia ($)</Label>
          <input value={f.price} onChange={set("price")} inputMode="numeric" placeholder="18500" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <Label>Precio con tarjeta ($)</Label>
          <input value={f.cardPrice} onChange={set("cardPrice")} inputMode="numeric" placeholder="Vacío = el mismo" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <Label>Avisar si quedan menos de</Label>
          <input value={f.minQuantity} onChange={set("minQuantity")} inputMode="numeric" placeholder="Ej. 3 (opcional)" className={FIELD} disabled={infiniteStock || giftCard} />
        </label>
        <div className="flex flex-col gap-2 self-end pb-2 text-[13px] text-neutral-300">
          <label className="flex items-center gap-2"><input type="checkbox" checked={infiniteStock} onChange={(e) => setInfiniteStock(e.target.checked)} />Stock infinito</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={giftCard} onChange={(e) => { setGiftCard(e.target.checked); if (e.target.checked) setInfiniteStock(true); }} />Es gift card</label>
        </div>
        <label className="flex flex-col gap-1">
          <Label>Cantidad que entra ahora</Label>
          <input value={f.quantity} onChange={set("quantity")} inputMode="numeric" placeholder="Ej. 12 (opcional)" className={FIELD} disabled={infiniteStock || giftCard} />
        </label>
        {!infiniteStock && !giftCard && <div className="flex flex-col gap-1">
          <Label>Vencimiento</Label>
          <ExpiryPicker value={f.expiresOn} onChange={(expiresOn) => setF({ ...f, expiresOn })} />
        </div>}
        <label className="flex flex-col gap-1">
          <Label>Lote (opcional)</Label>
          <input value={f.lotCode} onChange={set("lotCode")} placeholder="Como figura en la caja" className={FIELD} disabled={infiniteStock || giftCard} />
        </label>
        <CommissionField value={commission} onChange={setCommission} />
      </div>
      <ProviderPicker value={providerIds} onChange={setProviderIds} cuts={cuts} onCuts={setCuts} />
      <div className="flex gap-2">
        <button
          className={BTN_DARK}
          disabled={!ok || busy}
          onClick={async () => {
            setBusy(true);
            await onSubmit({
              name: f.name,
              price: toInt(f.price),
              cardPrice: toInt(f.cardPrice) ?? null,
              minQuantity: toInt(f.minQuantity) ?? 0,
              infiniteStock: infiniteStock || giftCard,
              giftCard,
              quantity: toInt(f.quantity),
              expiresOn: f.expiresOn,
              lotCode: f.lotCode,
              providerIds,
              providerCuts: cutsFromDraft(cuts, providerIds),
              commissionPct: parsePct(commission),
            });
            setBusy(false);
          }}
        >
          Crear producto
        </button>
        <button className={BTN} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

function LotForm({ unit, onCancel, onSubmit }: { unit: string; onCancel: () => void; onSubmit: (v: object) => Promise<boolean> }) {
  const [f, setF] = useState({ quantity: "", expiresOn: "", lotCode: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 p-3.5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <Label>Cantidad ({unit})</Label>
          <input autoFocus value={f.quantity} onChange={set("quantity")} inputMode="numeric" className={FIELD} />
        </label>
        <div className="flex flex-col gap-1">
          <Label>Vencimiento</Label>
          <ExpiryPicker value={f.expiresOn} onChange={(expiresOn) => setF({ ...f, expiresOn })} />
        </div>
        <label className="flex flex-col gap-1">
          <Label>Lote (opcional)</Label>
          <input value={f.lotCode} onChange={set("lotCode")} className={FIELD} />
        </label>
      </div>
      <div className="flex gap-2">
        <button
          className={BTN_DARK}
          disabled={!toInt(f.quantity) || busy}
          onClick={async () => {
            setBusy(true);
            await onSubmit({ quantity: toInt(f.quantity), expiresOn: f.expiresOn, lotCode: f.lotCode });
            setBusy(false);
          }}
        >
          Ingresar
        </button>
        <button className={BTN} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

type ProductPatch = {
  name?: string;
  price?: number;
  cardPrice?: number | null;
  minQuantity?: number;
  active?: boolean;
  infiniteStock?: boolean;
  giftCard?: boolean;
  providerIds?: string[];
  providerCuts?: Record<string, Cut>;
  commissionPct?: number | null;
};

function EditForm({ p, onCancel, onSubmit }: { p: CatalogProduct; onCancel: () => void; onSubmit: (v: ProductPatch) => Promise<boolean> }) {
  const [f, setF] = useState({
    name: p.name,
    price: p.price === null ? "" : String(p.price),
    cardPrice: p.cardPrice === null ? "" : String(p.cardPrice),
    minQuantity: String(p.minQuantity),
  });
  const [infiniteStock, setInfiniteStock] = useState(p.infiniteStock);
  const [giftCard, setGiftCard] = useState(p.giftCard);
  const [providerIds, setProviderIds] = useState<string[]>(p.providerIds);
  const [cuts, setCuts] = useState<CutDraft>(() => cutDraftOf(p.providerCuts));
  const [commission, setCommission] = useState(p.commissionPct === null ? "" : String(p.commissionPct));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 p-3.5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <Label>Nombre</Label>
          <input value={f.name} onChange={set("name")} className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <Label>Precio efectivo / transf. ($)</Label>
          <input value={f.price} onChange={set("price")} inputMode="numeric" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <Label>Precio con tarjeta ($)</Label>
          <input value={f.cardPrice} onChange={set("cardPrice")} inputMode="numeric" placeholder="Vacío = el mismo" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <Label>Mínimo</Label>
          <input value={f.minQuantity} onChange={set("minQuantity")} inputMode="numeric" className={FIELD} disabled={infiniteStock || giftCard} />
        </label>
        <div className="flex flex-col gap-2 self-end pb-2 text-[13px] text-neutral-300">
          <label className="flex items-center gap-2"><input type="checkbox" checked={infiniteStock} onChange={(e) => setInfiniteStock(e.target.checked)} />Stock infinito</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={giftCard} onChange={(e) => { setGiftCard(e.target.checked); if (e.target.checked) setInfiniteStock(true); }} />Es gift card</label>
        </div>
        <CommissionField value={commission} onChange={setCommission} />
      </div>
      <ProviderPicker value={providerIds} onChange={setProviderIds} cuts={cuts} onCuts={setCuts} />
      <div className="flex flex-wrap gap-2">
        <button className={BTN_DARK} onClick={() => onSubmit({ name: f.name, price: toInt(f.price), cardPrice: toInt(f.cardPrice) ?? null, minQuantity: toInt(f.minQuantity) ?? 0, infiniteStock: infiniteStock || giftCard, giftCard, providerIds, providerCuts: cutsFromDraft(cuts, providerIds), commissionPct: parsePct(commission) })}>
          Guardar
        </button>
        <button className={BTN} onClick={onCancel}>
          Cancelar
        </button>
        <span className="flex-1" />
        <button className={BTN} onClick={() => onSubmit({ active: false })}>
          Dar de baja el producto
        </button>
      </div>
    </div>
  );
}

function ExpirySetting({ days, onSave }: { days: number; onSave: (d: number) => void }) {
  const [v, setV] = useState(String(days));
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px] text-neutral-400">
      Avisar cuando falten
      <input value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className={`${FIELD} !w-16 text-center`} />
      días para que algo venza.
      {Number(v) !== days && Number(v) > 0 && (
        <button className={BTN_DARK} onClick={() => onSave(Number(v))}>
          Guardar
        </button>
      )}
    </div>
  );
}

function History() {
  const [data] = usePoll<{ ok: boolean; movements: Movement[] }>("/api/stock/movements?limit=150", 30_000);
  if (!data) return <p className="text-[13px] text-neutral-500">Cargando…</p>;
  if (!data.movements.length) return <p className="text-[13px] text-neutral-400">Sin movimientos todavía.</p>;
  return (
    <section className="flex flex-col gap-2">
      <h2 className={SECTION_TITLE}>Últimos movimientos</h2>
      <ul className="flex flex-col">
        {data.movements.map((m) => (
          <li key={m.id} className="flex items-baseline gap-3 border-b border-neutral-900 py-2 text-[13px] last:border-0">
            <span className="w-[86px] shrink-0 tabular-nums text-neutral-500">
              {m.createdAt.slice(8, 10)}/{m.createdAt.slice(5, 7)} {m.createdAt.slice(11, 16)}
            </span>
            <span className={`w-10 shrink-0 text-right tabular-nums ${m.delta > 0 ? "text-fg" : "text-neutral-400"}`}>
              {m.delta > 0 ? `+${m.delta}` : m.delta}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {m.itemName} <span className="text-neutral-500">· {REASON_LABEL[m.reason] ?? m.reason}</span>
            </span>
            <span className="hidden truncate text-neutral-500 sm:block">{m.actorName}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
