"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AUTH_CARD, AUTH_FIELD, AUTH_PRIMARY, AuthFrame, Err, Field, PasswordInput } from "@/app/auth-ui";

/**
 * Primer arranque (base vacía): nombre del consultorio y la cuenta del primer admin.
 * Después de esto la pantalla no vuelve a aparecer; el resto del equipo lo da de alta el admin.
 */
export default function SetupPage() {
  const router = useRouter();
  const [f, setF] = useState({ orgName: "", name: "", username: "", password: "", again: "", email: "", role: "recepcion" as "recepcion" | "medico" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    fetch("/api/setup")
      .then((r) => r.json())
      .then((d) => !d.needsSetup && router.replace("/login"))
      .catch(() => {});
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.password !== f.again) return setError("Las contraseñas no coinciden.");
    setBusy(true);
    setError("");
    const r = await fetch("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(f),
    });
    const d = await r.json().catch(() => ({ ok: false, error: "Error del servidor." }));
    setBusy(false);
    if (!d.ok) return setError(d.error ?? "No se pudo configurar.");
    router.replace("/");
    router.refresh();
  }

  return (
    <AuthFrame subtitle="Primer arranque: configurá el consultorio y tu cuenta de administrador.">
      <form onSubmit={submit} className={`${AUTH_CARD} space-y-3`}>
        <Field label="Nombre del consultorio">
          <input autoFocus value={f.orgName} onChange={set("orgName")} placeholder="Consultorio Decles" className={AUTH_FIELD} />
        </Field>
        <Field label="Tu nombre">
          <input value={f.name} onChange={set("name")} className={AUTH_FIELD} />
        </Field>
        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium">Tu rol</span>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["recepcion", "Secretaría"],
                ["medico", "Médica/o"],
              ] as const
            ).map(([id, label]) => (
              <button
                type="button"
                key={id}
                onClick={() => setF({ ...f, role: id })}
                className={`rounded-md border px-3 py-2 text-[14px] transition-colors ${
                  f.role === id ? "border-accent bg-accent-900 text-accent-200" : "border-neutral-800 text-neutral-300 hover:border-accent-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <Field label="Usuario" hint="Con esto entrás. Minúsculas, sin espacios.">
          <input value={f.username} onChange={set("username")} autoCapitalize="none" spellCheck={false} placeholder="ej. admin" className={AUTH_FIELD} />
        </Field>
        <Field label="Tu email (opcional)" hint="Para recuperar la contraseña si te la olvidás.">
          <input type="email" value={f.email} onChange={set("email")} autoCapitalize="none" spellCheck={false} placeholder="nombre@gmail.com" className={AUTH_FIELD} />
        </Field>
        <Field label="Contraseña" hint="Al menos 8 caracteres.">
          <PasswordInput value={f.password} onChange={(v) => setF({ ...f, password: v })} autoComplete="new-password" />
        </Field>
        <Field label="Repetila">
          <PasswordInput value={f.again} onChange={(v) => setF({ ...f, again: v })} autoComplete="new-password" />
        </Field>
        <button
          type="submit"
          disabled={busy || !f.orgName.trim() || !f.name.trim() || !f.username.trim() || f.password.length < 8}
          className={AUTH_PRIMARY}
        >
          {busy ? "Configurando…" : "Crear y entrar"}
        </button>
        <Err msg={error} />
      </form>
    </AuthFrame>
  );
}
