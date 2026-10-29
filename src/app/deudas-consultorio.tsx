"use client";

import { useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { call, money, usePoll } from "./shared";
import { remindLabel } from "./debt-reminder";

/** Espejo de `Payable` de src/lib/domain/payables.ts. */
export interface PayableRow {
  id: string;
  creditor: string;
  concept: string;
  amount: number;
  paid: number;
  remaining: number;
  remindMode: "daily" | "at" | null;
  remindAt: string | null;
  due: boolean;
  createdAt: string;
}
export type PayMethod = "efectivo" | "transferencia" | "tarjeta";
export const PAY_METHODS: [PayMethod, string][] = [
  ["efectivo", "Efectivo"],
  ["transferencia", "Transferencia"],
  ["tarjeta", "Tarjeta"],
];

/** «todos los días» / «hoy a las 10:00» / «jueves 30 de octubre a las 10:00». */
export function payableRemindText(mode: PayableRow["remindMode"], at: string | null): string {
  if (mode === "daily") return "todos los días, al arrancar";
  if (mode === "at" && at) return `${remindLabel(at.slice(0, 10))} a las ${at.slice(11, 16)}`;
  return "sin aviso";
}

const tomorrow9 = () => {
  const d = new Date(Date.now() + 24 * 3600e3);
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(d);
  return `${ymd}T09:00`;
};

/** Cuándo avisar: todos los días, un día y hora, o nunca. */
export function PayableReminderPicker({
  mode,
  at,
  onChange,
  chip,
  chipOn,
  field,
}: {
  mode: PayableRow["remindMode"];
  at: string | null;
  onChange: (mode: PayableRow["remindMode"], at: string | null) => void;
  chip: string;
  chipOn: string;
  field: string;
}) {
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="¿Cuándo te aviso?">
      <div className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={mode === "daily"} onClick={() => onChange("daily", null)} className={mode === "daily" ? chipOn : chip}>
          Todos los días
        </button>
        <button type="button" aria-pressed={mode === "at"} onClick={() => onChange("at", at ?? tomorrow9())} className={mode === "at" ? chipOn : chip}>
          Un día y hora
        </button>
        <button type="button" aria-pressed={mode === null} onClick={() => onChange(null, null)} className={mode === null ? chipOn : chip}>
          Sin aviso
        </button>
      </div>
      {mode === "at" && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={(at ?? tomorrow9()).slice(0, 10)}
            onChange={(e) => e.target.value && onChange("at", `${e.target.value}T${(at ?? tomorrow9()).slice(11, 16)}`)}
            aria-label="Día del aviso"
            className={`${field} w-auto [color-scheme:light_dark]`}
          />
          <input
            type="time"
            value={(at ?? tomorrow9()).slice(11, 16)}
            onChange={(e) => e.target.value && onChange("at", `${(at ?? tomorrow9()).slice(0, 10)}T${e.target.value}`)}
            aria-label="Hora del aviso"
            className={`${field} w-auto [color-scheme:light_dark]`}
          />
        </div>
      )}
    </div>
  );
}

const FIELD =
  "w-full rounded-md border border-neutral-800 bg-transparent px-3 py-2.5 text-[15px] text-fg placeholder:text-neutral-600 focus:border-accent-700 focus:outline-none";
const SMALL = (on: boolean) =>
  `rounded-md border px-2.5 py-1 text-[12.5px] ${on ? "border-accent bg-accent text-on-accent" : "border-neutral-800 text-neutral-300 hover:bg-accent-900"}`;
const MID = (on: boolean) =>
  `rounded-md border px-3 py-1.5 text-[13.5px] ${on ? "border-accent bg-accent text-on-accent" : "border-neutral-800 text-neutral-300 hover:bg-accent-900"}`;

