"use client";

import { useState } from "react";
import { call, money, usePoll, useToday } from "./shared";

/**
 * Al iniciar el día, a la secretaria se le pregunta cuánto cambio hay en la caja.
 * Se pregunta una vez por día: si lo carga, queda en el cierre; si toca «No sé», no vuelve a preguntar hasta mañana.
 */
export function OpeningCashPrompt() {
  const today = useToday();
  const [cash, refresh] = usePoll<{ ok: boolean; cash: { opening: number | null } }>(`/api/day-cash?date=${today}`, 5 * 60_000);
  const skipKey = `decles_opening_skip_${today}`;
  const [skipped, setSkipped] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`decles_opening_skip_${today}`);
    } catch {
      return null;
    }
  });
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const isSkipped = skipped === today;
  if (!cash?.ok || cash.cash.opening !== null || isSkipped) return null;

  const n = Number(v.replace(/\D/g, "") || 0);
  const skip = () => {
    try {
      localStorage.setItem(skipKey, today);
    } catch {
      /* sin storage: igual se cierra por ahora */
    }
    setSkipped(today);
  };
  async function save() {
    if (!v.trim() || busy) return;
    setBusy(true);
    setErr("");
    const r = await call("/api/day-cash", "PUT", { date: today, opening: n });
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "No se pudo guardar.");
    refresh();
  }

  return (
    <div className="cl-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex w-full max-w-[400px] flex-col gap-4 rounded-xl bg-surface p-5 shadow-lg"
      >
        <div>
          <h2 className="font-display text-[18px] font-medium tracking-[-.01em]">¿Cuánto cambio hay en la caja?</h2>
          <p className="text-[13px] text-neutral-400">Lo que hay al empezar el día. Queda en el cierre para saber cuánto efectivo tiene que haber.</p>
        </div>
        <input
          autoFocus
          value={v ? `$ ${n.toLocaleString("es-AR")}` : ""}
          onChange={(e) => setV(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder="$"
          className="w-full rounded-md border border-neutral-800 bg-transparent px-3 py-2.5 text-[18px] tabular-nums text-fg outline-none placeholder:text-neutral-600 focus:border-accent-700"
        />
        {err && <p className="text-[13px] text-neutral-200">{err}</p>}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={!v.trim() || busy}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-lg border border-accent bg-accent px-4 text-[14px] font-medium text-on-accent transition-opacity hover:opacity-85 disabled:opacity-40"
          >
            {busy ? "Guardando…" : v.trim() ? `Guardar · ${money(n)}` : "Guardar"}
          </button>
          <button type="button" onClick={skip} className="h-11 rounded-lg border border-neutral-800 px-4 text-[14px] text-neutral-300 hover:bg-accent-900">
            No sé
          </button>
        </div>
      </form>
    </div>
  );
}
