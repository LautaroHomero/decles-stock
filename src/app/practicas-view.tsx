"use client";

import { useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { InventarioView } from "./inventario-view";
import { BTN, BTN_DARK, CARD, FIELD, ProviderPicker, Toast, call, money, providerNames, usePoll, useSellers, useToast } from "./shared";

/** Stock: productos (con lotes y vencimientos) o prácticas (solo precio). */
export function StockSection({ canAdmin }: { canAdmin: boolean }) {
  const [tab, setTab] = useState<"productos" | "practicas">("productos");
  return (
    <>
      <div className="mx-auto w-full max-w-[880px] px-4 pt-6 sm:px-6 sm:pt-8">
        <div role="tablist" className="inline-flex rounded-2xl border-2 border-neutral-800 p-1">
          {(
            [
              ["productos", "Productos"],
              ["practicas", "Prácticas"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`min-h-11 rounded-xl px-5 text-[13.5px] font-semibold transition-colors ${
                tab === id ? "bg-accent text-on-accent" : "text-neutral-400 hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === "productos" ? <InventarioView /> : <PracticasView canAdmin={canAdmin} />}
    </>
  );
}

interface Practice {
  id: string;
  name: string;
  price: number;
  cardPrice: number | null;
  active: boolean;
  providerIds: string[];
}

const toInt = (s: string) => (s.trim() === "" ? null : Number(s.replace(/\./g, "").replace(",", ".")));

/** Prácticas (atención, peeling…): el admin carga nombre y precios; cuentan para la comisión de la médica. */
function PracticasView({ canAdmin }: { canAdmin: boolean }) {
  const [data, refresh] = usePoll<{ ok: boolean; practices: Practice[] }>("/api/practices", 60_000);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [toast, showToast] = useToast();
  const sellers = useSellers();
  const list = data?.practices ?? [];

  async function save(id: string | null, v: { name: string; price: string; cardPrice: string; active?: boolean; providerIds?: string[] }) {
    const price = toInt(v.price);
    if (price === null || !Number.isInteger(price) || price < 0) return showToast("El precio tiene que ser un número entero de pesos.");
    const card = toInt(v.cardPrice);
    if (card !== null && (!Number.isInteger(card) || card < 0)) return showToast("El precio con tarjeta tiene que ser un número entero de pesos.");
    const body = {
      name: v.name,
      price,
      cardPrice: card,
      ...(v.active === undefined ? {} : { active: v.active }),
      ...(v.providerIds === undefined ? {} : { providerIds: v.providerIds }),
    };
    const r = id ? await call(`/api/practices/${id}`, "PATCH", body) : await call("/api/practices", "POST", body);
    if (!r.ok) return showToast(r.error ?? "No se pudo guardar.");
    showToast(id ? "Guardado." : `«${v.name.trim()}» agregada.`);
    setEditing(null);
    refresh();
  }

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-4 py-6 sm:px-6">
      <Toast msg={toast} />
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[220px] flex-1 flex-col">
          <h1 className="font-display text-[18px] font-medium tracking-[-.01em]">Prácticas</h1>
          <p className="text-[13px] text-neutral-400">Lo que se hace en la consulta. La médica cobra su % sobre el precio en efectivo.</p>
        </div>
        {canAdmin && editing !== "new" && (
          <button className={`${BTN_DARK} inline-flex items-center gap-1.5`} onClick={() => setEditing("new")}>
            <PlusIcon size={14} weight="bold" /> Nueva práctica
          </button>
        )}
      </div>

      {editing === "new" && <PracticeForm onSave={(v) => save(null, v)} onCancel={() => setEditing(null)} />}

      {!data ? (
        <p className="text-[13px] text-neutral-500">Cargando…</p>
      ) : !list.length ? (
        <p className="text-[13.5px] text-neutral-400">{canAdmin ? "Todavía no hay prácticas. Agregá la primera (ej. «Atención»)." : "Todavía no hay prácticas cargadas."}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((p) =>
            editing === p.id ? (
              <PracticeForm key={p.id} initial={p} onSave={(v) => save(p.id, v)} onCancel={() => setEditing(null)} onToggle={() => save(p.id, { name: p.name, price: String(p.price), cardPrice: p.cardPrice === null ? "" : String(p.cardPrice), active: !p.active })} />
            ) : (
              <button
                key={p.id}
                disabled={!canAdmin}
                onClick={() => setEditing(p.id)}
                className={`flex items-center gap-4 rounded-2xl bg-surface px-5 py-4 text-left shadow-sm transition-colors enabled:hover:bg-neutral-900 ${p.active ? "" : "opacity-50"}`}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] font-semibold">
                    {p.name}
                    {!p.active && <span className="ml-2 text-[13px] font-normal text-neutral-500">(dada de baja)</span>}
                  </span>
                  <span className="truncate text-[13.5px] text-neutral-400">{providerNames(p.providerIds, sellers)}</span>
                </span>
                <span className="flex flex-col items-end text-[13.5px] tabular-nums">
                  <span>{money(p.price)}</span>
                  {p.cardPrice !== null && p.cardPrice !== p.price && <span className="text-[13px] text-neutral-500">tarjeta {money(p.cardPrice)}</span>}
                </span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function PracticeForm({
  initial,
  onSave,
  onCancel,
  onToggle,
}: {
  initial?: Practice;
  onSave: (v: { name: string; price: string; cardPrice: string; providerIds: string[] }) => void;
  onCancel: () => void;
  onToggle?: () => void;
}) {
  const [f, setF] = useState({
    name: initial?.name ?? "",
    price: initial ? String(initial.price) : "",
    cardPrice: initial?.cardPrice === null || !initial ? "" : String(initial.cardPrice),
    providerIds: initial?.providerIds ?? ([] as string[]),
  });
  return (
    <div className={`${CARD} animate-cl-in`}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 sm:col-span-3">
          <span className="text-[13px] text-neutral-400">Nombre</span>
          <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ej. Peeling" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[13px] text-neutral-400">Precio efectivo / transferencia</span>
          <input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/[^\d]/g, "") })} inputMode="numeric" placeholder="$" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[13px] text-neutral-400">Precio con tarjeta</span>
          <input value={f.cardPrice} onChange={(e) => setF({ ...f, cardPrice: e.target.value.replace(/[^\d]/g, "") })} inputMode="numeric" placeholder="Vacío = el mismo" className={FIELD} />
        </label>
      </div>
      <ProviderPicker value={f.providerIds} onChange={(providerIds) => setF({ ...f, providerIds })} />
      <div className="flex flex-wrap gap-2">
        <button className={BTN_DARK} disabled={!f.name.trim() || !f.price} onClick={() => onSave(f)}>
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
