"use client";

import { useEffect, useRef, useState } from "react";
import { SignOutIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { ThemeToggle, Wordmark, initials } from "./ui";
import { Bell } from "./bell";
import { VenderView } from "./vender-view";
import { InventarioView } from "./inventario-view";
import { VentasView } from "./ventas-view";

type Section = "vender" | "inventario" | "ventas";

const TABS: { id: Section; label: string }[] = [
  { id: "vender", label: "Vender" },
  { id: "inventario", label: "Stock" },
  { id: "ventas", label: "Ventas" },
];

const ROLE_LABEL = { medico: "Médica/o", recepcion: "Secretaría", paciente: "Paciente" } as const;

/** Shell con la misma barra que Clavdia (staff-shell.tsx): wordmark, pestañas, campanita y menú. */
export function StockApp({ actor }: { actor: Actor }) {
  const isAdmin = !!actor.activeOrg?.canAdmin;
  const isMedico = actor.role === "medico";
  // El admin arranca en el inventario (es quien carga); el resto, vendiendo.
  const [section, setSection] = useState<Section>(isAdmin ? "inventario" : "vender");

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-bg">
      <header className="cl-force-dark flex h-14 shrink-0 items-center gap-4 border-b border-neutral-800 bg-header px-4 text-fg sm:gap-8 sm:px-6">
        <button onClick={() => setSection("vender")} aria-label="Klavdia — Vender" className="shrink-0">
          <Wordmark size={17} />
        </button>
        <nav className="flex h-full items-stretch gap-1 sm:gap-2" aria-label="Secciones">
          {TABS.map((t) => {
            const active = section === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setSection(t.id)}
                aria-current={active ? "page" : undefined}
                className={`relative flex items-center px-2 text-[14px] transition-colors sm:px-3 ${active ? "text-fg" : "text-neutral-400 hover:text-fg"}`}
              >
                {t.label}
                {active && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-fg sm:inset-x-3" />}
              </button>
            );
          })}
        </nav>
        <span className="flex-1" />
        <span className="hidden truncate text-[13px] text-neutral-400 md:block">{actor.activeOrg?.name}</span>
        {isMedico && <Bell onOpenStock={() => setSection("inventario")} />}
        <AvatarMenu actor={actor} />
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {section === "vender" && <VenderView actor={actor} />}
        {section === "inventario" && <InventarioView />}
        {section === "ventas" && <VentasView actor={actor} />}
      </main>
    </div>
  );
}

function AvatarMenu({ actor }: { actor: Actor }) {
  const [open, setOpen] = useState(false);
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
            onClick={logout}
            className="mt-3 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-neutral-300 transition-colors hover:bg-accent-900"
          >
            <SignOutIcon size={15} /> Salir
          </button>
        </div>
      )}
    </div>
  );
}
