"use client";

import { useEffect, useRef, useState } from "react";
import { BellIcon } from "@phosphor-icons/react";
import { call, usePoll } from "./shared";

interface Notif {
  id: string;
  kind: "vence_pronto" | "vencido" | "stock_bajo" | "sin_stock" | "pendiente";
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<Notif["kind"], string> = {
  vence_pronto: "Vence pronto",
  vencido: "Vencido",
  stock_bajo: "Stock bajo",
  sin_stock: "Sin stock cargado",
  pendiente: "Para cargar",
};

const ago = (iso: string) => {
  const [d, t] = iso.split("T");
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  return d === ymd ? `hoy ${t.slice(0, 5)}` : `${d.slice(8, 10)}/${d.slice(5, 7)}`;
};

/** Campanita de la médica: vencimientos y stock bajo. Se refresca cada 30 s. */
export function Bell({ onOpenStock }: { onOpenStock: () => void }) {
  const [data, refresh] = usePoll<{ ok: boolean; items: Notif[]; unread: number }>("/api/notifications", 30_000);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = data?.unread ?? 0;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function read(id?: string) {
    await call("/api/notifications/read", "POST", id ? { id } : {});
    refresh();
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={unread ? `Notificaciones: ${unread} sin leer` : "Notificaciones"}
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 transition-colors hover:bg-accent-900 hover:text-fg"
      >
        <BellIcon size={19} weight={unread ? "fill" : "regular"} />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-accent px-1 text-[10.5px] font-semibold tabular-nums text-on-accent">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-40 flex max-h-[70vh] w-[min(360px,calc(100vw-24px))] animate-cl-in flex-col overflow-hidden rounded-xl bg-surface shadow-lg">
          <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
            <span className="text-[14px] font-medium">Avisos de stock</span>
            <span className="flex-1" />
            {unread > 0 && (
              <button onClick={() => read()} className="text-[12px] text-neutral-400 hover:text-fg">
                Marcar todo como leído
              </button>
            )}
          </div>
          <div className="overflow-y-auto">
            {!data?.items.length ? (
              <p className="px-4 py-6 text-[13px] text-neutral-400">Nada por ahora. Te aviso acá cuando algo esté por vencer o se esté terminando.</p>
            ) : (
              data.items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    if (!n.readAt) read(n.id);
                    setOpen(false);
                    onOpenStock();
                  }}
                  className={`flex w-full gap-3 border-b border-neutral-900 px-4 py-3 text-left transition-colors last:border-0 hover:bg-accent-900 ${n.readAt ? "opacity-55" : ""}`}
                >
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? "bg-transparent" : "bg-accent"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="text-[11px] uppercase tracking-[.06em] text-neutral-500">{KIND_LABEL[n.kind]}</span>
                      <span className="flex-1" />
                      <span className="text-[11px] tabular-nums text-neutral-500">{ago(n.createdAt)}</span>
                    </span>
                    <span className="block text-[13.5px] font-medium">{n.title}</span>
                    <span className="block text-[12.5px] text-neutral-400">{n.body}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
