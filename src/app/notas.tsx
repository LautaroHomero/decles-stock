"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { MagnifyingGlassIcon, NotePencilIcon, PlusIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { Toast, call, fmtTime, usePoll, useToast } from "./shared";

/** Espejo de `Note` de src/lib/domain/notes.ts. */
export interface Note {
  id: string;
  patient: string;
  visitId: string | null;
  date: string;
  text: string;
  visitWhat: string | null;
  visitProvider: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedByName: string | null;
}

const short = (name: string) => name.replace(/^(Dra?\.|Lic\.)\s*/i, "");
const longDate = (ymd: string) => {
  const s = new Date(`${ymd}T12:00:00`).toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const FIELD =
  "w-full rounded-lg border border-neutral-800 bg-transparent px-3 py-2.5 text-[15px] text-fg outline-none placeholder:text-neutral-500 focus:border-accent-700";

/**
 * Escribir o corregir una nota. Pegada a una atención (`visit`), el paciente y el día son los de la atención;
 * suelta, se escribe el paciente.
 */
export function NoteDialog({
  note,
  visit,
  canDelete,
  onClose,
  onSaved,
}: {
  note?: Note;
  visit?: { visitId: string; patient: string; what: string };
  canDelete?: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [patient, setPatient] = useState(note?.patient ?? visit?.patient ?? "");
  const [text, setText] = useState(note?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const linked = !!(visit || note?.visitId);
  const ok = text.trim() && (linked || patient.trim());

  async function save() {
    if (!ok || busy) return;
    setBusy(true);
    setErr("");
    const r = note
      ? await call(`/api/notes/${note.id}`, "PATCH", { text, patient })
      : await call("/api/notes", "POST", { text, patient, visitId: visit?.visitId });
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "No se pudo guardar.");
    onSaved(note ? "Nota corregida" : "Nota guardada");
  }
  async function remove() {
    if (!note || busy) return;
    setBusy(true);
    const r = await call(`/api/notes/${note.id}`, "DELETE");
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "No se pudo borrar.");
    onSaved("Nota borrada");
  }

  return (
    <div className="cl-fade-in fixed inset-0 z-40 overflow-y-auto bg-black/60 px-4 py-16" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="mx-auto flex w-full max-w-[480px] flex-col gap-4 rounded-xl bg-surface p-5 shadow-lg"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div>
          <h2 className="font-display text-[18px] font-medium tracking-[-.01em]">{note ? "Corregir nota" : "Nueva nota"}</h2>
          {visit && (
            <p className="text-[13px] text-neutral-400">
              {visit.patient || "Sin paciente"} · {visit.what}
            </p>
          )}
          {note?.visitId && !visit && note.visitWhat && (
            <p className="text-[13px] text-neutral-400">
              {note.visitWhat}
              {note.visitProvider ? ` · ${short(note.visitProvider)}` : ""}
            </p>
          )}
        </div>
        {!visit && (
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-neutral-400">Paciente</span>
            <input autoFocus={!patient} value={patient} onChange={(e) => setPatient(e.target.value)} placeholder="Ej. Carla Pérez" className={FIELD} />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-neutral-400">Nota</span>
          <textarea
            autoFocus={!!patient || !!visit}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
            }}
            rows={4}
            placeholder="Ej. Le dio alergia la crema de vitamina C"
            className={`${FIELD} resize-y`}
          />
        </label>
        {err && <p className="text-[13px] text-neutral-200">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={!ok || busy}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-lg border border-accent bg-accent px-4 text-[14px] font-medium text-on-accent transition-opacity hover:opacity-85 disabled:opacity-40"
          >
            {busy ? "Guardando…" : "Guardar"}
          </button>
          <button type="button" onClick={onClose} className="h-11 rounded-lg border border-neutral-800 px-4 text-[14px] text-neutral-300 hover:bg-accent-900">
            Cancelar
          </button>
        </div>
        {note && canDelete && (
          <button type="button" onClick={remove} disabled={busy} className="self-start text-[13px] text-neutral-400 underline-offset-4 hover:text-fg hover:underline">
            Borrar nota
          </button>
        )}
        {note?.updatedByName && <p className="text-[12px] text-neutral-500">Editada por {note.updatedByName}</p>}
      </form>
    </div>
  );
}

/** Las notas de una atención, debajo de lo que pagó (Planilla). */
export function VisitNotes({ notes, onOpen }: { notes: Note[]; onOpen: (n: Note) => void }) {
  if (!notes.length) return null;
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {notes.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(n);
            }}
            className="flex items-start gap-1.5 text-left text-[12.5px] text-neutral-400 hover:text-fg"
          >
            <NotePencilIcon size={13} className="mt-[2px] shrink-0" />
            <span className="whitespace-pre-line">
              {n.text} <span className="text-neutral-500">· {n.createdByName}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Pestaña Notas: todas las notas, de la más nueva a la más vieja, agrupadas por día. Se buscan por paciente o por lo
 * escrito («carla», «alergia»). «+ Nota» escribe una suelta (sin atención).
 */
export function NotasView({ actor }: { actor: Actor }) {
  const [q, setQ] = useState("");
  const dq = useDeferredValue(q.trim());
  const [data, refresh] = usePoll<{ ok: boolean; notes: Note[] }>(`/api/notes${dq ? `?q=${encodeURIComponent(dq)}` : ""}`, 60_000);
  const [toast, showToast] = useToast();
  const [form, setForm] = useState<{ note?: Note } | null>(null);
  const notes = useMemo(() => (data?.ok ? data.notes : []), [data]);
  const byDay = useMemo(() => {
    const m = new Map<string, Note[]>();
    for (const n of notes) m.set(n.date, [...(m.get(n.date) ?? []), n]);
    return [...m.entries()];
  }, [notes]);
  const isAdmin = !!actor.activeOrg?.canAdmin;

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-5 pb-20 pt-8 text-[14px] sm:px-6 sm:pt-12">
      <Toast msg={toast} />
      {form && (
        <NoteDialog
          note={form.note}
          canDelete={!!form.note && (form.note.createdBy === actor.userId || isAdmin)}
          onClose={() => setForm(null)}
          onSaved={(msg) => {
            setForm(null);
            showToast(msg + ".");
            refresh();
          }}
        />
      )}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[24px] font-medium tracking-[-.02em]">Notas</h1>
          <p className="text-[13.5px] text-neutral-400">Lo que se anotó de cada paciente. Se agregan acá o desde la Planilla, en cada atención.</p>
        </div>
        <button
          onClick={() => setForm({})}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-accent bg-accent px-4 text-[14px] font-medium text-on-accent hover:opacity-85"
        >
          <PlusIcon size={14} weight="bold" /> Nota
        </button>
      </header>

      <label className="flex items-center gap-2 rounded-lg border border-neutral-800 px-3 focus-within:border-accent-700">
        <MagnifyingGlassIcon size={16} className="shrink-0 text-neutral-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por paciente o por lo que se escribió"
          className="h-11 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-neutral-500"
        />
        {q && (
          <button onClick={() => setQ("")} className="text-[13px] text-neutral-500 hover:text-fg">
            Borrar
          </button>
        )}
      </label>

      {!data ? (
        <p className="text-neutral-500">Cargando…</p>
      ) : !notes.length ? (
        <p className="text-neutral-500">{dq ? `No hay notas con «${dq}».` : "Todavía no hay notas. Tocá «+ Nota» o agregalas desde la Planilla."}</p>
      ) : (
        <div className="flex flex-col gap-6">
          {dq && <p className="-mt-3 text-[13px] text-neutral-500">{notes.length === 1 ? "1 nota" : `${notes.length} notas`}</p>}
          {byDay.map(([day, list]) => (
            <section key={day} className="flex flex-col gap-2">
              <h2 className="text-[13px] text-neutral-400">{longDate(day)}</h2>
              <ul className="flex flex-col rounded-xl border border-neutral-800">
                {list.map((n) => (
                  <li key={n.id} className="border-t border-neutral-900 first:border-t-0">
                    <button onClick={() => setForm({ note: n })} className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-neutral-900">
                      <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <b className="font-medium">{n.patient || "Sin paciente"}</b>
                        <span className="text-[12.5px] text-neutral-500">
                          {fmtTime(n.createdAt)} · {n.createdByName}
                        </span>
                      </span>
                      {n.visitWhat && (
                        <span className="text-[12.5px] text-neutral-500">
                          {n.visitWhat}
                          {n.visitProvider ? ` · ${short(n.visitProvider)}` : ""}
                        </span>
                      )}
                      <span className="whitespace-pre-line text-[14.5px] text-neutral-200">{n.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {notes.length >= 300 && <p className="text-[13px] text-neutral-500">Se muestran las 300 más nuevas. Buscá para encontrar una más vieja.</p>}
        </div>
      )}
    </div>
  );
}
