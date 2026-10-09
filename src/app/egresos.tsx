"use client";

import { useState } from "react";
import { call, money } from "./shared";

/** Egresos de plata (luz, insumos, un retiro…): se anotan desde Anotar y se ven en Hoy, Cierre y Ventas. */
export interface Expense {
  id: string;
  direction?: "egreso" | "ingreso";
  concept: string;
  amount: number;
  createdByName: string;
  createdAt: string;
  updatedByName: string | null;
}

export interface ExpensesResponse {
  ok: boolean;
  expenses: Expense[];
  total: number;
}

const FIELD =
  "w-full rounded-md border border-neutral-800 bg-transparent px-3 py-2.5 text-[15px] text-fg placeholder:text-neutral-600 focus:border-accent-700 focus:outline-none";

/** Anotar o corregir un egreso (modal). Con `expense` edita y deja anularlo. */
export function ExpenseForm({
  expense,
  initial,
  direction = expense?.direction ?? "egreso",
  onClose,
  onSaved,
}: {
  direction?: "egreso" | "ingreso";
  expense?: Expense;
  initial?: { concept: string; amount: number };
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [concept, setConcept] = useState(expense?.concept ?? initial?.concept ?? "");
  const [amount, setAmount] = useState(String(expense?.amount ?? initial?.amount ?? "") === "0" ? "" : String(expense?.amount ?? initial?.amount ?? ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const n = Number(amount.replace(/\D/g, "") || 0);
  const ok = concept.trim() && n > 0;
  const ingreso = direction === "ingreso";
  const what = ingreso ? "Ingreso extra" : "Egreso";

  async function save() {
    if (!ok || busy) return;
    setBusy(true);
    setErr("");
    const body = { concept, amount: n, direction };
    const r = expense ? await call(`/api/expenses/${expense.id}`, "PATCH", body) : await call("/api/expenses", "POST", body);
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "No se pudo guardar.");
    onSaved(expense ? `${what} corregido` : `${what} · ${concept.trim()} · ${money(n)}`);
  }

  async function remove() {
    if (!expense || busy) return;
    setBusy(true);
    const r = await call(`/api/expenses/${expense.id}`, "DELETE");
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "No se pudo anular.");
    onSaved(`${what} anulado`);
  }

  return (
    <div className="cl-fade-in fixed inset-0 z-40 overflow-y-auto bg-black/60 px-4 py-16" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="mx-auto flex w-full max-w-[440px] flex-col gap-4 rounded-xl bg-surface p-5 shadow-lg"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div>
          <h2 className="font-display text-[18px] font-medium tracking-[-.01em]">{expense ? `Corregir ${what.toLowerCase()}` : ingreso ? "Anotar un ingreso extra" : "Anotar un egreso"}</h2>
          <p className="text-[13px] text-neutral-400">{ingreso ? "Plata que entra a la caja y no es de un paciente: cambio, varios…" : "Plata que sale de la caja: luz, insumos, un retiro…"}</p>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">¿En qué?</span>
          <input autoFocus={!concept} value={concept} onChange={(e) => setConcept(e.target.value)} placeholder={ingreso ? "Ej. Cambio" : "Ej. Luz"} className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">Importe</span>
          <input
            autoFocus={!!concept && !n}
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            placeholder="$"
            className={`${FIELD} tabular-nums`}
          />
        </label>
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
        {expense && (
          <button type="button" onClick={remove} disabled={busy} className="self-start text-[13px] text-neutral-400 underline-offset-4 hover:text-fg hover:underline">
            Anular
          </button>
        )}
        {expense?.updatedByName && <p className="text-[12px] text-neutral-500">Editado por {expense.updatedByName}</p>}
      </form>
    </div>
  );
}
