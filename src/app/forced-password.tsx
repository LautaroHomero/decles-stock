"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AUTH_CARD, AuthFrame, ChangePasswordForm, EmailForm } from "./auth-ui";
import { firstName } from "./ui";

/**
 * Primer ingreso (o después de un reset): elegir la contraseña propia antes de seguir.
 * Si la persona no tiene email, se lo pide (opcional) para poder recuperar la contraseña sola.
 */
export function ForcedPasswordChange({ name }: { name: string }) {
  const router = useRouter();
  const [step, setStep] = useState<"password" | "email">("password");

  async function afterPassword() {
    const d = await fetch("/api/auth/email")
      .then((r) => r.json())
      .catch(() => ({}));
    if (d.ok && !d.email) setStep("email");
    else router.refresh();
  }

  if (step === "email")
    return (
      <AuthFrame subtitle="Listo. Último paso: ¿a qué email te mandamos un código si un día te olvidás la contraseña?">
        <div className={AUTH_CARD}>
          <EmailForm initial="" skipLabel="Ahora no" onDone={() => router.refresh()} />
        </div>
      </AuthFrame>
    );

  return (
    <AuthFrame subtitle={`Hola, ${firstName(name)}. Elegí tu contraseña: la temporal que te dio el admin deja de servir.`}>
      <div className={AUTH_CARD}>
        <ChangePasswordForm forced onDone={afterPassword} />
      </div>
      <button
        onClick={async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          router.replace("/login");
        }}
        className="self-start text-[13px] text-neutral-500 hover:text-fg"
      >
        Salir
      </button>
    </AuthFrame>
  );
}
