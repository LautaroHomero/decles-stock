"use client";

import { useState } from "react";
import { call, money, usePoll, PAYMENTS } from "./shared";

/** Espejo de `Debt` / `DebtCollection` de src/lib/domain/debts.ts. */
export interface DebtRow {
  id: string;
  debtor: string;
  concept: string;
  amount: number;
  paid: number;
  remaining: number;
  providerId: string | null;
  providerName: string | null;
  share: number;
  visitId: string | null;
  status: "open" | "paid" | "voided";
  createdByName: string;
  createdAt: string;
  paidAt: string | null;
  payments: { id: string; date: string; amount: number; method: DebtMethod | null; createdByName: string; createdAt: string }[];
}
export type DebtMethod = "efectivo" | "transferencia" | "tarjeta";
export interface DebtCollectionRow {
  id: string;
  debtId: string;
  date: string;
  amount: number;
  method: DebtMethod | null;
  share: number;
  createdByName: string;
  createdAt: string;
  debtor: string;
  concept: string;
  providerId: string | null;
  providerName: string | null;
}

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const METHODS = PAYMENTS.filter(([m]) => m !== "dolares") as [DebtMethod, string][];

/**
 * Deudas abiertas (de todos los días): quién debe, por qué, desde cuándo y cuánto falta. «Cobrar» anota
 * el pago (todo o una parte) en la caja de hoy. El admin tiene el aviso en la campanita hasta que se salda.
 */
export function DebtsCard({ canAnul, onChange, showToast }: { canAnul: boolean; onChange: () => void; showToast: (m: string) => void }) {
  const [data, refresh] = usePoll<{ ok: boolean; debts: DebtRow[]; total: number }>("/api/debts", 30_000);
  const [paying, setPaying] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<DebtMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const debts = data?.ok ? data.debts : [];

  async function pay(d: DebtRow) {
    const n = amount ? Number(amount) : d.remaining;
    setBusy(true);
    const r = await call(`/api/debts/${d.id}/pay`, "POST", { amount: n, method });
    setBusy(false);
    if (!r.ok) return showToast(r.error ?? "No se pudo cobrar.");
    const left = (r.debt as DebtRow).remaining;
    showToast(`Cobrado ${money(n)} a ${d.debtor}${left ? ` · todavía debe ${money(left)}` : " · deuda saldada"}.`);
    setPaying(null);
    refresh();
    onChange();
  }
  async function anul(d: DebtRow) {
    const r = await call(`/api/debts/${d.id}`, "DELETE");
    if (!r.ok) return showToast(r.error ?? "No se pudo anular.");
    showToast("Deuda anulada.");
    refresh();
    onChange();
  }

  return (
    <section className="flex flex-col rounded-xl border border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
        <h2 className="text-[14px] font-medium">Deudas</h2>
        {debts.length > 0 && <span className="text-[13px] text-neutral-400">Te deben {money(data?.total ?? 0)}</span>}
      </div>
      {!data ? (
        <p className="px-4 pb-3 text-neutral-500">Cargando…</p>
      ) : !debts.length ? (
        <p className="px-4 pb-3 text-[13.5px] text-neutral-500">Nadie debe nada. Se anotan en Anotar: «botox a carla, gabi, pagó 80000, debe 40000».</p>
      ) : (
        <ul className="flex flex-col">
          {debts.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 border-t border-neutral-900 px-4 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="min-w-0">
                  <b className="font-medium">{d.debtor}</b>
                  <span className="block text-[12.5px] text-neutral-500">
                    {[d.concept, d.providerName, `desde el ${ddmm(d.createdAt)}`].filter(Boolean).join(" · ")}
                    {d.paid > 0 && ` · pagó ${money(d.paid)} de ${money(d.amount)}`}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="whitespace-nowrap font-medium tabular-nums">{money(d.remaining)}</span>
                  {paying !== d.id && (
                    <button
                      onClick={() => {
                        setPaying(d.id);
                        setAmount("");
                        setMethod(null);
                      }}
                      className="cl-no-print rounded-md border border-neutral-800 px-2.5 py-1 text-[12.5px] text-neutral-300 hover:border-accent-700 hover:bg-accent-900"
                    >
                      Cobrar
                    </button>
                  )}
                  {canAnul && d.paid === 0 && paying !== d.id && (
                    <button onClick={() => anul(d)} className="cl-no-print text-[12.5px] text-neutral-500 underline-offset-2 hover:text-fg hover:underline">
                      anular
                    </button>
                  )}
                </span>
              </div>
              {paying === d.id && (
                <div className="cl-no-print flex flex-wrap items-center gap-2">
                  <input
                    autoFocus
                    value={amount ? `$ ${Number(amount).toLocaleString("es-AR")}` : ""}
                    onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={(e) => e.key === "Enter" && !busy && pay(d)}
                    inputMode="numeric"
                    placeholder={`$ ${d.remaining.toLocaleString("es-AR")} (todo)`}
                    className="w-[150px] rounded-md border border-neutral-800 bg-transparent px-2.5 py-1 text-right tabular-nums text-fg outline-none placeholder:text-neutral-500 focus:border-accent-700"
                  />
                  {METHODS.map(([m, label]) => (
                    <button
                      key={m}
                      aria-pressed={method === m}
                      onClick={() => setMethod(method === m ? null : m)}
                      className={`rounded-md border px-2.5 py-1 text-[12.5px] ${method === m ? "border-accent bg-accent text-on-accent" : "border-neutral-800 text-neutral-300 hover:bg-accent-900"}`}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="flex-1" />
                  <button onClick={() => setPaying(null)} className="text-[12.5px] text-neutral-500 hover:text-fg">
                    Cancelar
                  </button>
                  <button
                    disabled={busy || Number(amount || d.remaining) <= 0 || Number(amount || 0) > d.remaining}
                    onClick={() => pay(d)}
                    className="rounded-md border border-accent bg-accent px-3 py-1 text-[12.5px] font-medium text-on-accent disabled:opacity-40"
                  >
                    Cobrar {money(amount ? Number(amount) : d.remaining)}
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