/** Anotar a mano algo que debe el consultorio. */
export function PayableForm({ onClose, onSaved }: { onClose: () => void; onSaved: (msg: string) => void }) {
  const [creditor, setCreditor] = useState("");
  const [concept, setConcept] = useState("");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<PayableRow["remindMode"]>("daily");
  const [at, setAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const n = Number(amount || 0);
  const ok = creditor.trim() && n > 0;

  async function save() {
    if (!ok || busy) return;
    setBusy(true);
    setErr("");
    const r = await call("/api/payables", "POST", { creditor, concept, amount: n, remindMode: mode, remindAt: at });
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "No se pudo guardar.");
    onSaved(`Debemos ${money(n)} a ${creditor.trim()} · aviso: ${payableRemindText(mode, at)}`);
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
          <h2 className="font-display text-[18px] font-medium tracking-[-.01em]">Anotar algo que debemos</h2>
          <p className="text-[13px] text-neutral-400">A un proveedor, el alquiler, un servicio… Te aviso hasta que se pague.</p>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">¿A quién?</span>
          <input autoFocus value={creditor} onChange={(e) => setCreditor(e.target.value)} placeholder="Ej. Distribuidora" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">¿Por qué? (opcional)</span>
          <input value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="Ej. Insumos de octubre" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">¿Cuánto?</span>
          <input
            value={amount ? `$ ${Number(amount).toLocaleString("es-AR")}` : ""}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            placeholder="$"
            className={`${FIELD} tabular-nums`}
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">¿Cuándo te aviso?</span>
          <PayableReminderPicker
            mode={mode}
            at={at}
            onChange={(m, a) => {
              setMode(m);
              setAt(a);
            }}
            chip={MID(false)}
            chipOn={MID(true)}
            field={FIELD}
          />
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
 * Lo que debe el consultorio (de todos los días): a quién, cuánto falta y cuándo avisa.
 * «Pagar» anota el pago (todo o una parte, con su medio) como egreso de hoy. «Aviso» cambia el recordatorio.
 */
export function PayablesCard({ onChange, showToast, canAnul }: { onChange: () => void; showToast: (m: string) => void; canAnul: boolean }) {
  const [data, refresh] = usePoll<{ ok: boolean; payables: PayableRow[]; total: number }>("/api/payables", 60_000);
  const list = data?.ok ? data.payables : [];
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PayMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const done = () => {
    refresh();
    onChange();
  };

  async function pay(p: PayableRow) {
    if (!method) return showToast("¿Cómo se pagó? Tocá efectivo, transferencia o tarjeta.");
    const n = amount ? Number(amount) : p.remaining;
    setBusy(true);
    const r = await call(`/api/payables/${p.id}/pay`, "POST", { amount: n, method });
    setBusy(false);
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar el pago.");
    const left = (r.payable as PayableRow).remaining;
    showToast(`Pagado ${money(n)} a ${p.creditor}${left ? ` · falta ${money(left)}` : " · deuda saldada, no avisa más"}.`);
    setPaying(null);
    done();
  }
  async function remind(p: PayableRow, mode: PayableRow["remindMode"], at: string | null) {
    const r = await call(`/api/payables/${p.id}`, "PATCH", { remindMode: mode, remindAt: at });
    if (!r.ok) return showToast(r.error ?? "No se pudo cambiar el aviso.");
    done();
  }
  async function anul(p: PayableRow) {
    const r = await call(`/api/payables/${p.id}`, "DELETE");
    if (!r.ok) return showToast(r.error ?? "No se pudo anular.");
    showToast("Deuda anulada.");
    done();
  }

  return (
    <section className="flex flex-col rounded-xl border border-neutral-800">
      {adding && (
        <PayableForm
          onClose={() => setAdding(false)}
          onSaved={(m) => {
            setAdding(false);
            showToast(m);
            done();
          }}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
        <h2 className="text-[14px] font-medium">Lo que debemos</h2>
        <span className="flex items-center gap-4">
          {list.length > 0 && <span className="text-[13px] text-neutral-400">Total {money(data?.total ?? 0)}</span>}
          <button onClick={() => setAdding(true)} className="cl-no-print inline-flex items-center gap-1 text-[13px] text-neutral-400 hover:text-fg">
            <PlusIcon size={12} weight="bold" /> Deuda
          </button>
        </span>
      </div>
      {!data ? (
        <p className="px-4 pb-3 text-neutral-500">Cargando…</p>
      ) : !list.length ? (
        <p className="px-4 pb-3 text-[13.5px] text-neutral-500">
          No se debe nada. Se anota con «+ Deuda» o en Anotar: «le debemos 300000 a la distribuidora, avisame todos los días».
        </p>
      ) : (
        <ul className="flex flex-col">
          {list.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 border-t border-neutral-900 px-4 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="min-w-0">
                  <b className="font-medium">{p.creditor}</b>
                  <span className="block text-[12.5px] text-neutral-500">
                    {[p.concept, `desde el ${p.createdAt.slice(8, 10)}/${p.createdAt.slice(5, 7)}`, p.paid ? `ya se pagó ${money(p.paid)} de ${money(p.amount)}` : ""]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <span className={`block text-[12.5px] ${p.due ? "font-medium text-warn" : "text-neutral-400"}`}>Aviso: {payableRemindText(p.remindMode, p.remindAt)}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="whitespace-nowrap font-medium tabular-nums">{money(p.remaining)}</span>
                  {paying !== p.id && (
                    <button
                      onClick={() => {
                        setPaying(p.id);
                        setEditing(null);
                        setAmount("");
                        setMethod(null);
                      }}
                      className="cl-no-print rounded-md border border-neutral-800 px-2.5 py-1 text-[12.5px] text-neutral-300 hover:border-accent-700 hover:bg-accent-900"
                    >
                      Pagar
                    </button>
                  )}
                  {paying !== p.id && (
                    <button
                      onClick={() => setEditing(editing === p.id ? null : p.id)}
                      className="cl-no-print text-[12.5px] text-neutral-500 underline-offset-2 hover:text-fg hover:underline"
                    >
                      aviso
                    </button>
                  )}
                  {canAnul && p.paid === 0 && paying !== p.id && (
                    <button onClick={() => anul(p)} className="cl-no-print text-[12.5px] text-neutral-500 underline-offset-2 hover:text-fg hover:underline">
                      anular
                    </button>
                  )}
                </span>
              </div>
              {editing === p.id && paying !== p.id && (
                <div className="cl-no-print rounded-lg bg-neutral-900/40 p-3">
                  <PayableReminderPicker mode={p.remindMode} at={p.remindAt} onChange={(m, a) => remind(p, m, a)} chip={MID(false)} chipOn={MID(true)} field={FIELD} />
                </div>
              )}
              {paying === p.id && (
                <div className="cl-no-print flex flex-wrap items-center gap-2">
                  <input
                    autoFocus
                    value={amount ? `$ ${Number(amount).toLocaleString("es-AR")}` : ""}
                    onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={(e) => e.key === "Enter" && !busy && pay(p)}
                    inputMode="numeric"
                    placeholder={`$ ${p.remaining.toLocaleString("es-AR")} (todo)`}
                    className="w-[150px] rounded-md border border-neutral-800 bg-transparent px-2.5 py-1 text-right tabular-nums text-fg outline-none placeholder:text-neutral-500 focus:border-accent-700"
                  />
                  {PAY_METHODS.map(([m, label]) => (
                    <button key={m} aria-pressed={method === m} onClick={() => setMethod(m)} className={SMALL(method === m)}>
                      {label}
                    </button>
                  ))}
                  <span className="flex-1" />
                  <button onClick={() => setPaying(null)} className="text-[12.5px] text-neutral-500 hover:text-fg">
                    Cancelar
                  </button>
                  <button
                    disabled={busy || !method || Number(amount || p.remaining) <= 0 || Number(amount || 0) > p.remaining}
                    onClick={() => pay(p)}
                    className="rounded-md border border-accent bg-accent px-3 py-1 text-[12.5px] font-medium text-on-accent disabled:opacity-40"
                  >
                    Pagar {money(amount ? Number(amount) : p.remaining)}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
