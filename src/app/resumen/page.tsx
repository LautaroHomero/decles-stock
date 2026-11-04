"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Balance, BalanceLine } from "../cuentas-profesionales";
import { fmtDate, localToday, money, usdFmt } from "../shared";

/**
 * Resumen diario de una profesional (o de todas) para mandárselo: paciente por paciente, su parte y la cuenta del día.
 * `/resumen?date=AAAA-MM-DD&provider=<id>` (sin `provider` = todas, una por hoja). Se abre desde Cierre → Cuentas con
 * profesionales y abre el diálogo de imprimir: «Guardar como PDF». Los datos son los de `/api/payouts` (solo admin y secretaría).
 */
export default function ResumenPage() {
  return (
    <Suspense fallback={null}>
      <Resumen />
    </Suspense>
  );
}

type Me = { name: string; activeOrg?: { name: string } };

const short = (name: string) => name.replace(/^(Dra?\.|Lic\.)\s*/i, "");
const longDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const s = new Date(y, m - 1, d).toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function cobro(l: BalanceLine) {
  if (l.direct === 0) return l.prepaid === "abonado" ? "Abono (pagado antes)" : l.prepaid === "giftcard" ? "Gift card" : "Consultorio";
  return l.direct >= l.total ? "Profesional" : `Profesional ${money(l.direct)}`;
}

function Resumen() {
  const q = useSearchParams();
  const router = useRouter();
  const date = q.get("date") || localToday();
  const provider = q.get("provider");
  const [me, setMe] = useState<Me | null>(null);
  const [list, setList] = useState<Balance[] | null>(null);
  const [error, setError] = useState("");
  const printed = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const [rm, rp] = await Promise.all([fetch("/api/auth/me"), fetch(`/api/payouts?date=${encodeURIComponent(date)}`)]);
        if (rm.status === 401) return router.replace("/login");
        const m = await rm.json();
        const p = await rp.json();
        if (!p.ok) return setError(p.error ?? "No se pudo cargar el resumen.");
        const all = (p.balances as Balance[]).filter((b) => !b.owner && b.lines.length + b.debtShare > 0);
        setMe(m.actor);
        setList(provider ? all.filter((b) => b.providerId === provider) : all);
      } catch {
        setError("No se pudo conectar.");
      }
    })();
  }, [date, provider, router]);

  // Nombre del PDF = título de la página.
  useEffect(() => {
    if (!list?.length) return;
    const who = list.length === 1 ? short(list[0].name) : "profesionales";
    document.title = `Resumen ${who} ${fmtDate(date).replaceAll("/", "-")}`;
    if (!printed.current) {
      printed.current = true;
      setTimeout(() => window.print(), 400);
    }
  }, [list, date]);

  const msg = error || (list && !list.length ? "No hay atenciones de profesionales para este día." : "");

  return (
    <div className="cl-resumen min-h-screen bg-white text-black">
      <div className="cl-no-print sticky top-0 flex items-center justify-between gap-2 border-b border-[#ccc] bg-white px-4 py-3">
        <span className="text-[13px] text-[#555]">Para mandarlo: «Guardar como PDF» en el diálogo de imprimir.</span>
        <div className="flex gap-2">
          <button onClick={() => window.print()} disabled={!list?.length} className="h-9 rounded-md bg-black px-3 text-[13px] font-medium text-white disabled:opacity-40">
            Guardar PDF / Imprimir
          </button>
          <button onClick={() => window.close()} className="h-9 rounded-md border border-[#ccc] px-3 text-[13px] text-[#333]">
            Cerrar
          </button>
        </div>
      </div>

      {msg ? (
        <p className="p-8 text-[14px] text-[#333]">{msg}</p>
      ) : !list ? (
        <p className="p-8 text-[14px] text-[#777]">Cargando…</p>
      ) : (
        list.map((b) => <Hoja key={b.providerId} b={b} date={date} org={me?.activeOrg?.name ?? ""} by={me?.name ?? ""} />)
      )}
    </div>
  );
}

