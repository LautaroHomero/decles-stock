"use client";

import { useState } from "react";
import { call, money, usePoll } from "./shared";

/** Espejo de `ProviderDebt` de src/lib/domain/payouts.ts. */
export interface ProviderDebtRow {
  id: string;
  direction: "consultorio" | "profesional";
  providerId: string;
  providerName: string;
  date: string;
  amount: number;
  paid: number;
  remaining: number;
  createdByName: string;
  createdAt: string;
}

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const short = (name: string) => name.replace(/^(Dra?\.|Lic\.)\s*/i, "");
type Method = "efectivo" | "transferencia";

/**
 * Deudas con profesionales de todos los días.
 *  · `consultorio` (por defecto): lo que les debemos («le quedamos debiendo» cuando no había efectivo). «Pagar» sale de la caja de hoy.
 *  · `profesional`: lo que nos deben ellas (les pagaron directo y no nos dieron lo nuestro). «Cobrar» entra a la caja de hoy.
 */
export function ProviderDebtsCard({
  canAnul,
  onChange,
  showToast,
  direction = "consultorio",
}: {
  canAnul: boolean;
  onChange: () => void;
  showToast: (m: string) => void;
  direction?: "consultorio" | "profesional";
}) {
  const theirs = direction === "profesional";
  const [data, refresh] = usePoll<{ ok: boolean; debts: ProviderDebtRow[]; total: number }>(`/api/provider-debts${theirs ? "?direction=profesional" : ""}`, 30_000);
  const [paying, setPaying] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("efectivo");
  const [busy, setBusy] = useState(false);
  const debts = data?.ok ? data.debts : [];

  async function pay(d: ProviderDebtRow) {
    const n = amount ? Number(amount) : d.remaining;
    setBusy(true);
    const r = await call("/api/provider-debts/pay", "POST", { debtId: d.id, amount: n, method });
    setBusy(false);
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar el pago.");
    showToast(`${theirs ? `Cobrado a ${short(d.providerName)}` : `Pagado a ${short(d.providerName)}`}: ${money(n)} ${method === "efectivo" ? "en efectivo" : "por transferencia"}.`);
    setPaying(null);
    refresh();
    onChange();
  }
  async function anul(d: ProviderDebtRow) {
    const r = await call(`/api/provider-debts/${d.id}`, "DELETE");
    if (!r.ok) return showToast(r.error ?? "No se pudo anular.");
    showToast("Listo: vuelve a figurar como pendiente de ese día.");
    refresh();
    onChange();
  }

  if (!data || !debts.length) return null;
  return (
    <section className="flex flex-col rounded-xl border border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
        <h2 className="text-[14px] font-medium">{theirs ? "Nos deben los profesionales" : "Le debemos a profesionales"}</h2>
        <span className="text-[13px] text-neutral-400">Total {money(data.total)}</span>
      </div>
      <ul className="flex flex-col">
        {debts.map((d) => (
          <li key={d.id} className="flex flex-col gap-2 border-t border-neutral-900 px-4 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="min-w-0">
                <b className="font-medium">{short(d.providerName)}</b>
                <span className="block text-[12.5px] text-neutral-500">
                  de lo del {ddmm(d.date)}
                  {d.paid > 0 && ` · ${theirs ? "nos dio" : "se le pagó"} ${money(d.paid)} de ${money(d.amount)}`}
                </span>
              </span>
              <span className="flex items-center gap-3">
                <span className="whitespace-nowrap font-medium tabular-nums">{money(d.remaining)}</span>
                {paying !== d.id && (
                  <button
                    onClick={() => {
                      setPaying(d.id);
                      setAmount("");
                      setMethod("efectivo");
                    }}
                    className="cl-no-print rounded-md border border-neutral-800 px-2.5 py-1 text-[12.5px] text-neutral-300 hover:border-accent-700 hover:bg-accent-900"
                  >
                    {theirs ? "Cobrar" : "Pagar"}
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
                {(["efectivo", "transferencia"] as const).map((m) => (
                  <button
                    key={m}
                    aria-pressed={method === m}
                    onClick={() => setMethod(m)}
                    className={`rounded-md border px-2.5 py-1 text-[12.5px] ${method === m ? "border-accent bg-accent text-on-accent" : "border-neutral-800 text-neutral-300 hover:bg-accent-900"}`}
                  >
                    {m === "efectivo" ? "Efectivo" : "Transferencia"}
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
                  {theirs ? "Cobrar" : "Pagar"} {money(amount ? Number(amount) : d.remaining)}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="px-4 pb-3 pt-1 text-[12.5px] text-neutral-500">
        {theirs
          ? "Lo nuestro de lo que les pagaron directo y no nos dieron ese día («Nos queda debiendo» en Cuentas con profesionales). Lo cobrado entra a la caja de hoy."
          : "Se anota con «Queda debiendo» en Cuentas con profesionales o escribiendo en Anotar «le quedamos debiendo 50000 a Marisa». Se paga desde acá o con «le pagué la deuda a Marisa»."}
      </p>
    </section>
  );
}
