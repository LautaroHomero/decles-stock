"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { CaretLeftIcon, CheckIcon, MinusIcon, PlusIcon, SquaresFourIcon, XIcon } from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { parseNote, suggest } from "@/lib/domain/quick-sale";
import { parseExpense } from "@/lib/domain/expense-note";
import { ExpenseForm, type Expense, type ExpensesResponse } from "./egresos";
import { firstName, greeting } from "./ui";
import { Toast, call, fmtTime, money, usePoll, useToast, type CatalogResponse, type Payment, type SaleRow, PAYMENTS } from "./shared";

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

/**
 * Médicas que pueden hacer TODO lo anotado (según lo que vinculó el admin). `null` = cualquiera
 * (nada de lo anotado tiene vínculos). Si queda una sola, es ella: no hace falta preguntar.
 */
function sellersFor(lines: { item: Item }[], all: Seller[]): Seller[] | null {
  const bound = lines.map((l) => l.item).filter((i) => i.kind !== "pendiente" && i.providerIds.length);
  if (!bound.length) return null;
  return all.filter((s) => bound.every((i) => i.providerIds.includes(s.id)));
}
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

/** Lo escrito → borrador. Lo que no se encuentra en la lista queda como pendiente (lo resuelve el admin). */
function buildDraft(text: string, items: Item[], sellers: Seller[], fixedSeller: string | null): Draft {
  const { lines, patient, patientSure, seller, payment } = parseNote(text, items, sellers);
  const d = emptyDraft("text", fixedSeller);
  d.patient = patient ?? "";
  d.patientUnsure = !!patient && !patientSure;
  for (const l of lines) {
    if (l.match) d.lines.push({ item: l.match, qty: l.quantity, sellerId: l.seller?.id ?? null });
    else if (l.candidates.length) d.unresolved.push({ text: l.text, qty: l.quantity, sellerId: l.seller?.id ?? null, candidates: l.candidates });
    else if (l.rest) d.lines.push({ item: pendingItem(l.rest), qty: l.quantity, sellerId: l.seller?.id ?? null });
    if (l.payment) d.payment ??= l.payment;
  }
  if (!d.sellerId && seller) d.sellerId = seller.id;
  // «peeling» y el peeling solo lo hace Laura → es Laura (sin preguntar).
  const only = sellersFor(d.lines, sellers);
  if (!d.sellerId && only?.length === 1) d.sellerId = only[0].id;
  d.payment ??= payment;
  return d;
}

const lineCash = (l: Line) => l.item.price * l.qty;
const lineCard = (l: Line) => cardOf(l.item) * l.qty;
const summaryOf = (d: Draft) =>
  [d.patient.trim(), d.lines.map((l) => `${l.qty > 1 ? `${l.qty} ` : ""}${l.item.name}`).join(", ")].filter(Boolean).join(" · ");

