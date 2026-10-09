"use client";

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";

// Primitivas visuales: copia de `src/app/ui.tsx` de Clavdia (misma estética).

/** Botón principal: relleno claro (una sola acción principal por pantalla). */
export const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-accent bg-accent px-3.5 text-[13px] font-medium text-on-accent transition-opacity hover:opacity-85 active:opacity-70 disabled:pointer-events-none disabled:opacity-40";
/** Botón secundario / ghost. */
export const BTN_GHOST =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-neutral-800 bg-transparent px-3 text-[13px] text-neutral-300 transition-colors hover:border-accent-700 hover:bg-accent-900 disabled:pointer-events-none disabled:opacity-40";
export const ICON_BTN =
  "flex items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-accent-900 hover:text-accent-300";
/** Título de sección del panel derecho. */
export const SECTION_TITLE = "text-[11px] uppercase tracking-[.08em] text-neutral-500";

export function Spinner({ size = 12 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 animate-cl-spin rounded-full border-[1.5px] border-neutral-700 border-t-accent"
      style={{ width: size, height: size }}
    />
  );
}

export function Pulse() {
  return <span aria-hidden className="inline-block h-2 w-2 shrink-0 animate-cl-ring rounded-full bg-accent" />;
}

export function Thinking({ label = "Pensando" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[12.5px] text-neutral-400" role="status">
      <span className="inline-flex gap-[3px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-[5px] w-[5px] rounded-full bg-accent"
            style={{ animation: `cl-dot 1.2s ease-in-out ${i * 0.15}s infinite` }}
          />
        ))}
      </span>
      {label}
    </span>
  );
}

export function Caret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[15px] w-[7px] animate-cl-blink bg-accent align-[-2px]"
    />
  );
}

const K_PATH = "M4 0H36V100H4Z M36 36C62 36 70 22 74 0H108C103 38 84 58 52 60H36Z M50 52H86L120 100H84Z";

/** Marca: la к cirílica. Toma el color del texto. */
export function BrandMark({ size = 22 }: { size?: number; dot?: number }) {
  return (
    <svg aria-hidden viewBox="0 0 124 100" height={size} width={(size * 124) / 100} fill="currentColor" className="shrink-0 text-fg">
      <path d={K_PATH} />
    </svg>
  );
}

export function Wordmark({ className = "", size = 18 }: { className?: string; size?: number }) {
  return (
    <span
      aria-label="Klavdia"
      className={`font-display font-medium leading-none tracking-[-.01em] whitespace-nowrap ${className}`}
      style={{ fontSize: size }}
    >
      кlavdia
    </span>
  );
}

/** Nombre de pila para saludar: sin título (Dr./Dra./Lic.) ni aclaraciones entre paréntesis. */
export function firstName(fullName: string): string {
  const clean = fullName
    .replace(/\(.*?\)/g, "")
    .replace(/^\s*(dr|dra|lic)\.?\s+/i, "")
    .trim();
  return clean.split(/\s+/)[0] || fullName;
}

/** Saludo según la hora local. */
export function greeting(): string {
  const h = new Date().getHours();
  return h < 13 ? "Buen día" : h < 20 ? "Buenas tardes" : "Buenas noches";
}

export function initials(name: string): string {
  const words = name
    .replace(/^(dr|dra|lic)\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.at(-1)?.[0] ?? "")).toUpperCase();
}

// ---------------------------------------------------------------------------
// Tema claro / oscuro — `data-theme` en <html>, persistido en localStorage.
// El layout lo aplica antes del primer pintado; esto solo lo cambia.
// ---------------------------------------------------------------------------

export type Theme = "dark" | "light";
const THEME_KEY = "clavdia_theme";

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>("dark");
  useEffect(() => {
    const sync = () => setThemeState(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    sync();
  }, []);
  function setTheme(t: Theme) {
    setThemeState(t);
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* ignore */
    }
  }
  return [theme, setTheme];
}

/** Selector segmentado Oscuro / Claro. `compact` = solo íconos. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useTheme();
  const opt = (t: Theme, label: string, Icon: typeof MoonIcon) => (
    <button
      type="button"
      onClick={() => setTheme(t)}
      aria-pressed={theme === t}
      title={label}
      className={`inline-flex items-center gap-1.5 rounded-[6px] transition-colors ${
        compact ? "h-7 w-7 justify-center" : "h-7 px-3"
      } ${theme === t ? "bg-accent-800 text-fg" : "text-neutral-400 hover:text-fg"}`}
    >
      <Icon size={14} />
      {!compact && label}
    </button>
  );
  return (
    <div className="flex rounded-md border border-neutral-800 p-0.5 text-[12.5px]">
      {opt("dark", "Oscuro", MoonIcon)}
      {opt("light", "Claro", SunIcon)}
    </div>
  );
}

/** Pill de estado (borde fino). */
export function Pill({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-pill border border-neutral-800 px-2.5 py-[3px] text-[11.5px] text-neutral-300 ${className}`}
    >
      {children}
    </span>
  );
}

/** Separador degradado que se desvanece 48px en cada punta. */
export function FadeRule() {
  return (
    <div
      aria-hidden
      className="h-px"
      style={{
        background:
          "linear-gradient(to right, transparent, var(--cl-divider) 48px, var(--cl-divider) calc(100% - 48px), transparent)",
      }}
    />
  );
}

/** Minutos transcurridos desde un instante real (UTC ISO), refrescado cada 15 s. `null` si no empezó. */
export function useElapsedMinutes(startedAt?: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 60_000));
}

/** "lleva 12 min" — cuánto lleva una consulta en curso (el tiempo real que después alimenta las estadísticas). */
export function Elapsed({ startedAt, prefix = "lleva " }: { startedAt?: string | null; prefix?: string }) {
  const m = useElapsedMinutes(startedAt);
  if (m === null) return null;
  return <span className="tabular-nums">{m === 0 ? "recién empieza" : `${prefix}${m} min`}</span>;
}
