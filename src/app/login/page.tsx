"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark, ThemeToggle, Wordmark } from "@/app/ui";

// Login recortado de Clavdia (src/app/login/page.tsx): sin altas de pacientes ni consultorios —
// al equipo lo da de alta el admin con `npm run user:create`.

type Screen = "login" | "reset";
type OrgOpt = { id: string; name: string };

const FIELD =
  "w-full rounded-md border border-neutral-800 bg-transparent px-3.5 py-2.5 text-[15px] text-fg placeholder:text-neutral-600 transition-colors focus:border-accent-700 focus:outline-none";
const PRIMARY =
  "w-full rounded-md border border-accent px-4 py-2.5 text-[15px] font-medium text-accent-300 transition-colors hover:bg-accent-900 active:bg-accent-800 disabled:opacity-40";
const CARD = "rounded-2xl bg-surface p-5 shadow-md";
const LINK =
  "text-[13px] font-medium text-muted underline decoration-hairline-strong underline-offset-4 hover:text-ink";

export default function LoginPage() {
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>("login");

  const go = () => {
    router.replace("/");
    router.refresh();
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[460px] flex-col justify-center gap-6 px-6 py-10">
      <header className="flex flex-col gap-6">
        <div className="flex justify-end">
          <ThemeToggle compact />
        </div>
        <div className="flex flex-col items-start gap-4">
          <BrandMark size={44} />
          <div className="flex flex-col gap-2">
            <Wordmark size={34} />
            <p className="text-[14px] text-neutral-400">Stock y ventas del consultorio.</p>
          </div>
        </div>
      </header>

      {screen === "login" && (
        <div className={CARD}>
          <EmailLogin onDone={go} onForgot={() => setScreen("reset")} />
        </div>
      )}

      {screen === "reset" && (
        <div className="space-y-4">
          <button onClick={() => setScreen("login")} className="text-[13px] font-medium text-muted hover:text-ink">
            ← volver
          </button>
          <div className={CARD}>
            <PinReset onDone={go} />
          </div>
        </div>
      )}
    </main>
  );
}

function Err({ msg }: { msg: string }) {
  return msg ? <p className="text-[13px] text-neutral-200">{msg}</p> : null;
}

/** PIN en 4 casillas: avanza solo, soporta pegar y borrar, y avisa al completar el cuarto dígito. */
function PinBoxes({
  value,
  onChange,
  onComplete,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (pin: string) => void;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: 4 }, (_, i) => value[i] ?? "");

  function set(next: string, focusAt: number) {
    onChange(next);
    refs.current[Math.min(focusAt, 3)]?.focus();
    if (next.length === 4) onComplete?.(next);
  }

  return (
    <div className="grid grid-cols-4 gap-2.5">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          disabled={disabled}
          inputMode="numeric"
          autoComplete="off"
          aria-label={`Dígito ${i + 1} del PIN`}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const typed = e.target.value.replace(/\D/g, "");
            if (!typed) return;
            const next = (value.slice(0, i) + typed).slice(0, 4);
            set(next, next.length);
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace") {
              e.preventDefault();
              if (d) set(value.slice(0, i) + value.slice(i + 1), i);
              else if (i > 0) set(value.slice(0, i - 1) + value.slice(i), i - 1);
            }
            if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
            if (e.key === "ArrowRight" && i < 3) refs.current[i + 1]?.focus();
          }}
          className="h-14 w-full rounded-md border border-neutral-800 bg-transparent text-center text-[22px] text-fg transition-colors focus:border-fg focus:outline-none"
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login — DNI o email + PIN, con selector si la persona está en más de un consultorio
// ---------------------------------------------------------------------------

