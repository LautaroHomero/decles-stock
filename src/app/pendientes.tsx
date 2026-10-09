"use client";

import { useMemo, useState } from "react";
import { parseNote } from "@/lib/domain/quick-sale";
import { BTN, BTN_DARK, FIELD, call, fmtDate, fmtTime, money, usePoll, type CatalogResponse, type SaleRow } from "./shared";

/**
 * Pendientes (solo admin): lo que se anotó y no estaba en la lista de precios. Se resuelve
 * diciendo qué es (un ítem existente) o creándolo con precio; ahí la venta toma precio y comisión.
 */
export function Pendientes({ onChange }: { onChange?: () => void }) {
  const [data, refresh] = usePoll<{ ok: boolean; pending: SaleRow[] }>("/api/pending", 30_000);
  const [catalog] = usePoll<CatalogResponse>("/api/catalog", 60_000);
  const items = useMemo(
    () => [
      ...(catalog?.practices ?? []).map((p) => ({ id: p.id, name: p.name, kind: "tratamiento" as const })),
      ...(catalog?.products ?? []).filter((p) => p.priceItemId).map((p) => ({ id: p.priceItemId!, name: p.name, kind: "producto" as const })),
    ],
    [catalog],
  );
  const list = data?.ok ? data.pending : [];
  if (!list.length) return null;

  const done = () => {
    refresh();
    onChange?.();
  };

  return (
    <section className="mx-auto w-full max-w-[880px] px-4 pt-6 sm:px-6">
      <div className="flex flex-col gap-3 rounded-[20px] border-2 border-accent-700 bg-surface p-5">
        <div>
          <h2 className="text-[18px] font-bold">Anotado sin cargar ({list.length})</h2>
          <p className="text-[14px] text-neutral-400">
            Se anotó algo que no estaba en la lista. Decí qué es o crealo con su precio: ahí se completan el importe y la comisión.
          </p>
        </div>
        {list.map((s) => (
          <PendingRow key={s.id} s={s} items={items} onDone={done} />
        ))}
      </div>
    </section>
  );
}

function PendingRow({ s, items, onDone }: { s: SaleRow; items: { id: string; name: string; kind: "tratamiento" | "producto" }[]; onDone: () => void }) {
  const [mode, setMode] = useState<"idle" | "pick" | "create">("idle");
  const [pick, setPick] = useState("");
  // Si al anotar se cargó lo que se cobró, se propone como precio de lista.
  const [f, setF] = useState({ kind: "tratamiento" as "tratamiento" | "producto", name: s.itemName, price: s.unitPrice ? String(s.unitPrice) : "", cardPrice: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Sugerencias: lo más parecido de la lista (mismo intérprete que la hoja).
  const guesses = useMemo(() => {
    const [l] = parseNote(s.itemName, items).lines;
    return l ? (l.match ? [l.match] : l.candidates).slice(0, 3) : [];
  }, [s.itemName, items]);

  async function resolve(body: object) {
    setBusy(true);
    setErr("");
    const r = await call(`/api/pending/${s.id}`, "POST", body);
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "No se pudo resolver.");
    onDone();
  }
  async function discard() {
    setBusy(true);
    const r = await call(`/api/sales/${s.id}/void`, "POST", { reason: "Descartado desde pendientes" });
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "No se pudo descartar.");
    onDone();
  }

  return (
    <div className="flex flex-col gap-3 border-t border-neutral-800 pt-3">
      <div>
        <p className="text-[16px] font-semibold">
          {s.quantity > 1 ? `${s.quantity} × ` : ""}«{s.itemName}»
        </p>
        <p className="text-[13.5px] text-neutral-400">
          {[s.patientName, s.providerName, `${fmtDate(s.createdAt.slice(0, 10))} ${fmtTime(s.createdAt)}`, `anotó ${s.createdByName}`].filter(Boolean).join(" · ")}
        </p>
        <p className="text-[13.5px] text-neutral-300">
          {s.total > 0 ? `Se cobró ${money(s.total)}: eso queda; solo falta decir qué es.` : "Sin precio: se completa al decir qué es o al crearlo."}
        </p>
      </div>

      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          {guesses.map((g) => (
            <button key={g.id} disabled={busy} className={BTN_DARK} onClick={() => resolve({ itemId: g.id })}>
              Es «{g.name}»
            </button>
          ))}
          <button className={BTN} onClick={() => setMode("pick")}>
            {guesses.length ? "Es otra cosa de la lista" : "Es algo de la lista"}
          </button>
          <button className={BTN} onClick={() => setMode("create")}>
            Crearlo con precio
          </button>
          <span className="flex-1" />
          <button className={BTN} disabled={busy} onClick={discard}>
            Descartar
          </button>
        </div>
      )}

      {mode === "pick" && (
        <div className="flex flex-wrap items-center gap-2">
          <select value={pick} onChange={(e) => setPick(e.target.value)} className={`${FIELD} !w-auto min-w-[220px] flex-1`}>
            <option value="">Elegí…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.kind === "tratamiento" ? "práctica" : "producto"})
              </option>
            ))}
          </select>
          <button className={BTN_DARK} disabled={!pick || busy} onClick={() => resolve({ itemId: pick })}>
            Listo
          </button>
          <button className={BTN} onClick={() => setMode("idle")}>
            Cancelar
          </button>
        </div>
      )}

      {mode === "create" && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            {(
              [
                ["tratamiento", "Práctica"],
                ["producto", "Producto"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setF({ ...f, kind: k })}
                className={`rounded-xl border-2 px-3.5 py-1.5 text-[14px] font-semibold ${f.kind === k ? "border-accent bg-accent text-on-accent" : "border-neutral-800"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Nombre" className={FIELD} />
            <input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/\D/g, "") })} inputMode="numeric" placeholder="Precio efectivo $" className={FIELD} />
            <input value={f.cardPrice} onChange={(e) => setF({ ...f, cardPrice: e.target.value.replace(/\D/g, "") })} inputMode="numeric" placeholder="Con tarjeta (vacío = igual)" className={FIELD} />
          </div>
          {f.kind === "producto" && <p className="text-[13px] text-neutral-500">Se crea sin stock: cargá el ingreso después y se compensa solo.</p>}
          <div className="flex gap-2">
            <button
              className={BTN_DARK}
              disabled={!f.name.trim() || !f.price || busy}
              onClick={() => resolve({ create: { kind: f.kind, name: f.name, price: Number(f.price), cardPrice: f.cardPrice ? Number(f.cardPrice) : null } })}
            >
              Crear y completar
            </button>
            <button className={BTN} onClick={() => setMode("idle")}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {err && <p className="text-[14px] text-accent">{err}</p>}
    </div>
  );
}