export function AnotarView({ actor, onOpenClose }: { actor: Actor; onOpenClose: () => void }) {
  const [catalog, refreshCatalog] = usePoll<CatalogResponse>("/api/catalog", 30_000);
  const [sellersData] = usePoll<{ ok: boolean; sellers: { providerId: string; name: string; aliases: string[] }[] }>("/api/sellers", 60_000);
  const [sales, refreshSales] = usePoll<{ ok: boolean; sales: SaleRow[] }>("/api/sales", 30_000);
  const [toast, showToast] = useToast();
  const isMedico = actor.role === "medico";
  // Egresos de plata: los anota la secretaría o el admin.
  const canExpense = !isMedico;
  const [expensesData, refreshExpenses] = usePoll<ExpensesResponse>("/api/expenses", 30_000);
  const [expenseForm, setExpenseForm] = useState<{ expense?: Expense; initial?: { concept: string; amount: number } } | null>(null);

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

  const [mode, setMode] = useState<"idle" | "manual" | "confirm">("idle");
  const [text, setText] = useState("");
  // Lo que se toca en la vista previa (si el texto no lo dice).
  const [pickSeller, setPickSeller] = useState<string | null>(null);
  const [pickPay, setPickPay] = useState<Payment | null>(null);
  // Respuestas tocadas en la vista previa: «crema» → cuál, y si el nombre dudoso es la paciente.
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [unsureIs, setUnsureIs] = useState<"patient" | "item" | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft("text", null));
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [lastVisit, setLastVisit] = useState<string | null>(null);
  const [editing, setEditing] = useState<SaleRow[] | null>(null);

  const box = useRef<HTMLTextAreaElement>(null);
  // La vista previa usa el texto «diferido»: el tipeo nunca espera a que se interprete.
  const typed = useDeferredValue(text);
  // Ayuda para escribir: completar la palabra que se está tipeando (Tab o un toque).
  const hints = useMemo(() => (items.length ? suggest(text, items, sellers) : []), [text, items, sellers]);
  const accept = (t: string) => {
    setText(t);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(t.length, t.length);
    });
  };

  // Vista previa en vivo de lo escrito.
  const preview = useMemo(() => {
    const text = typed;
    if (!text.trim() || !items.length) return null;
    const d = buildDraft(text, items, sellers, fixedSeller);
    // Lo elegido entre opciones pasa a renglón.
    for (const u of [...d.unresolved]) {
      const it = items.find((i) => i.id === chosen[u.text]);
      if (it) {
        d.lines.push({ item: it, qty: u.qty, sellerId: null });
        d.unresolved = d.unresolved.filter((x) => x !== u);
      }
    }
    if (d.patientUnsure && unsureIs === "patient") d.patientUnsure = false;
    if (d.patientUnsure && unsureIs === "item") {
      const it = items.find((i) => normQ(i.name) === normQ(d.patient));
      d.lines.push({ item: it ?? pendingItem(d.patient), qty: 1, sellerId: null });
      d.patient = "";
      d.patientUnsure = false;
    }
    if (!d.sellerId) {
      const only = sellersFor(d.lines, sellers);
      if (only?.length === 1) d.sellerId = only[0].id;
    }
    return { ...d, sellerId: pickSeller ?? d.sellerId, payment: d.payment ?? pickPay };
  }, [typed, items, sellers, fixedSeller, pickSeller, pickPay, chosen, unsureIs]);
  // «pagué 5000 de luz» → es un egreso, no una atención.
  const expense = useMemo(() => (canExpense ? parseExpense(typed) : null), [typed, canExpense]);
  const possible = preview ? sellersFor(preview.lines, sellers) : null;
  const notHers = !!preview && preview.lines.some((l) => !allowedFor(l.item, preview.sellerId));
  const missingSeller = !!preview && !isMedico && !preview.sellerId;
  const nothing = !!preview && !preview.lines.length && !preview.unresolved.length && !preview.patientUnsure;
  // Lo que falta contestar en la vista previa (todo se resuelve ahí, con un toque).
  const pendingQ = !!preview && (preview.unresolved.length > 0 || preview.patientUnsure);
  const canSave = !!preview && !nothing && !missingSeller && !notHers && !pendingQ;

  async function save(d: Draft) {
    setBusy(true);
    const r = await call("/api/visits", "POST", {
      patientName: d.patient.trim(),
      providerId: d.sellerId,
      paymentMethod: d.payment,
      lines: d.lines.map((l) =>
        l.item.kind === "pendiente" ? { pendingName: l.item.name, pendingPrice: l.item.price || null, quantity: l.qty } : { itemId: l.item.id, quantity: l.qty },
      ),
    });
    setBusy(false);
    if (!r.ok) {
      refreshSales();
      return showToast(r.error ?? "No se pudo anotar.");
    }
    // ¡Registrado! → animación y de vuelta al inicio, listo para la próxima.
    setFlash(summaryOf(d));
    setLastVisit(String(r.visitId ?? ""));
    setText("");
    setPickSeller(null);
    setPickPay(null);
    setChosen({});
    setUnsureIs(null);
    setMode("idle");
    refreshSales();
    refreshCatalog();
    setTimeout(() => setFlash(null), 1400);
  }

  async function saveExpense() {
    if (!expense || busy) return;
    if (!expense.concept || !expense.amount) return setExpenseForm({ initial: expense });
    setBusy(true);
    const r = await call("/api/expenses", "POST", expense);
    setBusy(false);
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar el egreso.");
    expenseDone(`Egreso · ${expense.concept} · ${money(expense.amount)}`);
  }

  function expenseDone(msg: string) {
    setExpenseForm(null);
    setFlash(msg);
    setText("");
    refreshExpenses();
    setTimeout(() => setFlash(null), 1400);
  }

  function go() {
    if (expense) return saveExpense();
    if (preview && canSave && !busy) save(preview);
  }

  const loading = !catalog || !sellersData;
  const cash = preview?.lines.reduce((n, l) => n + lineCash(l), 0) ?? 0;
  const card = preview?.lines.reduce((n, l) => n + lineCard(l), 0) ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-5 pb-20 pt-6 text-[14px] leading-[1.45] sm:px-6 sm:pt-8">
      <Toast msg={toast} />
      {flash !== null && <Registered summary={flash} onClose={() => setFlash(null)} />}

      {mode === "idle" && (
        <div className="flex flex-col gap-6">
          <h1 className="font-display text-[22px] font-medium leading-[1.15] tracking-[-.02em] sm:text-[22px]">
            {greeting()}, {firstName(actor.name)}
          </h1>
          <div className="flex flex-col gap-3">
            <label htmlFor="anotar" className="text-[15px] font-medium">
              ¿Qué querés anotar?
            </label>
            <textarea
              id="anotar"
              ref={box}
              autoFocus
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (!e.target.value.trim()) {
                  setChosen({});
                  setUnsureIs(null);
                  setPickSeller(null);
                  setPickPay(null);
                }
              }}
              onKeyDown={(e) => {
                // Tab completa con la primera sugerencia.
                if (e.key === "Tab" && hints.length) {
                  e.preventDefault();
                  accept(hints[0].text);
                  return;
                }
                // Enter guarda (o abre la revisión); Shift+Enter, otro renglón.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  go();
                }
              }}
              placeholder="Ej: María López, la atendió Laura, atención y peeling"
              className="min-h-[96px] w-full resize-none rounded-xl border border-neutral-800 bg-surface p-5 text-[16px] leading-[1.4] text-fg outline-none transition-colors placeholder:text-neutral-600 focus:border-accent-600 sm:text-[15px]"
            />

            {hints.length > 0 && (
              <div className="-mt-1 flex flex-wrap items-center gap-2" aria-label="Sugerencias">
                {hints.map((h, i) => (
                  <button
                    key={h.label + i}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => accept(h.text)}
                    className={`rounded-full border px-3.5 py-1.5 text-[14px] font-medium transition-colors ${
                      i === 0 ? "border-accent-600 text-fg" : "border-neutral-800 text-neutral-300 hover:border-accent-600"
                    }`}
                  >
                    {h.label}
                  </button>
                ))}
                <span className="hidden text-[12.5px] text-neutral-500 sm:inline">Tab para completar</span>
              </div>
            )}

            {expense ? (
              <div className="flex animate-cl-in flex-col gap-1 rounded-xl border border-neutral-800 px-5 py-4">
                <p className="text-[12px] uppercase tracking-[.06em] text-neutral-500">Egreso de plata</p>
                <p className="flex items-baseline justify-between gap-3 text-[14px]">
                  <b className="font-medium">{expense.concept || "¿En qué?"}</b>
                  <span className="whitespace-nowrap tabular-nums">{expense.amount ? `− ${money(expense.amount)}` : "¿Cuánto?"}</span>
                </p>
                <button onClick={() => setExpenseForm({ initial: expense })} className="self-start pt-1 text-[13px] text-neutral-400 underline-offset-4 hover:text-fg hover:underline">
                  Corregir
                </button>
              </div>
            ) : preview ? (
              <div className="flex animate-cl-in flex-col gap-3 rounded-xl border border-neutral-800 px-5 py-4">
                {preview.patient && !preview.patientUnsure && (
                  <p className="text-[14px]">
                    <span className="text-neutral-400">Paciente </span>
                    <b>{preview.patient}</b>
                  </p>
                )}
                {preview.patientUnsure && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px]">
                      <b>«{preview.patient}»</b> es…
                    </span>
                    <button onClick={() => setUnsureIs("patient")} className={CHIP}>
                      la paciente
                    </button>
                    <button onClick={() => setUnsureIs("item")} className={CHIP}>
                      lo que se hizo o vendió
                    </button>
                  </div>
                )}
                {(preview.lines.length > 0 || preview.unresolved.length > 0) && (
                  <ul className="flex flex-col gap-1">
                    {preview.lines.map((l, i) => (
                      <li key={i} className="flex items-baseline justify-between gap-3 text-[14px]">
                        <span>
                          {l.qty > 1 && <span className="tabular-nums text-neutral-400">{l.qty} × </span>}
                          <b className="font-medium">{l.item.name}</b>
                          {l.item.kind === "pendiente" && <span className="text-[13px] text-neutral-400"> · no está cargado, va como pendiente</span>}
                          {!allowedFor(l.item, preview.sellerId) && <span className="text-[13px] text-accent"> · no es de esa médica</span>}
                          {l.item.kind === "producto" && l.qty > (l.item.available ?? 0) && (
                            <span className="text-[13px] text-neutral-400"> · sin stock cargado, se avisa al admin</span>
                          )}
                        </span>
                        <span className="whitespace-nowrap tabular-nums text-neutral-300">
                          {l.item.kind === "pendiente" ? "—" : money(preview.payment === "tarjeta" ? lineCard(l) : lineCash(l))}
                        </span>
                      </li>
                    ))}
                    {preview.unresolved.map((u, k) => (
                      <li key={`u${k}`} className="flex flex-wrap items-center gap-2 py-1">
                        <span className="text-[14px]">«{u.text}»: ¿cuál?</span>
                        {(u.candidates.some((c) => allowedFor(c, preview.sellerId)) ? u.candidates.filter((c) => allowedFor(c, preview.sellerId)) : u.candidates).map((c) => (
                          <button key={c.id} onClick={() => setChosen({ ...chosen, [u.text]: c.id })} className={CHIP}>
                            {c.name}
                          </button>
                        ))}
                      </li>
                    ))}
                  </ul>
                )}
                {nothing && <p className="text-[14px] text-neutral-400">Falta qué se hizo o se vendió.</p>}

                {/* Quién: lo dice el texto, se deduce o se toca acá */}
                {!isMedico &&
                  (preview.sellerId && !pickSeller && !notHers ? (
                    <p className="text-[14px] text-neutral-400">
                      Atiende <span className="text-fg">{sellers.find((x) => x.id === preview.sellerId)?.name}</span>
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-[14px] ${notHers ? "text-accent" : "text-neutral-400"}`}>
                        {notHers ? "Eso no lo hace la médica nombrada. ¿Quién la atendió?" : "¿Quién la atendió?"}
                      </span>
                      {(possible?.length ? possible : sellers).map((x) => (
                        <button key={x.id} onClick={() => setPickSeller(pickSeller === x.id ? null : x.id)} className={pickSeller === x.id ? CHIP_ON : CHIP}>
                          {x.name}
                        </button>
                      ))}
                    </div>
                  ))}

                {/* Pago: opcional */}
                <div className="flex flex-wrap items-center gap-2">
                  {PAYMENTS.map(([m, label]) => (
                    <button
                      key={m}
                      aria-pressed={preview.payment === m}
                      onClick={() => setPickPay(pickPay === m ? null : m)}
                      className={preview.payment === m ? CHIP_ON : CHIP}
                    >
                      {label}
                    </button>
                  ))}
                  {!preview.payment && <span className="text-[13px] text-neutral-500">pago opcional</span>}
                </div>
              </div>
            ) : (
              <p className="text-[13.5px] text-neutral-400">
                Sirve para pacientes y para ventas. Ej: «Gabriela vendió 2 cremas con tarjeta»
                {canExpense && <> · y para egresos: «pagué 5000 de luz»</>}.
              </p>
            )}

            <button onClick={go} disabled={expense ? busy : !canSave || busy || loading} className={CTA}>
              {busy
                ? "Guardando…"
                : expense
                  ? expense.concept && expense.amount
                    ? `Guardar egreso · ${money(expense.amount)}`
                    : "Completar el egreso"
                  : !preview
                  ? "Guardar"
                  : nothing
                    ? "Falta qué se hizo"
                    : pendingQ
                      ? "Tocá la opción correcta"
                      : missingSeller || notHers
                        ? "Elegí quién la atendió"
                        : `Guardar · ${money(preview.payment === "tarjeta" ? card : cash)}`}
            </button>
            {preview && !nothing && !expense && (
              <button
                onClick={() => {
                  setDraft(preview);
                  setMode("confirm");
                }}
                className="-mt-1 self-center py-1 text-[13.5px] text-neutral-400 underline-offset-4 hover:text-fg hover:underline"
              >
                Editar detalles (cantidades, precio de lo no cargado)
              </button>
            )}
            <button
              onClick={() => {
                setDraft(emptyDraft("manual", fixedSeller));
                setMode("manual");
              }}
              disabled={loading}
              className={`${GHOST} min-h-[44px] gap-3`}
            >
              <SquaresFourIcon size={20} /> Prefiero elegirlo de una lista
            </button>
            {canExpense && (
              <button onClick={() => setExpenseForm({})} className={`${GHOST} min-h-[44px] gap-3`}>
                <MinusIcon size={18} /> Anotar un egreso de plata
              </button>
            )}
          </div>
        </div>
      )}

      {mode === "manual" && (
        <ManualView
          items={items}
          sellers={sellers}
          isMedico={isMedico}
          fixedSeller={fixedSeller}
          draft={draft}
          setDraft={setDraft}
          busy={busy}
          onBack={() => setMode("idle")}
          onSave={() => save(draft)}
        />
      )}

      {mode === "confirm" && (
        <Confirm items={items} draft={draft} setDraft={setDraft} sellers={sellers} isMedico={isMedico} busy={busy} onSave={() => save(draft)} onEdit={() => setMode("idle")} />
      )}

      {mode === "idle" && (
        <Today
          sales={sales?.sales ?? null}
          expenses={canExpense ? (expensesData?.expenses ?? []) : []}
          highlight={lastVisit}
          onOpenClose={onOpenClose}
          onEdit={setEditing}
          onEditExpense={(e) => setExpenseForm({ expense: e })}
        />
      )}
      {expenseForm && <ExpenseForm {...expenseForm} onClose={() => setExpenseForm(null)} onSaved={expenseDone} />}
      {editing && (
        <EditVisit
          sales={editing}
          isMedico={isMedico}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setFlash("Cambios guardados");
            setTimeout(() => setFlash(null), 1400);
            refreshSales();
            refreshCatalog();
          }}
        />
      )}
    </div>
  );
}

/**
 * Editar algo ya anotado (desde «Hoy» o Ventas). Arma el borrador con lo guardado y al guardar
 * reemplaza la anotación (el servidor devuelve y vuelve a descontar el stock, y recalcula la comisión).
 */
export function EditVisit({ sales, isMedico, onClose, onSaved }: { sales: SaleRow[]; isMedico: boolean; onClose: () => void; onSaved: () => void }) {
  const [catalog] = usePoll<CatalogResponse>("/api/catalog", 60_000);
  const [sellersData] = usePoll<{ ok: boolean; sellers: { providerId: string; name: string; aliases: string[] }[] }>("/api/sellers", 60_000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const items: Item[] = useMemo(() => {
    const practices = (catalog?.practices ?? []).map((p): Item => ({ id: p.id, name: p.name, kind: "practica", price: p.price, cardPrice: p.cardPrice, providerIds: p.providerIds ?? [] }));
    const products = (catalog?.products ?? [])
      .filter((p) => p.price !== null && p.priceItemId)
      .map((p): Item => ({ id: p.priceItemId!, name: p.name, kind: "producto", price: p.price!, cardPrice: p.cardPrice, available: p.available, providerIds: p.providerIds ?? [] }));
    return [...practices, ...products];
  }, [catalog]);
  const sellers: Seller[] = useMemo(() => (sellersData?.sellers ?? []).map((x) => ({ id: x.providerId, name: x.name, aliases: x.aliases })), [sellersData]);
  const paid = sales.filter((x) => x.status === "paid");
  // Borrador inicial armado con lo guardado; lo que se toca después vive en `edited`.
  const initial = useMemo(() => {
    if (!catalog) return null;
    const first = paid[0];
    const d = emptyDraft("text", first?.providerId ?? null);
    d.patient = first?.patientName ?? "";
    d.payment = first?.paymentMethod ?? null;
    d.lines = paid.map((x) => {
      const it = x.itemId ? items.find((i) => i.id === x.itemId) : undefined;
      // Lo guardado manda: si el producto ahora tiene menos stock, igual se puede mantener.
      const item: Item = it
        ? { ...it, available: (it.available ?? 0) + (it.kind === "producto" ? x.quantity : 0) }
        : pendingItem(x.itemName, x.kind === "pendiente" ? x.unitPrice : 0);
      return { item, qty: x.quantity, sellerId: null };
    });
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, items]);
  const [edited, setDraft] = useState<Draft | null>(null);
  const draft = edited ?? initial;
  const key = paid[0]?.visitId ?? paid[0]?.id;

  async function save() {
    if (!draft || !key) return;
    setBusy(true);
    setErr("");
    const r = await fetch(`/api/visits/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        patientName: draft.patient.trim(),
        providerId: draft.sellerId,
        paymentMethod: draft.payment,
        lines: draft.lines.map((l) =>
          l.item.kind === "pendiente" ? { pendingName: l.item.name, pendingPrice: l.item.price || null, quantity: l.qty } : { itemId: l.item.id, quantity: l.qty },
        ),
      }),
    })
      .then((x) => x.json())
      .catch(() => ({ ok: false, error: "No se pudo conectar." }));
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "No se pudo guardar.");
    onSaved();
  }

  // Lo anotado en la Planilla (importes a mano, observaciones, «Atención» sin práctica) se corrige allá.
  const fromSheet = paid.some((x) => x.priceManual || x.commissionManual || x.observations || (!x.itemId && x.kind !== "pendiente"));

  return (
    <div className="cl-fade-in fixed inset-0 z-40 overflow-y-auto bg-black/60 px-4 py-10" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mx-auto w-full max-w-[640px]">
        {fromSheet ? (
          <div className="flex flex-col gap-3 rounded-xl bg-surface p-5">
            <p className="text-[14px]">Esto se anotó en la planilla (con importes o notas escritas a mano). Corregilo desde Ventas → Día.</p>
            <button onClick={onClose} className="self-start rounded-md border border-neutral-800 px-3 py-1.5 text-[13px] hover:bg-accent-900">
              Entendido
            </button>
          </div>
        ) : !draft ? (
          <p className="text-center text-neutral-300">Cargando…</p>
        ) : (
          <>
            <Confirm items={items} draft={draft} setDraft={(d) => setDraft(d)} sellers={sellers} isMedico={isMedico} busy={busy} onSave={save} onEdit={onClose} editing />
            {err && <p className="mt-3 rounded-xl bg-surface px-4 py-3 text-[14px] text-accent">{err}</p>}
          </>
        )}
      </div>
    </div>
  );
}

