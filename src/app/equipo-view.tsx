"use client";

import { useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { Pill } from "./ui";
import { BTN, BTN_DARK, CARD, FIELD, Toast, call, usePoll, useToast } from "./shared";

interface Member {
  userId: string;
  name: string;
  username: string;
  role: "medico" | "recepcion";
  isAdmin: boolean;
  active: boolean;
  mustChangePassword: boolean;
  commissionPct: number;
  aliases: string[];
  email: string;
}

const ROLE = { medico: "Médica/o", recepcion: "Secretaría" } as const;

/**
 * Equipo (solo admin): alta de médicas y secretarias, baja/reactivación, admin,
 * % de comisión y reset de contraseña. La contraseña temporal se muestra una sola vez.
 */
export function EquipoView({ actor }: { actor: Actor }) {
  const [data, refresh] = usePoll<{ ok: boolean; members: Member[] }>("/api/team", 60_000);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ name: string; username: string; password: string } | null>(null);
  const [toast, showToast] = useToast();

  const members = data?.members ?? [];
  const active = members.filter((m) => m.active);
  const inactive = members.filter((m) => !m.active);

  async function patch(m: Member, body: object, ok: string) {
    const r = await call(`/api/team/${m.userId}`, "PATCH", body);
    if (!r.ok) return showToast(r.error ?? "No se pudo guardar.");
    showToast(ok);
    setEditing(null);
    refresh();
  }

  async function reset(m: Member) {
    const r = await call(`/api/team/${m.userId}/reset-password`, "POST");
    if (!r.ok) return showToast(r.error ?? "No se pudo resetear.");
    setSecret({ name: m.name, username: String(r.username), password: String(r.temporaryPassword) });
    refresh();
  }

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <Toast msg={toast} />
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <h1 className="font-display text-[22px] font-medium tracking-[-.01em]">Equipo</h1>
          <p className="text-[13px] text-neutral-400">Quién entra al sistema y cuánto cobra cada médica por venta.</p>
        </div>
        <span className="flex-1" />
        <button className={`${BTN_DARK} inline-flex items-center gap-1`} onClick={() => setCreating(true)}>
          <PlusIcon size={13} /> Agregar persona
        </button>
      </div>

      {secret && <SecretCard {...secret} onClose={() => setSecret(null)} />}

      {creating && (
        <NewMemberForm
          onCancel={() => setCreating(false)}
          onCreated={(name, username, password) => {
            setCreating(false);
            setSecret({ name, username, password });
            refresh();
          }}
          onError={showToast}
        />
      )}

      {!data ? (
        <p className="text-[13px] text-neutral-500">Cargando…</p>
      ) : (
        <div className="flex flex-col gap-2">
          {active.map((m) => (
            <MemberRow
              key={m.userId}
              m={m}
              self={m.userId === actor.userId}
              editing={editing === m.userId}
              onEdit={() => setEditing(editing === m.userId ? null : m.userId)}
              onSave={(body) => patch(m, body, "Guardado.")}
              onReset={() => reset(m)}
              onDeactivate={() => patch(m, { active: false }, `${m.name} quedó dada/o de baja. Ya no puede entrar.`)}
            />
          ))}
          {inactive.length > 0 && (
            <>
              <h2 className="mt-4 text-[11px] uppercase tracking-[.08em] text-neutral-500">Dados de baja</h2>
              {inactive.map((m) => (
                <div key={m.userId} className="flex items-center gap-3 rounded-xl bg-surface px-4 py-3 opacity-60 shadow-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px]">{m.name}</span>
                    <span className="text-[12.5px] text-neutral-400">
                      {ROLE[m.role]} · {m.username}
                    </span>
                  </span>
                  <button className={BTN} onClick={() => patch(m, { active: true }, `${m.name} reactivada/o.`)}>
                    Reactivar
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MemberRow({
  m,
  self,
  editing,
  onEdit,
  onSave,
  onReset,
  onDeactivate,
}: {
  m: Member;
  self: boolean;
  editing: boolean;
  onEdit: () => void;
  onSave: (body: object) => void;
  onReset: () => void;
  onDeactivate: () => void;
}) {
  const [name, setName] = useState(m.name);
  const [pct, setPct] = useState(String(m.commissionPct));
  const [aliases, setAliases] = useState(m.aliases.join(", "));
  const [email, setEmail] = useState(m.email);
  const [admin, setAdmin] = useState(m.isAdmin);
  const [confirmOff, setConfirmOff] = useState(false);

  return (
    <div className="overflow-hidden rounded-xl bg-surface shadow-sm">
      <button onClick={onEdit} aria-expanded={editing} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent-900">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14.5px] font-medium">{m.name}</span>
            {self && <span className="text-[12px] text-neutral-500">(vos)</span>}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-neutral-400">
            <span>{ROLE[m.role]}</span>
            <span>· {m.username}</span>
            {m.isAdmin && <Pill className="!py-0 !text-[11px]">admin</Pill>}
            {m.mustChangePassword && <Pill className="!py-0 !text-[11px]">contraseña temporal</Pill>}
            {!m.email && <Pill className="!py-0 !text-[11px]">sin email</Pill>}
          </span>
        </span>
        {m.role === "medico" && <span className="text-[14px] tabular-nums text-neutral-300">{m.commissionPct}%</span>}
      </button>

      {editing && (
        <div className="flex animate-cl-in flex-col gap-3 border-t border-neutral-800 px-4 py-3.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-neutral-400">Nombre</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className={FIELD} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-neutral-400">Email (para recuperar la contraseña)</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" placeholder="opcional" className={FIELD} />
            </label>
            {m.role === "medico" && (
              <label className="flex flex-col gap-1">
                <span className="text-[12px] text-neutral-400">Comisión (%) · salvo que la práctica o el producto tenga la suya</span>
                <input value={pct} onChange={(e) => setPct(e.target.value.replace(/[^\d.,]/g, ""))} inputMode="decimal" className={FIELD} />
              </label>
            )}
            {m.role === "medico" && (
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-[12px] text-neutral-400">Apodos (para la hoja de ventas, separados por coma)</span>
                <input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Ej. pili, pilu" className={FIELD} />
                <span className="text-[11.5px] text-neutral-500">Los diminutivos comunes («lau», «laurita») ya se entienden solos.</span>
              </label>
            )}
          </div>
          <label className={`flex items-center gap-2 text-[13px] ${self ? "opacity-50" : ""}`}>
            <input type="checkbox" checked={admin} disabled={self} onChange={(e) => setAdmin(e.target.checked)} />
            Es admin (carga stock y precios, gestiona el equipo, anula ventas)
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className={BTN_DARK}
              onClick={() =>
                onSave({
                  name,
                  email,
                  isAdmin: admin,
                  ...(m.role === "medico" ? { commissionPct: Number(pct.replace(",", ".")), aliases } : {}),
                })
              }
            >
              Guardar
            </button>
            <button className={BTN} onClick={onReset}>
              Resetear contraseña
            </button>
            <span className="flex-1" />
            {!self &&
              (confirmOff ? (
                <>
                  <span className="self-center text-[12.5px] text-neutral-400">¿Seguro? No va a poder entrar más.</span>
                  <button className={BTN_DARK} onClick={onDeactivate}>
                    Sí, dar de baja
                  </button>
                  <button className={BTN} onClick={() => setConfirmOff(false)}>
                    No
                  </button>
                </>
              ) : (
                <button className={BTN} onClick={() => setConfirmOff(true)}>
                  Dar de baja
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NewMemberForm({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void;
  onCreated: (name: string, username: string, password: string) => void;
  onError: (m: string) => void;
}) {
  const [f, setF] = useState({ name: "", username: "", role: "medico" as "medico" | "recepcion", pct: "", email: "", isAdmin: false });
  const [busy, setBusy] = useState(false);
  const suggest = (name: string) =>
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/^(dra?|lic)\.?\s+/, "")
      .trim()
      .split(/\s+/)[0]
      ?.replace(/[^a-z0-9]/g, "") ?? "";

  async function submit() {
    setBusy(true);
    const r = await call("/api/team", "POST", {
      name: f.name,
      username: f.username,
      role: f.role,
      isAdmin: f.isAdmin,
      email: f.email,
      commissionPct: f.role === "medico" ? Number(f.pct.replace(",", ".") || 0) : undefined,
    });
    setBusy(false);
    if (!r.ok) return onError(r.error ?? "No se pudo crear.");
    onCreated(f.name, String(r.username), String(r.temporaryPassword));
  }

  return (
    <div className={CARD}>
      <p className="text-[14px] font-medium">Agregar persona</p>
      <div className="grid grid-cols-2 gap-2">
        {(["medico", "recepcion"] as const).map((r) => (
          <button
            key={r}
            onClick={() => setF({ ...f, role: r })}
            className={`rounded-md border px-3 py-2 text-[13.5px] transition-colors ${
              f.role === r ? "border-accent bg-accent-900 text-accent-200" : "border-neutral-800 text-neutral-300 hover:border-accent-700"
            }`}
          >
            {ROLE[r]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">Nombre y apellido</span>
          <input
            autoFocus
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value, username: f.username && f.username !== suggest(f.name) ? f.username : suggest(e.target.value) })}
            placeholder={f.role === "medico" ? "Dra. Laura Pérez" : "Sofía Gómez"}
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">Usuario (para entrar)</span>
          <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase().replace(/\s/g, "") })} autoCapitalize="none" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">Email (opcional)</span>
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoCapitalize="none" placeholder="Para recuperar la contraseña" className={FIELD} />
        </label>
        {f.role === "medico" && (
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-neutral-400">Comisión (%) · salvo que la práctica o el producto tenga la suya</span>
            <input value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value.replace(/[^\d.,]/g, "") })} inputMode="decimal" placeholder="Ej. 10" className={FIELD} />
          </label>
        )}
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={f.isAdmin} onChange={(e) => setF({ ...f, isAdmin: e.target.checked })} />
        Es admin
      </label>
      <div className="flex gap-2">
        <button className={BTN_DARK} disabled={busy || !f.name.trim() || f.username.length < 3} onClick={submit}>
          Crear
        </button>
        <button className={BTN} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

function SecretCard({ name, username, password, onClose }: { name: string; username: string; password: string; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-accent-700 bg-surface p-5 shadow-md">
      <p className="text-[14px] font-medium">Pasale estos datos a {name}</p>
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[14px]">
        <span className="text-neutral-400">Usuario</span>
        <span className="font-mono">{username}</span>
        <span className="text-neutral-400">Contraseña temporal</span>
        <span className="font-mono text-[16px] tracking-wide">{password}</span>
      </div>
      <p className="text-[12.5px] text-neutral-400">
        Se muestra una sola vez. Al entrar va a tener que elegir su propia contraseña; vos no la vas a poder ver.
      </p>
      <button className={`${BTN} self-start`} onClick={onClose}>
        Listo, ya la anoté
      </button>
    </div>
  );
}
