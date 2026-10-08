"use client";

import { useRouter } from "next/navigation";
import { AUTH_CARD, AuthFrame, ChangePasswordForm } from "./auth-ui";
import { firstName } from "./ui";

/** Primer ingreso (o después de un reset): elegir la contraseña propia antes de seguir. */
export function ForcedPasswordChange({ name }: { name: string }) {
  const router = useRouter();
  return (
    <AuthFrame subtitle={`Hola, ${firstName(name)}. Elegí tu contraseña: la temporal que te dio el admin deja de servir.`}>
      <div className={AUTH_CARD}>
        <ChangePasswordForm forced onDone={() => router.refresh()} />
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
