"use client";

import { useMemo, useState } from "react";
import { CaretLeftIcon, CheckIcon, CreditCardIcon, MinusIcon, MoneyIcon, PlusIcon, SquaresFourIcon, XIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { parseNote } from "@/lib/domain/quick-sale";
import { firstName, greeting, initials } from "./ui";
import { Toast, call, fmtTime, money, usePoll, useToast, type CatalogResponse, type Payment, type SaleRow } from "./shared";

/**
 * Anotar (diseño «Vender»): lo que pasó en el consultorio en una frase —
 * «María López, la atendió laura, atención y peeling» o «gabriela vendió 2 cremas con tarjeta» —
 * o eligiéndolo de una lista en pasos. Siempre se confirma antes de guardar. Prácticas y
 * productos van juntos (`/api/visits`); los productos descuentan stock solos.
 *
 * Nada se pierde por un error o por falta de carga: lo que no se entiende se elige de la lista,
 * lo que no está cargado se anota como **pendiente** (el admin le pone precio) y un producto sin
 * stock en el sistema se vende igual (el admin recibe el aviso).
 */

interface Item {
  id: string; // price_list_item
  name: string;
  /** "pendiente": no está en la lista de precios; se guarda con el nombre escrito y lo resuelve el admin. */
  kind: "practica" | "producto" | "pendiente";
  price: number;
  cardPrice: number | null;
  /** Solo productos: unidades disponibles. */
  available?: number;
  /** Médicas que lo hacen / venden (vacío = cualquiera). */
  providerIds: string[];
}

/** ¿Esa médica puede anotar este ítem? (sin vínculos = cualquiera). */
const allowedFor = (it: Item, sellerId: string | null) => it.kind === "pendiente" || !sellerId || !it.providerIds.length || it.providerIds.includes(sellerId);
/** Algo no cargado. `price` = lo que se cobró por unidad, si se sabe (0 = lo define el admin). */
const pendingItem = (name: string, price = 0): Item => {
  const n = name.trim().replace(/\s+/g, " ");
  return { id: `pend:${n.toLowerCase()}`, name: n.charAt(0).toUpperCase() + n.slice(1), kind: "pendiente", price, cardPrice: null, providerIds: [] };
};
const toPesos = (s: string) => Number(s.replace(/\D/g, "") || 0);
const normQ = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
interface Seller {
  id: string;
  name: string;
  aliases?: string[];
}
interface Line {
  item: Item;
  qty: number;
  /** Médica escrita en ese renglón (si hay más de una en el texto). */
  sellerId: string | null;
}
interface Draft {
  from: "text" | "manual";
  patient: string;
  sellerId: string | null;
  payment: Payment | null;
  lines: Line[];
  /** Renglones que no se entendieron del todo: con opciones o sin nada. */
  unresolved: { text: string; qty: number; sellerId: string | null; candidates: Item[] }[];
  /** El paciente salió de una sola palabra suelta: puede ser algo no cargado («radiofrecuencia»). Se pregunta. */
  patientUnsure: boolean;
}
type Step = "idle" | "pick" | "who" | "pay" | "confirm" | "done";

const cardOf = (i: Item) => i.cardPrice ?? i.price;
const emptyDraft = (from: Draft["from"], sellerId: string | null): Draft => ({
  from,
  patient: "",
  sellerId,
  payment: null,
  lines: [],
  unresolved: [],
  patientUnsure: false,
});

export function AnotarView({ actor, onOpenClose }: { actor: Actor; onOpenClose: () => void }) {
  const [catalog, refreshCatalog] = usePoll<CatalogResponse>("/api/catalog", 30_000);
  const [sellersData] = usePoll<{ ok: boolean; sellers: { providerId: string; name: string; aliases: string[] }[] }>("/api/sellers", 60_000);
  const [sales, refreshSales] = usePoll<{ ok: boolean; sales: SaleRow[] }>("/api/sales", 30_000);
  const [toast, showToast] = useToast();
  const isMedico = actor.role === "medico";

  const items: Item[] = useMemo(() => {
    const practices = (catalog?.practices ?? []).map((p): Item => ({ id: p.id, name: p.name, kind: "practica", price: p.price, cardPrice: p.cardPrice, providerIds: p.providerIds ?? [] }));
    const products = (catalog?.products ?? [])
      .filter((p) => p.price !== null && p.priceItemId)
      .map((p): Item => ({ id: p.priceItemId!, name: p.name, kind: "producto", price: p.price!, cardPrice: p.cardPrice, available: p.available, providerIds: p.providerIds ?? [] }));
    return [...practices, ...products];
  }, [catalog]);
  const sellers: Seller[] = useMemo(
    () => (sellersData?.sellers ?? []).map((s) => ({ id: s.providerId, name: s.name, aliases: s.aliases })),
    [sellersData],
  );
  // La médica anota a su nombre; con una sola médica en el consultorio, queda elegida sola.
  const fixedSeller = isMedico ? (sellers[0]?.id ?? null) : sellers.length === 1 ? sellers[0].id : null;

  const [step, setStep] = useState<Step>("idle");
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft("text", null));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");

  // Pasos del modo manual: primero quién atendió (si hay que elegir), después qué y el pago.
  const manualSteps: Step[] = fixedSeller ? ["pick", "pay"] : ["who", "pick", "pay"];
  const stepNum = manualSteps.indexOf(step) + 1;

  function interpret() {
    const { lines, patient, patientSure, seller, payment } = parseNote(text, items, sellers);
    const d = emptyDraft("text", fixedSeller);
    d.patient = patient ?? "";
    d.patientUnsure = !!patient && !patientSure;
    for (const l of lines) {
      if (l.match) d.lines.push({ item: l.match, qty: l.quantity, sellerId: l.seller?.id ?? null });
      else d.unresolved.push({ text: l.text, qty: l.quantity, sellerId: l.seller?.id ?? null, candidates: l.candidates });
      if (l.payment) d.payment ??= l.payment;
    }
    if (!d.sellerId && seller) d.sellerId = seller.id;
    d.payment ??= payment;
    if (!d.lines.length && !d.unresolved.length && d.patientUnsure) {
      // «radiofrecuencia, laura»: ¿es la paciente o lo que se hizo? Se pregunta en la confirmación.
      setDraft(d);
      setStep("confirm");
      return;
    }
    if (!d.lines.length && !d.unresolved.length) {
      showToast(patient ? `Anoté a ${patient}. ¿Qué se le hizo? Elegilo de la lista.` : "No encontré qué anotar. Probá elegirlo de la lista.");
      if (patient) {
        setDraft({ ...d, from: "manual" });
        setStep(d.sellerId ? "pick" : manualSteps[0]);
      }
      return;
    }
    setDraft(d);
    setStep("confirm");
  }

  function startManual() {
    setDraft(emptyDraft("manual", fixedSeller));
    setStep(manualSteps[0]);
  }

  function back() {
    const i = manualSteps.indexOf(step);
    setStep(i > 0 ? manualSteps[i - 1] : "idle");
  }

  async function save() {
    setBusy(true);
    // Una anotación por médica (si el texto nombró a más de una).
    const groups = new Map<string, Line[]>();
    for (const l of draft.lines) {
      const k = l.sellerId ?? draft.sellerId ?? "";
      groups.set(k, [...(groups.get(k) ?? []), l]);
    }
    for (const [providerId, lines] of groups) {
      const r = await call("/api/visits", "POST", {
        patientName: draft.patient.trim(),
        providerId: providerId || null,
        paymentMethod: draft.payment,
        lines: lines.map((l) => (l.item.kind === "pendiente"
            ? { pendingName: l.item.name, pendingPrice: l.item.price || null, quantity: l.qty }
            : { itemId: l.item.id, quantity: l.qty })),
      });
      if (!r.ok) {
        setBusy(false);
        refreshSales();
        return showToast(r.error ?? "No se pudo anotar.");
      }
    }
    setBusy(false);
    const nPending = draft.lines.filter((l) => l.item.kind === "pendiente").length;
    setSaved(
      [draft.patient.trim(), draft.lines.map((l) => `${l.qty > 1 ? `${l.qty} ` : ""}${l.item.name}`).join(", ")].filter(Boolean).join(" · ") +
        (nPending ? `. ${nPending === 1 ? "Lo que no estaba cargado le llega" : "Lo que no estaba cargado les llega"} al admin para ponerle precio.` : ""),
    );
    setText("");
    setStep("done");
    refreshSales();
    refreshCatalog();
  }

  const loading = !catalog || !sellersData;

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-5 pb-20 pt-10 text-[15px] leading-[1.45] sm:px-6 sm:pt-14">
      <Toast msg={toast} />

      {step === "idle" && (
        <div className="flex flex-col gap-7">
          <h1 className="font-display text-[23px] font-medium leading-[1.15] tracking-[-.02em] sm:text-[28px]">
            {greeting()}, {firstName(actor.name)}
          </h1>
          <div className="flex flex-col gap-3.5">
            <label htmlFor="anotar" className="text-[17px] font-semibold">
              ¿Qué querés anotar?
            </label>
            <textarea
              id="anotar"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) interpret();
              }}
              placeholder="Ej: María López, la atendió Laura, atención y peeling"
              className="min-h-[110px] w-full resize-none rounded-[20px] border-2 border-neutral-800 bg-surface p-5 text-[16px] leading-[1.4] text-fg outline-none transition-colors placeholder:text-neutral-600 focus:border-accent-600 sm:text-[17px]"
            />
            <p className="text-[13.5px] text-neutral-400">Sirve para pacientes y para ventas. Ej: «Gabriela vendió 2 cremas con tarjeta».</p>
            <button onClick={interpret} disabled={!text.trim() || loading} className={CTA}>
              Anotar
            </button>
            <button onClick={startManual} disabled={loading} className={`${GHOST} min-h-[44px] gap-3`}>
              <SquaresFourIcon size={24} /> Prefiero elegirlo de una lista
            </button>
          </div>
        </div>
      )}

      {(step === "pick" || step === "who" || step === "pay") && (
        <div className="flex items-center justify-between">
          <button onClick={back} className="flex min-h-12 items-center gap-2 rounded-xl py-2.5 pl-1.5 pr-3.5 text-[15px] font-semibold hover:bg-neutral-900">
            <CaretLeftIcon size={22} weight="bold" /> Volver
          </button>
          <span className="text-[14px] text-neutral-400">
            Paso {stepNum} de {manualSteps.length}
          </span>
        </div>
      )}

      {step === "pick" && (
        <PickItems
          items={items}
          draft={draft}
          setDraft={setDraft}
          proName={sellers.find((x) => x.id === draft.sellerId)?.name ?? ""}
          onNext={() => setStep("pay")}
        />
      )}

      {step === "who" && (
        <section className="flex flex-col gap-3.5">
          <h1 className="mb-2 text-[23px] font-bold leading-[1.2] sm:text-[24px]">¿Quién la atendió?</h1>
          {sellers.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setDraft({ ...draft, sellerId: s.id });
                setStep("pick");
              }}
              className={OPTION}
            >
              <span className="flex h-[44px] w-[44px] flex-none items-center justify-center rounded-full bg-neutral-900 text-[14px] font-bold">{initials(s.name)}</span>
              <span className="text-[17px] font-semibold sm:text-[17px]">{s.name}</span>
            </button>
          ))}
          {!sellers.length && <p className="text-neutral-400">No hay médicas activas: el admin las da de alta en Equipo.</p>}
        </section>
      )}

      {step === "pay" && (
        <section className="flex flex-col gap-3.5">
          <h1 className="mb-2 text-[23px] font-bold leading-[1.2] sm:text-[24px]">¿Cómo pagó?</h1>
          {(
            [
              ["efectivo", "Efectivo o transferencia", <MoneyIcon key="m" size={32} />],
              ["tarjeta", "Tarjeta", <CreditCardIcon key="c" size={32} />],
            ] as const
          ).map(([m, label, icon]) => (
            <button
              key={m}
              onClick={() => {
                setDraft({ ...draft, payment: m });
                setStep("confirm");
              }}
              className={OPTION}
            >
              {icon}
              <span className="text-[17px] font-semibold sm:text-[17px]">{label}</span>
            </button>
          ))}
          <button
            onClick={() => {
              setDraft({ ...draft, payment: null });
              setStep("confirm");
            }}
            className={`${GHOST} min-h-[44px]`}
          >
            Todavía no sé
          </button>
        </section>
      )}

      {step === "confirm" && (
        <Confirm
          items={items}
          draft={draft}
          setDraft={setDraft}
          sellers={sellers}
          isMedico={isMedico}
          busy={busy}
          onSave={save}
          onEdit={() => setStep(draft.from === "manual" ? manualSteps[0] : "idle")}
        />
      )}

      {step === "done" && (
        <div className="flex animate-cl-in flex-col items-center gap-4 py-6 text-center">
          <span className="flex h-[56px] w-[56px] items-center justify-center rounded-full bg-success text-on-success">
            <CheckIcon size={36} weight="bold" />
          </span>
          <p className="text-[21px] font-bold">¡Listo, anotado!</p>
          {saved && <p className="max-w-[520px] text-[15px] text-neutral-300">{saved}</p>}
          <button onClick={() => setStep("idle")} className={`${CTA} mt-2 px-9`}>
            Anotar otra
          </button>
        </div>
      )}

      {(step === "idle" || step === "done") && <Today sales={sales?.sales ?? null} onOpenClose={onOpenClose} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paso «¿Qué se hizo o se vendió?»: se puede marcar más de uno
// ---------------------------------------------------------------------------

function PickItems({
  items,
  draft,
  setDraft,
  proName,
  onNext,
}: {
  items: Item[];
  draft: Draft;
  setDraft: (d: Draft) => void;
  proName: string;
  onNext: () => void;
}) {
  const picked = new Set(draft.lines.map((l) => l.item.id));
  const toggle = (it: Item) =>
    setDraft({
      ...draft,
      lines: picked.has(it.id) ? draft.lines.filter((l) => l.item.id !== it.id) : [...draft.lines, { item: it, qty: 1, sellerId: null }],
    });
  // Solo lo que hace / vende la profesional elegida.
  const mine = items.filter((i) => allowedFor(i, draft.sellerId));
  const groups = [
    { title: "Prácticas", list: mine.filter((i) => i.kind === "practica") },
    { title: "Productos", list: mine.filter((i) => i.kind === "producto") },
  ].filter((g) => g.list.length);
  const n = draft.lines.length;

  return (
    <section className="flex flex-col gap-5">
      <div>
        {(draft.patient || proName) && <p className="mb-1 text-[15px] text-neutral-300">{[draft.patient, proName].filter(Boolean).join(" · ")}</p>}
        <h1 className="text-[23px] font-bold leading-[1.2] sm:text-[24px]">¿Qué se hizo o se vendió?</h1>
        <p className="mt-1 text-[14px] text-neutral-400">Podés marcar más de uno.</p>
      </div>
      {groups.map((g) => (
        <div key={g.title} className="flex flex-col gap-3">
          {groups.length > 1 && <h2 className="text-[13px] font-bold uppercase tracking-[.08em] text-neutral-500">{g.title}</h2>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {g.list.map((it) => {
              const on = picked.has(it.id);
              const out = it.kind === "producto" && (it.available ?? 0) <= 0;
              return (
                <button
                  key={it.id}
                  onClick={() => toggle(it)}
                  aria-pressed={on}
                  className={`flex min-h-[60px] items-center justify-between gap-3 rounded-[18px] border-2 px-5 py-3.5 text-left transition-colors ${
                    on ? "border-fg bg-fg text-bg" : "border-neutral-800 bg-surface hover:border-accent"
                  }`}
                >
                  <span className="flex flex-col">
                    <span className="text-[16px] font-semibold leading-tight">{it.name}</span>
                    <span className={`text-[13.5px] ${on ? "opacity-70" : "text-neutral-400"}`}>{money(it.price)}
                      {out && " · sin stock cargado"}</span>
                  </span>
                  {on && <CheckIcon size={26} weight="bold" className="flex-none" />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {!groups.length && (
        <p className="text-neutral-400">
          {proName ? `${proName} no tiene prácticas ni productos asignados.` : "Todavía no hay prácticas ni productos con precio."} Los carga el admin en Stock.
        </p>
      )}
      {draft.lines
        .filter((l) => l.item.kind === "pendiente")
        .map((l) => (
          <div key={l.item.id} className="flex items-center gap-3 rounded-[18px] border-2 border-dashed border-accent-700 px-5 py-3">
            <span className="min-w-0 flex-1">
              <span className="block text-[16px] font-semibold">{l.item.name}</span>
              <span className="text-[13px] text-neutral-400">
                {l.item.price ? `Sin cargar · se cobró ${money(l.item.price)}` : "Sin cargar · el precio lo podés poner al confirmar"}
              </span>
            </span>
            <button aria-label={`Quitar ${l.item.name}`} onClick={() => toggle(l.item)} className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-neutral-900">
              <XIcon size={18} />
            </button>
          </div>
        ))}
      <AddPending onAdd={(name, price) => !picked.has(pendingItem(name).id) && toggle(pendingItem(name, price))} />
      <button onClick={onNext} disabled={!n} className={`${CTA} mt-2`}>
        {n ? `Seguir (${n})` : "Marcá al menos uno"}
      </button>
    </section>
  );
}

/** «¿No está en la lista?»: se anota con el nombre escrito y queda pendiente para el admin. */
function AddPending({ onAdd, initial = "", compact }: { onAdd: (name: string, price: number) => void; initial?: string; compact?: boolean }) {
  const [open, setOpen] = useState(!!initial);
  const [name, setName] = useState(initial);
  const [price, setPrice] = useState("");
  const add = () => {
    onAdd(name, toPesos(price));
    setName("");
    setPrice("");
    setOpen(false);
  };
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="self-start py-1 text-[14.5px] font-semibold text-accent underline-offset-4 hover:underline">
        ¿No está en la lista? Anotalo igual
      </button>
    );
  return (
    <div className={`flex flex-col gap-2 ${compact ? "" : "rounded-[18px] border-2 border-neutral-800 p-4"}`}>
      {!compact && <span className="text-[14px] text-neutral-300">Escribí qué se hizo o vendió y, si lo sabés, cuánto se cobró. El admin después lo carga en la lista.</span>}
      <div className="flex flex-wrap gap-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && add()}
          placeholder="Ej: radiofrecuencia"
          className="min-w-[180px] flex-1 rounded-xl border-2 border-neutral-800 bg-bg px-3 py-2 text-[15px] outline-none focus:border-accent-600"
        />
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && add()}
          inputMode="numeric"
          placeholder="Precio $ (opcional)"
          aria-label="Cuánto se cobró (opcional)"
          className="w-[170px] rounded-xl border-2 border-neutral-800 bg-bg px-3 py-2 text-[15px] outline-none focus:border-accent-600"
        />
        <button disabled={!name.trim()} onClick={add} className={CHIP_ON + " disabled:opacity-40"}>
          Agregar
        </button>
      </div>
    </div>
  );
}

/** Buscar en la lista (cuando lo escrito no se entendió). */
function SearchItems({ items, sellerId, onPick }: { items: Item[]; sellerId: string | null; onPick: (it: Item) => void }) {
  const [q, setQ] = useState("");
  const list = items
    .filter((i) => allowedFor(i, sellerId))
    .filter((i) => !q.trim() || normQ(i.name).includes(normQ(q.trim())))
    .slice(0, 8);
  return (
    <div className="flex flex-col gap-2">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Buscar…"
        className="rounded-xl border-2 border-neutral-800 bg-bg px-3 py-2 text-[15px] outline-none focus:border-accent-600"
      />
      <div className="flex flex-wrap gap-2">
        {list.map((it) => (
          <button key={it.id} onClick={() => onPick(it)} className={CHIP}>
            {it.name}
          </button>
        ))}
        {!list.length && <span className="text-[13.5px] text-neutral-500">Nada con ese nombre.</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// «¿Está bien así?»
// ---------------------------------------------------------------------------

function Confirm({
  items,
  draft,
  setDraft,
  sellers,
  isMedico,
  busy,
  onSave,
  onEdit,
}: {
  items: Item[];
  draft: Draft;
  setDraft: (d: Draft) => void;
  sellers: Seller[];
  isMedico: boolean;
  busy: boolean;
  onSave: () => void;
  onEdit: () => void;
}) {
  const [pickWho, setPickWho] = useState(false);
  // Renglón no entendido que se está resolviendo: "lista" (buscar) o "pendiente" (anotarlo igual).
  const [fixing, setFixing] = useState<{ k: number; mode: "lista" | "pendiente" } | null>(null);
  const sellerName = (id: string | null) => sellers.find((s) => s.id === id)?.name ?? null;
  const isVisit = !!draft.patient.trim() || draft.lines.some((l) => l.item.kind !== "producto");
  const missingSeller = !isMedico && draft.lines.some((l) => !(l.sellerId ?? draft.sellerId));
  const whoNames = draft.lines.length
    ? [...new Set(draft.lines.map((l) => sellerName(l.sellerId ?? draft.sellerId)).filter(Boolean))]
    : [sellerName(draft.sellerId)].filter(Boolean);
  const cash = draft.lines.reduce((n, l) => n + l.item.price * l.qty, 0);
  const card = draft.lines.reduce((n, l) => n + cardOf(l.item) * l.qty, 0);
  const pendingCount = draft.lines.filter((l) => l.item.kind === "pendiente" && !l.item.price).length;
  const setPrice = (i: number, price: number) =>
    setDraft({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, item: { ...l.item, price } } : l)) });
  // Algo que la médica elegida no tiene asignado (el admin lo vincula en Stock).
  const notHers = (l: Line) => !allowedFor(l.item, l.sellerId ?? draft.sellerId);
  const anyNotHers = draft.lines.some(notHers);
  const blocked = !draft.lines.length || draft.unresolved.length > 0 || missingSeller || anyNotHers || draft.patientUnsure;

  const setQty = (i: number, qty: number) =>
    setDraft({ ...draft, lines: qty <= 0 ? draft.lines.filter((_, j) => j !== i) : draft.lines.map((l, j) => (j === i ? { ...l, qty } : l)) });
  const resolve = (k: number, it: Item | null) => {
    const u = draft.unresolved[k];
    setFixing(null);
    setDraft({
      ...draft,
      unresolved: draft.unresolved.filter((_, j) => j !== k),
      lines: it ? [...draft.lines, { item: it, qty: u.qty, sellerId: u.sellerId }] : draft.lines,
    });
  };

  return (
    <section className="flex animate-cl-in flex-col gap-6 rounded-3xl border-2 border-neutral-800 bg-surface p-5 sm:p-7">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-tag-bg px-3.5 py-1 text-[13px] font-bold text-tag-fg">{isVisit ? "Paciente" : "Venta"}</span>
        <span className="text-[15px] text-neutral-300">¿Está bien así?</span>
      </div>

      {draft.patientUnsure && (
        <div className="flex flex-col gap-3 rounded-2xl border-2 border-accent-700 p-4">
          <span className="text-[15px]">
            ¿<b>«{draft.patient}»</b> es el nombre de la paciente, o es algo que se hizo o se vendió?
          </span>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setDraft({ ...draft, patientUnsure: false })} className={CHIP}>
              Es la paciente
            </button>
            <button
              onClick={() => {
                const it = items.find((i) => normQ(i.name) === normQ(draft.patient));
                setDraft({
                  ...draft,
                  patient: "",
                  patientUnsure: false,
                  ...(it
                    ? { lines: [...draft.lines, { item: it, qty: 1, sellerId: null }] }
                    : { unresolved: [...draft.unresolved, { text: draft.patient.toLowerCase(), qty: 1, sellerId: null, candidates: [] }] }),
                });
              }}
              className={CHIP}
            >
              Es lo que se hizo o vendió
            </button>
          </div>
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[13px] text-neutral-400">Paciente</span>
        <input
          value={draft.patient}
          onChange={(e) => setDraft({ ...draft, patient: e.target.value, patientUnsure: false })}
          placeholder="Nombre (opcional)"
          className="border-b-2 border-neutral-800 bg-transparent pb-1 text-[21px] font-bold leading-tight outline-none placeholder:font-semibold placeholder:text-neutral-600 focus:border-accent-600 sm:text-[24px]"
        />
      </label>

      {/* Renglones */}
      <ul className="flex flex-col gap-3">
        {draft.lines.map((l, i) => (
          <li key={`${l.item.id}-${i}`} className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="flex items-center gap-2">
              <button onClick={() => setQty(i, l.qty - 1)} aria-label={l.qty === 1 ? `Quitar ${l.item.name}` : "Uno menos"} className={ROUND}>
                {l.qty === 1 ? <XIcon size={18} weight="bold" /> : <MinusIcon size={18} weight="bold" />}
              </button>
              <span className="min-w-8 text-center text-[19px] font-bold tabular-nums">{l.qty}</span>
              <button
                onClick={() => setQty(i, l.qty + 1)}
                aria-label="Uno más"
                className={ROUND}
              >
                <PlusIcon size={18} weight="bold" />
              </button>
            </span>
            <span className="min-w-0 flex-1 text-[17px] font-bold leading-tight sm:text-[19px]">
              {l.item.name}
              {notHers(l) && (
                <span className="block text-[13.5px] font-semibold text-accent">
                  {sellerName(l.sellerId ?? draft.sellerId)} no tiene asignado esto. Quitalo o cambiá la médica.
                </span>
              )}
              {l.item.kind === "pendiente" && (
                <span className="block text-[13px] font-normal text-neutral-400">
                  No está cargado: se anota igual y el admin lo agrega a la lista.{l.item.price ? "" : " Si sabés cuánto se cobró, ponelo."}
                </span>
              )}
              {l.item.kind === "producto" && l.qty > (l.item.available ?? 0) && (
                <span className="block text-[13px] font-normal text-neutral-400">
                  El sistema tiene {Math.max(l.item.available ?? 0, 0)}: se anota igual y se le avisa al admin para cargar el ingreso.
                </span>
              )}
            </span>
            {l.item.kind === "pendiente" ? (
              <label className="flex items-center gap-1 rounded-xl border-2 border-neutral-800 px-2.5 py-1 focus-within:border-accent-600">
                <span className="text-[15px] text-neutral-400">$</span>
                <input
                  value={l.item.price ? l.item.price.toLocaleString("es-AR") : ""}
                  onChange={(e) => setPrice(i, toPesos(e.target.value))}
                  inputMode="numeric"
                  placeholder="precio"
                  aria-label={`Cuánto se cobró ${l.item.name} (por unidad)`}
                  className="w-[96px] bg-transparent text-right text-[15px] tabular-nums outline-none placeholder:text-neutral-600"
                />
              </label>
            ) : (
              <span className="text-[15px] tabular-nums text-neutral-300">{money((draft.payment === "tarjeta" ? cardOf(l.item) : l.item.price) * l.qty)}</span>
            )}
          </li>
        ))}
        {draft.unresolved.map((u, k) => (
          <li key={`u-${k}`} className="flex flex-col gap-2 rounded-2xl border-2 border-dashed border-neutral-700 p-4">
            <span className="text-[14px] text-neutral-300">
              {u.candidates.length ? <>«{u.text}»: ¿cuál?</> : <>No encontré «{u.text}» en la lista.</>}
            </span>
            {fixing?.k === k && fixing.mode === "lista" ? (
              <SearchItems items={items} sellerId={u.sellerId ?? draft.sellerId} onPick={(it) => resolve(k, it)} />
            ) : fixing?.k === k && fixing.mode === "pendiente" ? (
              <AddPending compact initial={u.text} onAdd={(name, price) => resolve(k, pendingItem(name, price))} />
            ) : (
              <div className="flex flex-wrap gap-2">
                {u.candidates.map((c) => (
                  <button key={c.id} onClick={() => resolve(k, c)} className={CHIP}>
                    {c.name}
                  </button>
                ))}
                <button onClick={() => setFixing({ k, mode: "lista" })} className={CHIP}>
                  Buscar en la lista
                </button>
                <button onClick={() => setFixing({ k, mode: "pendiente" })} className={CHIP}>
                  No está: anotarlo igual
                </button>
                <button onClick={() => resolve(k, null)} className={`${CHIP} text-neutral-400`}>
                  Quitar
                </button>
              </div>
            )}
          </li>
        ))}
        {!draft.lines.length && !draft.unresolved.length && <li className="text-neutral-400">No quedó nada para anotar.</li>}
      </ul>

      {/* Quién y cómo pagó */}
      <div className="flex flex-col gap-3">
        {!isMedico && (missingSeller || pickWho) ? (
          <div className="flex flex-col gap-2">
            <span className="text-[14px] text-neutral-300">{isVisit ? "¿Quién la atendió?" : "¿Quién lo vendió?"}</span>
            <div className="flex flex-wrap gap-2">
              {sellers.map((s) => (
                <button
                  key={s.id}
                  aria-pressed={draft.sellerId === s.id}
                  onClick={() => {
                    setDraft({ ...draft, sellerId: s.id, lines: draft.lines.map((l) => ({ ...l, sellerId: null })) });
                    setPickWho(false);
                  }}
                  className={draft.sellerId === s.id && !missingSeller ? CHIP_ON : CHIP}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[15px] text-neutral-300">
            {whoNames.join(" y ") || "—"}
            {!isMedico && (
              <button onClick={() => setPickWho(true)} className="ml-3 text-[13.5px] text-accent underline-offset-4 hover:underline">
                Cambiar
              </button>
            )}
          </p>
        )}
        <div className="flex flex-wrap gap-2" role="group" aria-label="¿Cómo pagó?">
          {(
            [
              ["efectivo", "Efectivo o transf."],
              ["tarjeta", "Tarjeta"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              aria-pressed={draft.payment === m}
              onClick={() => setDraft({ ...draft, payment: draft.payment === m ? null : m })}
              className={draft.payment === m ? CHIP_ON : CHIP}
            >
              {label}
            </button>
          ))}
          {!draft.payment && <span className="self-center text-[13px] text-neutral-500">Cómo pagó: opcional</span>}
        </div>
      </div>

      <div>
        <p className="font-display text-[26px] font-medium tracking-[-.02em] tabular-nums sm:text-[30px]">
          {money(draft.payment === "tarjeta" ? card : cash)}
        </p>
        {!draft.payment && card !== cash && <p className="text-[14px] text-neutral-400">o {money(card)} si paga con tarjeta</p>}
        {pendingCount > 0 && (
          <p className="text-[14px] text-neutral-400">+ {pendingCount === 1 ? "1 cosa sin precio" : `${pendingCount} cosas sin precio`} todavía (lo completa el admin)</p>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <button onClick={onSave} disabled={busy || blocked} className={`${CTA} flex-[2_1_220px]`}>
          {busy ? "Guardando…" : missingSeller ? "Falta quién" : draft.unresolved.length || anyNotHers || draft.patientUnsure ? "Revisá lo marcado" : "Sí, guardar"}
        </button>
        <button onClick={onEdit} className={`${GHOST} min-h-[56px] flex-[1_1_160px]`}>
          Corregir
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// «Hoy»: lo anotado en el día, agrupado por anotación
// ---------------------------------------------------------------------------

type TodaySale = SaleRow;

function Today({ sales, onOpenClose }: { sales: TodaySale[] | null; onOpenClose: () => void }) {
  const rows = useMemo(() => {
    const paid = (sales ?? []).filter((s) => s.status === "paid");
    const byVisit = new Map<string, TodaySale[]>();
    for (const s of paid) {
      const k = s.visitId ?? s.id;
      byVisit.set(k, [...(byVisit.get(k) ?? []), s]);
    }
    return [...byVisit.values()].map((g) => {
      const items = g
        .map((s) => `${s.kind === "producto" || s.quantity > 1 ? `${s.quantity} ` : ""}${s.itemName}${s.kind === "pendiente" ? " (sin cargar)" : ""}`)
        .join(", ");
      const patient = g[0].patientName;
      return {
        key: g[0].visitId ?? g[0].id,
        time: fmtTime(g[g.length - 1].createdAt),
        label: patient ? `${patient} — ${items}` : items,
        patient: !!patient,
        product: g.some((s) => s.kind === "producto"),
        total: g.reduce((n, s) => n + s.total, 0),
      };
    });
  }, [sales]);
  if (!sales) return null;
  const total = rows.reduce((n, r) => n + r.total, 0);
  const patients = rows.filter((r) => r.patient).length;
  const ventas = rows.filter((r) => r.product).length;

  return (
    <section className="mt-6 flex flex-col">
      <div className="flex items-baseline justify-between gap-3 border-b border-neutral-800 pb-3">
        <span className="text-[15px] text-neutral-300">
          Hoy
          {rows.length > 0 && (
            <span className="text-neutral-500">
              {" "}
              · {patients} {patients === 1 ? "paciente" : "pacientes"} · {ventas} {ventas === 1 ? "venta" : "ventas"}
            </span>
          )}
        </span>
        <span className="whitespace-nowrap text-[17px] font-bold tabular-nums">{money(total)}</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="flex justify-between gap-4 border-b border-neutral-900 py-3.5 text-[14px] sm:text-[15px]">
          <span className="min-w-0">
            <span className="mr-3.5 tabular-nums text-neutral-500">{r.time}</span>
            {r.label}
          </span>
          <span className="whitespace-nowrap tabular-nums text-neutral-300">{money(r.total)}</span>
        </div>
      ))}
      {!rows.length && <p className="py-4 text-[14px] text-neutral-500">Todavía no se anotó nada hoy.</p>}
      <button onClick={onOpenClose} className="mt-4 self-start py-2 text-[15px] font-semibold text-accent underline-offset-4 hover:underline">
        Ver el cierre del día →
      </button>
    </section>
  );
}

const CTA =
  "flex min-h-[56px] items-center justify-center rounded-[18px] bg-accent px-6 text-[16px] font-bold text-on-accent transition-[filter,opacity] hover:brightness-105 active:opacity-85 disabled:cursor-not-allowed disabled:bg-neutral-900 disabled:text-neutral-500 sm:text-[17px]";
const GHOST =
  "flex items-center justify-center rounded-[18px] border-2 border-neutral-800 px-5 text-[15px] font-semibold text-fg transition-colors hover:bg-neutral-900";
const OPTION =
  "flex min-h-[64px] items-center gap-[18px] rounded-[18px] border-2 border-neutral-800 bg-surface px-5 py-3.5 text-left text-fg transition-colors hover:border-accent";
const ROUND =
  "flex h-[44px] w-[44px] items-center justify-center rounded-full border-2 border-neutral-700 text-fg transition-colors hover:bg-neutral-900 disabled:opacity-30";
const CHIP = "rounded-full border-2 border-neutral-700 px-4 py-2 text-[14px] font-semibold transition-colors hover:border-accent";
const CHIP_ON = "rounded-full border-2 border-accent bg-accent px-4 py-2 text-[14px] font-bold text-on-accent";
