"use client";

import { useState } from "react";
import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { BrandMark, ThemeToggle, Wordmark } from "./ui";

// Piezas compartidas por login, primer arranque y cambio de contraseña (estética del login de Clavdia).

export const AUTH_FIELD =
  "w-full rounded-2xl border-2 border-neutral-800 bg-bg px-4 py-3 text-[14px] text-fg placeholder:text-neutral-600 transition-colors focus:border-accent-600 focus:outline-none";
export const AUTH_PRIMARY =
  "w-full min-h-12 rounded-2xl bg-accent px-4 text-[14px] font-bold text-on-accent transition-[filter,opacity] hover:brightness-105 active:opacity-85 disabled:opacity-40";
export const AUTH_CARD = "rounded-3xl border-2 border-neutral-800 bg-surface p-6";

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[13px] font-semibold text-fg">{label}</span>
      {children}
      {hint && <span className="block text-[13.5px] text-neutral-400">{hint}</span>}
    </label>
  );
}

export function Err({ msg }: { msg: string }) {
  return msg ? (
    <p role="alert" className="text-[13px] text-accent-300">
      {msg}
    </p>
  ) : null;
}

export function PasswordInput({
  value,
  onChange,
  autoComplete,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? "text" : "password"}
        value={value}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className={`${AUTH_FIELD} pr-11`}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
        className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-md text-neutral-500 hover:text-fg"
      >
        {show ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
      </button>
    </div>
  );
}

/** Cambio de contraseña. `forced`: entró con una temporal y no puede seguir sin cambiarla. */
export function ChangePasswordForm({ forced, onDone }: { forced?: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== again) return setError("Las dos contraseñas nuevas no coinciden.");
    setBusy(true);
    setError("");
    const r = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current, next }),
    });
    const d = await r.json().catch(() => ({ ok: false, error: "Error del servidor." }));
    setBusy(false);
    if (!d.ok) return setError(d.error ?? "No se pudo cambiar.");
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label={forced ? "Contraseña temporal (la que te dio el admin)" : "Contraseña actual"}>
        <PasswordInput value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
      </Field>
      <Field label="Contraseña nueva" hint="Al menos 8 caracteres. Solo la sabés vos.">
        <PasswordInput value={next} onChange={setNext} autoComplete="new-password" />
      </Field>
      <Field label="Repetila">
        <PasswordInput value={again} onChange={setAgain} autoComplete="new-password" />
      </Field>
      <button type="submit" disabled={busy || !current || next.length < 8 || !again} className={AUTH_PRIMARY}>
        {busy ? "Guardando…" : "Guardar contraseña"}
      </button>
      <Err msg={error} />
    </form>
  );
}

/** Marco de las pantallas sin sesión (login, primer arranque, contraseña obligatoria). */
export function AuthFrame({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[480px] flex-col justify-center gap-7 px-6 py-10 text-[14px]">
      <header className="flex flex-col gap-6">
        <div className="flex justify-end">
          <ThemeToggle compact />
        </div>
        <div className="flex flex-col items-start gap-4">
          <BrandMark size={44} />
          <div className="flex flex-col gap-2">
            <Wordmark size={34} />
            <p className="text-[14px] leading-snug text-neutral-300">{subtitle}</p>
          </div>
        </div>
      </header>
      {children}
    </main>
  );
}

/** Email propio para recuperar la contraseña. Vacío = borrarlo. */
export function EmailForm({ initial, onDone, skipLabel }: { initial: string; onDone: (email: string) => void; skipLabel?: string }) {
  const [email, setEmail] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const r = await fetch("/api/auth/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
    const d = await r.json().catch(() => ({ ok: false, error: "Error del servidor." }));
    setBusy(false);
    if (!d.ok) return setError(d.error ?? "No se pudo guardar.");
    onDone(d.email ?? "");
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Tu email" hint="Si un día te olvidás la contraseña, te llega un código acá. Nadie más lo ve.">
        <input
          type="email"
          autoFocus
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="nombre@gmail.com"
          className={AUTH_FIELD}
        />
      </Field>
      <button type="submit" disabled={busy || (!email.trim() && !initial)} className={AUTH_PRIMARY}>
        {busy ? "Guardando…" : email.trim() || !initial ? "Guardar email" : "Borrar email"}
      </button>
      {skipLabel && (
        <button type="button" onClick={() => onDone(initial)} className="w-full text-center text-[13px] text-neutral-500 hover:text-fg">
          {skipLabel}
        </button>
      )}
      <Err msg={error} />
    </form>
  );
}
