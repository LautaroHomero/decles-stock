"use client";

import { useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { call, money, usePoll, type CatalogResponse } from "./shared";

/** Espejo de `Prepaid` de src/lib/domain/prepaids.ts. */
export interface PrepaidRow {
  id: string;
  patient: string;
  itemId: string;
  itemName: string;
  unitPrice: number;
  sessions: number | null;
  amount: number;
  used: number;
  sessionsLeft: number;
  balance: number;
  createdAt: string;
}

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Abonos con sesiones o saldo pendiente (de todos los días): quién, de qué, cuánto pagó y cuánto le queda.
 * Se anotan y se usan desde Anotar; acá se ven y se anula uno mal anotado (si todavía no se usó).
 */
export function AbonosCard({ onChange, showToast, canAdd = true }: { onChange: () => void; showToast: (m: string) => void; canAdd?: boolean }) {
  const [data, refresh] = usePoll<{ ok: boolean; prepaids: PrepaidRow[] }>("/api/prepaids", 60_000);
  const list = data?.ok ? data.prepaids : [];
  const [adding, setAdding] = useState(false);

  async function anul(p: PrepaidRow) {
    const r = await call(`/api/prepaids/${p.id}`, "DELETE");
    if (!r.ok) return showToast(r.error ?? "No se pudo anular.");
    showToast("Abono anulado: la plata sale de la caja de ese día.");
    refresh();
    onChange();
  }

  return (
    <section className="flex flex-col rounded-xl border border-neutral-800">
      {adding && (
        <AbonoForm
          onClose={() => setAdding(false)}
          onSaved={(msg) => {
            setAdding(false);
            showToast(msg);
            refresh();
            onChange();
          }}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
        <h2 className="text-[14px] font-medium">Abonos</h2>
        <span className="flex items-center gap-4">
          {list.length > 0 && <span className="text-[13px] text-neutral-400">Sin usar {money(list.reduce((n, p) => n + p.balance, 0))}</span>}
          {canAdd && (
            <button onClick={() => setAdding(true)} className="cl-no-print inline-flex items-center gap-1 text-[13px] text-neutral-400 hover:text-fg">
              <PlusIcon size={12} weight="bold" /> Abono
            </button>
          )}
        </span>
      </div>
      {!data ? (
        <p className="px-4 pb-3 text-neutral-500">Cargando…</p>
      ) : !list.length ? (
        <p className="px-4 pb-3 text-[13.5px] text-neutral-500">
          No hay abonos abiertos. Se anotan en Anotar: «carla dejó un abono de 5 sesiones de venus freeze, pagó 250000 en efectivo».
        </p>
      ) : (
        <ul className="flex flex-col">
          {list.map((p) => (
            <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-neutral-900 px-4 py-2.5">
              <span className="min-w-0">
                <b className="font-medium">{p.patient}</b>
                <span className="block text-[12.5px] text-neutral-500">
                  {p.sessions ? `${p.sessions} sesiones de ${p.itemName}` : `Saldo para ${p.itemName}`} · {money(p.unitPrice)} c/u · pagó {money(p.amount)} el {ddmm(p.createdAt)}
                </span>
              </span>
              <span className="flex items-center gap-3">
                <span className="whitespace-nowrap text-right">
                  <span className="font-medium tabular-nums">{p.sessions ? `${p.sessionsLeft} de ${p.sessions}` : money(p.balance)}</span>
                  <span className="block text-[12px] text-neutral-500">{p.sessions ? "sesiones" : `${p.sessionsLeft} sesiones`}</span>
                </span>
                {p.used === 0 && (
                  <button onClick={() => anul(p)} className="cl-no-print text-[12.5px] text-neutral-500 underline-offset-2 hover:text-fg hover:underline">
                    anular
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const FIELD =
  "w-full rounded-md border border-neutral-800 bg-transparent px-3 py-2.5 text-[15px] text-fg placeholder:text-neutral-600 focus:border-accent-700 focus:outline-none";
const TOGGLE = (on: boolean) =>
  `rounded-md border px-3 py-1.5 text-[13.5px] ${on ? "border-accent bg-accent text-on-accent" : "border-neutral-800 text-neutral-300 hover:bg-accent-900"}`;

/**
 * Anotar un abono a mano (Planilla, Cierre): paciente, tratamiento, por sesiones o saldo, cuánto pagó y cómo.
 * El precio por sesión queda congelado (con sesiones: lo pagado / sesiones; con saldo: el de lista de hoy).
 */
export function AbonoForm({ onClose, onSaved }: { onClose: () => void; onSaved: (msg: string) => void }) {
  const [catalog] = usePoll<CatalogResponse>("/api/catalog", 120_000);
  const practices = catalog?.practices ?? [];
  const [patient, setPatient] = useState("");
  const [itemId, setItemId] = useState("");
  const [bySessions, setBySessions] = useState(true);
  const [sessions, setSessions] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"efectivo" | "transferencia" | "tarjeta" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const item = practices.find((p) => p.id === itemId);
  const n = Number(amount || 0);
  const ses = Number(sessions || 0);
  const unit = bySessions ? (ses > 0 && n > 0 ? Math.round(n / ses) : 0) : (item?.price ?? 0);
  const ok = patient.trim() && item && n > 0 && method && (!bySessions || ses > 0);

  async function save() {
    if (!ok || busy) return;
    setBusy(true);
    setErr("");
    const r = await call("/api/prepaids", "POST", { patient, itemId, sessions: bySessions ? ses : null, amount: n, method });
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "No se pudo guardar.");
    onSaved(`Abono · ${patient.trim()} · ${bySessions ? `${ses} sesiones de ` : ""}${item!.name} · ${money(n)}`);
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
          <h2 className="font-display text-[18px] font-medium tracking-[-.01em]">Anotar un abono</h2>
          <p className="text-[13px] text-neutral-400">La paciente paga antes para congelar el precio. La plata entra hoy; las sesiones se descuentan cuando viene.</p>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">Paciente</span>
          <input autoFocus value={patient} onChange={(e) => setPatient(e.target.value)} placeholder="Nombre y apellido" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">Tratamiento</span>
          <select value={itemId} onChange={(e) => setItemId(e.target.value)} className={FIELD}>
            <option value="">Elegí…</option>
            {practices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {money(p.price)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">¿Cómo es?</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setBySessions(true)} className={TOGGLE(bySessions)}>
              Cantidad de sesiones
            </button>
            <button type="button" onClick={() => setBySessions(false)} className={TOGGLE(!bySessions)}>
              Saldo en plata
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {bySessions && (
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-neutral-400">Sesiones</span>
              <input value={sessions} onChange={(e) => setSessions(e.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" placeholder="Ej. 5" className={`${FIELD} tabular-nums`} />
            </label>
          )}
          <label className={`flex flex-col gap-1 ${bySessions ? "" : "col-span-2"}`}>
            <span className="text-[12px] text-neutral-400">Pagó</span>
            <input
              value={amount ? `$ ${Number(amount).toLocaleString("es-AR")}` : ""}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              placeholder="$"
              className={`${FIELD} tabular-nums`}
            />
          </label>
        </div>
        {item && unit > 0 && (
          <p className="text-[13px] text-neutral-400">
            Precio congelado {money(unit)} por sesión
            {!bySessions && n > 0 && ` · alcanza para ${Math.floor(n / unit)} sesiones`}
            {unit !== item.price && ` · hoy sale ${money(item.price)}`}
          </p>
        )}
        <div className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">¿Cómo pagó? · solo el efectivo cuenta en la caja</span>
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