function Hoja({ b, date, org, by }: { b: Balance; date: string; org: string; by: string }) {
  const saldo = b.owed - b.owesUs;
  const facturado = b.lines.reduce((n, l) => n + (l.usd ? 0 : l.total), 0);
  const usd = b.lines.reduce((n, l) => n + (l.usd ?? 0), 0);
  const now = new Date();
  return (
    <section className="cl-hoja mx-auto flex max-w-[800px] flex-col gap-5 px-8 py-8 text-[13px]">
      <header className="flex items-start justify-between gap-4 border-b border-black pb-3">
        <div>
          <p className="text-[12px] uppercase tracking-wide text-[#555]">{org || "Consultorio"} · Resumen del día</p>
          <h1 className="mt-1 text-[22px] font-semibold">{b.name}</h1>
        </div>
        <p className="text-right text-[13px]">{longDate(date)}</p>
      </header>

      {b.lines.length > 0 && (
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr className="whitespace-nowrap border-b border-[#999] text-left text-[11.5px] uppercase tracking-wide text-[#555]">
              <th className="py-1.5 pr-2 font-medium">Hora</th>
              <th className="py-1.5 pr-2 font-medium">Paciente</th>
              <th className="py-1.5 pr-2 font-medium">Qué se hizo</th>
              <th className="py-1.5 pr-2 font-medium">Cobró</th>
              <th className="py-1.5 pr-2 text-right font-medium">Importe</th>
              <th className="py-1.5 text-right font-medium">Su parte</th>
            </tr>
          </thead>
          <tbody>
            {b.lines.map((l) => (
              <tr key={l.key} className="border-b border-[#ddd] align-top">
                <td className="py-1.5 pr-2 text-[#555]">{l.time}</td>
                <td className="py-1.5 pr-2 font-medium">{l.patient || "Sin paciente"}</td>
                <td className="py-1.5 pr-2">{l.what}</td>
                <td className="py-1.5 pr-2 text-[#333]">{cobro(l)}</td>
                <td className="whitespace-nowrap py-1.5 pr-2 text-right">{l.usd ? usdFmt(l.usd) : money(l.total)}</td>
                <td className="whitespace-nowrap py-1.5 text-right font-medium">{money(l.share)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <td className="pt-2" colSpan={4}>
                {b.lines.length} {b.lines.length === 1 ? "atención" : "atenciones"}
              </td>
              <td className="whitespace-nowrap pt-2 pr-2 text-right">{[facturado ? money(facturado) : "", usd ? usdFmt(usd) : ""].filter(Boolean).join(" + ") || money(0)}</td>
              <td className="whitespace-nowrap pt-2 text-right">{money(b.share - b.debtShare)}</td>
            </tr>
          </tfoot>
        </table>
      )}

      <div className="ml-auto flex w-full max-w-[380px] flex-col tabular-nums">
        <Fila label="Su parte por atenciones" value={money(b.share - b.debtShare)} />
        {b.debtShare > 0 && <Fila label="+ Su parte de deudas cobradas hoy" value={`+ ${money(b.debtShare)}`} />}
        <Fila label="Ganó en el día" value={money(b.share)} strong />
        {b.direct > 0 && <Fila label="− Cobró directo" value={`− ${money(b.direct)}`} />}
        {b.paid > 0 && <Fila label="− Ya se le pagó" value={`− ${money(b.paid)}`} />}
        {b.collected > 0 && <Fila label="+ Ya le dio al consultorio" value={`+ ${money(b.collected)}`} />}
        {b.deferred > 0 && <Fila label="− Queda como deuda del consultorio" value={`− ${money(b.deferred)}`} />}
        {b.deferredHer > 0 && <Fila label="+ Queda como deuda con el consultorio" value={`+ ${money(b.deferredHer)}`} />}
        <div className="mt-1 flex items-baseline justify-between border-t-2 border-black pt-2 text-[15px] font-semibold">
          <span>{saldo > 0 ? "El consultorio le debe" : saldo < 0 ? "Le debe al consultorio" : "Saldo del día"}</span>
          <span>{money(Math.abs(saldo))}</span>
        </div>
      </div>

      <footer className="mt-auto pt-6 text-[11px] text-[#777]">
        Generado el {fmtDate(localToday())} a las {now.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
        {by ? ` por ${by}` : ""}.
      </footer>
    </section>
  );
}

function Fila({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between py-0.5 ${strong ? "font-semibold" : ""}`}>
      <span className={strong ? "" : "text-[#333]"}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
