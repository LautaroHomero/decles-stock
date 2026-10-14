"use client";

import { useEffect, useRef, useState } from "react";
import { EnvelopeSimpleIcon, KeyIcon, ListChecksIcon, SignOutIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { ThemeToggle, Wordmark, initials } from "./ui";
import { Bell } from "./bell";
import { AnotarView } from "./anotar-view";
import { CierreView } from "./cierre-view";
import { StockSection } from "./practicas-view";
import { VentasView } from "./ventas-view";
import { EquipoView } from "./equipo-view";
import { ChangePasswordForm, EmailForm } from "./auth-ui";
import { Onboarding } from "./onboarding";
import { OpeningCashPrompt } from "./opening-cash";
import { DolarChip } from "./dolar-chip";

type Section = "vender" | "cierre" | "inventario" | "ventas" | "equipo";

const TABS: { id: Section; label: string }[] = [
  { id: "vender", label: "Anotar" },
  { id: "cierre", label: "Cierre" },
  { id: "ventas", label: "Ventas" },
  { id: "inventario", label: "Stock" },
  { id: "equipo", label: "Equipo" },
];

const ROLE_LABEL = { medico: "Médica/o", recepcion: "Secretaría", paciente: "Paciente" } as const;

/** Shell con la misma barra que Clavdia (staff-shell.tsx): wordmark, pestañas, campanita y menú. */
export function StockApp({ actor }: { actor: Actor }) {
  const isAdmin = !!actor.activeOrg?.canAdmin;
  const isMedico = actor.role === "medico";
  // Todos arrancan anotando; el admin carga stock y prácticas desde Stock.
  const [section, setSection] = useState<Section>("vender");
  // La secretaría solo vende: el inventario (vencimientos, lotes) es del admin y la médica.
  // El equipo, solo el admin.
  const tabs = TABS.filter((t) => (t.id !== "inventario" || isAdmin || isMedico) && (t.id !== "equipo" || isAdmin));
  // Cambia al moverse de pestaña o al reabrir "Primeros pasos": el checklist se recalcula.
  const [onbKey, setOnbKey] = useState(0);
  const go = (s: Section) => {
    setSection(s);
    setOnbKey((k) => k + 1);
  };

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-bg print:h-auto print:overflow-visible">
      <header className="cl-force-dark cl-no-print flex h-14 shrink-0 items-center gap-4 border-b border-neutral-800 bg-header px-4 text-fg sm:gap-8 sm:px-6">
        <button onClick={() => setSection("vender")} aria-label="Klavdia — Anotar" className="shrink-0">
          <Wordmark size={17} />
        </button>
        <nav className="-mx-1 flex h-full min-w-0 items-stretch gap-1 overflow-x-auto sm:gap-2" aria-label="Secciones">
          {tabs.map((t) => {
            const active = section === t.id;
            return (
              <button
                key={t.id}
                onClick={() => go(t.id)}
                aria-current={active ? "page" : undefined}
                className={`relative flex shrink-0 items-center px-2 text-[14px] transition-colors sm:px-3 ${active ? "text-fg" : "text-neutral-400 hover:text-fg"}`}
              >
                {t.label}
                {active && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-fg sm:inset-x-3" />}
              </button>
            );
          })}
        </nav>
        <span className="flex-1" />
        <span className="hidden truncate text-[13px] text-neutral-400 md:block">{actor.activeOrg?.name}</span>
        {!isMedico && <DolarChip canEdit />}
        {(isMedico || isAdmin) && <Bell onOpenStock={() => go("inventario")} />}
        <AvatarMenu actor={actor} onOnboarding={() => setOnbKey((k) => k + 1)} />
      </header>

      {actor.role === "recepcion" && <OpeningCashPrompt />}
      <main className="min-h-0 flex-1 overflow-y-auto print:overflow-visible">
        {isAdmin && section !== "cierre" && <Onboarding go={go} reloadKey={onbKey} />}
        {section === "vender" && <AnotarView actor={actor} onOpenClose={() => go("cierre")} />}
        {section === "cierre" && <CierreView actor={actor} onOpenSales={() => go("ventas")} />}
        {section === "inventario" && (isAdmin || isMedico) && <StockSection canAdmin={isAdmin} />}
        {section === "ventas" && <VentasView actor={actor} />}
        {section === "equipo" && isAdmin && <EquipoView actor={actor} />}
      </main>
    </div>
  );
}

function AvatarMenu({ actor, onOnboarding }: { actor: Actor; onOnboarding: () => void }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  const [mail, setMail] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <div ref={ref} className="relative">
      {pw && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onMouseDown={(e) => e.target === e.currentTarget && setPw(false)}>
          <div className="w-full max-w-[400px] animate-cl-in rounded-2xl bg-surface p-5 text-fg shadow-lg">
            <p className="mb-3 text-[15px] font-medium">Cambiar contraseña</p>
            <ChangePasswordForm onDone={() => setPw(false)} />
          </div>
        </div>
      )}
      {mail !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onMouseDown={(e) => e.target === e.currentTarget && setMail(null)}>
          <div className="w-full max-w-[400px] animate-cl-in rounded-2xl bg-surface p-5 text-fg shadow-lg">
            <p className="mb-3 text-[15px] font-medium">Mi email</p>
            <EmailForm initial={mail} onDone={() => setMail(null)} skipLabel="Cancelar" />
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Tu cuenta"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-700 text-[12px] font-medium text-neutral-200 transition-colors hover:border-accent-600"
      >
        {initials(actor.name)}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-40 w-[240px] animate-cl-in rounded-xl bg-surface p-3 shadow-lg">
          <p className="text-[14px] font-medium">{actor.name}</p>
          <p className="text-[12px] text-neutral-400">
            {ROLE_LABEL[actor.role]}
            {actor.activeOrg?.canAdmin ? " · Admin" : ""} · {actor.activeOrg?.name}
          </p>
          <div className="my-3 h-px bg-neutral-800" />
          <ThemeToggle />
          <button
            onClick={() => {
              setOpen(false);
              setPw(true);
            }}
            className="mt-3 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-neutral-300 transition-colors hover:bg-accent-900"
          >
            <KeyIcon size={15} /> Cambiar contraseña
          </button>
          <button
            onClick={async () => {
              setOpen(false);
              const d = await fetch("/api/auth/email")
                .then((r) => r.json())
                .catch(() => ({}));
              setMail(d.email ?? "");
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-neutral-300 transition-colors hover:bg-accent-900"
          >
            <EnvelopeSimpleIcon size={15} /> Mi email
          </button>
          {actor.activeOrg?.canAdmin && (
            <button
              onClick={async () => {
                setOpen(false);
                await fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: false }) });
                onOnboarding();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-neutral-300 transition-colors hover:bg-accent-900"
            >
              <ListChecksIcon size={15} /> Primeros pasos
            </button>
          )}
          <button
            onClick={logout}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-neutral-300 transition-colors hover:bg-accent-900"
          >
            <SignOutIcon size={15} /> Salir
          </button>
        </div>
      )}
    </div>
  );
}
