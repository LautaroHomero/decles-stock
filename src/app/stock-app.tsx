"use client";

import { useEffect, useRef, useState } from "react";
import { KeyIcon, SignOutIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { ThemeToggle, Wordmark, initials } from "./ui";
import { Bell } from "./bell";
import { VenderView } from "./vender-view";
import { InventarioView } from "./inventario-view";
import { VentasView } from "./ventas-view";
import { EquipoView } from "./equipo-view";
import { ChangePasswordForm } from "./auth-ui";

type Section = "vender" | "inventario" | "ventas" | "equipo";

const TABS: { id: Section; label: string }[] = [
  { id: "vender", label: "Vender" },
  { id: "inventario", label: "Stock" },
  { id: "ventas", label: "Ventas" },
  { id: "equipo", label: "Equipo" },
];

const ROLE_LABEL = { medico: "Médica/o", recepcion: "Secretaría", paciente: "Paciente" } as const;

/** Shell con la misma barra que Clavdia (staff-shell.tsx): wordmark, pestañas, campanita y menú. */
export function StockApp({ actor }: { actor: Actor }) {
  const isAdmin = !!actor.activeOrg?.canAdmin;
  const isMedico = actor.role === "medico";
  // El admin arranca en el inventario (es quien carga); el resto, vendiendo.
  const [section, setSection] = useState<Section>(isAdmin ? "inventario" : "vender");
  // La secretaría solo vende: el inventario (vencimientos, lotes) es del admin y la médica.
  // El equipo, solo el admin.
  const tabs = TABS.filter((t) => (t.id !== "inventario" || isAdmin || isMedico) && (t.id !== "equipo" || isAdmin));

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-bg">
      <header className="cl-force-dark flex h-14 shrink-0 items-center gap-4 border-b border-neutral-800 bg-header px-4 text-fg sm:gap-8 sm:px-6">
        <button onClick={() => setSection("vender")} aria-label="Klavdia — Vender" className="shrink-0">
          <Wordmark size={17} />
        </button>
        <nav className="flex h-full items-stretch gap-1 sm:gap-2" aria-label="Secciones">
          {tabs.map((t) => {
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
        {section === "inventario" && (isAdmin || isMedico) && <InventarioView />}
        {section === "ventas" && <VentasView actor={actor} />}
        {section === "equipo" && isAdmin && <EquipoView actor={actor} />}
      </main>
    </div>
  );
}

function AvatarMenu({ actor }: { actor: Actor }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
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
