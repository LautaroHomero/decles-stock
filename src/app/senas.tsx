"use client";

import { useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { call, money, usePoll, type CatalogResponse } from "./shared";
import { remindLabel } from "./debt-reminder";

/** Espejo de `Deposit` de src/lib/domain/deposits.ts. */
export interface DepositRow {
  id: string;
  patient: string;
  itemId: string | null;
  itemName: string;
  amount: number;
  dueOn: string | null;
  used: boolean;
  createdAt: string;
}

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const FIELD =
  "w-full rounded-md border border-neutral-800 bg-transparent px-3 py-2.5 text-[15px] text-fg placeholder:text-neutral-600 focus:border-accent-700 focus:outline-none";
const TOGGLE = (on: boolean) =>
  `rounded-md border px-3 py-1.5 text-[13.5px] ${on ? "border-accent bg-accent text-on-accent" : "border-neutral-800 text-neutral-300 hover:bg-accent-900"}`;

/** Anotar una seña a mano (Planilla, Cierre): paciente, práctica, cuánto dejó, cómo y qué día viene. */
export function SenaForm({ onClose, onSaved }: { onClose: () => void; onSaved: (msg: string) => void }) {
  const [catalog] = usePoll<CatalogResponse>("/api/catalog", 120_000);
  const practices = catalog?.practices ?? [];
  const [patient, setPatient] = useState("");
  const [itemId, setItemId] = useState("");
  const [amount, setAmount] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [method, setMethod] = useState<"efectivo" | "transferencia" | "tarjeta" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const n = Number(amount || 0);
  const item = practices.find((p) => p.id === itemId);
  const ok = patient.trim() && n > 0 && method;

  async function save() {
    if (!ok || busy) return;
    setBusy(true);
    setErr("");
    const r = await call("/api/deposits", "POST", { patient, itemId: itemId || null, amount: n, method, dueOn: dueOn || null });
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "No se pudo guardar.");
    onSaved(`Seña · ${patient.trim()}${item ? ` · ${item.name}` : ""} · ${money(n)}${dueOn ? ` · viene el ${remindLabel(dueOn)}` : ""}`);
  }

  return (
    <div className="cl-fade-in fixed inset-0 z-40 overflow-y-auto bg-black/60 px-4 py-16" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="mx-auto flex w-full max-w-[460px] flex-col gap-4 rounded-xl bg-surface p-5 shadow-lg"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div>
          <h2 className="font-display text-[18px] font-medium tracking-[-.01em]">Anotar una seña</h2>
          <p className="text-[13px] text-neutral-400">Entra a la caja hoy. El día que viene se descuenta: paga solo el resto y no queda deuda.</p>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">Paciente</span>
          <input autoFocus value={patient} onChange={(e) => setPatient(e.target.value)} placeholder="Nombre y apellido" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">Práctica</span>
          <select value={itemId} onChange={(e) => setItemId(e.target.value)} className={FIELD}>
            <option value="">Todavía no se sabe</option>
            {practices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {money(p.price)}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-neutral-400">Seña</span>
            <input
              value={amount ? `$ ${Number(amount).toLocaleString("es-AR")}` : ""}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              placeholder="$"
              className={`${FIELD} tabular-nums`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-neutral-400">Viene el</span>
            <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} className={`${FIELD} [color-scheme:light_dark]`} />
          </label>
        </div>
        {item && n > 0 && <p className="text-[13px] text-neutral-400">Ese día paga el resto: {money(Math.max(0, item.price - n))}.</p>}
        <div className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">¿Cómo pagó la seña? · solo el efectivo cuenta en la caja</span>
          <div className="flex flex-wrap gap-2">
            {(["efectivo", "transferencia", "tarjeta"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(m)} className={TOGGLE(method === m)}>
                {m === "efectivo" ? "Efectivo" : m === "transferencia" ? "Transferencia" : "Tarjeta"}
              </button>
            ))}
          </div>
        </div>
        {err && <p className="text-[13px] text-neutral-200">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={!ok || busy}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-lg border border-accent bg-accent px-4 text-[14px] font-medium text-on-accent transition-opacity hover:opacity-85 disabled:opacity-40"
          >
            {busy ? "Guardando…" : `Guardar${n ? ` · ${money(n)}` : ""}`}
          </button>
          <button type="button" onClick={onClose} className="h-11 rounded-lg border border-neutral-800 px-4 text-[14px] text-neutral-300 hover:bg-accent-900">
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Señas sin usar (de todos los días): quién, para qué, cuánto dejó y qué día viene. Se descuentan solas al anotar
 * la atención de esa paciente. Acá se cambia el día del turno o se anula una mal anotada.
 */
export function SenasCard({ onChange, showToast, canAdd = true }: { onChange: () => void; showToast: (m: string) => void; canAdd?: boolean }) {
  const [data, refresh] = usePoll<{ ok: boolean; deposits: DepositRow[]; total: number }>("/api/deposits", 60_000);
  const list = data?.ok ? data.deposits : [];
  const [adding, setAdding] = useState(false);
  const done = () => {
    refresh();
    onChange();
  };
  async function setDate(d: DepositRow, dueOn: string) {
    const r = await call(`/api/deposits/${d.id}`, "PATCH", { dueOn: dueOn || null });
    if (!r.ok) return showToast(r.error ?? "No se pudo cambiar.");
    done();
  }
  async function anul(d: DepositRow) {
    const r = await call(`/api/deposits/${d.id}`, "DELETE");
    if (!r.ok) return showToast(r.error ?? "No se pudo anular.");
    showToast("Seña anulada: la plata sale de la caja de ese día.");
    done();
  }

  return (
    <section className="flex flex-col rounded-xl border border-neutral-800">
      {adding && (
        <SenaForm
          onClose={() => setAdding(false)}
          onSaved={(m) => {
            setAdding(false);
            showToast(m);
            done();
          }}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
        <h2 className="text-[14px] font-medium">Señas</h2>
        <span className="flex items-center gap-4">
          {list.length > 0 && <span className="text-[13px] text-neutral-400">Sin usar {money(data?.total ?? 0)}</span>}
          {canAdd && (
            <button onClick={() => setAdding(true)} className="cl-no-print inline-flex items-center gap-1 text-[13px] text-neutral-400 hover:text-fg">
              <PlusIcon size={12} weight="bold" /> Seña
            </button>
          )}
        </span>
      </div>
      {!data ? (
        <p className="px-4 pb-3 text-neutral-500">Cargando…</p>
      ) : !list.length ? (
        <p className="px-4 pb-3 text-[13.5px] text-neutral-500">No hay señas pendientes. En Anotar: «carla dejó 20000 de seña para botox, viene el 28/10».</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-neutral-900 px-4 py-2.5">
              <span className="min-w-0">
                <b className="font-medium">{d.patient}</b>
                <span className="block text-[12.5px] text-neutral-500">
                  {[d.itemName || "práctica sin definir", `dejó ${money(d.amount)} el ${ddmm(d.createdAt)}`].join(" · ")}
                </span>
              </span>
              <span className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-[12.5px] text-neutral-400">
                  viene
                  <input
                    type="date"
                    value={d.dueOn ?? ""}
                    onChange={(e) => setDate(d, e.target.value)}
                    className="cl-no-print rounded-md border border-neutral-800 bg-transparent px-2 py-1 text-[12.5px] text-fg [color-scheme:light_dark]"
                  />
                </label>
                <span className="whitespace-nowrap font-medium tabular-nums">{money(d.amount)}</span>
                <button onClick={() => anul(d)} className="cl-no-print text-[12.5px] text-neutral-500 underline-offset-2 hover:text-fg hover:underline">
                  anular
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
