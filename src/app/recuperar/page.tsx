"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AUTH_CARD, AUTH_FIELD, AUTH_PRIMARY, AuthFrame, Err, Field, PasswordInput } from "@/app/auth-ui";

const RESEND_SECONDS = 60;

async function post(url: string, body: object): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return await r.json().catch(() => ({ ok: false, error: "Error del servidor." }));
  } catch {
    return { ok: false, error: "No se pudo conectar." };
  }
}

/** "¿Te olvidaste la contraseña?": usuario o email → código de 6 dígitos por mail → contraseña nueva. */
export default function RecoverPage() {
  const router = useRouter();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [step, setStep] = useState<"ask" | "code">("ask");
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    fetch("/api/auth/forgot")
      .then((r) => r.json())
      .then((d) => setEnabled(!!d.enabled))
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    const d = await post("/api/auth/forgot", { identifier: identifier.trim() });
    setBusy(false);
    if (!d.ok) return setError(d.error ?? "No se pudo mandar el código.");
    setStep("code");
    setWait(RESEND_SECONDS);
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (password !== again) return setError("Las dos contraseñas no coinciden.");
    setBusy(true);
    setError("");
    const d = await post("/api/auth/forgot/confirm", { identifier: identifier.trim(), code, password });
    setBusy(false);
    if (!d.ok) return setError(d.error ?? "No se pudo cambiar la contraseña.");
    router.replace("/");
    router.refresh();
  }

  const back = (
    <Link href="/login" className="self-start text-[13px] text-neutral-500 hover:text-fg">
      ← Volver a entrar
    </Link>
  );

  if (enabled === false)
    return (
      <AuthFrame subtitle="Recuperar la contraseña.">
        <div className={`${AUTH_CARD} space-y-2 text-[14px]`}>
          <p>La recuperación por email todavía no está activada en este consultorio.</p>
          <p className="text-neutral-400">Pedile a un admin que te resetee la contraseña desde Equipo: te da una temporal y elegís la tuya al entrar.</p>
        </div>
        {back}
      </AuthFrame>
    );

  if (step === "ask")
    return (
      <AuthFrame subtitle="Te mandamos un código a tu email para que elijas una contraseña nueva.">
        <form onSubmit={sendCode} className={`${AUTH_CARD} space-y-3`}>
          <Field label="Tu usuario o tu email">
            <input
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              className={AUTH_FIELD}
            />
          </Field>
          <button type="submit" disabled={busy || !identifier.trim() || enabled === null} className={AUTH_PRIMARY}>
            {busy ? "Mandando…" : "Mandarme el código"}
          </button>
          <Err msg={error} />
        </form>
        {back}
      </AuthFrame>
    );

  return (
    <AuthFrame subtitle="Si el usuario existe y tiene email cargado, te llegó un código de 6 dígitos. Revisá también spam.">
      <form onSubmit={confirm} className={`${AUTH_CARD} space-y-3`}>
        <Field label="Código">
          <input
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="000000"
            className={`${AUTH_FIELD} font-mono text-[20px] tracking-[.35em]`}
          />
        </Field>
        <Field label="Contraseña nueva" hint="Al menos 8 caracteres.">
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" />
        </Field>
        <Field label="Repetila">
          <PasswordInput value={again} onChange={setAgain} autoComplete="new-password" />
        </Field>
        <button type="submit" disabled={busy || code.length !== 6 || password.length < 8 || !again} className={AUTH_PRIMARY}>
          {busy ? "Guardando…" : "Guardar y entrar"}
        </button>
        <Err msg={error} />
        <div className="flex items-center justify-between pt-1 text-[13px] text-neutral-500">
          <button type="button" disabled={wait > 0 || busy} onClick={() => sendCode()} className="hover:text-fg disabled:opacity-50 disabled:hover:text-neutral-500">
            {wait > 0 ? `Reenviar en ${wait} s` : "Reenviar código"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep("ask");
              setCode("");
              setError("");
            }}
            className="hover:text-fg"
          >
            Cambiar usuario
          </button>
        </div>
      </form>
      <p className="text-[12.5px] text-neutral-500">
        ¿No te llega? Puede que no tengas email cargado: pedile a un admin que te resetee la contraseña desde Equipo.
      </p>
      {back}
    </AuthFrame>
  );
}