function EmailLogin({ onDone, onForgot }: { onDone: () => void; onForgot: () => void }) {
  const [ident, setIdent] = useState("");
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState<OrgOpt[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(organizationId?: string, pinValue = pin) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: ident.trim(), pin: pinValue, organizationId }),
      });
      const d = await r.json().catch(() => ({ ok: false, error: "Error del servidor. Revisá la consola de `npm run dev`." }));
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo iniciar sesión.");
        setPin("");
        return;
      }
      if (d.needsOrg) {
        setPending(d.organizations);
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <div className="space-y-3">
        <p className="text-[14px] font-medium text-ink">¿En qué consultorio entrás?</p>
        {pending.map((o) => (
          <button
            key={o.id}
            onClick={() => submit(o.id)}
            disabled={busy}
            className="w-full rounded-md border border-hairline px-3.5 py-2.5 text-left text-[15px] transition-colors hover:border-ink"
          >
            {o.name}
          </button>
        ))}
        <Err msg={error} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="block text-[13px] font-medium text-ink">DNI o email</label>
      <input
        autoFocus
        value={ident}
        onChange={(e) => setIdent(e.target.value)}
        placeholder="Tu DNI o email"
        className={FIELD}
      />
      <div className="flex items-baseline justify-between">
        <label className="block text-[13px] font-medium text-ink">PIN</label>
        <button type="button" onClick={onForgot} className={LINK}>
          Me lo olvidé
        </button>
      </div>
      <PinBoxes value={pin} onChange={setPin} onComplete={(v) => ident.trim() && submit(undefined, v)} disabled={busy} />
      <button onClick={() => submit()} disabled={busy || !ident.trim() || pin.length < 4} className={PRIMARY}>
        Entrar
      </button>
      <Err msg={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// PIN recovery — one-time code by email, then a new PIN (también el primer ingreso)
// ---------------------------------------------------------------------------

function PinReset({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<"request" | "confirm">("request");
  const [ident, setIdent] = useState("");
  const channel = "email";
  const [code, setCode] = useState("");
  const [newPin, setNewPin] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const identBody = () => (ident.includes("@") ? { email: ident.trim() } : { dni: ident.trim() });

  async function request() {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const r = await fetch("/api/auth/pin-reset/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...identBody(), channel }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return setError(d.error ?? "No se pudo enviar el código.");
      setMsg(d.message ?? "Si los datos son correctos, te enviamos un código.");
      setPhase("confirm");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/pin-reset/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...identBody(), code: code.trim(), newPin }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return setError(d.error ?? "No se pudo restablecer el PIN.");
      if (d.staff) {
        setPhase("request");
        setCode("");
        setNewPin("");
        setMsg(d.message ?? "PIN actualizado. Iniciá sesión.");
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[14px] font-medium text-ink">Recuperar el PIN</p>
      {phase === "request" ? (
        <>
          <p className="text-[13px] text-muted">
            Ingresá tu email o DNI. Te mandamos un código de un solo uso al email que cargó el consultorio. La
            primera vez que entrás también es por acá: así elegís tu PIN.
          </p>
          <input
            autoFocus
            value={ident}
            onChange={(e) => setIdent(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ident.trim() && request()}
            placeholder="Email o DNI"
            className={FIELD}
          />
          <button onClick={request} disabled={busy || !ident.trim()} className={PRIMARY}>
            Enviar código
          </button>
        </>
      ) : (
        <>
          {msg && <p className="text-[13px] text-muted">{msg}</p>}
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            placeholder="Código de 6 dígitos"
            className={`${FIELD} text-center text-[18px] tracking-[0.3em]`}
          />
          <input
            value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            placeholder="PIN nuevo (4 dígitos)"
            className={`${FIELD} text-center text-[18px] tracking-[0.4em]`}
          />
          <button
            onClick={confirm}
            disabled={busy || code.length !== 6 || newPin.length !== 4}
            className={PRIMARY}
          >
            Cambiar PIN y entrar
          </button>
          <button onClick={() => setPhase("request")} className={LINK}>
            Pedir otro código
          </button>
        </>
      )}
      <Err msg={error} />
    </div>
  );
}
