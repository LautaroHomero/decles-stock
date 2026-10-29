"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ArrowsLeftRightIcon,
  CaretLeftIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  CreditCardIcon,
  CurrencyDollarIcon,
  HandCoinsIcon,
  MinusIcon,
  MoneyIcon,
  PlusIcon,
  SquaresFourIcon,
  StackIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { Actor } from "@/lib/domain/types";
import { parseNote, searchScore, suggest } from "@/lib/domain/quick-sale";
import { parseExpense } from "@/lib/domain/expense-note";
import { parsePrepaidNote, prepaidPatient, samePatient, SAYS_PREPAID, USES_PREPAID } from "@/lib/domain/prepaid-note";
import { parsePayable, parsePayablePayment } from "@/lib/domain/payable-note";
import { depositPatient, parseDepositNote, USES_DEPOSIT } from "@/lib/domain/deposit-note";
import type { DepositRow } from "./senas";
import { realNowIso } from "@/lib/domain/clock";
import { PAY_METHODS, PayableReminderPicker, payableRemindText, type PayableRow, type PayMethod } from "./deudas-consultorio";
import { debtorName, extractMoney, fractionsToPesos, parseDebtPayment, parsePayout, parseProviderDebt, splitPaid, splitParts, splitPesos, type MoneyNote, type Split } from "@/lib/domain/money-note";
import { ExpenseForm, type Expense, type ExpensesResponse } from "./egresos";
import { ReminderPicker, remindLabel } from "./debt-reminder";
import { firstName, greeting } from "./ui";
import { Toast, call, fmtTime, money, usePoll, useToast, useToday, useDolar, type CatalogResponse, type Cut, type Payment, type PaymentsMap, type SaleRow, PAYMENTS } from "./shared";

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
  giftCard?: boolean;
  /** % de comisión propio del ítem (null = el de la médica). */
  pct?: number | null;
  /** Lo que se lleva cada profesional en este ítem, si es distinto (% o plata fija por unidad). */
  cuts?: Record<string, Cut>;
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
  /** % de comisión de la profesional. */
  pct?: number;
  /** Es admin del consultorio (la dueña): no cobra comisión, todo va para el consultorio. */
  owner?: boolean;
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
  /** Lo que ingresó (null = el precio de lista). 0 = le pagaron directo a la profesional / abono. */
  paid: number | null;
  /** Abono: no pasó por caja. (Pagado directo a la profesional es el medio «profesional».) */
  direct: boolean;
  /** Medio «profesional»: lo nuestro que nos debe ella («nos debe 36000»); null = el resto de su parte. */
  owesUs: number | null;
  /** Lo que le corresponde a la profesional, si se aclaró (null = según su %). */
  share: number | null;
  /** Pagó con varios medios o en dólares (null = un solo medio, o sin cargar). */
  split: Split | null;
  /** Lo que quedó debiendo (null = nada). */
  debt: number | null;
  /** «debe todo» / «fiado»: no pagó nada y debe lo que salía. */
  debtAll: boolean;
  /** Día para acordarse de cobrar la deuda (AAAA-MM-DD), dicho en el texto o elegido. */
  remindOn: string | null;
  /** «la mitad en efectivo y la mitad con tarjeta» (sin importes): se pasa a pesos con el precio. */
  fractions: MoneyNote["fractions"];
  /** «pagó en dólares» sin cantidad: los dólares salen de lo que salía y la cotización del día. */
  usdAll: boolean;
  /** Sesión de un abono: ese renglón no pasa por caja. */
  prepaidId?: string | null;
  /** Atención por obra social / prepaga (OSMECON): las prácticas no pasan por caja. */
  insurerId?: string | null;
  /** Seña que se descuenta: paga solo el resto. */
  depositId?: string | null;
}
type Insurer = { id: string; name: string; fee: number; active: boolean };
/** «por osmecon», «con la prepaga osmecon», «osmecon»: la obra social nombrada y el texto sin esa parte. */
function insurerIn(text: string, insurers: Insurer[]): { insurer: Insurer; cleaned: string } | null {
  const n = normQ(text);
  for (const i of insurers) {
    if (!i.active) continue;
    const name = normQ(i.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = n.match(new RegExp(String.raw`(?:\b(?:por|con|de|x|via)\s+)?(?:(?:la\s+)?(?:obra\s+social|prepaga|os)\s+)?\b${name}\b`));
    if (m) return { insurer: i, cleaned: text.slice(0, m.index!) + " " + text.slice(m.index! + m[0].length) };
  }
  return null;
}
/** Abono abierto (espejo de `Prepaid` de src/lib/domain/prepaids.ts). */
type OpenPrepaid = { id: string; patient: string; itemId: string; itemName: string; unitPrice: number; sessions: number | null; amount: number; used: number; sessionsLeft: number; balance: number };
const prepaidLeft = (p: OpenPrepaid) =>
  p.sessions !== null
    ? `${p.sessionsLeft === 1 ? "queda 1 sesión" : `quedan ${p.sessionsLeft} sesiones`} de ${p.sessions}`
    : `le quedan ${money(p.balance)} (${p.sessionsLeft === 1 ? "1 sesión" : `${p.sessionsLeft} sesiones`} a ${money(p.unitPrice)})`;

const cardOf = (i: Item) => i.cardPrice ?? i.price;
const emptyDraft = (from: Draft["from"], sellerId: string | null): Draft => ({
  from,
  patient: "",
  sellerId,
  payment: null,
  lines: [],
  unresolved: [],
  patientUnsure: false,
  paid: null,
  direct: false,
  owesUs: null,
  share: null,
  split: null,
  debt: null,
  debtAll: false,
  remindOn: null,
  fractions: null,
  usdAll: false,
});

/** Lo escrito → borrador. Lo que no se encuentra en la lista queda como pendiente (lo resuelve el admin). */
function buildDraft(text: string, items: Item[], sellers: Seller[], fixedSeller: string | null): Draft {
  // La plata primero («45000», «le transfirieron a carmen», «le corresponden 9000»): el resto es paciente, médica y qué.
  const money = extractMoney(text);
  const { lines, patient, patientSure, seller, payment } = parseNote(money.text, items, sellers);
  const d = emptyDraft("text", fixedSeller);
  d.paid = money.paid;
  d.direct = money.direct && !money.toProvider;
  d.share = money.share;
  // «le transfirieron a carmen»: medio «a la profesional» (vale lo que salía; no entra a la caja).
  if (money.toProvider) d.payment = "profesional";
  d.owesUs = money.owesUs;
  d.split = money.split;
  d.debt = money.debt;
  d.debtAll = money.debtAll;
  d.remindOn = money.remindOn;
  d.fractions = money.fractions;
  d.usdAll = money.usdAll;
  if (money.method) d.payment = money.method;
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

/** Toda práctica es de un paciente: con una práctica anotada, el nombre es obligatorio. */
const hasPractice = (lines: Line[]) => lines.some((l) => l.item.kind === "practica");

const lineCash = (l: Line) => l.item.price * l.qty;
const lineCard = (l: Line) => cardOf(l.item) * l.qty;
/** Precio de lista de un renglón según el medio de pago. */
const lineList = (l: Line, payment: Payment | null) => (payment === "tarjeta" ? lineCard(l) : lineCash(l));
/** Lo que ingresó por cada renglón: lo escrito repartido (productos a lista, el resto a la práctica). */
const lineAmounts = (d: Draft) =>
  splitPaid(
    d.lines.map((l) => ({ list: lineList(l, d.payment), product: l.item.kind === "producto" })),
    d.paid,
  );
/** La parte de la profesional según su % (o el del ítem), sobre lo que ingresó. */
/** Lo que ingresó: lo escrito, o la lista menos lo que quedó debiendo. */
const shownPaid = (d: Draft) => d.paid ?? Math.max(0, d.lines.reduce((n, l) => n + lineList(l, d.payment), 0) - (d.debt ?? 0));

/** «Queda debiendo»: se anota como deuda a nombre del paciente (el admin recibe el aviso). */
function DebtInput({ draft, setDraft, width = "w-[140px]" }: { draft: Draft; setDraft: (d: Draft) => void; width?: string }) {
  return (
    <label className="flex flex-wrap items-center gap-2">
      <span className={`${width} text-neutral-400`}>Queda debiendo</span>
      <input
        value={draft.debt ? `$ ${draft.debt.toLocaleString("es-AR")}` : ""}
        onChange={(e) => {
          const debt = toPesos(e.target.value) || null;
          // Si lo que ingresó era automático, se recalcula solo (lista − deuda).
          if (!draft.split) return setDraft({ ...draft, debt, debtAll: false });
          // Con varios medios: lo que se debe se descuenta de las partes (primero efectivo) para no pasarse de la lista.
          const list = draft.lines.reduce((n, l) => n + lineCash(l), 0);
          const sp = { ...draft.split };
          let over = sp.efectivo + sp.transferencia + sp.tarjeta + (debt ?? 0) - list;
          for (const m of ["efectivo", "transferencia", "tarjeta"] as const) {
            if (over <= 0) break;
            const cut = Math.min(sp[m], over);
            sp[m] -= cut;
            over -= cut;
          }
          setDraft({ ...draft, debt, debtAll: false, split: sp, paid: sp.efectivo + sp.transferencia + sp.tarjeta + Math.round(sp.usd * (sp.rate ?? 0)) });
        }}
        inputMode="numeric"
        placeholder="$ 0"
        className={MONEY_IN}
      />
      <span className="text-[13px] text-neutral-500">{draft.debt ? "se anota como deuda · el admin recibe el aviso" : "si pagó una parte"}</span>
    </label>
  );
}

function autoShare(d: Draft, sellers: Seller[], deposit?: { amount: number; itemId: string | null } | null): number {
  const amounts = lineAmounts(d);
  // Con seña, la profesional cobra sobre el total de esa práctica (lo de hoy + la seña), como lo calcula el servidor.
  if (deposit) {
    const at = deposit.itemId ? d.lines.findIndex((l) => l.item.id === deposit.itemId) : -1;
    const i = at >= 0 ? at : d.lines.findIndex((l) => l.item.kind !== "producto");
    if (i >= 0) amounts[i] += deposit.amount;
  }
  return d.lines.reduce((n, l, i) => {
    const sid = l.sellerId ?? d.sellerId;
    if (sellers.find((s) => s.id === sid)?.owner) return n;
    const cut = sid ? l.item.cuts?.[sid] : undefined;
    if (cut?.fixed !== null && cut?.fixed !== undefined) return n + (amounts[i] === 0 ? 0 : cut.fixed * l.qty);
    const pct = cut?.pct ?? l.item.pct ?? sellers.find((s) => s.id === sid)?.pct ?? 0;
    return n + Math.round((amounts[i] * pct) / 100);
  }, 0);
}
/** Renglones para `/api/visits` con lo que ingresó y, si se aclaró, la parte de la profesional. */
function visitLines(d: Draft) {
  const amounts = lineAmounts(d);
  const kAt = Math.max(0, d.lines.findIndex((l) => l.item.kind !== "producto"));
  return d.lines.map((l, i) => {
    const money = {
      ...(d.paid !== null ? { amount: amounts[i] } : {}),
      ...(d.share !== null ? { commission: i === kAt ? d.share : 0 } : {}),
    };
    return l.item.kind === "pendiente"
      ? { pendingName: l.item.name, pendingPrice: (d.paid !== null ? Math.round(amounts[i] / l.qty) : l.item.price) || null, quantity: l.qty, ...money }
      : { itemId: l.item.id, quantity: l.qty, ...money };
  });
}
const summaryOf = (d: Draft) =>
  [d.patient.trim(), d.lines.map((l) => `${l.qty > 1 ? `${l.qty} ` : ""}${l.item.name}`).join(", "), d.debt ? `debe ${money(d.debt)}` : ""]
    .filter(Boolean)
    .join(" · ");
/** «carla díaz» → «Carla Díaz». */
const titleCase = (s: string) => s.trim().replace(/\s+/g, " ").replace(/(^|\s)(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
type OpenDebt = { id: string; debtor: string; concept: string; amount: number; paid: number; remaining: number; providerName: string | null; createdAt: string };

export function AnotarView({ actor, onOpenClose }: { actor: Actor; onOpenClose: () => void }) {
  const [catalog, refreshCatalog] = usePoll<CatalogResponse>("/api/catalog", 30_000);
  const [sellersData] = usePoll<{ ok: boolean; sellers: { providerId: string; name: string; aliases: string[]; commissionPct: number; owner?: boolean }[] }>(
    "/api/sellers",
    60_000,
  );
  const [sales, refreshSales] = usePoll<{ ok: boolean; sales: SaleRow[] }>("/api/sales", 30_000);
  const [toast, showToast] = useToast();
  const isMedico = actor.role === "medico";
  // Egresos de plata: los anota la secretaría o el admin.
  const canExpense = !isMedico;
  const [expensesData, refreshExpenses] = usePoll<ExpensesResponse>("/api/expenses", 30_000);
  const [expenseForm, setExpenseForm] = useState<{ expense?: Expense; initial?: { concept: string; amount: number } } | null>(null);

  const items: Item[] = useMemo(() => {
    const practices = (catalog?.practices ?? []).map((p): Item => ({ id: p.id, name: p.name, kind: "practica", price: p.price, cardPrice: p.cardPrice, providerIds: p.providerIds ?? [], pct: p.commissionPct, cuts: p.providerCuts }));
    const products = (catalog?.products ?? [])
      .filter((p) => p.price !== null && p.priceItemId)
      .map((p): Item => ({ id: p.priceItemId!, name: p.name, kind: "producto", price: p.price!, cardPrice: p.cardPrice, available: p.available, giftCard: p.giftCard, providerIds: p.providerIds ?? [], pct: p.commissionPct, cuts: p.providerCuts }));
    return [...practices, ...products];
  }, [catalog]);
  const sellers: Seller[] = useMemo(
    () => (sellersData?.sellers ?? []).map((s) => ({ id: s.providerId, name: s.name, aliases: s.aliases, pct: s.commissionPct, owner: !!s.owner })),
    [sellersData],
  );
  // La médica anota a su nombre; con una sola médica en el consultorio, queda elegida sola.
  const fixedSeller = isMedico ? (sellers[0]?.id ?? null) : sellers.length === 1 ? sellers[0].id : null;

  const [mode, setMode] = useState<"idle" | "manual" | "confirm">("idle");
  const [text, setText] = useState("");
  // Lo que se toca en la vista previa (si el texto no lo dice).
  const [pickSeller, setPickSeller] = useState<string | null>(null);
  const [pickPay, setPickPay] = useState<Payment | "varios" | null>(null);
  // Partes tocadas a mano (varios medios / dólares).
  const [pickSplit, setPickSplit] = useState<Split | null>(null);
  const [dolar] = useDolar();
  const rate = dolar?.rate ?? null;
  // Plata tocada en la vista previa: lo que ingresó y la parte de la profesional (null = lo del texto / automático).
  const [pickPaid, setPickPaid] = useState<string | null>(null);
  const [pickShare, setPickShare] = useState<string | null>(null);
  // Lo que quedó debiendo, tocado en la vista previa (null = lo del texto; "" = nada).
  const [pickDebt, setPickDebt] = useState<string | null>(null);
  // Recordatorio elegido en la vista previa (undefined = lo que dice el texto).
  const [pickRemind, setPickRemind] = useState<string | null | undefined>(undefined);
  // Respuestas tocadas en la vista previa: «crema» → cuál, y si el nombre dudoso es la paciente.
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [unsureIs, setUnsureIs] = useState<"patient" | "item" | null>(null);
  // Paciente escrito en la vista previa cuando el texto no lo nombra.
  const [pickPatient, setPickPatient] = useState("");
  const [giftCardKind, setGiftCardKind] = useState<"amount" | "treatment">("amount");
  const [giftCardTreatmentId, setGiftCardTreatmentId] = useState("");
  const [giftCardBuyer, setGiftCardBuyer] = useState("");
  const [giftCardCodeInput, setGiftCardCodeInput] = useState("");
  const [giftCardFound, setGiftCardFound] = useState<{ code: string; kind: "amount" | "treatment"; balance: number; treatmentItemId: string | null; treatmentName: string | null } | null>(null);
  const [giftCardError, setGiftCardError] = useState("");
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

  // Abonos abiertos: si la paciente tiene uno de lo que se hizo, se pregunta si la sesión es del abono.
  const [prepaidsData, refreshPrepaids] = usePoll<{ ok: boolean; prepaids: OpenPrepaid[] }>("/api/prepaids", 60_000);
  const openPrepaids = useMemo(() => (prepaidsData?.ok ? prepaidsData.prepaids : []), [prepaidsData]);
  const [pickAbono, setPickAbono] = useState<boolean | null>(null);
  const [pickAbonoId, setPickAbonoId] = useState<string | null>(null);
  // Obras sociales (OSMECON): «botox a carla por osmecon» → no entra plata, la profesional se lleva el monto fijo.
  const [insurersData] = usePoll<{ ok: boolean; insurers: Insurer[] }>("/api/insurers", 300_000);
  const insurers = useMemo(() => (insurersData?.ok ? insurersData.insurers : []), [insurersData]);
  const [pickInsurer, setPickInsurer] = useState<string | null | undefined>(undefined);
  // Señas: si la paciente dejó una, se descuenta (paga el resto).
  const [depositsData, refreshDeposits] = usePoll<{ ok: boolean; deposits: DepositRow[] }>("/api/deposits", 60_000);
  const openDeposits = useMemo(() => (depositsData?.ok ? depositsData.deposits : []), [depositsData]);
  const [pickDeposit, setPickDeposit] = useState<boolean | null>(null);

  // Vista previa en vivo de lo escrito.
  const preview = useMemo(() => {
    if (!typed.trim() || !items.length) return null;
    const named = insurerIn(typed, insurers);
    const insurer = pickInsurer === undefined ? (named?.insurer ?? null) : (insurers.find((i) => i.id === pickInsurer) ?? null);
    const text = named && insurer?.id === named.insurer.id ? named.cleaned : typed;
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
    // Hay práctica y el texto no nombra al paciente: se pregunta en la vista previa.
    const askPatient = (hasPractice(d.lines) || !!insurer) && !d.patient.trim() && !d.patientUnsure;
    if (askPatient) d.patient = pickPatient.trim();
    // Abono: «con abono» lo usa; si dijo cuánto pagó, no; si no dijo nada, se pregunta.
    // «plan» / «abonado» solos también: es una sesión del plan («carla, plan»).
    const saysAbono = USES_PREPAID.test(normQ(text)) || (SAYS_PREPAID.test(normQ(text)) && !parsePrepaidNote(text));
    if (saysAbono) d.lines = d.lines.filter((l) => !(l.item.kind === "pendiente" && /^(?:plan|abono|abonad[oa]s?)$/.test(normQ(l.item.name))));
    if (saysAbono) d.unresolved = d.unresolved.filter((u) => !/^(?:plan|abono|abonad[oa]s?)$/.test(normQ(u.text)));
    let abono = d.patient.trim() ? (openPrepaids.find((p) => samePatient(p.patient, d.patient) && d.lines.some((l) => l.item.id === p.itemId)) ?? null) : null;
    // Sin decir la práctica: la del plan de esa paciente (si tiene más de uno, se pregunta cuál).
    let abonoChoices: OpenPrepaid[] = [];
    if (!abono && saysAbono && d.patient.trim() && !hasPractice(d.lines)) {
      const mine = openPrepaids.filter((p) => samePatient(p.patient, d.patient));
      const pick = mine.find((p) => p.id === pickAbonoId) ?? (mine.length === 1 ? mine[0] : null);
      if (pick) {
        d.lines.push({ item: items.find((i) => i.id === pick.itemId) ?? pendingItem(pick.itemName), qty: 1, sellerId: null });
        d.patientUnsure = false;
        abono = pick;
      } else abonoChoices = mine;
    }
    if (abonoChoices.length) d.patientUnsure = false;
    const useAbono = abono ? (pickAbono ?? (saysAbono ? true : d.paid !== null && !d.direct ? false : null)) : false;
    if (abono && useAbono) {
      d.direct = false;
      d.prepaidId = abono.id;
      if (pickPaid === null) d.paid = d.lines.filter((l) => l.item.id !== abono.itemId).reduce((n, l) => n + lineCash(l), 0);
    }
    if (pickPaid !== null) d.paid = toPesos(pickPaid);
    if (pickShare !== null) d.share = pickShare.trim() === "" ? null : toPesos(pickShare);
    // «la mitad en efectivo y la mitad con tarjeta»: las partes salen del precio (o de lo que dijo que pagó).
    if (d.fractions && !pickPay && pickPaid === null) {
      const fx = fractionsToPesos(d.fractions, d.paid ?? d.lines.reduce((n, l) => n + lineCash(l), 0), rate);
      const used = (["efectivo", "transferencia", "tarjeta"] as const).filter((m) => fx.split[m] > 0);
      // Con dólares (aunque sea una sola parte) va por partes: los dólares se cuentan aparte.
      if (used.length > 1 || d.fractions.usd > 0) d.split = fx.split;
      else if (used.length === 1) {
        d.payment = used[0];
        d.paid = fx.split[used[0]];
      }
      if (fx.debt && d.debt === null) d.debt = fx.debt;
    }
    // «pagó en dólares»: lo que salía (o lo escrito en pesos) pasado a dólares con la cotización del día.
    if (d.usdAll && !d.split && !pickPay) {
      const pesos = d.paid ?? d.lines.reduce((n, l) => n + lineCash(l), 0) - (d.debt ?? 0);
      d.split = { efectivo: 0, transferencia: 0, tarjeta: 0, usd: rate && pesos > 0 ? Math.round((pesos / rate) * 100) / 100 : 0 };
      d.payment = null;
    }
    // Medio: lo tocado manda sobre lo escrito. «Dólares» y «Varios» usan partes; los demás, un solo medio.
    const list = d.lines.reduce((n, l) => n + lineCash(l), 0);
    if (pickPay === "dolares") {
      d.split = pickSplit ?? { efectivo: 0, transferencia: 0, tarjeta: 0, usd: d.split?.usd ?? 0 };
      d.payment = null;
    } else if (pickPay === "varios") {
      d.split = pickSplit ?? d.split ?? { efectivo: d.paid ?? list, transferencia: 0, tarjeta: 0, usd: 0 };
      d.payment = null;
    } else if (pickPay) {
      d.split = null;
      d.payment = pickPay;
    } else if (d.split) {
      if (pickSplit) d.split = pickSplit;
      d.payment = null;
    }
    // Con partes, lo que ingresó es su suma (los dólares a la cotización del día).
    if (d.split) d.paid = splitPesos(d.split, rate);
    // Deuda: «debe todo» = lo que salía; «debe 40000» sin decir cuánto pagó = pagó el resto.
    const listNow = d.lines.reduce((n, l) => n + lineList(l, d.payment), 0);
    if (d.debtAll) d.debt = listNow || null;
    if (pickDebt !== null) d.debt = pickDebt.trim() === "" ? null : toPesos(pickDebt) || null;
    if (d.debt && d.paid === null && pickPaid === null && d.lines.length) d.paid = Math.max(0, listNow - d.debt);
    // Si debe, hay que saber quién: se pregunta como con las prácticas.
    const askPatient2 = askPatient || (!!d.debt && d.lines.length > 0 && !d.patient.trim() && !d.patientUnsure);
    if (askPatient2 && !askPatient) d.patient = pickPatient.trim();
    if (pickRemind !== undefined) d.remindOn = pickRemind;
    // Seña: la paciente dejó una (para esta práctica, o sin práctica definida) → se descuenta, paga el resto.
    const deposit =
      d.patient.trim() && !(abono && useAbono)
        ? (openDeposits.find((x) => samePatient(x.patient, d.patient) && (!x.itemId || d.lines.some((l) => l.item.id === x.itemId)) && hasPractice(d.lines)) ?? null)
        : null;
    const useDeposit = deposit ? (pickDeposit ?? true) : false;
    if (deposit && useDeposit) {
      d.depositId = deposit.id;
      d.direct = false;
      const listCash = d.lines.reduce((n, l) => n + lineList(l, d.payment), 0);
      if (pickPaid === null && !d.split && (d.paid === null || USES_DEPOSIT.test(normQ(text)))) d.paid = Math.max(0, listCash - deposit.amount);
    }
    // Obra social: las prácticas no pasan por caja (los productos sí).
    const byInsurer = insurer && !(abono && useAbono) ? insurer : null;
    if (byInsurer) {
      d.insurerId = byInsurer.id;
      d.direct = false;
      if (pickPaid === null) d.paid = d.lines.filter((l) => l.item.kind === "producto").reduce((n, l) => n + lineCash(l), 0);
    }
    // Le pagaron directo a la profesional y se dijo cuánto nos debe: su parte es lo que cobró menos eso.
    if (d.payment === "profesional" && !d.split && d.owesUs !== null && pickShare === null) {
      const cobro = d.paid ?? d.lines.reduce((n, l) => n + lineList(l, d.payment), 0);
      d.share = Math.max(0, cobro - d.owesUs);
    }
    return {
      ...d,
      sellerId: pickSeller ?? d.sellerId,
      askPatient: askPatient2,
      // Con seña, lo que «salía» hoy es el resto (así no pregunta si quedó debiendo).
      listNow: deposit && useDeposit ? Math.max(0, listNow - deposit.amount) : listNow,
      abono,
      useAbono,
      saysAbono,
      abonoChoices,
      insurer: byInsurer,
      namedInsurer: named?.insurer ?? null,
      deposit,
      useDeposit,
    };
  }, [insurers, pickInsurer, openDeposits, pickDeposit, pickAbonoId, typed, items, sellers, fixedSeller, pickSeller, pickPay, pickSplit, rate, chosen, unsureIs, pickPatient, pickPaid, pickShare, pickDebt, pickRemind, openPrepaids, pickAbono]);
  // Modo del pago para los botones: un medio, «dolares» (todo en dólares) o «varios».
  const payMode = preview
    ? preview.split
      ? preview.split.efectivo + preview.split.transferencia + preview.split.tarjeta + (preview.split.giftcard ?? 0) === 0
        ? "dolares"
        : "varios"
      : preview.payment
    : null;
  // «pagué 5000 de luz» → es un egreso, no una atención.
  // «ya le pagué todo a carmen» → pago a una profesional (va antes que los egresos: también dice «pagué»).
  const payout = useMemo(() => (canExpense ? parsePayout(typed, sellers) : null), [typed, canExpense, sellers]);
  const [payoutsData, refreshPayouts] = usePoll<{ ok: boolean; balances: { providerId: string; share: number; paid: number; owed: number }[] }>(
    "/api/payouts",
    30_000,
  );
  const owedTo = (id: string) => payoutsData?.balances?.find((b) => b.providerId === id);
  // «le quedamos debiendo 50000 a marisa» → deuda del consultorio con ella; «le pagué la deuda a marisa» → se le paga.
  const provDebt = useMemo(() => (canExpense ? parseProviderDebt(typed, sellers) : null), [typed, canExpense, sellers]);
  const [provDebtsData, refreshProvDebts] = usePoll<{ ok: boolean; debts: { id: string; providerId: string; date: string; remaining: number }[] }>(
    "/api/provider-debts",
    30_000,
  );
  const weOwe = (id: string) => (provDebtsData?.ok ? provDebtsData.debts : []).filter((d) => d.providerId === id).reduce((n, d) => n + d.remaining, 0);
  const [pickPayoutMethod, setPickPayoutMethod] = useState<"efectivo" | "transferencia" | null>(null);
  const payoutMethod = pickPayoutMethod ?? payout?.method ?? provDebt?.method ?? "efectivo";
  const payoutAmount = payout ? (payout.debt ? Math.min(payout.amount ?? weOwe(payout.seller.id), weOwe(payout.seller.id)) : (payout.amount ?? owedTo(payout.seller.id)?.owed ?? 0)) : 0;
  const provDebtOwed = provDebt ? Math.max(0, (owedTo(provDebt.seller.id)?.owed ?? 0) - (provDebt.paidNow ?? 0)) : 0;
  const provDebtAmount = provDebt ? (provDebt.amount ?? provDebtOwed) : 0;
  // «carla dejó un abono de 5 sesiones de venus freeze, pagó 250000» → abono nuevo (la plata entra hoy).
  const prepaidNote = useMemo(() => (canExpense && !provDebt && !payout ? parsePrepaidNote(typed) : null), [typed, canExpense, provDebt, payout]);
  const [pickPrepaidMethod, setPickPrepaidMethod] = useState<"efectivo" | "transferencia" | "tarjeta" | null>(null);
  const newPrepaid = prepaidNote
    ? (() => {
        const item = preview?.lines.find((l) => l.item.kind === "practica")?.item ?? null;
        const sessions = prepaidNote.sessions;
        const amount = prepaidNote.amount;
        const unitPrice = prepaidNote.unitPrice ?? (sessions && amount ? Math.round(amount / sessions) : (item?.price ?? null));
        const patient = titleCase(pickPatient.trim() || prepaidPatient(typed, item?.name ?? null) || preview?.patient || "");
        return { patient, item, sessions, amount, unitPrice, method: pickPrepaidMethod ?? prepaidNote.method };
      })()
    : null;
  const prepaidReady = !!newPrepaid && !!newPrepaid.patient && !!newPrepaid.item && !!newPrepaid.amount && !!newPrepaid.method;
  // Seña nueva: «carla dejó 20000 de seña para botox, viene el 28/10» (entra a la caja hoy).
  const depositNote = useMemo(() => (canExpense && !provDebt && !payout && !prepaidNote ? parseDepositNote(typed) : null), [typed, canExpense, provDebt, payout, prepaidNote]);
  const [pickDepositMethod, setPickDepositMethod] = useState<"efectivo" | "transferencia" | "tarjeta" | null>(null);
  const [pickDepositDate, setPickDepositDate] = useState<string | null>(null);
  const newDeposit = depositNote
    ? (() => {
        const item = preview?.lines.find((l) => l.item.kind === "practica")?.item ?? null;
        return {
          patient: titleCase(pickPatient.trim() || depositPatient(typed, item?.name ?? null) || preview?.patient || ""),
          item,
          amount: depositNote.amount,
          dueOn: pickDepositDate ?? depositNote.dueOn,
          method: pickDepositMethod ?? depositNote.method,
        };
      })()
    : null;
  const depositReady = !!newDeposit && !!newDeposit.patient && newDeposit.amount > 0 && !!newDeposit.method;
  // Lo que debe el consultorio: «le debemos 300000 a la distribuidora, avisame todos los días» / «le pagamos a la distribuidora».
  const [payablesData, refreshPayables] = usePoll<{ ok: boolean; payables: PayableRow[] }>("/api/payables", 60_000);
  const openPayables = useMemo(() => (payablesData?.ok ? payablesData.payables : []), [payablesData]);
  const duePayables = openPayables.filter((p) => p.due);
  const payablePay = useMemo(
    () => (canExpense && !provDebt && !payout && !prepaidNote && !depositNote ? parsePayablePayment(typed, openPayables) : null),
    [typed, canExpense, provDebt, payout, prepaidNote, depositNote, openPayables],
  );
  const payableNote = useMemo(
    () => (canExpense && !provDebt && !payout && !prepaidNote && !depositNote && !payablePay ? parsePayable(typed, realNowIso().slice(0, 16)) : null),
    [typed, canExpense, provDebt, payout, prepaidNote, depositNote, payablePay],
  );
  const [pickPayableId, setPickPayableId] = useState<string | null>(null);
  const [payablePayAmount, setPayablePayAmount] = useState<string | null>(null);
  const [payablePayMethod, setPayablePayMethod] = useState<PayMethod | null>(null);
  const payingPayable = payablePay ? (payablePay.payables.length === 1 ? payablePay.payables[0] : (payablePay.payables.find((p) => p.id === pickPayableId) ?? null)) : null;
  const payableAmount = payingPayable
    ? payablePayAmount !== null
      ? toPesos(payablePayAmount)
      : Math.min(payablePay?.amount ?? payingPayable.remaining, payingPayable.remaining)
    : 0;
  const payableMethod = payablePayMethod ?? payablePay?.method ?? null;
  const [pickCreditor, setPickCreditor] = useState<string | null>(null);
  const [pickPayableRemind, setPickPayableRemind] = useState<{ mode: PayableRow["remindMode"]; at: string | null } | null>(null);
  const newPayable = payableNote
    ? {
        creditor: (pickCreditor ?? payableNote.creditor).trim(),
        concept: payableNote.concept,
        amount: payableNote.amount,
        remindMode: pickPayableRemind ? pickPayableRemind.mode : payableNote.remindMode,
        remindAt: pickPayableRemind ? pickPayableRemind.at : payableNote.remindAt,
      }
    : null;
  const payableReady = !!newPayable && !!newPayable.creditor && !!newPayable.amount;
  function resetPayablePicks() {
    setPickPayableId(null);
    setPayablePayAmount(null);
    setPayablePayMethod(null);
    setPickCreditor(null);
    setPickPayableRemind(null);
  }
  // Deudas: «carla pagó la deuda» → cobro; «carla debe 40000» (sin práctica) → deuda suelta.
  const [debtsData, refreshDebtsList] = usePoll<{ ok: boolean; debts: OpenDebt[] }>("/api/debts", 30_000);
  // Deudas con recordatorio de hoy (o vencido): se muestran arriba, «Para cobrar hoy».
  const [dueData, refreshDue] = usePoll<{ ok: boolean; debts: (OpenDebt & { remindOn: string | null })[] }>("/api/debts/reminders", 60_000);
  const dueDebts = dueData?.ok ? dueData.debts : [];
  const todayStr = useToday();
  const refreshDebts = () => {
    refreshDebtsList();
    refreshDue();
  };
  async function postponeDebt(id: string) {
    const d = new Date(`${todayStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    const r = await call(`/api/debts/${id}`, "PATCH", { remindOn: d.toISOString().slice(0, 10) });
    if (!r.ok) return showToast(r.error ?? "No se pudo cambiar el recordatorio.");
    showToast(`Te lo recuerdo el ${remindLabel(d.toISOString().slice(0, 10))}.`);
    refreshDue();
  }
  const openDebts = useMemo(() => (debtsData?.ok ? debtsData.debts : []), [debtsData]);
  const debtPay = useMemo(() => (canExpense && !payout && !provDebt && !prepaidNote && !depositNote && !payablePay && !payableNote ? parseDebtPayment(typed, openDebts) : null), [typed, canExpense, openDebts, payout, provDebt, prepaidNote, depositNote, payablePay, payableNote]);
  const [pickDebtId, setPickDebtId] = useState<string | null>(null);
  const [debtPayAmount, setDebtPayAmount] = useState<string | null>(null);
  const [debtPayMethod, setDebtPayMethod] = useState<"efectivo" | "transferencia" | "tarjeta" | null>(null);
  const payingDebt = debtPay ? (debtPay.debts.length === 1 ? debtPay.debts[0] : debtPay.debts.find((d) => d.id === pickDebtId) ?? null) : null;
  const debtMethod = debtPayMethod ?? debtPay?.method ?? null;
  const payAmount = payingDebt ? (debtPayAmount !== null ? toPesos(debtPayAmount) : Math.min(debtPay?.amount ?? payingDebt.remaining, payingDebt.remaining)) : 0;
  const newDebt =
    canExpense && !debtPay && !payout && !provDebt && !prepaidNote && !depositNote && !payablePay && !payableNote && preview && preview.debt && !preview.lines.length && !preview.unresolved.length
      ? {
          debtor: titleCase(preview.patient || debtorName(extractMoney(typed).text)),
          amount: preview.debt,
          // «marisa me debe 5000»: si el nombre se tomó como profesional, es quien debe, no de quién es la atención.
          providerId: !preview.patient.trim() && !pickSeller ? null : preview.sellerId, remindOn: preview.remindOn }
      : null;
  const expense = useMemo(
    () => (canExpense && !payout && !debtPay && !provDebt && !prepaidNote && !depositNote && !payablePay && !payableNote ? parseExpense(typed) : null),
    [typed, canExpense, payout, debtPay, provDebt, prepaidNote, depositNote, payablePay, payableNote],
  );
  const possible = preview ? sellersFor(preview.lines, sellers) : null;
  const notHers = !!preview && preview.lines.some((l) => !allowedFor(l.item, preview.sellerId));
  const missingSeller = !!preview && !isMedico && !preview.sellerId;
  // Por obra social sin decir qué se hizo: es una «Atención» (la arma el servidor).
  const nothing = !!preview && !preview.insurer && !preview.lines.length && !preview.unresolved.length && !preview.patientUnsure;
  // Lo que falta contestar en la vista previa (todo se resuelve ahí, con un toque).
  // Sesión del abono sin nada más: no hay plata ni medio para preguntar.
  const onlyAbono =
    (!!preview?.abono && preview.useAbono === true && preview.lines.every((l) => l.item.id === preview.abono!.itemId)) ||
    (!!preview?.insurer && preview.lines.every((l) => l.item.kind !== "producto"));
  const pendingQ =
    !!preview && (preview.unresolved.length > 0 || preview.patientUnsure || (!!preview.abono && preview.useAbono === null) || preview.abonoChoices.length > 1);
  const missingPatient = !!preview && (hasPractice(preview.lines) || !!preview.debt || !!preview.insurer) && !preview.patient.trim();
  const giftCardLine = preview?.lines.find((l) => l.item.giftCard) ?? null;
  const invalidGiftCardIssue = !!giftCardLine && giftCardKind === "treatment" && !giftCardTreatmentId;
  const canSave = !!preview && !nothing && !missingSeller && !notHers && !pendingQ && !missingPatient && !invalidGiftCardIssue;

  async function lookupGiftCard() {
    setGiftCardError("");
    setGiftCardFound(null);
    try {
      const response = await fetch(`/api/gift-cards?code=${encodeURIComponent(giftCardCodeInput)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) return setGiftCardError(data.error ?? "No se encontró la gift card.");
      setGiftCardFound(data.giftCard);
    } catch {
      setGiftCardError("No se pudo consultar la gift card.");
    }
  }

  function applyGiftCard() {
    if (!giftCardFound || !preview) return;
    if (giftCardFound.kind === "treatment" && !preview.lines.some((l) => l.item.id === giftCardFound.treatmentItemId)) {
      setGiftCardError(`Este vale es para ${giftCardFound.treatmentName}.`);
      return;
    }
    const amount = Math.min(giftCardFound.balance, preview.listNow);
    setPickSplit({ efectivo: preview.listNow - amount, transferencia: 0, tarjeta: 0, giftcard: amount, usd: 0 });
    setPickPay("varios");
    setPickPaid(null);
    setGiftCardError("");
  }

  async function save(d: Draft) {
    if (d.debt && d.paid === null && !d.split) d = { ...d, paid: shownPaid(d) };
    if (d.debt && !d.patient.trim()) return showToast("¿Quién quedó debiendo? Escribí el nombre del paciente.");
    if ((d.split && splitParts(d.split, rate).some((p) => p.method === "dolares" && !p.rate)) || (d.usdAll && !rate))
      return showToast("Falta la cotización del dólar (arriba a la derecha).");
    setBusy(true);
    const r = await call("/api/visits", "POST", {
      patientName: d.patient.trim(),
      providerId: d.sellerId,
      ...(d.split ? { payments: splitParts(d.split, rate) } : { paymentMethod: d.payment }),
      ...(d.debt ? { debt: d.debt, debtRemindOn: d.remindOn } : {}),
      ...(d.prepaidId ? { prepaidId: d.prepaidId } : {}),
      ...(d.insurerId ? { insurerId: d.insurerId } : {}),
      ...(d.depositId ? { depositId: d.depositId } : {}),
      ...(d.split?.giftcard ? { giftCardCode: giftCardFound?.code } : {}),
      ...(giftCardLine ? { giftCardIssue: { kind: giftCardKind, treatmentItemId: giftCardKind === "treatment" ? giftCardTreatmentId : null, buyer: giftCardBuyer } } : {}),
      lines: visitLines(d),
    });
    setBusy(false);
    if (!r.ok) {
      refreshSales();
      return showToast(r.error ?? "No se pudo anotar.");
    }
    // ¡Registrado! → animación y de vuelta al inicio, listo para la próxima.
    setFlash(r.giftCardCode ? `${summaryOf(d)} · Código gift card: ${r.giftCardCode}` : summaryOf(d));
    setLastVisit(String(r.visitId ?? ""));
    setText("");
    setPickSeller(null);
    setPickPay(null);
    setPickSplit(null);
    setPickPaid(null);
    setPickShare(null);
    setPickDebt(null);
    setPickRemind(undefined);
    setPickAbono(null);
    setPickAbonoId(null);
    setPickInsurer(undefined);
    setPickDeposit(null);
    setChosen({});
    setUnsureIs(null);
    setPickPatient("");
    setGiftCardCodeInput("");
    setGiftCardFound(null);
    setGiftCardBuyer("");
    setGiftCardTreatmentId("");
    setGiftCardKind("amount");
    setMode("idle");
    if (d.debt) refreshDebts();
    if (d.prepaidId) refreshPrepaids();
    if (d.depositId) refreshDeposits();
    refreshSales();
    refreshCatalog();
    refreshPayouts();
    setTimeout(() => setFlash(null), 2400);
  }

  async function saveExpense() {
    if (!expense || busy) return;
    if (!expense.concept || !expense.amount) return setExpenseForm({ initial: expense });
    setBusy(true);
    const r = await call("/api/expenses", "POST", expense);
    setBusy(false);
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar el egreso.");
    expenseDone(`Gasto anotado: ${expense.concept}, ${money(expense.amount)}.`);
  }

  function expenseDone(msg: string) {
    setExpenseForm(null);
    setPickPayoutMethod(null);
    setFlash(msg);
    setText("");
    refreshExpenses();
    setTimeout(() => setFlash(null), 2400);
  }

  const how = (m: "efectivo" | "transferencia") => (m === "efectivo" ? "en efectivo" : "por transferencia");

  async function savePayout() {
    if (!payout || busy) return;
    setBusy(true);
    const r = payout.debt
      ? await call("/api/provider-debts/pay", "POST", { providerId: payout.seller.id, amount: payoutAmount, method: payoutMethod })
      : await call("/api/payouts", "POST", { providerId: payout.seller.id, amount: payout.amount, method: payoutMethod });
    setBusy(false);
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar el pago.");
    refreshPayouts();
    refreshProvDebts();
    if (payout.debt) {
      const left = Number(r.remaining ?? 0);
      return expenseDone(`Pagado a ${payout.seller.name} · ${money(payoutAmount)} ${how(payoutMethod)}. ${left ? `Se le sigue debiendo ${money(left)}.` : "Ya no se le debe nada."}`);
    }
    const p = r.payout as { amount: number; providerName: string };
    expenseDone(`Pagado a ${p.providerName} · ${money(p.amount)} ${how(payoutMethod)}`);
  }

  async function savePrepaid() {
    if (!newPrepaid || !prepaidReady || busy) return;
    setBusy(true);
    const r = await call("/api/prepaids", "POST", {
      patient: newPrepaid.patient,
      itemId: newPrepaid.item!.id,
      sessions: newPrepaid.sessions,
      amount: newPrepaid.amount,
      unitPrice: newPrepaid.unitPrice,
      method: newPrepaid.method,
    });
    setBusy(false);
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar el abono.");
    setPickPrepaidMethod(null);
    refreshPrepaids();
    expenseDone(
      `Abono · ${newPrepaid.patient} · ${newPrepaid.sessions ? `${newPrepaid.sessions} sesiones de ` : ""}${newPrepaid.item!.name} · ${money(newPrepaid.amount!)}`,
    );
  }

  async function saveDeposit() {
    if (!newDeposit || !depositReady || busy) return;
    setBusy(true);
    const r = await call("/api/deposits", "POST", {
      patient: newDeposit.patient,
      itemId: newDeposit.item?.id ?? null,
      amount: newDeposit.amount,
      method: newDeposit.method,
      dueOn: newDeposit.dueOn,
    });
    setBusy(false);
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar la seña.");
    setPickDepositMethod(null);
    setPickDepositDate(null);
    refreshDeposits();
    expenseDone(`Seña · ${newDeposit.patient}${newDeposit.item ? ` · ${newDeposit.item.name}` : ""} · ${money(newDeposit.amount)}${newDeposit.dueOn ? ` · viene el ${remindLabel(newDeposit.dueOn)}` : ""}`);
  }

  async function saveNewPayable() {
    if (!newPayable || !payableReady || busy) return;
    setBusy(true);
    const r = await call("/api/payables", "POST", newPayable);
    setBusy(false);
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar.");
    resetPayablePicks();
    refreshPayables();
    expenseDone(`Debemos ${money(newPayable.amount!)} a ${newPayable.creditor} · aviso: ${payableRemindText(newPayable.remindMode, newPayable.remindAt)}`);
  }

  async function savePayablePay() {
    if (!payingPayable || busy) return;
    if (payableAmount <= 0) return showToast("¿Cuánto se pagó?");
    if (!payableMethod) return showToast("¿Cómo se pagó? Tocá efectivo, transferencia o tarjeta.");
    setBusy(true);
    const r = await call(`/api/payables/${payingPayable.id}/pay`, "POST", { amount: payableAmount, method: payableMethod });
    setBusy(false);
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar el pago.");
    const left = (r.payable as PayableRow).remaining;
    resetPayablePicks();
    refreshPayables();
    refreshExpenses();
    expenseDone(`Pagado ${money(payableAmount)} a ${payingPayable.creditor}. ${left ? `Falta ${money(left)}.` : "Deuda saldada: no avisa más."}`);
  }

  async function saveProvDebt() {
    if (!provDebt || busy) return;
    if (provDebtAmount <= 0) return showToast(`Hoy no se le debe nada a ${provDebt.seller.name}.`);
    setBusy(true);
    if (provDebt.paidNow) {
      const r = await call("/api/payouts", "POST", { providerId: provDebt.seller.id, amount: provDebt.paidNow, method: payoutMethod });
      if (!r.ok) {
        setBusy(false);
        return showToast(r.error ?? "No se pudo anotar el pago.");
      }
    }
    const r = await call("/api/provider-debts", "POST", { providerId: provDebt.seller.id, amount: provDebtAmount });
    setBusy(false);
    refreshPayouts();
    refreshProvDebts();
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar la deuda.");
    expenseDone(`${provDebt.paidNow ? `Pagado ${money(provDebt.paidNow)} · ` : ""}Le debemos a ${provDebt.seller.name} ${money(provDebtAmount)}`);
  }

  function resetDebtPicks() {
    setPickDebt(null);
    setPickRemind(undefined);
    setPickAbono(null);
    setPickAbonoId(null);
    setPickInsurer(undefined);
    setPickDeposit(null);
    setPickDebtId(null);
    setDebtPayAmount(null);
    setDebtPayMethod(null);
  }

  async function saveDebtPayment() {
    if (!payingDebt || busy) return;
    if (payAmount <= 0) return showToast("¿Cuánto pagó?");
    if (!debtMethod) return showToast("¿Cómo pagó? Tocá efectivo, transferencia o tarjeta.");
    setBusy(true);
    const r = await call(`/api/debts/${payingDebt.id}/pay`, "POST", { amount: payAmount, method: debtMethod });
    setBusy(false);
    if (!r.ok) return showToast(r.error ?? "No se pudo cobrar.");
    const left = (r.debt as { remaining: number }).remaining;
    resetDebtPicks();
    refreshDebts();
    refreshPayouts();
    const how = debtMethod === "efectivo" ? "en efectivo" : debtMethod === "tarjeta" ? "con tarjeta" : "por transferencia";
    expenseDone(`${payingDebt.debtor} pagó ${money(payAmount)} ${how}. ${left ? `Queda debiendo ${money(left)}.` : "Ya no debe nada."}`);
  }

  async function saveNewDebt() {
    if (!newDebt || busy) return;
    if (!newDebt.debtor) return showToast("¿Quién debe?");
    setBusy(true);
    const r = await call("/api/debts", "POST", { debtor: newDebt.debtor, amount: newDebt.amount, providerId: newDebt.providerId, remindOn: newDebt.remindOn });
    setBusy(false);
    if (!r.ok) return showToast(r.error ?? "No se pudo anotar la deuda.");
    resetDebtPicks();
    refreshDebts();
    expenseDone(`Deuda · ${newDebt.debtor} · ${money(newDebt.amount)}`);
  }

  function go() {
    if (provDebt) return saveProvDebt();
    if (newPrepaid) return savePrepaid();
    if (newDeposit) return saveDeposit();
    if (payablePay) return savePayablePay();
    if (newPayable) return saveNewPayable();
    if (debtPay) return saveDebtPayment();
    if (newDebt) return saveNewDebt();
    if (payout) return savePayout();
    if (expense) return saveExpense();
    if (preview && canSave && !busy) save(preview);
  }

  const loading = !catalog || !sellersData;
  const cash = preview?.lines.reduce((n, l) => n + lineCash(l), 0) ?? 0;
  const card = preview?.lines.reduce((n, l) => n + lineCard(l), 0) ?? 0;
  // Lo que ingresó (lo escrito o la lista) y el reparto: la profesional (su % o lo aclarado) y Decles.
  const ingreso = preview ? (preview.paid ?? (preview.payment === "tarjeta" ? card : cash)) : 0;
  const auto = preview ? autoShare(preview, sellers, preview.useDeposit ? preview.deposit : null) : 0;
  const sellerName = sellers.find((s) => s.id === preview?.sellerId)?.name;
  // La dueña (médica admin) no cobra comisión: lo que entra es todo del consultorio.
  const sellerOwner = !!sellers.find((s) => s.id === preview?.sellerId)?.owner;
  const parte = sellerOwner ? 0 : (preview?.share ?? auto);

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-5 pb-20 pt-6 text-[14px] leading-[1.45] sm:px-6 sm:pt-8">
      <Toast msg={toast} />
      {flash !== null && <Registered summary={flash} onClose={() => setFlash(null)} />}

      {mode === "idle" && (
        <div className="flex flex-col gap-6">
          <h1 className="font-display text-[22px] font-medium leading-[1.15] tracking-[-.02em] sm:text-[22px]">
            {greeting()}, {firstName(actor.name)}
          </h1>
          {canExpense && dueDebts.length > 0 && (
            <section aria-label="Para cobrar hoy" className="flex flex-col gap-2 rounded-2xl border-2 border-warn/40 px-4 py-3">
              <span className="text-[16px] font-semibold text-warn">Para cobrar hoy</span>
              <ul className="flex flex-col">
                {dueDebts.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-divider py-2.5 first:border-0">
                    <span className="min-w-0 flex-1">
                      <b className="font-semibold">{d.debtor}</b> debe <b className="font-semibold tabular-nums text-owe">{money(d.remaining)}</b>
                      <span className="block text-[14px] text-neutral-500">
                        {[d.concept, d.remindOn && d.remindOn < todayStr ? `había que cobrar el ${remindLabel(d.remindOn)}` : "recordatorio de hoy"].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const t = `${d.debtor.split(" ")[0]} pagó la deuda`;
                        setText(t);
                        requestAnimationFrame(() => {
                          box.current?.focus();
                          box.current?.setSelectionRange(t.length, t.length);
                        });
                      }}
                      className={CHIP_ON}
                    >
                      Cobrar
                    </button>
                    <button type="button" onClick={() => postponeDebt(d.id)} className={CHIP}>
                      En una semana
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {canExpense && openDeposits.some((x) => x.dueOn === todayStr) && (
            <section aria-label="Hoy vienen con seña" className="flex flex-col gap-2 rounded-2xl border-2 border-neutral-800 px-4 py-3">
              <span className="text-[16px] font-semibold">Hoy vienen con seña</span>
              <ul className="flex flex-col">
                {openDeposits
                  .filter((x) => x.dueOn === todayStr)
                  .map((x) => (
                    <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-divider py-2.5 first:border-0">
                      <span className="min-w-0 flex-1">
                        <b className="font-semibold">{x.patient}</b>
                        {x.itemName && <span className="text-neutral-400"> · {x.itemName}</span>}
                        <span className="block text-[14px] text-neutral-500">dejó {money(x.amount)} de seña</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const t = `${x.itemName ? `${x.itemName.toLowerCase()} a ` : ""}${x.patient}, `;
                          setText(t);
                          requestAnimationFrame(() => {
                            box.current?.focus();
                            box.current?.setSelectionRange(t.length, t.length);
                          });
                        }}
                        className={CHIP}
                      >
                        Anotar
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          )}
          {canExpense && duePayables.length > 0 && (
            <section aria-label="Para pagar" className="flex flex-col gap-2 rounded-2xl border-2 border-warn/40 px-4 py-3">
              <span className="text-[16px] font-semibold text-warn">Para pagar</span>
              <ul className="flex flex-col">
                {duePayables.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-divider py-2.5 first:border-0">
                    <span className="min-w-0 flex-1">
                      Le debemos <b className="font-semibold tabular-nums text-owe">{money(p.remaining)}</b> a <b className="font-semibold">{p.creditor}</b>
                      <span className="block text-[14px] text-neutral-500">{[p.concept, `aviso: ${payableRemindText(p.remindMode, p.remindAt)}`].filter(Boolean).join(" · ")}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const t = `le pagamos a ${p.creditor.toLowerCase()}`;
                        setText(t);
                        requestAnimationFrame(() => {
                          box.current?.focus();
                          box.current?.setSelectionRange(t.length, t.length);
                        });
                      }}
                      className={CHIP_ON}
                    >
                      Pagar
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
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
                  setPickSplit(null);
                  setPickPaid(null);
                  setPickShare(null);
                  setPickDebt(null);
    setPickRemind(undefined);
    setPickAbono(null);
    setPickAbonoId(null);
    setPickInsurer(undefined);
    setPickDeposit(null);
                  setPickDebtId(null);
                  setDebtPayAmount(null);
                  setDebtPayMethod(null);
                  setPickPatient("");
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
                    className={`min-h-[44px] rounded-full border px-4 py-2 text-[15px] font-medium transition-colors ${
                      i === 0 ? "border-accent-600 text-fg" : "border-neutral-800 text-neutral-300 hover:border-accent-600"
                    }`}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
            )}

            {provDebt ? (
              <Understood tone="owe" icon={<ClockIcon size={20} weight="bold" />} title="Le quedamos debiendo" note="Deuda del consultorio con la profesional">
                <Person name={provDebt.seller.name}>
                  Le debemos <b className="font-semibold tabular-nums text-owe">{money(provDebtAmount)}</b>
                  {provDebt.amount === null && (provDebt.paidNow ? " · el resto de hoy" : " · todo lo de hoy")}
                </Person>
                <p className="text-[15px] text-neutral-400">
                  Su parte de hoy <span className="tabular-nums text-fg">{money(owedTo(provDebt.seller.id)?.share ?? 0)}</span> · ya se le pagó{" "}
                  <span className="tabular-nums text-fg">{money(owedTo(provDebt.seller.id)?.paid ?? 0)}</span>
                  {weOwe(provDebt.seller.id) > 0 && (
                    <>
                      {" "}
                      · ya anotado como deuda <span className="tabular-nums text-fg">{money(weOwe(provDebt.seller.id))}</span>
                    </>
                  )}
                </p>
                {provDebt.paidNow ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-[16px] font-semibold">
                      Ahora se le pagan <span className="tabular-nums">{money(provDebt.paidNow)}</span>. ¿Cómo?
                    </span>
                    <PayoutMethodChips value={payoutMethod} onChange={setPickPayoutMethod} />
                  </div>
                ) : null}
                {provDebtAmount <= 0 && <Missing>Hoy no se le debe nada para dejar pendiente</Missing>}
                <p className="text-[14px] text-neutral-500">
                  Queda en Cierre, «Le debemos a profesionales». Se le paga escribiendo «le pagué la deuda a {provDebt.seller.name.split(" ")[0]}» o desde ahí.
                </p>
              </Understood>
            ) : newPrepaid ? (
              <Understood tone="in" icon={<ArrowDownIcon size={20} weight="bold" />} title="Abono nuevo" note="Lo paga antes: entra a la caja de hoy">
                <Person name={newPrepaid.patient}>Paciente</Person>
                {!newPrepaid.patient && (
                  <div className="flex flex-col gap-2">
                    <Missing>Falta de qué paciente es</Missing>
                    <input
                      value={pickPatient}
                      onChange={(e) => setPickPatient(e.target.value)}
                      placeholder="Nombre y apellido"
                      className="min-h-[52px] rounded-xl border-2 border-neutral-800 bg-transparent px-4 text-[17px] outline-none focus:border-accent-700"
                    />
                  </div>
                )}
                {newPrepaid.item ? (
                  <div className="flex flex-col gap-1">
                    <b className="text-[18px] font-semibold">
                      {newPrepaid.sessions ? `${newPrepaid.sessions} sesiones de ${newPrepaid.item.name}` : `Saldo para ${newPrepaid.item.name}`}
                    </b>
                    {newPrepaid.unitPrice && newPrepaid.amount ? (
                      <span className="text-[15px] text-neutral-400">
                        Precio congelado <span className="tabular-nums text-fg">{money(newPrepaid.unitPrice)}</span> por sesión
                        {!newPrepaid.sessions && ` · alcanza para ${Math.floor(newPrepaid.amount / newPrepaid.unitPrice)} sesiones`}
                        {newPrepaid.item.price !== newPrepaid.unitPrice && ` · hoy sale ${money(newPrepaid.item.price)}`}
                      </span>
                    ) : null}
                  </div>
                ) : preview?.unresolved.length ? (
                  <div className="flex flex-col gap-2">
                    <Missing>¿Para qué tratamiento?</Missing>
                    <div className="flex flex-wrap gap-2.5">
                      {preview.unresolved[0].candidates.map((c) => (
                        <button key={c.id} onClick={() => setChosen({ ...chosen, [preview.unresolved[0].text]: c.id })} className={CHIP}>
                          {c.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <Missing>Falta para qué tratamiento: escribilo («… de venus freeze»)</Missing>
                )}
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[16px] font-semibold">Pagó</span>
                  <b className="text-[22px] font-semibold tabular-nums text-in">{newPrepaid.amount ? `+ ${money(newPrepaid.amount)}` : "—"}</b>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-[16px] font-semibold">¿Cómo pagó?</span>
                  {!newPrepaid.method && <Missing>Falta cómo pagó</Missing>}
                  <div className="flex flex-wrap gap-2.5">
                    {(["efectivo", "transferencia", "tarjeta"] as const).map((m) => (
                      <button key={m} aria-pressed={newPrepaid.method === m} onClick={() => setPickPrepaidMethod(m)} className={newPrepaid.method === m ? CHIP_ON : CHIP}>
                        {m === "efectivo" ? "Efectivo" : m === "transferencia" ? "Transferencia" : "Tarjeta"}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-[14px] text-neutral-500">
                  Cuando venga a hacerse una sesión, escribí «{newPrepaid.item?.name.toLowerCase() ?? "venus freeze"} a {newPrepaid.patient.split(" ")[0] || "carla"}, con abono»: no entra plata y la profesional cobra su parte ese día.
                </p>
              </Understood>
            ) : newDeposit ? (
              <Understood tone="in" icon={<ArrowDownIcon size={20} weight="bold" />} title="Seña" note="Entra a la caja de hoy; el día que viene paga el resto">
                <Person name={newDeposit.patient}>Paciente</Person>
                {!newDeposit.patient && (
                  <div className="flex flex-col gap-2">
                    <Missing>Falta de qué paciente es</Missing>
                    <input
                      value={pickPatient}
                      onChange={(e) => setPickPatient(e.target.value)}
                      placeholder="Nombre y apellido"
                      className="min-h-[52px] rounded-xl border-2 border-neutral-800 bg-transparent px-4 text-[17px] outline-none focus:border-accent-700"
                    />
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[16px]">
                    <b className="font-semibold">{newDeposit.item?.name ?? "Práctica sin definir"}</b>
                    {newDeposit.item && <span className="text-neutral-400"> · ese día paga {money(Math.max(0, newDeposit.item.price - newDeposit.amount))}</span>}
                  </span>
                  <b className="whitespace-nowrap text-[22px] font-semibold tabular-nums text-in">+ {money(newDeposit.amount)}</b>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-[16px] font-semibold">
                    ¿Qué día viene?{" "}
                    <span className="text-[14px] font-normal text-neutral-500">{newDeposit.dueOn ? `· ${remindLabel(newDeposit.dueOn)}` : "· si no sabés, dejalo"}</span>
                  </span>
                  <input
                    type="date"
                    value={newDeposit.dueOn ?? ""}
                    onChange={(e) => setPickDepositDate(e.target.value || null)}
                    className="min-h-[48px] self-start rounded-xl border-2 border-neutral-800 bg-transparent px-3 text-[16px] outline-none focus:border-accent-700 [color-scheme:light_dark]"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-[16px] font-semibold">¿Cómo pagó la seña?</span>
                  {!newDeposit.method && <Missing>Falta cómo pagó</Missing>}
                  <div className="flex flex-wrap gap-2.5">
                    {PAY_METHODS.map(([m, label]) => (
                      <button key={m} aria-pressed={newDeposit.method === m} onClick={() => setPickDepositMethod(m)} className={newDeposit.method === m ? CHIP_ON : CHIP}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-[14px] text-neutral-500">
                  Cuando venga, anotá la atención como siempre («{newDeposit.item?.name.toLowerCase() ?? "botox"} a {newDeposit.patient.split(" ")[0] || "carla"}»): se descuenta la seña y paga el resto.
                </p>
              </Understood>
            ) : payablePay ? (
              <Understood
                tone="out"
                icon={<ArrowUpIcon size={20} weight="bold" />}
                title="Pago de lo que debemos"
                note={payableMethod === "efectivo" ? "Sale de la caja" : payableMethod ? "No sale de la caja" : "Es un egreso de hoy"}
              >
                {!payingPayable ? (
                  <div className="flex flex-col gap-2">
                    <Missing>¿Cuál de estas?</Missing>
                    <div className="flex flex-wrap gap-2.5">
                      {payablePay.payables.map((p) => (
                        <button key={p.id} onClick={() => setPickPayableId(p.id)} className={CHIP}>
                          {p.creditor}
                          {p.concept ? ` · ${p.concept}` : ""} · {money(p.remaining)}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <>
                    <Person name={payingPayable.creditor}>
                      Se le paga <b className="font-semibold tabular-nums text-fg">{money(payableAmount)}</b>
                      {payableAmount === payingPayable.remaining ? " · todo" : ` de ${money(payingPayable.remaining)}`}
                    </Person>
                    <label className="flex flex-wrap items-center gap-3 text-[15px]">
                      <span className="w-[120px] font-semibold">Pagó</span>
                      <input
                        value={payablePayAmount !== null ? (payablePayAmount ? `$ ${toPesos(payablePayAmount).toLocaleString("es-AR")}` : "") : `$ ${payableAmount.toLocaleString("es-AR")}`}
                        onChange={(e) => setPayablePayAmount(e.target.value.replace(/\D/g, ""))}
                        inputMode="numeric"
                        className={MONEY_IN}
                      />
                    </label>
                    <div className="flex flex-col gap-2">
                      <span className="text-[16px] font-semibold">¿Cómo se pagó?</span>
                      {!payableMethod && <Missing>Falta cómo se pagó</Missing>}
                      <div className="flex flex-wrap gap-2.5">
                        {PAY_METHODS.map(([m, label]) => (
                          <button key={m} aria-pressed={payableMethod === m} onClick={() => setPayablePayMethod(m)} className={payableMethod === m ? CHIP_ON : CHIP}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <After label="Falta pagar después de esto" from={payingPayable.remaining} to={Math.max(0, payingPayable.remaining - payableAmount)} good />
                  </>
                )}
              </Understood>
            ) : newPayable ? (
              <Understood tone="owe" icon={<ClockIcon size={20} weight="bold" />} title="Lo que debemos" note="Deuda del consultorio: te aviso hasta que se pague">
                {newPayable.creditor ? (
                  <Person name={titleCase(newPayable.creditor)}>
                    Le debemos <b className="font-semibold tabular-nums text-owe">{newPayable.amount ? money(newPayable.amount) : "—"}</b>
                    {newPayable.concept && ` · ${newPayable.concept}`}
                  </Person>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Missing>Falta a quién se le debe</Missing>
                    <input
                      value={pickCreditor ?? ""}
                      onChange={(e) => setPickCreditor(e.target.value)}
                      placeholder="Ej. Distribuidora"
                      className="min-h-[52px] rounded-xl border-2 border-neutral-800 bg-transparent px-4 text-[17px] outline-none focus:border-accent-700"
                    />
                  </div>
                )}
                {!newPayable.amount && <Missing>Falta cuánto se debe: escribilo («… 300000 …»)</Missing>}
                <div className="flex flex-col gap-2">
                  <span className="text-[16px] font-semibold">
                    ¿Cuándo te aviso? <span className="text-[14px] font-normal text-neutral-500">· {payableRemindText(newPayable.remindMode, newPayable.remindAt)}</span>
                  </span>
                  <PayableReminderPicker
                    mode={newPayable.remindMode}
                    at={newPayable.remindAt}
                    onChange={(mode, at) => setPickPayableRemind({ mode, at })}
                    chip={CHIP}
                    chipOn={CHIP_ON}
                    field="min-h-[44px] rounded-xl border-2 border-neutral-800 bg-transparent px-3 text-[16px] outline-none focus:border-accent-700"
                  />
                </div>
                <p className="text-[14px] text-neutral-500">
                  Se paga escribiendo «le pagamos a {newPayable.creditor || "la distribuidora"}» o desde Cierre → Lo que debemos. Pagada, no avisa más.
                </p>
              </Understood>
            ) : debtPay ? (
              <Understood tone="in" icon={<ArrowDownIcon size={20} weight="bold" />} title="Cobro de deuda" note="Entra a la caja de hoy">
                {!payingDebt ? (
                  <div className="flex flex-col gap-2">
                    <Missing>¿Cuál de estas deudas?</Missing>
                    <div className="flex flex-wrap gap-2.5">
                      {debtPay.debts.map((d) => (
                        <button key={d.id} onClick={() => setPickDebtId(d.id)} className={CHIP}>
                          {d.debtor} · {money(d.remaining)}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <>
                    <Person name={payingDebt.debtor}>
                      Debe <b className="font-semibold tabular-nums text-owe">{money(payingDebt.remaining)}</b> desde el{" "}
                      {payingDebt.createdAt.slice(8, 10)}/{payingDebt.createdAt.slice(5, 7)}
                      {(payingDebt.concept || payingDebt.providerName || payingDebt.paid > 0) && (
                        <span className="block text-[14px] text-neutral-500">
                          {[payingDebt.concept, payingDebt.providerName, payingDebt.paid > 0 ? `ya pagó ${money(payingDebt.paid)}` : null].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </Person>

                    <div className="h-px bg-divider" />

                    <div className="flex flex-col gap-2">
                      <label htmlFor="cobro-monto" className="text-[16px] font-semibold">
                        ¿Cuánto paga?
                      </label>
                      <div className="flex flex-wrap items-center gap-4">
                        <input
                          id="cobro-monto"
                          value={`$ ${payAmount.toLocaleString("es-AR")}`}
                          onChange={(e) => setDebtPayAmount(e.target.value.replace(/\D/g, ""))}
                          inputMode="numeric"
                          className="h-14 w-[200px] rounded-xl border-2 border-neutral-800 bg-surface px-4 text-right text-[24px] font-semibold tabular-nums text-fg outline-none focus:border-in"
                        />
                        {payAmount >= payingDebt.remaining ? (
                          <span className="inline-flex items-center gap-2 text-[16px] font-semibold text-in-fg">
                            <CheckCircleIcon size={22} weight="bold" aria-hidden="true" /> Paga toda la deuda
                          </span>
                        ) : (
                          <Missing>Queda debiendo {money(Math.max(0, payingDebt.remaining - payAmount))}</Missing>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <span id="cobro-medio" className="text-[16px] font-semibold">
                        ¿Cómo pagó?
                      </span>
                      {!debtMethod && <Missing>Falta decir cómo pagó. Tocá una opción:</Missing>}
                      <div role="radiogroup" aria-labelledby="cobro-medio" className="grid grid-cols-3 gap-2.5">
                        {PAY_OPTIONS.filter(([m]) => m === "efectivo" || m === "transferencia" || m === "tarjeta").map(([m, label, Icon]) => {
                          const on = debtMethod === m;
                          return (
                            <button key={m} role="radio" aria-checked={on} onClick={() => setDebtPayMethod(m as "efectivo" | "transferencia" | "tarjeta")} className={on ? PICK_ON : PICK}>
                              <Icon size={24} aria-hidden="true" />
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <After
                      label={`Deuda de ${firstName(payingDebt.debtor)} después de esto`}
                      from={payingDebt.remaining}
                      to={Math.max(0, payingDebt.remaining - payAmount)}
                      good={payAmount >= payingDebt.remaining}
                    />
                  </>
                )}
              </Understood>
            ) : newDebt ? (
              <Understood tone="owe" icon={<ClockIcon size={20} weight="bold" />} title="Deuda nueva" note="Le debe al consultorio">
                <Person name={newDebt.debtor}>
                  Debe <b className="font-semibold tabular-nums text-owe">{money(newDebt.amount)}</b>
                </Person>
                {!newDebt.debtor && <Missing>Falta quién debe</Missing>}
                <div className="flex flex-col gap-2">
                  <span className="text-[16px] font-semibold">
                    ¿De la atención de quién? <span className="text-[14px] font-normal text-neutral-500">(si no sabés, dejalo)</span>
                  </span>
                  <div className="flex flex-wrap gap-2.5">
                    {sellers.map((x) => (
                      <button key={x.id} aria-pressed={newDebt.providerId === x.id} onClick={() => setPickSeller(pickSeller === x.id ? null : x.id)} className={newDebt.providerId === x.id ? CHIP_ON : CHIP}>
                        {x.name}
                      </button>
                    ))}
                  </div>
                </div>
                <ReminderPicker value={newDebt.remindOn} onChange={(v) => setPickRemind(v)} chip={CHIP} chipOn={CHIP_ON} />
                <p className="text-[14px] text-neutral-500">
                  El aviso te llega a vos y a los admins. Se cobra escribiendo «{newDebt.debtor.split(" ")[0] || "carla"} pagó la deuda» o desde Cierre.
                </p>
              </Understood>
            ) : payout ? (
              <Understood
                tone="out"
                icon={<ArrowUpIcon size={20} weight="bold" />}
                title={payout.debt ? "Pago de lo que se le debía" : "Pago a profesional"}
                note={payoutMethod === "efectivo" ? "Sale de la caja" : "Por transferencia: no sale de la caja"}
              >
                <Person name={payout.seller.name}>
                  Se le paga <b className="font-semibold tabular-nums text-fg">{money(payoutAmount)}</b>
                  {payout.amount === null && (payout.debt ? " · todo lo que se le debía" : " · todo lo de hoy")}
                </Person>
                <div className="flex flex-col gap-2">
                  <span className="text-[16px] font-semibold">¿Cómo se le paga?</span>
                  <PayoutMethodChips value={payoutMethod} onChange={setPickPayoutMethod} />
                </div>
                {payout.debt ? (
                  <>
                    {weOwe(payout.seller.id) <= 0 && <Missing>No figura nada que se le deba de otros días</Missing>}
                    <After label="Se le debe después de esto" from={weOwe(payout.seller.id)} to={Math.max(0, weOwe(payout.seller.id) - payoutAmount)} good />
                  </>
                ) : (
                <>
                <p className="text-[15px] text-neutral-400">
                  Su parte de hoy <span className="tabular-nums text-fg">{money(owedTo(payout.seller.id)?.share ?? 0)}</span> · ya se le pagó{" "}
                  <span className="tabular-nums text-fg">{money(owedTo(payout.seller.id)?.paid ?? 0)}</span>
                </p>
                <After
                  label="Se le debe después de esto"
                  from={owedTo(payout.seller.id)?.owed ?? 0}
                  to={Math.max(0, (owedTo(payout.seller.id)?.owed ?? 0) - (payout.amount ?? owedTo(payout.seller.id)?.owed ?? 0))}
                  good
                />
                {weOwe(payout.seller.id) > 0 && (
                  <p className="text-[14px] text-neutral-500">
                    Aparte, ya anotado como deuda se le deben {money(weOwe(payout.seller.id))}: para eso escribí «le pagué la deuda a {payout.seller.name.split(" ")[0]}».
                  </p>
                )}
                </>
                )}
              </Understood>
            ) : expense ? (
              <Understood tone="out" icon={<ArrowUpIcon size={20} weight="bold" />} title="Gasto" note={expense.method === "efectivo" ? "Sale de la caja" : expense.method === "tarjeta" ? "Con tarjeta: no sale de la caja" : "Por transferencia: no sale de la caja"}>
                <div className="flex items-baseline justify-between gap-3">
                  <b className="text-[20px] font-semibold leading-tight">{expense.concept}</b>
                  {!!expense.amount && <span className="whitespace-nowrap text-[20px] font-semibold tabular-nums">− {money(expense.amount)}</span>}
                </div>
                {!expense.concept && <Missing>Falta en qué se gastó</Missing>}
                {!expense.amount && <Missing>Falta cuánto se gastó</Missing>}
                <button onClick={() => setExpenseForm({ initial: expense })} className="self-start text-[15px] text-neutral-400 underline-offset-4 hover:text-fg hover:underline">
                  Cambiar detalles
                </button>
              </Understood>
            ) : preview ? (
              <Understood
                tone="in"
                icon={<ArrowDownIcon size={20} weight="bold" />}
                title={hasPractice(preview.lines) ? "Atención" : preview.lines.length ? "Venta" : "Anotación"}
                note={preview.insurer ? `Por ${preview.insurer.name}: no entra plata` : preview.useAbono ? "Sesión del plan: ya está pagada" : preview.direct ? "No pasó por caja" : preview.payment === "profesional" ? "Le pagaron directo a la profesional: no entra a la caja" : preview.split?.giftcard ? "Gift card + otros medios: caja solo lo que se cobra hoy" : "Entra a la caja de hoy"}
              >
                {preview.askPatient ? (
                  <div className="flex flex-col gap-2">
                    <label htmlFor="ver-paciente" className="text-[16px] font-semibold">
                      ¿A qué paciente?
                    </label>
                    {!preview.patient && <Missing>Falta el nombre del paciente</Missing>}
                    <input
                      id="ver-paciente"
                      value={pickPatient}
                      onChange={(e) => setPickPatient(e.target.value)}
                      placeholder="Nombre del paciente"
                      className="h-12 rounded-xl border-2 border-neutral-800 bg-surface px-4 text-[17px] font-medium text-fg outline-none placeholder:text-neutral-600 focus:border-in"
                    />
                  </div>
                ) : preview.patientUnsure ? (
                  <div className="flex flex-col gap-2">
                    <Missing>«{preview.patient}» es…</Missing>
                    <div className="flex flex-wrap gap-2.5">
                      <button onClick={() => setUnsureIs("patient")} className={CHIP}>
                        el paciente
                      </button>
                      <button onClick={() => setUnsureIs("item")} className={CHIP}>
                        lo que se hizo o vendió
                      </button>
                    </div>
                  </div>
                ) : preview.patient ? (
                  <Person name={preview.patient}>Paciente</Person>
                ) : null}

                {(preview.lines.length > 0 || preview.unresolved.length > 0) && (
                  <ul className="flex flex-col gap-2">
                    {preview.lines.map((l, i) => (
                      <li key={i} className="flex items-baseline justify-between gap-3 text-[16px]">
                        <span>
                          {l.qty > 1 && <span className="tabular-nums text-neutral-400">{l.qty} × </span>}
                          <b className="font-semibold">{l.item.name}</b>
                          {l.item.kind === "pendiente" && <span className="text-[14px] text-neutral-400"> · no está cargado, va como pendiente</span>}
                          {!allowedFor(l.item, preview.sellerId) && <span className="text-[14px] font-medium text-warn"> · no es de esa médica</span>}
                          {l.item.kind === "producto" && l.qty > (l.item.available ?? 0) && (
                            <span className="text-[14px] text-neutral-400"> · sin stock cargado, se avisa al admin</span>
                          )}
                        </span>
                        <span className="whitespace-nowrap tabular-nums text-neutral-300">
                          {l.item.kind === "pendiente" && preview.paid === null ? "—" : money(lineAmounts(preview)[i])}
                        </span>
                      </li>
                    ))}
                    {preview.unresolved.map((u, k) => (
                      <li key={`u${k}`} className="flex flex-col gap-2 py-1">
                        <Missing>«{u.text}»: ¿cuál es?</Missing>
                        <div className="flex flex-wrap gap-2.5">
                          {(u.candidates.some((c) => allowedFor(c, preview.sellerId)) ? u.candidates.filter((c) => allowedFor(c, preview.sellerId)) : u.candidates).map((c) => (
                            <button key={c.id} onClick={() => setChosen({ ...chosen, [u.text]: c.id })} className={CHIP}>
                              {c.name}
                            </button>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {preview.deposit && (
                  <div className="flex flex-col gap-2.5 rounded-xl bg-neutral-900/60 px-4 py-3">
                    <span className="text-[16px] font-semibold">
                      Dejó seña de {money(preview.deposit.amount)}{" "}
                      <span className="font-normal text-neutral-400">
                        el {preview.deposit.createdAt.slice(8, 10)}/{preview.deposit.createdAt.slice(5, 7)}
                        {preview.deposit.itemName ? ` para ${preview.deposit.itemName}` : ""}
                      </span>
                    </span>
                    {preview.useDeposit ? (
                      <span className="text-[14px] text-neutral-500">
                        Se descuenta: hoy paga el resto y no queda deuda. La profesional cobra sobre el total.
                      </span>
                    ) : (
                      <span className="text-[14px] text-neutral-500">No se descuenta: la seña sigue guardada para otro día.</span>
                    )}
                    <button type="button" onClick={() => setPickDeposit(!preview.useDeposit)} className={`${CHIP} self-start`}>
                      {preview.useDeposit ? "No descontar la seña" : "Descontar la seña"}
                    </button>
                  </div>
                )}
                {giftCardLine && (
                  <div className="flex flex-col gap-3 rounded-xl bg-neutral-900/60 px-4 py-3">
                    <span className="text-[16px] font-semibold">Emitir gift card</span>
                    <p className="text-[13px] text-neutral-400">El valor se toma de «Pagó» y puede ser distinto del precio de lista del producto.</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" aria-pressed={giftCardKind === "amount"} onClick={() => setGiftCardKind("amount")} className={giftCardKind === "amount" ? CHIP_ON : CHIP}>Por monto</button>
                      <button type="button" aria-pressed={giftCardKind === "treatment"} onClick={() => setGiftCardKind("treatment")} className={giftCardKind === "treatment" ? CHIP_ON : CHIP}>Por tratamiento</button>
                    </div>
                    {giftCardKind === "treatment" && (
                      <label className="flex flex-col gap-1">
                        <span className="text-[13px] text-neutral-400">Tratamiento incluido</span>
                        <select value={giftCardTreatmentId} onChange={(e) => setGiftCardTreatmentId(e.target.value)} className="min-h-11 rounded-lg border border-neutral-700 bg-surface px-3 text-[14px] text-fg">
                          <option value="">Elegí un tratamiento…</option>
                          {(catalog?.practices ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.price)}</option>)}
                        </select>
                        {!giftCardTreatmentId && <Missing>Elegí el tratamiento del vale</Missing>}
                      </label>
                    )}
                    <label className="flex flex-col gap-1">
                      <span className="text-[13px] text-neutral-400">Comprador (opcional)</span>
                      <input value={giftCardBuyer} onChange={(e) => setGiftCardBuyer(e.target.value)} placeholder="Nombre de quien compra" className="min-h-11 rounded-lg border border-neutral-700 bg-surface px-3 text-[14px] text-fg" />
                    </label>
                  </div>
                )}
                {!giftCardLine && preview.lines.length > 0 && (
                  <div className="flex flex-col gap-2 rounded-xl bg-neutral-900/60 px-4 py-3">
                    <span className="text-[15px] font-semibold">Canjear gift card</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <input value={giftCardCodeInput} onChange={(e) => setGiftCardCodeInput(e.target.value.toUpperCase())} placeholder="Código GC-…" className="min-h-11 min-w-[190px] flex-1 rounded-lg border border-neutral-700 bg-surface px-3 text-[14px] text-fg" />
                      <button type="button" disabled={!giftCardCodeInput.trim()} onClick={lookupGiftCard} className={CHIP}>Consultar</button>
                    </div>
                    {giftCardError && <p role="alert" className="text-[13px] text-warn">{giftCardError}</p>}
                    {giftCardFound && (
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[14px]">
                        <span>{giftCardFound.code}{giftCardFound.kind === "treatment" ? ` · ${giftCardFound.treatmentName}` : " · saldo"} · disponible {money(giftCardFound.balance)}</span>
                        <button type="button" onClick={applyGiftCard} className={CHIP_ON}>Aplicar hasta {money(Math.min(giftCardFound.balance, preview.listNow))}</button>
                      </div>
                    )}
                    {!!preview.split?.giftcard && <p className="text-[13px] text-neutral-400">Se aplican {money(preview.split.giftcard)} de la gift card; el resto queda distribuido en los otros medios.</p>}
                  </div>
                )}
                {preview.insurer ? (
                  <div className="flex flex-col gap-2.5 rounded-xl bg-neutral-900/60 px-4 py-3">
                    <span className="text-[16px] font-semibold">
                      Por {preview.insurer.name}
                      {preview.sellerId && (
                        <span className="font-normal text-neutral-400">
                          {" "}
                          · {sellers.find((x) => x.id === preview.sellerId)?.owner
                            ? "es admin: no se lleva nada"
                            : `${firstName((sellers.find((x) => x.id === preview.sellerId)?.name ?? "").replace(/^(Dra?\.|Lic\.)\s*/i, ""))} se lleva ${money(preview.insurer.fee)}`}
                        </span>
                      )}
                    </span>
                    <span className="text-[14px] text-neutral-500">No entra plata por la atención. El consultorio le paga a la profesional el monto de {preview.insurer.name}.</span>
                    <button type="button" onClick={() => setPickInsurer(null)} className={`${CHIP} self-start`}>
                      No es por {preview.insurer.name}, pagó
                    </button>
                  </div>
                ) : preview.namedInsurer && pickInsurer === null ? (
                  <button type="button" onClick={() => setPickInsurer(undefined)} className={`${CHIP} self-start`}>
                    Es por {preview.namedInsurer.name}
                  </button>
                ) : null}
                {preview.abono ? (
                  <div className="flex flex-col gap-2.5 rounded-xl bg-neutral-900/60 px-4 py-3">
                    <span className="text-[16px] font-semibold">
                      Tiene un plan de {preview.abono.itemName}: {prepaidLeft(preview.abono)}
                    </span>
                    {preview.useAbono === null && <Missing>¿Esta sesión es del plan?</Missing>}
                    <div className="flex flex-wrap gap-2.5">
                      <button aria-pressed={preview.useAbono === true} onClick={() => setPickAbono(true)} className={preview.useAbono === true ? CHIP_ON : CHIP}>
                        Sí, descontar del plan
                      </button>
                      <button aria-pressed={preview.useAbono === false} onClick={() => setPickAbono(false)} className={preview.useAbono === false ? CHIP_ON : CHIP}>
                        No, pagó aparte
                      </button>
                    </div>
                    {preview.useAbono && (
                      <span className="text-[14px] text-neutral-500">
                        No entra plata: ya la pagó. La profesional cobra su parte sobre {money(preview.abono.unitPrice)}. Después{" "}
                        {preview.abono.sessionsLeft - 1 <= 0 ? "el plan queda terminado" : preview.abono.sessionsLeft - 1 === 1 ? "queda 1 sesión" : `quedan ${preview.abono.sessionsLeft - 1} sesiones`}.
                      </span>
                    )}
                  </div>
                ) : preview.abonoChoices.length > 1 ? (
                  <div className="flex flex-col gap-2.5 rounded-xl bg-neutral-900/60 px-4 py-3">
                    <Missing>¿De cuál plan?</Missing>
                    <div className="flex flex-wrap gap-2.5">
                      {preview.abonoChoices.map((p) => (
                        <button key={p.id} type="button" onClick={() => setPickAbonoId(p.id)} className={CHIP}>
                          {p.itemName} · {prepaidLeft(p)}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : preview.saysAbono && preview.patient ? (
                  <p className="text-[14px] text-neutral-500">No encontré un plan de {preview.patient} para esto: se anota sin que entre plata.</p>
                ) : null}
                {nothing && <Missing>Falta qué se hizo o se vendió</Missing>}

                {/* Quién: lo dice el texto, se deduce o se toca acá */}
                {!isMedico &&
                  (preview.sellerId && !pickSeller && !notHers ? (
                    <p className="text-[15px] text-neutral-400">
                      Atiende <span className="font-semibold text-fg">{sellers.find((x) => x.id === preview.sellerId)?.name}</span>
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {notHers ? (
                        <Missing>Eso no lo hace la médica nombrada. ¿Quién la atendió?</Missing>
                      ) : preview.sellerId ? (
                        <span className="text-[16px] font-semibold">¿Quién la atendió?</span>
                      ) : (
                        <Missing>Falta quién la atendió. Tocá una opción:</Missing>
                      )}
                      <div className="flex flex-wrap gap-2.5">
                        {(possible?.length ? possible : sellers).map((x) => (
                          <button key={x.id} aria-pressed={pickSeller === x.id} onClick={() => setPickSeller(pickSeller === x.id ? null : x.id)} className={pickSeller === x.id ? CHIP_ON : CHIP}>
                            {x.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}

                {/* Plata: cuánto ingresó (siempre) y el reparto que hace el sistema */}
                {preview.lines.length > 0 && !onlyAbono && (
                  <div className="flex flex-col gap-3 border-t border-divider pt-4 text-[15px]">
                    <label className="flex flex-wrap items-center gap-3">
                      <span className="w-[120px] font-semibold">Pagó</span>
                      <input
                        value={pickPaid !== null ? (pickPaid ? `$ ${toPesos(pickPaid).toLocaleString("es-AR")}` : "") : `$ ${ingreso.toLocaleString("es-AR")}`}
                        onChange={(e) => setPickPaid(e.target.value.replace(/\D/g, ""))}
                        inputMode="numeric"
                        placeholder="$ 0"
                        disabled={!!preview.split}
                        className={MONEY_IN}
                      />
                      {preview.split ? (
                        <span className="text-[14px] text-neutral-500">suma de los medios de abajo</span>
                      ) : preview.payment === "profesional" ? (
                        <span className="text-[14px] text-neutral-500">lo cobró ella · no entra a la caja</span>
                      ) : preview.direct ? (
                        <span className="text-[14px] text-neutral-500">no pasó por caja</span>
                      ) : preview.paid === null && pickPaid === null ? (
                        <span className="text-[14px] text-neutral-500">precio de lista · cambialo si pagó otro importe</span>
                      ) : null}
                    </label>
                    {sellerOwner ? (
                      <p className="flex flex-wrap items-center gap-3">
                        <span className="w-[120px] truncate text-neutral-400">Para {firstName(sellerName!.replace(/^(Dra?\.|Lic\.)\s*/i, ""))}</span>
                        <span className="text-[14px] text-neutral-500">nada aparte: es admin, todo va para el consultorio</span>
                      </p>
                    ) : (
                      <label className="flex flex-wrap items-center gap-3">
                        <span className="w-[120px] truncate text-neutral-400">Para {sellerName ? firstName(sellerName.replace(/^(Dra?\.|Lic\.)\s*/i, "")) : "la profesional"}</span>
                        <input
                          value={pickShare !== null ? (pickShare ? `$ ${toPesos(pickShare).toLocaleString("es-AR")}` : "") : preview.share !== null ? `$ ${preview.share.toLocaleString("es-AR")}` : ""}
                          onChange={(e) => setPickShare(e.target.value.replace(/\D/g, ""))}
                          inputMode="numeric"
                          placeholder={`$ ${auto.toLocaleString("es-AR")}`}
                          className={MONEY_IN}
                        />
                        <span className="text-[14px] text-neutral-500">
                          {preview.share === null ? "según su comisión" : preview.payment === "profesional" && preview.owesUs !== null && pickShare === null ? "lo que cobró menos lo que nos debe" : "lo que aclaraste"}
                        </span>
                      </label>
                    )}
                    <p className="flex flex-wrap items-center gap-3">
                      <span className="w-[120px] text-neutral-400">Para Decles</span>
                      <span className="font-semibold tabular-nums">{ingreso - parte < 0 ? `− ${money(parte - ingreso)}` : money(ingreso - parte)}</span>
                      {preview.payment === "profesional" && !sellerOwner && ingreso - parte > 0 && (
                        <span className="text-[14px] text-neutral-500">nos lo debe {sellerName ? firstName(sellerName.replace(/^(Dra?\.|Lic\.)\s*/i, "")) : "ella"} · se descuenta en el cierre</span>
                      )}
                    </p>
                    {canExpense &&
                      (preview.debt ? (
                        <label className="flex flex-wrap items-center gap-3">
                          <span className="w-[120px] font-semibold text-owe">Queda debiendo</span>
                          <input
                            value={pickDebt !== null ? (pickDebt ? `$ ${toPesos(pickDebt).toLocaleString("es-AR")}` : "") : `$ ${preview.debt.toLocaleString("es-AR")}`}
                            onChange={(e) => setPickDebt(e.target.value.replace(/\D/g, ""))}
                            inputMode="numeric"
                            placeholder="$ 0"
                            className={MONEY_IN}
                          />
                          <span className="text-[14px] text-neutral-500">se anota como deuda · el admin recibe el aviso</span>
                        </label>
                      ) : !preview.direct && !preview.split && ingreso < preview.listNow ? (
                        <button onClick={() => setPickDebt(String(preview.listNow - ingreso))} className={`${CHIP} self-start`}>
                          ¿Quedó debiendo {money(preview.listNow - ingreso)}?
                        </button>
                      ) : pickDebt === "" ? null : (
                        <button onClick={() => setPickDebt("")} className="self-start text-[14px] text-neutral-500 underline-offset-4 hover:text-fg hover:underline">
                          Quedó debiendo algo
                        </button>
                      ))}
                    {pickDebt === "" && !preview.debt && (
                      <label className="flex flex-wrap items-center gap-3">
                        <span className="w-[120px] font-semibold text-owe">Queda debiendo</span>
                        <input autoFocus value="" onChange={(e) => setPickDebt(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="$ 0" className={MONEY_IN} />
                      </label>
                    )}
                    {canExpense && !!preview.debt && <ReminderPicker value={preview.remindOn} onChange={(v) => setPickRemind(v)} chip={CHIP} chipOn={CHIP_ON} />}
                  </div>
                )}

                {/* Pago: un medio, dólares o varios medios */}
                {!onlyAbono && (
                <div className="flex flex-col gap-2">
                  <span className="text-[16px] font-semibold">
                    ¿Cómo pagó? {!payMode && <span className="text-[14px] font-normal text-neutral-500">(si no sabés, dejalo)</span>}
                  </span>
                  <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
                    {PAY_OPTIONS.map(([m, label, Icon]) => {
                      const on = payMode === m;
                      return (
                        <button
                          key={m}
                          aria-pressed={on}
                          onClick={() => {
                            setPickSplit(null);
                            setPickPay(on ? null : m);
                          }}
                          className={on ? PICK_ON : PICK}
                        >
                          <Icon size={24} aria-hidden="true" />
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                )}
                {preview.split && (
                  <SplitInputs
                    split={preview.split}
                    onlyUsd={payMode === "dolares"}
                    rate={preview.split.rate ?? rate}
                    onChange={(s) => {
                      if (!pickPay) setPickPay(payMode as "dolares" | "varios");
                      setPickSplit(s);
                    }}
                  />
                )}
              </Understood>
            ) : (
              <p className="text-[14px] text-neutral-400">
                Sirve para pacientes y para ventas. Ej: «Gabriela vendió 2 cremas con tarjeta»
                {canExpense && <> · y para gastos: «pagué 5000 de luz»</>}.
              </p>
            )}

            <button
              onClick={go}
              disabled={
                provDebt
                  ? provDebtAmount <= 0 || busy
                  : newDeposit
                    ? !depositReady || busy
                  : newPrepaid
                    ? !prepaidReady || busy
                    : payablePay
                      ? !payingPayable || !payableMethod || payableAmount <= 0 || busy
                      : newPayable
                        ? !payableReady || busy
                        : payout ? payoutAmount <= 0 || busy : debtPay ? !payingDebt || !debtMethod || busy : newDebt || expense ? busy : !canSave || busy || loading}
              className={debtPay || newPrepaid || newDeposit ? CTA_IN : provDebt || newDebt || payablePay || newPayable || payout || expense ? CTA : CTA_IN}
            >
              {busy
                ? "Guardando…"
                : provDebt
                  ? provDebt.paidNow
                    ? `Sí, pagar ${money(provDebt.paidNow)} y dejar debiendo ${money(provDebtAmount)}`
                    : `Sí, anotar que le debemos ${money(provDebtAmount)}`
                : newDeposit
                  ? depositReady
                    ? `Sí, anotar seña de ${money(newDeposit.amount)}`
                    : "Completá lo que falta"
                : payablePay
                  ? !payingPayable
                    ? "Elegí cuál"
                    : !payableMethod
                      ? "Primero elegí cómo se pagó"
                      : `Sí, anotar pago de ${money(payableAmount)}`
                : newPayable
                  ? payableReady
                    ? `Sí, anotar que debemos ${money(newPayable.amount!)}`
                    : "Completá lo que falta"
                : newPrepaid
                  ? prepaidReady
                    ? `Sí, anotar abono de ${money(newPrepaid.amount!)}`
                    : "Completá lo que falta"
                : debtPay
                  ? !payingDebt
                    ? "Elegí cuál deuda"
                    : !debtMethod
                      ? "Primero elegí cómo pagó"
                      : `Sí, anotar cobro de ${money(payAmount)}`
                  : newDebt
                    ? `Sí, anotar deuda de ${money(newDebt.amount)}`
                    : payout
                      ? `Sí, anotar pago de ${money(payoutAmount)}`
                      : expense
                        ? expense.concept && expense.amount
                          ? `Sí, anotar gasto de ${money(expense.amount)}`
                          : "Completar el gasto"
                        : !preview
                          ? "Guardar"
                          : nothing
                            ? "Falta qué se hizo"
                            : pendingQ
                              ? "Primero tocá la opción correcta"
                              : missingPatient
                                ? "Falta el paciente"
                                : missingSeller || notHers
                                  ? "Primero elegí quién la atendió"
                                  : onlyAbono
                                    ? preview.insurer
                                      ? `Sí, anotar atención por ${preview.insurer.name}`
                                      : "Sí, anotar sesión del plan"
                                    : `Sí, anotar ${hasPractice(preview.lines) ? "atención" : "venta"} de ${money(ingreso)}`}
            </button>
            {(provDebt || newPrepaid || newDeposit || payablePay || newPayable || debtPay || newDebt || payout || expense || preview) && (
              <button onClick={() => box.current?.focus()} className={`${GHOST} -mt-1 min-h-[52px] text-[15px] font-medium`}>
                No, quiero corregirlo
              </button>
            )}
            {preview && !nothing && !expense && !payout && !debtPay && !newDebt && !provDebt && !newPrepaid && !newDeposit && !payablePay && !newPayable && (
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
            <div className="flex flex-col gap-2 pt-2">
              {text.trim() && <span className="text-[13.5px] text-neutral-500">¿No era esto?</span>}
              <div className={`grid gap-2.5 ${canExpense ? "sm:grid-cols-2" : ""}`}>
                <button
                  onClick={() => {
                    setDraft(emptyDraft("manual", fixedSeller));
                    setMode("manual");
                  }}
                  disabled={loading}
                  className={`${GHOST} min-h-[48px] gap-2.5 border-transparent bg-neutral-900`}
                >
                  <SquaresFourIcon size={20} /> Elegir de una lista
                </button>
                {canExpense && (
                  <button onClick={() => setExpenseForm({})} className={`${GHOST} min-h-[48px] gap-2.5 border-transparent bg-neutral-900`}>
                    <MinusIcon size={18} /> Anotar un gasto
                  </button>
                )}
              </div>
            </div>
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
            setTimeout(() => setFlash(null), 2400);
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
  const [sellersData] = usePoll<{ ok: boolean; sellers: { providerId: string; name: string; aliases: string[]; commissionPct?: number; owner?: boolean }[] }>(
    "/api/sellers",
    60_000,
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const items: Item[] = useMemo(() => {
    const practices = (catalog?.practices ?? []).map((p): Item => ({ id: p.id, name: p.name, kind: "practica", price: p.price, cardPrice: p.cardPrice, providerIds: p.providerIds ?? [], pct: p.commissionPct, cuts: p.providerCuts }));
    const products = (catalog?.products ?? [])
      .filter((p) => p.price !== null && p.priceItemId)
      .map((p): Item => ({ id: p.priceItemId!, name: p.name, kind: "producto", price: p.price!, cardPrice: p.cardPrice, available: p.available, giftCard: p.giftCard, providerIds: p.providerIds ?? [], pct: p.commissionPct, cuts: p.providerCuts }));
    return [...practices, ...products];
  }, [catalog]);
  const sellers: Seller[] = useMemo(
    () => (sellersData?.sellers ?? []).map((x) => ({ id: x.providerId, name: x.name, aliases: x.aliases, pct: x.commissionPct, owner: !!x.owner })),
    [sellersData],
  );
  const paid = sales.filter((x) => x.status === "paid");
  // Varios medios / dólares: las partes guardadas (con la cotización que se usó ese día).
  const day = paid[0]?.createdAt.slice(0, 10) ?? "";
  const split0 = paid[0]?.paymentMethod === "mixto" || paid[0]?.paymentMethod === "dolares";
  const [payData] = usePoll<{ ok: boolean; payments?: PaymentsMap }>(split0 ? `/api/sales?from=${day}&to=${day}&limit=500` : "/api/dolar", 60_000);
  // Borrador inicial armado con lo guardado; lo que se toca después vive en `edited`.
  const initial = useMemo(() => {
    if (!catalog || (split0 && !payData)) return null;
    const first = paid[0];
    const d = emptyDraft("text", first?.providerId ?? null);
    d.patient = first?.patientName ?? "";
    const pm = first?.paymentMethod ?? null;
    d.payment = pm === "mixto" || pm === "dolares" ? null : pm;
    if (split0 && first?.visitId) {
      const parts = payData?.payments?.[first.visitId] ?? [];
      const s: Split = { efectivo: 0, transferencia: 0, tarjeta: 0, usd: 0, rate: null };
      for (const p of parts) {
        if (p.method === "dolares") {
          s.usd += p.usd ?? 0;
          s.rate = p.rate ?? s.rate;
        } else if (p.method === "efectivo" || p.method === "transferencia" || p.method === "tarjeta") s[p.method] += p.amount;
        else if (p.method === "giftcard") s.giftcard = (s.giftcard ?? 0) + p.amount;
      }
      d.split = s;
      d.paid = splitPesos(s, null);
    }
    // Lo que ingresó y la parte de la profesional, si se escribieron a mano, se conservan.
    if (paid.some((x) => x.priceManual)) d.paid = paid.reduce((n, x) => n + x.total, 0);
    if (paid.some((x) => x.commissionManual)) d.share = paid.reduce((n, x) => n + x.commissionAmount, 0);
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
  }, [catalog, items, payData]);
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
        ...(draft.split ? { payments: splitParts(draft.split, null) } : { paymentMethod: draft.payment }),
        lines: visitLines(draft),
      }),
    })
      .then((x) => x.json())
      .catch(() => ({ ok: false, error: "No se pudo conectar." }));
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "No se pudo guardar.");
    onSaved();
  }

  // Lo anotado en la Planilla (importes a mano, observaciones, «Atención» sin práctica) se corrige allá.
  const fromSheet = paid.some((x) => x.observations || (!x.itemId && x.kind !== "pendiente"));

  return (
    <div className="cl-fade-in fixed inset-0 z-40 overflow-y-auto bg-black/60 px-4 py-10" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mx-auto w-full max-w-[640px]">
        {fromSheet ? (
          <div className="flex flex-col gap-3 rounded-xl bg-surface p-5">
            <p className="text-[14px]">Esto se anotó en Planilla → Día como «Atención» sin práctica. Corregilo desde ahí.</p>
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
      <span className="text-[26px] font-semibold">¡Listo, anotado!</span>
      {summary && <span className="max-w-[480px] text-[17px] leading-[1.5] text-neutral-300">{summary}</span>}
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
  const missingSeller = !isMedico && !draft.sellerId;
  const missingPatient = (hasPractice(draft.lines) || !!draft.debt) && !draft.patient.trim();
  const [dolar] = useDolar();
  const rate = dolar?.rate ?? null;
  const mode = draft.split ? (draft.split.efectivo + draft.split.transferencia + draft.split.tarjeta + (draft.split.giftcard ?? 0) === 0 ? "dolares" : "varios") : draft.payment;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="flex min-h-11 items-center gap-2 rounded-xl py-2 pl-1.5 pr-3.5 text-[14px] font-medium hover:bg-neutral-900">
          <CaretLeftIcon size={20} weight="bold" /> Volver
        </button>
        <input
          value={draft.patient}
          onChange={(e) => setDraft({ ...draft, patient: e.target.value })}
          placeholder="Paciente"
          aria-label="Paciente"
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
        {draft.lines.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="¿Cómo pagó?">
              {[...PAYMENTS, ["varios", "Varios medios"] as const].map(([m, label]) => (
                <button
                  key={m}
                  aria-pressed={mode === m}
                  onClick={() => {
                    if (mode === m) return setDraft({ ...draft, payment: null, split: null, paid: draft.split ? null : draft.paid });
                    if (m === "dolares" || m === "varios") {
                      const sp: Split = m === "dolares" ? { efectivo: 0, transferencia: 0, tarjeta: 0, usd: 0 } : { efectivo: shownPaid(draft), transferencia: 0, tarjeta: 0, usd: 0 };
                      return setDraft({ ...draft, payment: null, split: sp, paid: splitPesos(sp, rate) });
                    }
                    setDraft({ ...draft, payment: m as Payment, split: null, paid: draft.split ? null : draft.paid });
                  }}
                  className={mode === m ? CHIP_ON : CHIP}
                >
                  {label}
                </button>
              ))}
              {!mode && <span className="text-[13px] text-neutral-500">pago opcional</span>}
            </div>
            {draft.split && (
              <SplitInputs
                split={draft.split}
                onlyUsd={mode === "dolares"}
                rate={draft.split.rate ?? rate}
                onChange={(sp) => setDraft({ ...draft, split: sp, paid: splitPesos(sp, rate) })}
              />
            )}
            <div className="flex flex-col gap-2 text-[14px]">
              <label className="flex flex-wrap items-center gap-2">
                <span className="w-[140px] text-neutral-400">Ingresó</span>
                <input
                  value={`$ ${shownPaid(draft).toLocaleString("es-AR")}`}
                  onChange={(e) => setDraft({ ...draft, paid: toPesos(e.target.value) })}
                  disabled={!!draft.split}
                  inputMode="numeric"
                  className={MONEY_IN}
                />
                {draft.paid === null && !draft.debt && <span className="text-[13px] text-neutral-500">precio de lista</span>}
              </label>
              <DebtInput draft={draft} setDraft={setDraft} />
            </div>
          </>
        )}
        <button onClick={onSave} disabled={busy || missingSeller || !draft.lines.length || missingPatient} className={CTA}>
          {busy
            ? "Guardando…"
            : missingSeller
              ? "Elegí quién la atendió"
              : !draft.lines.length
                ? "Marcá lo que se hizo o vendió"
                : missingPatient
                  ? "Falta el paciente"
                  : `Guardar · ${money(shownPaid(draft))}${draft.debt ? ` · debe ${money(draft.debt)}` : ""}`}
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
  // Sin importar mayúsculas, tildes ni errores de tipeo; lo más parecido primero.
  const list = items
    .filter((i) => allowedFor(i, sellerId))
    .map((i) => ({ i, s: q.trim() ? searchScore(q, i.name) : 1 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.i)
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
  const [dolar] = useDolar();
  const rate = dolar?.rate ?? null;
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
  const missingPatient = (hasPractice(draft.lines) || !!draft.debt) && !draft.patient.trim();
  const blocked = !draft.lines.length || draft.unresolved.length > 0 || missingSeller || anyNotHers || draft.patientUnsure || missingPatient;

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
          placeholder={hasPractice(draft.lines) ? "Nombre de la paciente" : "Nombre (opcional)"}
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
              <span className="text-[14px] tabular-nums text-neutral-300">{money(lineAmounts(draft)[i])}</span>
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
          {[...PAYMENTS, ["varios", "Varios medios"] as const].map(([m, label]) => {
            const mode = draft.split ? (draft.split.efectivo + draft.split.transferencia + draft.split.tarjeta + (draft.split.giftcard ?? 0) === 0 ? "dolares" : "varios") : draft.payment;
            return (
              <button
                key={m}
                aria-pressed={mode === m}
                onClick={() => {
                  if (mode === m) return setDraft({ ...draft, payment: null, split: null, paid: draft.split ? null : draft.paid });
                  if (m === "dolares" || m === "varios") {
                    const s: Split = m === "dolares" ? { efectivo: 0, transferencia: 0, tarjeta: 0, usd: 0 } : { efectivo: draft.paid ?? cash, transferencia: 0, tarjeta: 0, usd: 0 };
                    return setDraft({ ...draft, payment: null, split: s, paid: splitPesos(s, rate) });
                  }
                  setDraft({ ...draft, payment: m as Payment, split: null, paid: draft.split ? null : draft.paid });
                }}
                className={mode === m ? CHIP_ON : CHIP}
              >
                {label}
              </button>
            );
          })}
          {!draft.payment && !draft.split && <span className="self-center text-[13px] text-neutral-500">Cómo pagó: opcional</span>}
        </div>
        {draft.split && (
          <SplitInputs
            split={draft.split}
            onlyUsd={draft.split.efectivo + draft.split.transferencia + draft.split.tarjeta + (draft.split.giftcard ?? 0) === 0}
            rate={draft.split.rate ?? rate}
            onChange={(s) => setDraft({ ...draft, split: s, paid: splitPesos(s, rate) })}
          />
        )}
      </div>

      {/* Plata: cuánto ingresó y el reparto (la profesional según su %, salvo que se aclare) */}
      <div className="flex flex-col gap-2 text-[14px]">
        <label className="flex flex-wrap items-center gap-2">
          <span className="w-[140px] text-neutral-400">Ingresó</span>
          <input
            value={`$ ${shownPaid(draft).toLocaleString("es-AR")}`}
            onChange={(e) => setDraft({ ...draft, paid: toPesos(e.target.value), direct: false })}
            disabled={!!draft.split}
            inputMode="numeric"
            className={MONEY_IN}
          />
          {draft.paid === null && !draft.payment && card !== cash && <span className="text-[13px] text-neutral-500">o {money(card)} con tarjeta</span>}
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <span className="w-[140px] text-neutral-400">Para la profesional</span>
          <input
            value={draft.share !== null ? `$ ${draft.share.toLocaleString("es-AR")}` : ""}
            onChange={(e) => setDraft({ ...draft, share: e.target.value.replace(/\D/g, "") ? toPesos(e.target.value) : null })}
            inputMode="numeric"
            placeholder={`$ ${autoShare(draft, sellers).toLocaleString("es-AR")}`}
            className={MONEY_IN}
          />
          <span className="text-[13px] text-neutral-500">{draft.share === null ? "según su comisión" : "a mano"}</span>
        </label>
        <p className="flex items-center gap-2">
          <span className="w-[140px] text-neutral-400">Para Decles</span>
          <span className="tabular-nums">
            {money(shownPaid(draft) - (draft.share ?? autoShare(draft, sellers)))}
          </span>
        </p>
        {/* Editando, la deuda ya existe (se corrige desde Cierre → Deudas). */}
        {!editing && <DebtInput draft={draft} setDraft={setDraft} />}
        {pendingCount > 0 && (
          <p className="text-[14px] text-neutral-400">+ {pendingCount === 1 ? "1 cosa sin precio" : `${pendingCount} cosas sin precio`} todavía (lo completa el admin)</p>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <button onClick={onSave} disabled={busy || blocked} className={`${CTA} flex-[2_1_220px]`}>
          {busy
            ? "Guardando…"
            : missingPatient
              ? "Falta el paciente"
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

/** Cuánto pagó con cada medio; los dólares se pasan a pesos con la cotización del día. */
function SplitInputs({ split, onlyUsd, rate, onChange }: { split: Split; onlyUsd: boolean; rate: number | null; onChange: (s: Split) => void }) {
  const field = (k: "efectivo" | "transferencia" | "tarjeta", label: string) => (
    <label key={k} className="flex items-center gap-2">
      <span className="w-[112px] text-neutral-400">{label}</span>
      <input
        value={split[k] ? `$ ${split[k].toLocaleString("es-AR")}` : ""}
        onChange={(e) => onChange({ ...split, [k]: toPesos(e.target.value) })}
        inputMode="numeric"
        placeholder="$ 0"
        className={MONEY_IN}
      />
    </label>
  );
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-neutral-900/60 px-3 py-2.5 text-[14px]">
      {!onlyUsd && (
        <>
          {field("efectivo", "Efectivo")}
          {field("transferencia", "Transferencia")}
          {field("tarjeta", "Tarjeta")}
          {split.giftcard !== undefined && (
            <label className="flex items-center gap-2">
              <span className="w-[112px] text-neutral-400">Gift card</span>
              <input value={split.giftcard ? `$ ${split.giftcard.toLocaleString("es-AR")}` : ""} onChange={(e) => onChange({ ...split, giftcard: toPesos(e.target.value) })} inputMode="numeric" placeholder="$ 0" className={MONEY_IN} />
            </label>
          )}
        </>
      )}
      <label className="flex flex-wrap items-center gap-2">
        <span className="w-[112px] text-neutral-400">Dólares</span>
        <input
          value={split.usd ? `US$ ${split.usd.toLocaleString("es-AR")}` : ""}
          onChange={(e) => onChange({ ...split, usd: Number(e.target.value.replace(/[^\d,]/g, "").replace(",", ".")) || 0 })}
          inputMode="decimal"
          placeholder="US$ 0"
          className={MONEY_IN}
        />
        <span className="text-[13px] text-neutral-500">
          {rate ? `× ${money(rate)} = ${money(Math.round(split.usd * rate))}` : "falta la cotización del dólar"}
        </span>
      </label>
    </div>
  );
}

const MONEY_IN =
  "h-11 w-[150px] rounded-lg border-2 border-neutral-800 bg-surface px-3 text-right text-[17px] font-semibold tabular-nums text-fg outline-none placeholder:text-neutral-500 focus:border-in disabled:opacity-60";
const CTA =
  "flex min-h-14 items-center justify-center gap-2 rounded-lg border border-accent bg-accent px-5 text-[17px] font-semibold text-on-accent transition-opacity hover:opacity-85 active:opacity-70 disabled:cursor-not-allowed disabled:border-dashed disabled:border-neutral-700 disabled:bg-neutral-900 disabled:text-neutral-400";
const CTA_IN =
  "flex min-h-14 items-center justify-center gap-2 rounded-lg border border-in bg-in px-5 text-[17px] font-semibold text-on-in transition-opacity hover:opacity-90 active:opacity-75 disabled:cursor-not-allowed disabled:border-dashed disabled:border-neutral-700 disabled:bg-neutral-900 disabled:text-neutral-400";
/** Medios de pago en la confirmación, con nombre completo e ícono (no se abrevia). */
const PAY_OPTIONS = [
  ["efectivo", "Efectivo", MoneyIcon],
  ["transferencia", "Transferencia", ArrowsLeftRightIcon],
  ["tarjeta", "Tarjeta", CreditCardIcon],
  ["dolares", "Dólares", CurrencyDollarIcon],
  ["varios", "Varios medios", StackIcon],
  ["profesional", "A la profesional", HandCoinsIcon],
] as const;
const PICK =
  "flex min-h-[68px] flex-col items-center justify-center gap-1 rounded-xl border-2 border-neutral-800 px-2 text-center text-[15px] font-semibold text-neutral-300 transition-colors hover:border-neutral-600";
const PICK_ON =
  "flex min-h-[68px] flex-col items-center justify-center gap-1 rounded-xl border-2 border-in bg-in-bg px-2 text-center text-[15px] font-semibold text-in-fg";

/**
 * «Lo que entendí»: la tarjeta de confirmación de Anotar. El color dice qué pasa con la plata:
 * `in` entra (verde), `out` sale (neutro), `owe` queda debiendo (óxido).
 */
const TONES = {
  in: { border: "border-in-line", band: "bg-in-bg", dot: "bg-in text-on-in", fg: "text-in-fg" },
  out: { border: "border-neutral-800", band: "bg-neutral-900", dot: "bg-fg text-bg", fg: "text-neutral-300" },
  owe: { border: "border-neutral-800", band: "bg-neutral-900", dot: "bg-owe text-surface", fg: "text-neutral-300" },
} as const;

function Understood({ tone, icon, title, note, children }: { tone: keyof typeof TONES; icon: ReactNode; title: string; note: string; children: ReactNode }) {
  const t = TONES[tone];
  return (
    <section aria-label="Lo que entendí" className={`flex animate-cl-in flex-col overflow-hidden rounded-2xl border-2 bg-surface ${t.border}`}>
      <div className={`flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 ${t.band}`}>
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${t.dot}`}>
            {icon}
          </span>
          <div className="flex flex-col">
            <span className={`text-[17px] font-semibold ${t.fg}`}>{title}</span>
            <span className={`text-[14px] ${t.fg}`}>{note}</span>
          </div>
        </div>
        <span className={`text-[14px] ${t.fg}`}>Revisá que esté bien</span>
      </div>
      <div className="flex flex-col gap-5 px-5 py-5 text-[15px]">{children}</div>
    </section>
  );
}

/** Persona de la anotación: iniciales, nombre grande y una línea de detalle. */
function Person({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-[16px] font-semibold text-neutral-300">
        {initials(name) || "?"}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <b className="text-[20px] font-semibold leading-tight">{name || "¿Quién?"}</b>
        {children && <span className="text-[15px] text-neutral-400">{children}</span>}
      </div>
    </div>
  );
}

/** Efectivo (sale de la caja) o transferencia, para pagarle a una profesional. */
function PayoutMethodChips({ value, onChange }: { value: "efectivo" | "transferencia"; onChange: (m: "efectivo" | "transferencia") => void }) {
  return (
    <div className="flex flex-wrap gap-2.5">
      {(["efectivo", "transferencia"] as const).map((m) => (
        <button key={m} type="button" aria-pressed={value === m} onClick={() => onChange(m)} className={value === m ? CHIP_ON : CHIP}>
          {m === "efectivo" ? "Efectivo" : "Transferencia"}
        </button>
      ))}
    </div>
  );
}

/** Algo que falta o hay que mirar (ámbar). */
function Missing({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[15px] font-medium text-warn">
      <WarningCircleIcon size={20} weight="bold" aria-hidden="true" className="shrink-0" />
      <span>{children}</span>
    </span>
  );
}

/** Cómo queda un saldo después de anotar: antes tachado → después. */
function After({ label, from, to, good }: { label: string; from: number; to: number; good?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-neutral-900 px-4 py-3 text-[15px]">
      <span className="text-neutral-400">{label}</span>
      <span className="inline-flex items-center gap-2 tabular-nums">
        <span className="text-neutral-500 line-through">{money(from)}</span>
        <ArrowRightIcon size={16} className="text-neutral-500" aria-hidden="true" />
        <b className={`text-[17px] font-semibold ${good || to === 0 ? "text-in-fg" : "text-owe"}`}>{money(to)}</b>
      </span>
    </div>
  );
}
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.replace(/[^\p{L}]/gu, "")[0] ?? "")
    .map((c) => c.toUpperCase())
    .join("");
const GHOST =
  "flex items-center justify-center rounded-lg border border-neutral-800 px-4 text-[14px] text-neutral-300 transition-colors hover:border-accent-700 hover:bg-accent-900 hover:text-fg";
const ROUND =
  "flex h-9 w-9 items-center justify-center rounded-md border border-neutral-800 text-fg transition-colors hover:bg-accent-900 disabled:opacity-30";
const CHIP = "min-h-[44px] rounded-pill border-2 border-neutral-800 px-4 py-2 text-[15px] font-medium transition-colors hover:border-neutral-600";
const CHIP_ON = "min-h-[44px] rounded-pill border-2 border-accent bg-accent px-4 py-2 text-[15px] font-medium text-on-accent";
