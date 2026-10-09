"use client";

import { useState } from "react";
import { CheckIcon, CaretDownIcon } from "@phosphor-icons/react";
import { BTN, BTN_DARK, call, usePoll } from "./shared";
import { EmailForm } from "./auth-ui";

type StepId = "email" | "practicas" | "productos" | "stock" | "medicas" | "secretaria" | "venta";
type Section = "vender" | "cierre" | "inventario" | "ventas" | "equipo";

const STEPS: Record<StepId, { title: string; body: string; cta?: string; go?: Section }> = {
  email: {
    title: "Cargá tu email",
    body: "Si un día te olvidás la contraseña, te llega un código a este mail para elegir una nueva.",
  },
  practicas: {
    title: "Cargá las prácticas",
    body: "Atención, peeling, limpieza… con su precio en efectivo/transferencia y con tarjeta. Cuentan para la comisión de cada médica.",
    cta: "Ir a Stock",
    go: "inventario",
  },
  productos: {
    title: "Cargá los productos que venden",
    body: "Nombre, precio en efectivo/transferencia y precio con tarjeta. Si es el mismo, dejá el de tarjeta vacío.",
    cta: "Ir a Stock",
    go: "inventario",
  },
  stock: {
    title: "Ingresá cuánto hay y cuándo vence",
    body: "Por cada producto, la cantidad y la fecha de vencimiento de cada lote. Con eso las médicas y los admins reciben el aviso antes de que algo venza.",
    cta: "Ir a Stock",
    go: "inventario",
  },
  medicas: {
    title: "Sumá a las médicas",
    body: "Con su usuario, su email y su % de comisión (se calcula sobre el precio en efectivo). Les pasás la contraseña temporal y la cambian al entrar.",
    cta: "Ir a Equipo",
    go: "equipo",
  },
  secretaria: {
    title: "Sumá a la secretaría",
    body: "Con su usuario y su email. Solo ve la pantalla de venta: nombre y precio de cada producto. Nada de stock ni vencimientos.",
    cta: "Ir a Equipo",
    go: "equipo",
  },
  venta: {
    title: "Anotá algo de prueba",
    body: "Escribí, por ejemplo, «María López, la atendió Laura, atención» o «laura vendió 2 cremas con tarjeta». Después lo podés anular desde Ventas.",
    cta: "Ir a Anotar",
    go: "vender",
  },
};

/**
 * "Primeros pasos" del admin. Cada paso se tilda solo cuando el dato existe (no hay que
 * marcar nada). Se puede ocultar y volver a abrir desde el menú de la cuenta.
 */
export function Onboarding({ go, reloadKey }: { go: (s: Section) => void; reloadKey: number }) {
  const [data, refresh] = usePoll<{ ok: boolean; done: boolean; steps: { id: StepId; done: boolean }[] }>(
    `/api/onboarding?k=${reloadKey}`,
    15_000,
  );
  const [roles, setRoles] = useState(false);
  if (!data?.ok || data.done) return null;

  const total = data.steps.length;
  const ready = data.steps.filter((s) => s.done).length;
  const next = data.steps.find((s) => !s.done)?.id;
  const finished = ready === total;

  async function close() {
    await call("/api/onboarding", "POST", { done: true });
    refresh();
  }

  return (
    <section className="mx-auto mt-6 w-full max-w-[880px] px-4 sm:px-6">
      <div className="flex flex-col gap-4 rounded-2xl bg-surface p-5 shadow-md">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-[240px] flex-1 flex-col gap-1">
            <span className="text-[11px] uppercase tracking-[.08em] text-neutral-500">
              Primeros pasos · {ready} de {total}
            </span>
            <h2 className="font-display text-[19px] font-medium tracking-[-.01em]">
              {finished ? "¡Listo! El consultorio ya puede usarlo." : "Dejemos el consultorio listo para vender"}
            </h2>
            <p className="text-[13px] text-neutral-400">
              {finished
                ? "Cada persona entra con su usuario. Las ventas, comisiones y avisos de vencimiento ya funcionan solos."
                : "Siete pasos cortos. Cada uno se tilda solo cuando lo hacés."}
            </p>
          </div>
          <button className={finished ? BTN_DARK : BTN} onClick={close}>
            {finished ? "Cerrar" : "Ocultar"}
          </button>
        </div>

        <div className="h-1 overflow-hidden rounded-full bg-neutral-800" aria-hidden>
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(ready / total) * 100}%` }} />
        </div>

        <ol className="flex flex-col">
          {data.steps.map((s, i) => {
            const step = STEPS[s.id];
            const current = s.id === next;
            return (
              <li key={s.id} className="flex gap-3 border-t border-neutral-900 py-3 first:border-0">
                <span
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[12px] tabular-nums ${
                    s.done ? "border-accent bg-accent text-on-accent" : current ? "border-accent text-fg" : "border-neutral-700 text-neutral-500"
                  }`}
                >
                  {s.done ? <CheckIcon size={13} weight="bold" /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[14.5px] ${s.done ? "text-neutral-500 line-through decoration-neutral-700" : "font-medium"}`}>
                    {step.title}
                  </span>
                  {current && s.id !== "email" && <span className="mt-0.5 block text-[13px] leading-snug text-neutral-400">{step.body}</span>}
                  {current && s.id === "email" && (
                    <span className="mt-3 block max-w-[360px]">
                      <EmailForm initial="" onDone={refresh} />
                    </span>
                  )}
                </span>
                {!s.done && step.go && (
                  <button className={current ? BTN_DARK : BTN} onClick={() => go(step.go!)}>
                    {step.cta}
                  </button>
                )}
              </li>
            );
          })}
        </ol>

        <button onClick={() => setRoles((r) => !r)} className="flex items-center gap-1.5 self-start text-[12.5px] text-neutral-400 hover:text-fg">
          ¿Quién ve qué?
          <CaretDownIcon size={12} className={`transition-transform ${roles ? "rotate-180" : ""}`} />
        </button>
        {roles && (
          <dl className="grid animate-cl-in grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[auto_1fr]">
            <dt className="font-medium">Secretaría</dt>
            <dd className="text-neutral-400">Vende: elige o escribe quién vendió y, si quiere, cómo pagó. Ve nombre y precio, nada más.</dd>
            <dt className="font-medium">Médicas</dt>
            <dd className="text-neutral-400">Venden a su nombre, ven el stock y su comisión, y reciben en la campanita los vencimientos y el stock bajo.</dd>
            <dt className="font-medium">Admin</dt>
            <dd className="text-neutral-400">
              Todo lo anterior (también la campanita), más: productos y precios, stock, equipo y comisiones, y anular ventas. Puede haber más de uno.
            </dd>
          </dl>
        )}
      </div>
    </section>
  );
}
