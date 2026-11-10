"use client";

import { useMemo, useState } from "react";
import { MinusIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { normalize } from "@/lib/domain/quick-sale";
import { BTN, BTN_DARK, CARD, FIELD, Toast, call, money, usePoll, useToast, type CatalogResponse } from "./shared";

export interface ComboRow {
  id: string;
  name: string;
  price: number;
  cardPrice: number | null;
  active: boolean;
  items: { itemId: string; qty: number; name: string; kind: string }[];
  /** Lo que se lleva la profesional por el combo; null = lo de cada práctica. */
  cut: { pct: number | null; fixed: number | null } | null;
}

const cutText = (c: ComboRow["cut"]) => (!c ? null : c.fixed !== null ? `la profesional se lleva ${money(c.fixed)}` : `la profesional se lleva ${c.pct}%`);

/** Algo de la lista que puede ir en un combo (práctica o producto con precio). */
interface Pickable {
  id: string;
  name: string;
  product: boolean;
  price: number;
  cardPrice: number;
}

const toInt = (s: string) => (s.trim() === "" ? null : Number(s.replace(/\D/g, "")));

/** Stock → Combos: varias prácticas y/o productos a un precio especial. Al anotarlos juntos se aplica solo. */
export function CombosView({ canAdmin }: { canAdmin: boolean }) {
  const [data, refresh] = usePoll<{ ok: boolean; combos: ComboRow[] }>("/api/combos", 60_000);
  const [catalog] = usePoll<CatalogResponse>("/api/catalog", 60_000);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [toast, showToast] = useToast();
  const list = data?.combos ?? [];
  const pickable: Pickable[] = useMemo(
    () => [
      ...(catalog?.practices ?? []).map((p) => ({ id: p.id, name: p.name, product: false, price: p.price, cardPrice: p.cardPrice ?? p.price })),
      ...(catalog?.products ?? [])
        .filter((p) => p.priceItemId && p.price !== null && !p.giftCard)
        .map((p) => ({ id: p.priceItemId!, name: p.name, product: true, price: p.price ?? 0, cardPrice: p.cardPrice ?? p.price ?? 0 })),
    ],
    [catalog],
  );

  async function save(id: string | null, body: Record<string, unknown>, done: string) {
    const r = id ? await call(`/api/combos/${id}`, "PATCH", body) : await call("/api/combos", "POST", body);
    if (!r.ok) return showToast(r.error ?? "No se pudo guardar.");
    showToast(done);
    setEditing(null);
    refresh();
  }

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-4 py-6 sm:px-6">
      <Toast msg={toast} />
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[220px] flex-1 flex-col">
          <h1 className="font-display text-[16px] font-medium tracking-[-.01em]">Combos</h1>
          <p className="text-[13px] text-neutral-400">
            Prácticas y productos juntos a un precio especial. Cuando se anotan juntos (con la misma profesional), el combo se aplica solo.
          </p>
        </div>
        {canAdmin && editing !== "new" && (
          <button className={`${BTN_DARK} inline-flex items-center gap-1.5`} onClick={() => setEditing("new")}>
            <PlusIcon size={14} weight="bold" /> Nuevo combo
          </button>
        )}
      </div>

      {editing === "new" && <ComboForm pickable={pickable} onSave={(b) => save(null, b, `Combo «${String(b.name).trim()}» armado.`)} onCancel={() => setEditing(null)} />}

      {!data ? (
        <p className="text-[13px] text-neutral-500">Cargando…</p>
      ) : !list.length ? (
        <p className="text-[13.5px] text-neutral-400">{canAdmin ? "Todavía no hay combos. Armá el primero." : "Todavía no hay combos."}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((c) => {
            const lista = c.items.reduce((n, i) => n + (pickable.find((p) => p.id === i.itemId)?.price ?? 0) * i.qty, 0);
            return editing === c.id ? (
              <ComboForm
                key={c.id}
                initial={c}
                pickable={pickable}
                onSave={(b) => save(c.id, b, "Guardado.")}
                onCancel={() => setEditing(null)}
                onToggle={() => save(c.id, { active: !c.active }, c.active ? "Combo dado de baja." : "Combo reactivado.")}
              />
            ) : (
              <button
                key={c.id}
                disabled={!canAdmin}
                onClick={() => setEditing(c.id)}
                className={`flex items-center gap-4 rounded-xl bg-surface px-5 py-4 text-left shadow-sm transition-colors enabled:hover:bg-neutral-900 ${c.active ? "" : "opacity-50"}`}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] font-medium">
                    {c.name}
                    {!c.active && <span className="ml-2 text-[13px] font-normal text-neutral-500">(dado de baja)</span>}
                  </span>
                  <span className="text-[13.5px] text-neutral-400">{c.items.map((i) => `${i.qty > 1 ? `${i.qty} × ` : ""}${i.name}`).join(" + ")}</span>
                  {cutText(c.cut) && <span className="text-[13px] text-neutral-500">{cutText(c.cut)}</span>}
                </span>
                <span className="flex flex-col items-end text-[13.5px] tabular-nums">
                  <span>{money(c.price)}</span>
                  {c.cardPrice !== null && c.cardPrice !== c.price && <span className="text-[13px] text-neutral-500">tarjeta {money(c.cardPrice)}</span>}
                  {lista > c.price && <span className="text-[12.5px] text-neutral-500 line-through">{money(lista)}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ComboForm({
  initial,
  pickable,
  onSave,
  onCancel,
  onToggle,
}: {
  initial?: ComboRow;
  pickable: Pickable[];
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
  onToggle?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [price, setPrice] = useState(initial ? String(initial.price) : "");
  const [cardPrice, setCardPrice] = useState(initial?.cardPrice === null || !initial ? "" : String(initial.cardPrice));
  const [items, setItems] = useState<{ itemId: string; qty: number }[]>(initial?.items.map((i) => ({ itemId: i.itemId, qty: i.qty })) ?? []);
  const [q, setQ] = useState("");
  // Lo que se lleva la profesional: lo de cada práctica (como siempre), un % del combo o un monto fijo.
  const [cutMode, setCutMode] = useState<"normal" | "pct" | "fixed">(!initial?.cut ? "normal" : initial.cut.fixed !== null ? "fixed" : "pct");
  const [cutValue, setCutValue] = useState(!initial?.cut ? "" : String(initial.cut.fixed ?? initial.cut.pct ?? "").replace(".", ","));
  const cutNum = Number(cutValue.replace(/\./g, "").replace(",", "."));
  const cut = cutMode === "normal" || cutValue.trim() === "" ? null : cutMode === "fixed" ? { fixed: Math.round(cutNum) } : { pct: cutNum };
  const nameOf = (id: string) => pickable.find((p) => p.id === id)?.name ?? initial?.items.find((i) => i.itemId === id)?.name ?? "—";
  const hits = q.trim()
    ? pickable.filter((p) => normalize(p.name).includes(normalize(q.trim())) && !items.some((i) => i.itemId === p.id)).slice(0, 6)
    : [];
  const add = (id: string) => {
    setItems([...items, { itemId: id, qty: 1 }]);
    setQ("");
  };
  const setQty = (id: string, qty: number) => setItems(qty <= 0 ? items.filter((i) => i.itemId !== id) : items.map((i) => (i.itemId === id ? { ...i, qty } : i)));
  const listCash = items.reduce((n, i) => n + (pickable.find((p) => p.id === i.itemId)?.price ?? 0) * i.qty, 0);
  const listCard = items.reduce((n, i) => n + (pickable.find((p) => p.id === i.itemId)?.cardPrice ?? 0) * i.qty, 0);
  const p = toInt(price);
  const units = items.reduce((n, i) => n + i.qty, 0);
  const ready = !!name.trim() && p !== null && units >= 2;

  return (
    <div className={`${CARD} animate-cl-in`}>
      <label className="flex flex-col gap-1">
        <span className="cl-label">Nombre</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Promo peeling + contorno" className={FIELD} />
      </label>

      <div className="flex flex-col gap-2">
        <span className="cl-label">Qué lleva</span>
        {items.map((i) => (
          <div key={i.itemId} className="flex items-center gap-2 rounded-xl border border-neutral-800 px-3 py-2">
            <span className="flex-1 text-[14px]">
              {nameOf(i.itemId)}
              <span className="ml-2 text-[12.5px] text-neutral-500">{pickable.find((x) => x.id === i.itemId)?.product ? "producto" : "práctica"}</span>
            </span>
            <button type="button" aria-label="Uno menos" onClick={() => setQty(i.itemId, i.qty - 1)} className="grid size-9 place-items-center rounded-lg text-neutral-400 hover:text-fg">
              <MinusIcon size={14} />
            </button>
            <span className="w-6 text-center tabular-nums">{i.qty}</span>
            <button type="button" aria-label="Uno más" onClick={() => setQty(i.itemId, i.qty + 1)} className="grid size-9 place-items-center rounded-lg text-neutral-400 hover:text-fg">
              <PlusIcon size={14} />
            </button>
            <button type="button" aria-label="Sacar" onClick={() => setQty(i.itemId, 0)} className="grid size-9 place-items-center rounded-lg text-neutral-400 hover:text-fg">
              <XIcon size={14} />
            </button>
          </div>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits.length) {
              e.preventDefault();
              add(hits[0].id);
            }
          }}
          placeholder={items.length ? "Agregar otra práctica o producto…" : "Buscá una práctica o producto…"}
          className={FIELD}
        />
        {hits.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {hits.map((h) => (
              <button key={h.id} type="button" onClick={() => add(h.id)} className="rounded-pill border border-neutral-800 px-3 py-1 text-[13px] text-neutral-300 hover:text-fg">
                {h.name} · {money(h.price)}
              </button>
            ))}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="cl-label">Precio del combo (efectivo / transf.)</span>
          <input value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="$" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="cl-label">Con tarjeta</span>
          <input value={cardPrice} onChange={(e) => setCardPrice(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Vacío = el mismo" className={FIELD} />
        </label>
        <span className="flex flex-col justify-end pb-2 text-[13px] text-neutral-400">
          {units > 0 && (
            <>
              <span>
                Por separado: {money(listCash)}
                {listCard !== listCash ? ` · tarjeta ${money(listCard)}` : ""}
              </span>
              {p !== null && listCash > p && <span className="text-in">Ahorra {money(listCash - p)}</span>}
            </>
          )}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="cl-label">Lo que se lleva la profesional</span>
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" className="inline-flex rounded-xl border border-neutral-800 p-1">
            {(
              [
                ["normal", "Lo de cada práctica"],
                ["pct", "% del combo"],
                ["fixed", "Monto fijo"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={cutMode === id}
                onClick={() => setCutMode(id)}
                className={`min-h-10 rounded-lg px-3 text-[13px] font-medium ${cutMode === id ? "bg-accent text-on-accent" : "text-neutral-400 hover:text-fg"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {cutMode !== "normal" && (
            <input
              value={cutValue}
              onChange={(e) => setCutValue(e.target.value.replace(cutMode === "pct" ? /[^\d.,]/g : /\D/g, ""))}
              inputMode={cutMode === "pct" ? "decimal" : "numeric"}
              placeholder={cutMode === "pct" ? "%" : "$"}
              className={`${FIELD} w-[130px]`}
            />
          )}
        </div>
        <span className="text-[12.5px] text-neutral-500">
          {cutMode === "normal"
            ? "Cobra como si fueran por separado: su parte de cada práctica sobre lo que se cobró."
            : cutMode === "pct"
              ? `Su % sobre lo que se cobró por el combo${p !== null && cutValue ? ` (en efectivo: ${money(Math.round((p * cutNum) / 100))})` : ""}.`
              : "Ese monto por cada combo, sin importar el medio de pago."}
        </span>
      </div>

      {units > 0 && units < 2 && <p className="text-[13px] text-neutral-400">Un combo lleva al menos dos cosas (o dos de la misma).</p>}

      <div className="flex flex-wrap gap-2">
        <button
          className={BTN_DARK}
          disabled={!ready}
          onClick={() => onSave({ name, price: p, cardPrice: toInt(cardPrice), items, cut })}
        >
          Guardar
        </button>
        <button className={BTN} onClick={onCancel}>
          Cancelar
        </button>
        <span className="flex-1" />
        {initial && onToggle && (
          <button className={BTN} onClick={onToggle}>
            {initial.active ? "Dar de baja" : "Reactivar"}
          </button>
        )}
      </div>
    </div>
  );
}
