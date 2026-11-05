"use client";

import { useState } from "react";
import { CaretDownIcon, FunnelSimpleIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import type { Payment } from "./shared";
import type { Row, Seller } from "./planilla-view";

/**
 * Planilla → Día: buscador + filtros. En reposo solo se ve el buscador; la fila de filtros aparece al tocarlo, al
 * escribir o si hay alguno puesto. Cada filtro abre un menú chico que se cierra al elegir, así nunca tapa los resultados.
 * Búsqueda sin tildes ni mayúsculas, en paciente, profesional o práctica/producto.
 */

export type Scope = "todo" | "paciente" | "profesional" | "practica";
export interface Filtros {
  q: string;
  scope: Scope;
  pro: string | null;
  method: Payment | null;
  debt: boolean;
}
export const SIN_FILTROS: Filtros = { q: "", scope: "todo", pro: null, method: null, debt: false };
export const filtrando = (f: Filtros) => !!(f.q.trim() || f.pro || f.method || f.debt);

const SCOPES: [Scope, string][] = [
  ["todo", "Todo"],
  ["paciente", "Paciente"],
  ["profesional", "Profesional"],
  ["practica", "Práctica"],
];
const METHODS: [Payment, string][] = [
  ["efectivo", "Efectivo"],
  ["transferencia", "Transf."],
  ["tarjeta", "Tarjeta"],
  ["dolares", "US$"],
];

/** Minúsculas y sin tildes, letra por letra (mismo largo: sirve para resaltar). */
export const fold = (s: string) =>
  [...s].map((c) => c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().charAt(0) || c).join("");

function inScope(r: Row, scope: Scope, q: string, proName: (id: string | null) => string): boolean {
  if (!q) return true;
  const p = fold(r.patient).includes(q);
  const pr = fold(proName(r.providerId)).includes(q);
  const it = r.items.some((i) => fold(i.name).includes(q));
  return scope === "paciente" ? p : scope === "profesional" ? pr : scope === "practica" ? it : p || pr || it;
}

/** Filtros sin la búsqueda (profesional, medio, deuda). */
function passes(r: Row, f: Filtros): boolean {
  if (f.pro && r.providerId !== f.pro) return false;
  if (f.method && !(r.method === f.method || r.parts.some((p) => p.method === f.method))) return false;
  if (f.debt && !r.debt?.remaining) return false;
  return true;
}

export function filtrar(rows: Row[], f: Filtros, sellers: Seller[], fallbackName: (r: Row) => string): Row[] {
  const q = fold(f.q.trim());
  const name = (id: string | null) => sellers.find((s) => s.id === id)?.name ?? "";
  return rows.filter((r) => passes(r, f) && inScope(r, f.scope, q, (id) => name(id) || fallbackName(r)));
}

/** Nombre con la parte buscada resaltada. */
export function Resaltar({ text, q }: { text: string; q: string }) {
  const n = fold(q.trim());
  const i = n ? fold(text).indexOf(n) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[3px] bg-warn/25 text-fg">{text.slice(i, i + n.length)}</mark>
      {text.slice(i + n.length)}
    </>
  );
}

const PILL = "inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[14px] font-medium transition-colors";
const pill = (on: boolean) => `${PILL} ${on ? "border-accent bg-accent text-on-accent" : "border-neutral-800 text-neutral-300 hover:text-fg"}`;