/** «¡Registrado!»: tilde animado y vuelve solo al inicio. */
function Registered({ summary, onClose }: { summary: string; onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      aria-live="polite"
      className="cl-fade-in fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-bg/85 px-6 text-center backdrop-blur-sm"
    >
      <span className="cl-pop flex h-24 w-24 items-center justify-center rounded-full bg-success text-on-success shadow-lg">
        <CheckIcon size={52} weight="bold" />
      </span>
      <span className="text-[22px] font-medium">¡Registrado!</span>
      {summary && <span className="max-w-[480px] text-[14px] text-neutral-300">{summary}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Modo lista: una sola pantalla (quién → qué → pago opcional → Guardar)
// ---------------------------------------------------------------------------

function ManualView({
  items,
  sellers,
  isMedico,
  fixedSeller,
  draft,
  setDraft,
  busy,
  onBack,
  onSave,
}: {
  items: Item[];
  sellers: Seller[];
  isMedico: boolean;
  fixedSeller: string | null;
  draft: Draft;
  setDraft: (d: Draft) => void;
  busy: boolean;
  onBack: () => void;
  onSave: () => void;
}) {
  const picked = new Set(draft.lines.map((l) => l.item.id));
  const toggle = (it: Item) =>
    setDraft({
      ...draft,
      lines: picked.has(it.id) ? draft.lines.filter((l) => l.item.id !== it.id) : [...draft.lines, { item: it, qty: 1, sellerId: null }],
    });
  const setQty = (id: string, qty: number) =>
    setDraft({ ...draft, lines: qty <= 0 ? draft.lines.filter((l) => l.item.id !== id) : draft.lines.map((l) => (l.item.id === id ? { ...l, qty } : l)) });
  const chooseSeller = (id: string) =>
    // Al cambiar de médica se sacan los ítems que no son suyos.
    setDraft({ ...draft, sellerId: id, lines: draft.lines.filter((l) => allowedFor(l.item, id)) });

  const mine = draft.sellerId ? items.filter((i) => allowedFor(i, draft.sellerId)) : items;
  const groups = [
    { title: "Prácticas", list: mine.filter((i) => i.kind === "practica") },
    { title: "Productos", list: mine.filter((i) => i.kind === "producto") },
  ].filter((g) => g.list.length);
  const cash = draft.lines.reduce((n, l) => n + lineCash(l), 0);
  const card = draft.lines.reduce((n, l) => n + lineCard(l), 0);
  const missingSeller = !isMedico && !draft.sellerId;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="flex min-h-11 items-center gap-2 rounded-xl py-2 pl-1.5 pr-3.5 text-[14px] font-medium hover:bg-neutral-900">
          <CaretLeftIcon size={20} weight="bold" /> Volver
        </button>
        <input
          value={draft.patient}
          onChange={(e) => setDraft({ ...draft, patient: e.target.value })}
          placeholder="Paciente (opcional)"
          aria-label="Paciente (opcional)"
          className="w-[220px] rounded-xl border border-neutral-800 bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent-600"
        />
      </div>

      {!fixedSeller && (
        <div className="flex flex-col gap-2.5">
          <h2 className="text-[15px] font-medium">¿Quién la atendió?</h2>
          <div className="flex flex-wrap gap-2">
            {sellers.map((x) => (
              <button key={x.id} onClick={() => chooseSeller(x.id)} aria-pressed={draft.sellerId === x.id} className={`${draft.sellerId === x.id ? CHIP_ON : CHIP} !px-5 !py-2.5 !text-[14px]`}>
                {x.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={`flex flex-col gap-4 transition-opacity ${missingSeller ? "pointer-events-none opacity-40" : ""}`} aria-disabled={missingSeller}>
        <h2 className="text-[15px] font-medium">¿Qué se hizo o se vendió?</h2>
        {groups.map((g) => (
          <div key={g.title} className="flex flex-col gap-2.5">
            {groups.length > 1 && <h3 className="text-[12px] font-medium uppercase tracking-[.08em] text-neutral-500">{g.title}</h3>}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {g.list.map((it) => {
                const line = draft.lines.find((l) => l.item.id === it.id);
                const out = it.kind === "producto" && (it.available ?? 0) <= 0;
                return (
                  <div
                    key={it.id}
                    className={`flex min-h-[56px] items-center gap-2 rounded-xl border pl-4 pr-2 transition-colors ${
                      line ? "border-fg bg-fg text-bg" : "border-neutral-800 bg-surface hover:border-accent"
                    }`}
                  >
                    <button onClick={() => toggle(it)} aria-pressed={!!line} className="flex min-w-0 flex-1 flex-col py-2.5 text-left">
                      <span className="text-[14px] font-medium leading-tight">{it.name}</span>
                      <span className={`text-[13px] ${line ? "opacity-70" : "text-neutral-400"}`}>
                        {money(it.price)}
                        {out && " · sin stock cargado"}
                      </span>
                    </button>
                    {line && (
                      <span className="flex items-center gap-1">
                        <button onClick={() => setQty(it.id, line.qty - 1)} aria-label="Uno menos" className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/10">
                          <MinusIcon size={16} weight="bold" />
                        </button>
                        <span className="min-w-5 text-center text-[15px] font-medium tabular-nums">{line.qty}</span>
                        <button onClick={() => setQty(it.id, line.qty + 1)} aria-label="Uno más" className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/10">
                          <PlusIcon size={16} weight="bold" />
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {!groups.length && <p className="text-neutral-400">No hay prácticas ni productos {draft.sellerId ? "asignados a esa médica" : "con precio"}. Los carga el admin en Stock.</p>}
        {draft.lines
          .filter((l) => l.item.kind === "pendiente")
          .map((l) => (
            <div key={l.item.id} className="flex items-center gap-3 rounded-xl border border-dashed border-accent-700 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">{l.item.name}</span>
                <span className="text-[13px] text-neutral-400">{l.item.price ? `Sin cargar · ${money(l.item.price)}` : "Sin cargar · el admin le pone precio"}</span>
              </span>
              <button aria-label={`Quitar ${l.item.name}`} onClick={() => toggle(l.item)} className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-neutral-900">
                <XIcon size={16} />
              </button>
            </div>
          ))}
        <AddPending onAdd={(name, price) => !picked.has(pendingItem(name).id) && toggle(pendingItem(name, price))} />
      </div>

      <div className="sticky bottom-0 -mx-5 flex flex-col gap-3 border-t border-neutral-900 bg-bg/95 px-5 pb-4 pt-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          {PAYMENTS.map(([m, label]) => (
            <button key={m} aria-pressed={draft.payment === m} onClick={() => setDraft({ ...draft, payment: draft.payment === m ? null : m })} className={draft.payment === m ? CHIP_ON : CHIP}>
              {label}
            </button>
          ))}
          {!draft.payment && <span className="text-[13px] text-neutral-500">pago opcional</span>}
        </div>
        <button onClick={onSave} disabled={busy || missingSeller || !draft.lines.length} className={CTA}>
          {busy
            ? "Guardando…"
            : missingSeller
              ? "Elegí quién la atendió"
              : !draft.lines.length
                ? "Marcá lo que se hizo o vendió"
                : `Guardar · ${money(draft.payment === "tarjeta" ? card : cash)}`}
        </button>
      </div>
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
      <button onClick={() => setOpen(true)} className="self-start py-1 text-[14.5px] font-medium text-accent underline-offset-4 hover:underline">
        ¿No está en la lista? Anotalo igual
      </button>
    );
  return (
    <div className={`flex flex-col gap-2 ${compact ? "" : "rounded-xl border border-neutral-800 p-4"}`}>
      {!compact && <span className="text-[14px] text-neutral-300">Escribí qué se hizo o vendió y, si lo sabés, cuánto se cobró. El admin después lo carga en la lista.</span>}
      <div className="flex flex-wrap gap-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && add()}
          placeholder="Ej: radiofrecuencia"
          className="min-w-[180px] flex-1 rounded-xl border border-neutral-800 bg-bg px-3 py-2 text-[14px] outline-none focus:border-accent-600"
        />
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && add()}
          inputMode="numeric"
          placeholder="Precio $ (opcional)"
          aria-label="Cuánto se cobró (opcional)"
          className="w-[170px] rounded-xl border border-neutral-800 bg-bg px-3 py-2 text-[14px] outline-none focus:border-accent-600"
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
        className="rounded-xl border border-neutral-800 bg-bg px-3 py-2 text-[14px] outline-none focus:border-accent-600"
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
  editing,
}: {
  items: Item[];
  draft: Draft;
  setDraft: (d: Draft) => void;
  sellers: Seller[];
  isMedico: boolean;
  busy: boolean;
  onSave: () => void;
  onEdit: () => void;
  /** Editando algo ya guardado: cambian los textos de los botones. */
  editing?: boolean;
}) {
  const [pickWho, setPickWho] = useState(false);
  const [adding, setAdding] = useState(false);
  // Renglón no entendido que se está resolviendo: "lista" (buscar) o "pendiente" (anotarlo igual).
  const [fixing, setFixing] = useState<{ k: number; mode: "lista" | "pendiente" } | null>(null);
  const sellerName = (id: string | null) => sellers.find((s) => s.id === id)?.name ?? null;
  const isVisit = !!draft.patient.trim() || draft.lines.some((l) => l.item.kind !== "producto");
  const possible = sellersFor(draft.lines, sellers);
  // Si lo anotado lo puede hacer una sola médica, es ella.
  const inferred = !draft.sellerId && possible?.length === 1 ? possible[0].id : null;
  useEffect(() => {
    if (inferred) setDraft({ ...draft, sellerId: inferred });
  }, [inferred, draft, setDraft]);
  const missingSeller = !isMedico && !inferred && draft.lines.some((l) => !(l.sellerId ?? draft.sellerId));
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
    <section className="flex animate-cl-in flex-col gap-6 rounded-xl border border-neutral-800 bg-surface p-5 sm:p-7">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-tag-bg px-3.5 py-1 text-[13px] font-medium text-tag-fg">{isVisit ? "Paciente" : "Venta"}</span>
        <span className="text-[14px] text-neutral-300">{editing ? "Editando lo anotado" : "¿Está bien así?"}</span>
      </div>

      {draft.patientUnsure && (
        <div className="flex flex-col gap-3 rounded-xl border border-accent-700 p-4">
          <span className="text-[14px]">
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
          className="border-b-2 border-neutral-800 bg-transparent pb-1 text-[18px] font-medium leading-tight outline-none placeholder:font-medium placeholder:text-neutral-600 focus:border-accent-600 sm:text-[22px]"
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
              <span className="min-w-8 text-center text-[16px] font-medium tabular-nums">{l.qty}</span>
              <button
                onClick={() => setQty(i, l.qty + 1)}
                aria-label="Uno más"
                className={ROUND}
              >
                <PlusIcon size={18} weight="bold" />
              </button>
            </span>
            <span className="min-w-0 flex-1 text-[15px] font-medium leading-tight sm:text-[16px]">
              {l.item.name}
              {notHers(l) && (
                <span className="block text-[13.5px] font-medium text-accent">
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
              <label className="flex items-center gap-1 rounded-xl border border-neutral-800 px-2.5 py-1 focus-within:border-accent-600">
                <span className="text-[14px] text-neutral-400">$</span>
                <input
                  value={l.item.price ? l.item.price.toLocaleString("es-AR") : ""}
                  onChange={(e) => setPrice(i, toPesos(e.target.value))}
                  inputMode="numeric"
                  placeholder="precio"
                  aria-label={`Cuánto se cobró ${l.item.name} (por unidad)`}
                  className="w-[96px] bg-transparent text-right text-[14px] tabular-nums outline-none placeholder:text-neutral-600"
                />
              </label>
            ) : (
              <span className="text-[14px] tabular-nums text-neutral-300">{money((draft.payment === "tarjeta" ? cardOf(l.item) : l.item.price) * l.qty)}</span>
            )}
          </li>
        ))}
        {draft.unresolved.map((u, k) => (
          <li key={`u-${k}`} className="flex flex-col gap-2 rounded-xl border border-dashed border-neutral-700 p-4">
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
        <li>
          {adding ? (
            <SearchItems
              items={items}
              sellerId={draft.sellerId}
              onPick={(it) => {
                setAdding(false);
                setDraft({ ...draft, lines: [...draft.lines, { item: it, qty: 1, sellerId: null }] });
              }}
            />
          ) : (
            <button onClick={() => setAdding(true)} className="py-1 text-[14px] font-medium text-accent underline-offset-4 hover:underline">
              + Agregar algo
            </button>
          )}
        </li>
      </ul>

      {/* Quién y cómo pagó */}
      <div className="flex flex-col gap-3">
        {!isMedico && (missingSeller || pickWho) ? (
          <div className="flex flex-col gap-2">
            <span className="text-[14px] text-neutral-300">{isVisit ? "¿Quién la atendió?" : "¿Quién lo vendió?"}</span>
            <div className="flex flex-wrap gap-2">
              {(possible?.length ? possible : sellers).map((s) => (
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
          <p className="text-[14px] text-neutral-300">
            {whoNames.join(" y ") || "—"}
            {!isMedico && (
              <button onClick={() => setPickWho(true)} className="ml-3 text-[13.5px] text-accent underline-offset-4 hover:underline">
                Cambiar
              </button>
            )}
          </p>
        )}
        <div className="flex flex-wrap gap-2" role="group" aria-label="¿Cómo pagó?">
          {PAYMENTS.map(([m, label]) => (
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
        <p className="font-display text-[22px] font-medium tracking-[-.02em] tabular-nums sm:text-[24px]">
          {money(draft.payment === "tarjeta" ? card : cash)}
        </p>
        {!draft.payment && card !== cash && <p className="text-[14px] text-neutral-400">o {money(card)} si paga con tarjeta</p>}
        {pendingCount > 0 && (
          <p className="text-[14px] text-neutral-400">+ {pendingCount === 1 ? "1 cosa sin precio" : `${pendingCount} cosas sin precio`} todavía (lo completa el admin)</p>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <button onClick={onSave} disabled={busy || blocked} className={`${CTA} flex-[2_1_220px]`}>
          {busy
            ? "Guardando…"
            : missingSeller
              ? "Falta quién"
              : draft.unresolved.length || anyNotHers || draft.patientUnsure
                ? "Revisá lo marcado"
                : editing
                  ? "Guardar cambios"
                  : "Sí, guardar"}
        </button>
        <button onClick={onEdit} className={`${GHOST} min-h-[56px] flex-[1_1_160px]`}>
          {editing ? "Cancelar" : "Corregir"}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// «Hoy»: lo anotado en el día, agrupado por anotación
// ---------------------------------------------------------------------------

type TodaySale = SaleRow;

function Today({
  sales,
  expenses,
  highlight,
  onOpenClose,
  onEdit,
  onEditExpense,
}: {
  sales: TodaySale[] | null;
  expenses: Expense[];
  highlight: string | null;
  onOpenClose: () => void;
  onEdit: (rows: SaleRow[]) => void;
  onEditExpense: (e: Expense) => void;
}) {
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
        rows: g,
        createdAt: g[g.length - 1].createdAt,
        expense: null as Expense | null,
      };
    });
  }, [sales]);
  const all = useMemo(
    () =>
      [
        ...rows,
        ...expenses.map((e) => ({
          key: e.id,
          time: fmtTime(e.createdAt),
          label: `Egreso · ${e.concept}`,
          patient: false,
          product: false,
          total: -e.amount,
          rows: [] as SaleRow[],
          createdAt: e.createdAt,
          expense: e as Expense | null,
        })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [rows, expenses],
  );
  const outflow = expenses.reduce((n, e) => n + e.amount, 0);
  if (!sales) return null;
  const total = rows.reduce((n, r) => n + r.total, 0);
  const patients = rows.filter((r) => r.patient).length;
  const ventas = rows.filter((r) => r.product).length;

  return (
    <section className="mt-6 flex flex-col">
      <div className="flex items-baseline justify-between gap-3 border-b border-neutral-800 pb-3">
        <span className="text-[14px] text-neutral-300">
          Hoy
          {rows.length > 0 && (
            <span className="text-neutral-500">
              {" "}
              · {patients} {patients === 1 ? "paciente" : "pacientes"} · {ventas} {ventas === 1 ? "venta" : "ventas"}
            </span>
          )}
        </span>
        <span className="whitespace-nowrap text-[15px] font-medium tabular-nums">{money(total)}</span>
      </div>
      {outflow > 0 && (
        <div className="flex items-baseline justify-between gap-3 border-b border-neutral-800 py-2 text-[13px] text-neutral-400">
          <span>Egresos · queda {money(total - outflow)}</span>
          <span className="tabular-nums">− {money(outflow)}</span>
        </div>
      )}
      {all.map((r) => (
        <button
          key={r.key}
          onClick={() => (r.expense ? onEditExpense(r.expense) : onEdit(r.rows))}
          title="Tocá para editar"
          className={`-mx-2 flex justify-between gap-4 rounded-lg border-b border-neutral-900 px-2 py-3.5 text-left text-[14px] transition-colors hover:bg-neutral-900 sm:text-[14px] ${r.key === highlight ? "cl-flash-row" : ""}`}
        >
          <span className="min-w-0">
            <span className="mr-3.5 tabular-nums text-neutral-500">{r.time}</span>
            {r.label}
          </span>
          <span className="whitespace-nowrap tabular-nums text-neutral-300">{r.total < 0 ? `− ${money(-r.total)}` : money(r.total)}</span>
        </button>
      ))}
      {!all.length && <p className="py-4 text-[14px] text-neutral-500">Todavía no se anotó nada hoy.</p>}
      {all.length > 0 && <p className="pt-2 text-[13px] text-neutral-500">Tocá una fila para corregirla.</p>}
      <button onClick={onOpenClose} className="mt-4 self-start py-2 text-[14px] font-medium text-accent underline-offset-4 hover:underline">
        Ver el cierre del día →
      </button>
    </section>
  );
}

const CTA =
  "flex min-h-12 items-center justify-center rounded-lg border border-accent bg-accent px-5 text-[15px] font-medium text-on-accent transition-opacity hover:opacity-85 active:opacity-70 disabled:cursor-not-allowed disabled:border-neutral-800 disabled:bg-neutral-900 disabled:text-neutral-500";
const GHOST =
  "flex items-center justify-center rounded-lg border border-neutral-800 px-4 text-[14px] text-neutral-300 transition-colors hover:border-accent-700 hover:bg-accent-900 hover:text-fg";
const ROUND =
  "flex h-9 w-9 items-center justify-center rounded-md border border-neutral-800 text-fg transition-colors hover:bg-accent-900 disabled:opacity-30";
const CHIP = "rounded-pill border border-neutral-700 px-3 py-1.5 text-[13px] transition-colors hover:border-accent hover:bg-accent-900";
const CHIP_ON = "rounded-pill border border-accent bg-accent px-3 py-1.5 text-[13px] text-on-accent";
