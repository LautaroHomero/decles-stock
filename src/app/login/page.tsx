"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AUTH_CARD, AUTH_FIELD, AUTH_PRIMARY, AuthFrame, Err, Field, PasswordInput } from "@/app/auth-ui";

/** Usuario + contraseña. Si la base está vacía, manda al primer arranque. */
export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/setup")
      .then((r) => r.json())
      .then((d) => d.needsSetup && router.replace("/setup"))
      .catch(() => {});
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const d = await r.json().catch(() => ({ ok: false, error: "Error del servidor. Revisá la consola de `npm run dev`." }));
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo iniciar sesión.");
        setPassword("");
        return;
      }
      router.replace("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame subtitle="Stock y ventas del consultorio.">
      <form onSubmit={submit} className={`${AUTH_CARD} space-y-3`}>
        <Field label="Usuario">
          <input
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={AUTH_FIELD}
          />
        </Field>
        <Field label="Contraseña">
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        <button type="submit" disabled={busy || !username.trim() || !password} className={AUTH_PRIMARY}>
          {busy ? "Entrando…" : "Entrar"}
        </button>
        <Err msg={error} />
      </form>
      <Link href="/recuperar" className="self-start text-[13px] text-neutral-500 hover:text-fg">
        ¿Te olvidaste la contraseña?
      </Link>
    </AuthFrame>
  );
}