export function PlanillaFiltros({
  value: f,
  onChange,
  rows,
  sellers,
  fallbackName,
  shown,
}: {
  value: Filtros;
  onChange: (f: Filtros) => void;
  rows: Row[];
  sellers: Seller[];
  fallbackName: (r: Row) => string;
  /** Cuántas filas quedan con todo aplicado. */
  shown: number;
}) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<"scope" | "pro" | "method" | null>(null);
  const set = (p: Partial<Filtros>) => {
    onChange({ ...f, ...p });
    setMenu(null);
  };
  const active = (f.scope !== "todo" ? 1 : 0) + (f.pro ? 1 : 0) + (f.method ? 1 : 0) + (f.debt ? 1 : 0);
  const showBar = open || !!f.q || active > 0;
  const q = f.q.trim();
  const countIn = (s: Scope) => filtrar(rows, { ...f, scope: s }, sellers, fallbackName).length;
  const proName = sellers.find((s) => s.id === f.pro)?.name;

  const drops = [
    {
      key: "scope" as const,
      label: "Buscar en",
      value: SCOPES.find(([s]) => s === f.scope)![1],
      on: f.scope !== "todo",
      options: SCOPES.map(([s, l]) => ({ id: s, label: l, on: f.scope === s, count: q ? String(countIn(s)) : "", pick: () => set({ scope: s }) })),
    },
    {
      key: "pro" as const,
      label: "Profesional",
      value: proName ?? "Todos",
      on: !!f.pro,
      options: [{ id: "", name: "Todos" }, ...sellers].map((s) => ({
        id: s.id,
        label: s.name,
        on: (f.pro ?? "") === s.id,
        count: "",
        pick: () => set({ pro: s.id || null }),
      })),
    },
    {
      key: "method" as const,
      label: "Medio",
      value: METHODS.find(([m]) => m === f.method)?.[1] ?? "Todos",
      on: !!f.method,
      options: [["", "Todos"] as const, ...METHODS].map(([m, l]) => ({
        id: m,
        label: l,
        on: (f.method ?? "") === m,
        count: "",
        pick: () => set({ method: (m || null) as Payment | null }),
      })),
    },
  ];

  return (
    <div className="cl-no-print flex flex-col gap-2.5">
      {menu && <button tabIndex={-1} aria-label="Cerrar menú" onClick={() => setMenu(null)} className="fixed inset-0 z-20 cursor-default" />}
      <div className="relative flex items-center">
        <MagnifyingGlassIcon size={20} className="pointer-events-none absolute left-4 text-neutral-400" />
        <label htmlFor="planilla-q" className="sr-only">
          Buscar
        </label>
        <input
          id="planilla-q"
          type="text"
          autoComplete="off"
          value={f.q}
          onChange={(e) => onChange({ ...f, q: e.target.value })}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => e.key === "Escape" && onChange({ ...f, q: "" })}
          placeholder="Buscar paciente, profesional o práctica…"
          className={`h-14 w-full rounded-2xl border bg-surface pl-12 text-[16px] text-fg placeholder:text-neutral-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cl-ring)] ${
            f.q ? "pr-44" : "pr-32"
          } ${open ? "border-neutral-700" : "border-neutral-800"}`}
        />
        <div className="absolute right-2 flex items-center gap-0.5">
          {f.q && (
            <button aria-label="Borrar búsqueda" onClick={() => onChange({ ...f, q: "" })} className="flex h-11 w-11 items-center justify-center rounded-lg text-neutral-400 hover:text-fg">
              <XIcon size={18} />
            </button>
          )}
          <button
            aria-expanded={showBar}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-neutral-800 px-3 text-[14px] font-medium text-neutral-200 hover:text-fg"
          >
            <FunnelSimpleIcon size={16} />
            Filtros
            {active > 0 && <span className="min-w-5 rounded-full bg-accent px-1.5 text-center text-[12px] leading-5 text-on-accent">{active}</span>}
          </button>
        </div>
      </div>

      {showBar && (
        <div className="relative z-30 flex flex-wrap items-center gap-2">
          {drops.map((d) => (
            <div key={d.key} className="relative">
              <button aria-haspopup="menu" aria-expanded={menu === d.key} onClick={() => setMenu(menu === d.key ? null : d.key)} className={`${pill(d.on)} pr-3`}>
                <span className={d.on ? "opacity-60" : "text-neutral-400"}>{d.label}:</span>
                {d.value}
                <CaretDownIcon size={13} weight="bold" className={`transition-transform ${menu === d.key ? "rotate-180" : ""}`} />
              </button>
              {menu === d.key && (
                <div role="menu" aria-label={d.label} className="absolute left-0 top-12 flex min-w-[220px] flex-col gap-0.5 rounded-xl bg-surface p-1.5 shadow-lg">
                  {d.options.map((o) => (
                    <button
                      key={o.id}
                      role="menuitemradio"
                      aria-checked={o.on}
                      onClick={o.pick}
                      className={`flex min-h-10 items-center justify-between gap-4 rounded-lg px-3 text-left text-[14.5px] font-medium ${o.on ? "bg-neutral-800 text-fg" : "text-neutral-200 hover:bg-neutral-900"}`}
                    >
                      <span>{o.label}</span>
                      <span className="tabular-nums text-neutral-400">{o.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <button
            aria-pressed={f.debt}
            onClick={() => set({ debt: !f.debt })}
            className={`${PILL} ${f.debt ? "border-owe-line bg-owe-bg text-owe" : "border-neutral-800 text-neutral-300 hover:text-fg"}`}
          >
            Quedó debiendo
          </button>
          {(active > 0 || f.q) && (
            <button onClick={() => set(SIN_FILTROS)} className="min-h-10 px-2 text-[14px] font-medium text-neutral-400 underline underline-offset-4 hover:text-fg">
              Limpiar
            </button>
          )}
          {filtrando(f) && <span className="ml-auto text-[13.5px] text-neutral-400">{shown === 1 ? "1 atención" : `${shown} atenciones`}</span>}
        </div>
      )}
    </div>
  );
}
