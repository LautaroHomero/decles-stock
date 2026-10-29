"use client";

import { useState } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { call, money } from "./shared";

/** Espejo de `ProviderBalance` / `BalanceLine` de src/lib/domain/payouts.ts. */
export interface BalanceLine {
  key: string;
  time: string;
  patient: string;
  what: string;
  total: number;
  share: number;
  direct: number;
}
export interface Balance {
  providerId: string;
  name: string;
  share: number;
  direct: number;
  debtShare: number;
  paid: number;
  collected: number;
  deferred: number;
  deferredHer: number;
  owed: number;
  owesUs: number;
  owner?: boolean;
  lines: BalanceLine[];
}

const short = (name: string) => name.replace(/^(Dra?\.|Lic\.)\s*/i, "");
type Method = "efectivo" | "transferencia";
const BTN =
  "rounded-md border border-neutral-800 px-2.5 py-1 text-[12.5px] text-neutral-200 hover:bg-accent-900 disabled:opacity-40";
const LINK =
  "px-1 text-[12.5px] text-neutral-500 underline-offset-2 hover:text-fg hover:underline disabled:opacity-40";

/**
 * Cierre → Cuentas con profesionales: por cada una, sus atenciones del día (quién cobró, su parte, lo que cobró ella directo)
 * y la cuenta: su parte − lo que cobró ella − lo pagado + lo que nos dio − quedamos debiendo + nos quedó debiendo.
 * Saldo a favor de ella: «Pagar todo» / «por transf.» / «Queda debiendo». A favor nuestro: «Cobrar todo» / «por transf.» / «Nos queda debiendo».
 */
