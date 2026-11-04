"use client";

import { useState } from "react";
import { call, money, usePoll, AddButton, type CatalogResponse } from "./shared";

interface Insurer {
  id: string;
  name: string;
  fee: number;
  /** Valor por práctica: item_id → monto. */
  fees: Record<string, number>;
  active: boolean;
}

const INPUT =
  "rounded-md border border-neutral-800 bg-transparent px-2.5 py-1.5 text-[13.5px] text-fg outline-none placeholder:text-neutral-600 focus:border-accent-700";

/**
 * Obras sociales y prepagas (OSMECON…): cuánto se lleva la profesional según la práctica. Al anotar «por osmecon»
 * no entra plata y la profesional suma el valor de cada práctica (sin valor propio: el general). Cambiar montos no
 * toca lo ya anotado.
 */
export function ObrasSociales({ showToast }: { showToast: (m: string) => void }) {
  const [data, refresh] = usePoll<{ ok: boolean; insurers: Insurer[] }>("/api/insurers", 120_000);
  const list = data?.ok ? data.insurers : [];
  const [name, setName] = useState("");
  const [fee, setFee] = useState("");
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [catalog] = usePoll<CatalogResponse>("/api/catalog", 120_000);
  const practices = catalog?.practices ?? [];

  async function add() {
    const r = await call("/api/insurers", "POST", { name, fee: Number(fee || 0) });
    if (!r.ok) return showToast(r.error ?? "No se pudo guardar.");
    showToast(`${name.trim()} agregada.`);
    setName("");
    setFee("");
    setAdding(false);
    refresh();
  }
  async function patch(i: Insurer, body: object, msg: string) {
    const r = await call(`/api/insurers/${i.id}`, "PATCH", body);
    if (!r.ok) return showToast(r.error ?? "No se pudo guardar.");
    showToast(msg);
    setEdit((e) => {
      const { [i.id]: _, ...rest } = e;
      void _;
      return rest;
    });
    refresh();
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-medium">Obras sociales y prepagas</h2>
          <p className="text-[13px] text-neutral-400">
            Por estas no entra plata: la profesional que atiende se lleva el valor de cada práctica. Las prácticas sin valor propio usan el general.
          </p>
        </div>
        {!adding && (
          <AddButton onClick={() => setAdding(true)}>Obra social</AddButton>
        )}
      </div>
      <ul className="flex flex-col rounded-xl border border-neutral-800">
        {list.map((i) => (
          <li key={i.id} className={`flex flex-wrap items-center gap-3 border-t border-neutral-900 px-4 py-2.5 first:border-0 ${i.active ? "" : "opacity-50"}`}>
            <b className="min-w-[120px] flex-1 font-medium">{i.name}</b>
            <span className="text-[13px] text-neutral-400">la profesional se lleva</span>
            <input
              value={edit[i.id] !== undefined ? (edit[i.id] ? `$ ${Number(edit[i.id]).toLocaleString("es-AR")}` : "") : money(i.fee)}
              onChange={(e) => setEdit({ ...edit, [i.id]: e.target.value.replace(/\D/g, "") })}
              onBlur={() => edit[i.id] !== undefined && Number(edit[i.id] || 0) !== i.fee && patch(i, { fee: Number(edit[i.id] || 0) }, `${i.name}: ${money(Number(edit[i.id] || 0))} general.`)}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              inputMode="numeric"
              disabled={!i.active}
              className={`${INPUT} w-[120px] text-right tabular-nums`}
            />
            <span className="text-[13px] text-neutral-400">general</span>
            {i.active && (
              <button
                onClick={() => setOpen(open === i.id ? null : i.id)}
                className="text-[12.5px] text-neutral-400 underline-offset-2 hover:text-fg hover:underline"
              >
                {open === i.id ? "cerrar" : `por práctica${Object.keys(i.fees ?? {}).length ? ` (${Object.keys(i.fees).length})` : ""}`}
              </button>
            )}
            <button
              onClick={() => patch(i, { active: !i.active }, i.active ? `${i.name} dada de baja.` : `${i.name} activa.`)}
              className="text-[12.5px] text-neutral-500 underline-offset-2 hover:text-fg hover:underline"
            >
              {i.active ? "dar de baja" : "reactivar"}
            </button>
            {open === i.id && (
              <ul className="flex w-full flex-col gap-1.5 pt-1">
                {practices.map((p) => {
                  const k = `${i.id}:${p.id}`;
                  const cur = i.fees?.[p.id];
                  const val = edit[k] !== undefined ? edit[k] : cur !== undefined ? String(cur) : "";
                  const save = () => {
                    if (edit[k] === undefined) return;
                    const next = edit[k] === "" ? null : Number(edit[k]);
                    if (next === (cur ?? null)) return;
                    void patch(
                      i,
                      { practice: { itemId: p.id, fee: next } },
                      next === null ? `${p.name}: vuelve al general (${money(i.fee)}).` : `${i.name} · ${p.name}: ${money(next)}.`,
                    ).then(() => setEdit((e) => {
                      const { [k]: _, ...rest } = e;
                      void _;
                      return rest;
                    }));
                  };
                  return (
                    <li key={p.id} className="flex items-center gap-3 pl-1">
                      <span className="flex-1 text-[13.5px]">{p.name}</span>
                      <input
                        value={val ? `$ ${Number(val).toLocaleString("es-AR")}` : ""}
                        onChange={(e) => setEdit({ ...edit, [k]: e.target.value.replace(/\D/g, "") })}
                        onBlur={save}
                        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                        inputMode="numeric"
                        placeholder={money(i.fee)}
                        className={`${INPUT} w-[120px] text-right tabular-nums`}
                      />
                    </li>
                  );
                })}
                {!practices.length && <li className="text-[13px] text-neutral-500">No hay prácticas en la lista de precios.</li>}
              </ul>
            )}
          </li>
        ))}
        {!list.length && !adding && <li className="px-4 py-3 text-[13.5px] text-neutral-500">No hay ninguna cargada.</li>}
        {adding && (
          <li className="flex flex-wrap items-center gap-3 border-t border-neutral-900 px-4 py-2.5 first:border-0">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre (ej. OSMECON)" className={`${INPUT} min-w-[160px] flex-1`} />
            <input
              value={fee ? `$ ${Number(fee).toLocaleString("es-AR")}` : ""}
              onChange={(e) => setFee(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && name.trim() && add()}
              inputMode="numeric"
              placeholder="$ general"
              className={`${INPUT} w-[140px] text-right tabular-nums`}
            />
            <button onClick={() => setAdding(false)} className="text-[12.5px] text-neutral-500 hover:text-fg">
              Cancelar
            </button>
            <button
              onClick={add}
              disabled={!name.trim()}
              className="rounded-md border border-accent bg-accent px-3 py-1 text-[12.5px] font-medium text-on-accent disabled:opacity-40"
            >
              Guardar
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}