export function CuentasProfesionales({
  balances,
  error,
  date,
  canEdit,
  showToast,
  onChange,
}: {
  balances: Balance[];
  /** La cuenta no se pudo calcular (p. ej. falta correr la migración): se avisa en vez de mostrarla vacía. */
  error?: string | null;
  date: string;
  canEdit: boolean;
  showToast: (m: string) => void;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // Cada profesional es un desplegable: se toca su nombre y aparece su resumen.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const owedTotal = balances.reduce((n, b) => n + b.owed, 0);
  const owesUsTotal = balances.reduce((n, b) => n + b.owesUs, 0);

  async function act(
    b: Balance,
    what: "pagar" | "cobrar" | "debemos" | "debe",
    method: Method = "efectivo",
  ) {
    setBusy(b.providerId);
    const r =
      what === "pagar" || what === "cobrar"
        ? await call("/api/payouts", "POST", {
            providerId: b.providerId,
            date,
            method,
            direction: what === "cobrar" ? "cobro" : "pago",
          })
        : await call("/api/provider-debts", "POST", {
            providerId: b.providerId,
            date,
            direction: what === "debe" ? "profesional" : "consultorio",
          });
    setBusy(null);
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar.");
    const n = short(b.name);
    const how = method === "efectivo" ? "en efectivo" : "por transferencia";
    showToast(
      what === "pagar"
        ? `Pagado a ${n}: ${money(b.owed)} ${how}.`
        : what === "cobrar"
          ? `${n} nos dio ${money(b.owesUs)} ${how}.`
          : what === "debemos"
            ? `Le quedamos debiendo a ${n} ${money(b.owed)}.`
            : `${n} nos queda debiendo ${money(b.owesUs)}.`,
    );
    onChange();
  }

  return (
    <section className="flex flex-col rounded-xl border border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
        <h2 className="text-[14px] font-medium">Cuentas con profesionales</h2>
        <span className="text-[13px] text-neutral-400">
          {owedTotal > 0 || owesUsTotal > 0
            ? [
                owedTotal > 0 ? `Les debemos ${money(owedTotal)}` : "",
                owesUsTotal > 0 ? `Nos deben ${money(owesUsTotal)}` : "",
              ]
                .filter(Boolean)
                .join(" · ")
            : balances.length
              ? "Todo saldado"
              : ""}
        </span>
      </div>
      {error ? (
        <p className="px-4 pb-3 text-owe">
          {error} Si recién actualizaste, corré «npm run db:migrate».
        </p>
      ) : !balances.length ? (
        <p className="px-4 pb-3 text-neutral-500">
          No hay nada anotado con profesionales este día.
        </p>
      ) : (
        balances.map((b) => {
          const saldo = b.owed - b.owesUs;
          const settled =
            !b.owner &&
            b.owed === 0 &&
            b.owesUs === 0 &&
            (b.share > 0 || b.direct > 0);
          return (
            <div
              key={b.providerId}
              className="flex flex-col border-t border-neutral-900"
            >
              <button
                type="button"
                aria-expanded={open.has(b.providerId)}
                onClick={() => toggle(b.providerId)}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-neutral-900"
              >
                <span className="inline-flex items-center gap-2 font-medium">
                  <CaretDownIcon
                    size={12}
                    weight="bold"
                    className={`cl-no-print text-neutral-500 transition-transform ${open.has(b.providerId) ? "" : "-rotate-90"}`}
                  />
                  {short(b.name)}
                  <span className="text-[12.5px] font-normal text-neutral-500">
                    {b.lines.length}{" "}
                    {b.lines.length === 1 ? "atención" : "atenciones"}
                  </span>
                  {b.owner && (
                    <span className="text-[12px] font-normal text-neutral-500">
                      admin · sin comisión
                    </span>
                  )}
                </span>
                {!b.owner && (
                  <span
                    className={`tabular-nums ${saldo ? "font-medium" : "text-neutral-400"}`}
                  >
                    {saldo > 0 ? (
                      `Le debemos ${money(saldo)}`
                    ) : saldo < 0 ? (
                      `Nos debe ${money(-saldo)}`
                    ) : settled ? (
                      <span className="inline-flex items-center gap-1 text-[13px]">
                        <CheckIcon size={12} weight="bold" /> al día
                      </span>
                    ) : (
                      "—"
                    )}
                  </span>
                )}
              </button>

              {open.has(b.providerId) && (
                <div className="flex flex-col px-4 pb-3">
                  {/* Sus atenciones del día */}
                  {b.lines.length > 0 && (
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[560px] border-collapse text-[13px] tabular-nums">
                        <thead>
                          <tr className="text-left text-[11.5px] text-neutral-500">
                            <th className="w-[44px] pb-1 font-normal">Hora</th>
                            <th className="pb-1 font-normal">Paciente · qué</th>
                            <th className="pb-1 font-normal">Cobró</th>
                            <th className="pb-1 text-right font-normal">
                              Importe
                            </th>
                            <th className="pb-1 text-right font-normal">
                              Su parte
                            </th>
                            <th className="pb-1 text-right font-normal">
                              {b.owner ? "" : "Queda"}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {b.lines.map((l) => {
                            // Lo que le queda a cada uno de esta atención: + le debemos / − nos debe.
                            const net = l.share - l.direct;
                            return (
                              <tr
                                key={l.key}
                                className="border-t border-neutral-900 align-top"
                              >
                                <td className="py-1.5 text-neutral-500">
                                  {l.time}
                                </td>
                                <td className="py-1.5 pr-3">
                                  <span
                                    className={
                                      l.patient ? "" : "text-neutral-500"
                                    }
                                  >
                                    {l.patient || "Sin paciente"}
                                  </span>
                                  <span className="text-neutral-400">
                                    {" "}
                                    · {l.what}
                                  </span>
                                </td>
                                <td className="whitespace-nowrap py-1.5 pr-3 text-neutral-400">
                                  {l.direct === 0
                                    ? "el consultorio"
                                    : l.direct >= l.total
                                      ? "ella, directo"
                                      : `ella ${money(l.direct)}`}
                                </td>
                                <td className="py-1.5 text-right">
                                  {money(l.total)}
                                </td>
                                <td className="py-1.5 text-right">
                                  {b.owner ? "—" : money(l.share)}
                                </td>
                                <td className="whitespace-nowrap py-1.5 pl-3 text-right text-neutral-400">
                                  {b.owner
                                    ? ""
                                    : net > 0
                                      ? `le debemos ${money(net)}`
                                      : net < 0
                                        ? `nos debe ${money(-net)}`
                                        : "—"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* La cuenta */}
                  {!b.owner && (
                    <div className="mt-2 flex flex-col text-[13px] tabular-nums sm:ml-auto sm:w-[360px]">
                      <Row label="Su parte del día" value={money(b.share)} />
                      {b.debtShare > 0 && (
                        <Row
                          label="de eso, de deudas cobradas"
                          value={money(b.debtShare)}
                          muted
                        />
                      )}
                      {b.direct > 0 && (
                        <Row
                          label="− Cobró ella directo"
                          value={`− ${money(b.direct)}`}
                        />
                      )}
                      {b.paid > 0 && (
                        <Row
                          label="− Ya le pagamos"
                          value={`− ${money(b.paid)}`}
                        />
                      )}
                      {b.collected > 0 && (
                        <Row
                          label="+ Ya nos dio"
                          value={`+ ${money(b.collected)}`}
                        />
                      )}
                      {b.deferred > 0 && (
                        <Row
                          label="− Le quedamos debiendo"
                          value={`− ${money(b.deferred)}`}
                        />
                      )}
                      {b.deferredHer > 0 && (
                        <Row
                          label="+ Nos quedó debiendo"
                          value={`+ ${money(b.deferredHer)}`}
                        />
                      )}
                      <div className="mt-1 flex items-baseline justify-between border-t border-neutral-800 pt-1.5 font-medium">
                        <span>
                          {saldo > 0
                            ? "Le debemos"
                            : saldo < 0
                              ? "Nos debe"
                              : "Saldo"}
                        </span>
                        <span>{money(Math.abs(saldo))}</span>
                      </div>
                    </div>
                  )}

                  {canEdit && !b.owner && (b.owed > 0 || b.owesUs > 0) && (
                    <div className="cl-no-print mt-2 flex flex-wrap items-center justify-end gap-1.5">
                      {b.owed > 0 ? (
                        <>
                          <button
                            onClick={() => act(b, "pagar", "efectivo")}
                            disabled={busy === b.providerId}
                            className={BTN}
                          >
                            {busy === b.providerId ? "…" : "Pagar todo"}
                          </button>
                          <button
                            onClick={() => act(b, "pagar", "transferencia")}
                            disabled={busy === b.providerId}
                            className={BTN}
                          >
                            por transf.
                          </button>
                          <button
                            onClick={() => act(b, "debemos")}
                            disabled={busy === b.providerId}
                            className={LINK}
                          >
                            Queda debiendo
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => act(b, "cobrar", "efectivo")}
                            disabled={busy === b.providerId}
                            className={BTN}
                          >
                            {busy === b.providerId ? "…" : "Cobrar todo"}
                          </button>
                          <button
                            onClick={() => act(b, "cobrar", "transferencia")}
                            disabled={busy === b.providerId}
                            className={BTN}
                          >
                            por transf.
                          </button>
                          <button
                            onClick={() => act(b, "debe")}
                            disabled={busy === b.providerId}
                            className={LINK}
                          >
                            Nos queda debiendo
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
      <p className="border-t border-neutral-900 px-4 pb-3 pt-2 text-[12.5px] text-neutral-500">
        Tocá una profesional para ver su resumen. Si a la profesional le pagaron
        directo, esa plata la tiene ella: lo nuestro se descuenta de lo que le
        debemos y, si no alcanza, nos lo debe. «Pagar todo» / «Cobrar todo» = en
        efectivo (toca la caja); «por transf.», por transferencia. Si no se
        salda hoy, queda en «Le debemos a profesionales» o «Nos deben los
        profesionales». En Anotar: «botox a carla, carmen, 40000, le
        transfirieron a carmen, nos debe 36000».
      </p>
    </section>
  );
}

function Row({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 py-0.5 ${muted ? "pl-3 text-[12.5px] text-neutral-500" : "text-neutral-300"}`}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
