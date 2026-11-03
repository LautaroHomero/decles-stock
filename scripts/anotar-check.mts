/* eslint-disable @typescript-eslint/no-explicit-any -- banco de pruebas: compara salidas de distintos parsers */
/**
 * Banco de pruebas del texto libre de Anotar: `npm run test:anotar`. Cada frase dice qué tiene que entender
 * (tipo de anotación, paciente, profesional, prácticas, plata). Sin base ni red: corre los parsers puros.
 * `route` sigue el mismo orden que `anotar-view.tsx` (pago a profesional → le debemos → abono → seña →
 * pago de lo que debemos → lo que debemos → cobro de deuda → egreso → atención). Sumá acá cada frase que falle en la vida real.
 */
import { parseNote } from "../src/lib/domain/quick-sale";
import { extractMoney, parsePayout, parseProviderDebt, parseDebtPayment } from "../src/lib/domain/money-note";
import { parseExpense } from "../src/lib/domain/expense-note";
import { parseDepositNote } from "../src/lib/domain/deposit-note";
import { parsePrepaidNote } from "../src/lib/domain/prepaid-note";
import { parsePayable, parsePayablePayment } from "../src/lib/domain/payable-note";

const names = ["Toxina botulínica (por zona)","Aplicación de botox","Consulta de ornella","Glicolico","Electroporación","Electrocoagulación","Kinesiologia","Sérum vitamina C","Shampoo Ketogeno","Venus freeze","Contorno LDA","Jeringas","Limpieza facial","Peeling","Atención","Crema hidratante facial","Protector solar FPS 50","Ácido hialurónico","Dermapen","Plasma rico en plaquetas","Radiofrecuencia","Mesoterapia"];
const items = names.map((n,i)=>({id:"i"+i,name:n}));
const sellers = [
  {id:"gab",name:"Gabriela Bravo",aliases:["gabi"]},{id:"mar",name:"Marisa Lopes"},{id:"orn",name:"Ornella Volpe"},
  {id:"lau",name:"Dra. Laura Decles"},{id:"car",name:"Carmen Ruiz"},{id:"pau",name:"Lic. Paula Ríos"},
];
const debts=[{id:"d1",debtor:"Florencia Cuevas",remaining:200000},{id:"d2",debtor:"Castucci",remaining:240000}];
const payables=[{id:"p1",creditor:"Distribuidora",concept:"insumos",remaining:300000}];
export function route(t: string) {
  const payout = parsePayout(t, sellers); if (payout) return { intent:"payout", seller:payout.seller.id, amount:payout.amount, method:payout.method, debt:payout.debt };
  const pd = parseProviderDebt(t, sellers); if (pd) return { intent:"provDebt", seller:pd.seller.id, amount:pd.amount };
  const pp = parsePrepaidNote(t); if (pp) return { intent:"prepaid", ...pp };
  const dp = parseDepositNote(t, "2026-11-03"); if (dp) return { intent:"deposit", ...dp };
  const pyp = parsePayablePayment(t, payables); if (pyp) return { intent:"payablePay", ...pyp, payable: (pyp as any).payable?.id };
  const py = parsePayable(t, "2026-11-03T12:00"); if (py) return { intent:"payable", ...py };
  const dpy = parseDebtPayment(t, debts); if (dpy) return { intent:"debtPay", debt:dpy.debts[0]?.id, amount:dpy.amount, usd:dpy.usd };
  const ex = parseExpense(t); if (ex) return { intent:"expense", ...ex };
  const m = extractMoney(t, "2026-11-03");
  const n = parseNote(m.text, items, sellers);
  return { intent:"visit", patient:n.patient, sure:n.patientSure, seller:n.seller?.id ?? null, pay:n.payment ?? m.method, lines:n.lines.map(l=>({q:l.quantity, item:l.match?.name ?? (l.candidates.length? "?"+l.candidates.map(c=>c.name).join("|") : "PEND:"+l.rest), s:l.seller?.id})), paid:m.paid, debt:m.debt, share:m.share, split:m.split, toProvider:m.toProvider, owesUs:m.owesUs, direct:m.direct, remind:m.remindOn, debtAll:m.debtAll, debtRest:m.debtRest, fractions:!!m.fractions, restMethod:(m as any).restMethod ?? null, text:m.text };
}

type Exp = Record<string, unknown>;
const C: [string, Exp][] = [
  // --- atenciones: orden y conectores
  ["villar luciana consulta ornella 45000", {intent:"visit", patient:"Villar Luciana", seller:"orn", items:["Consulta de ornella"], paid:45000}],
  ["consulta de ornella a villar luciana, 45000 transferencia", {patient:"Villar Luciana", seller:"orn", items:["Consulta de ornella"], pay:"transferencia", paid:45000}],
  ["le hice un glicolico a rey ana, 30000", {patient:"Rey Ana", items:["Glicolico"], paid:30000}],
  ["rey ana se hizo un glicólico con ornella, pagó 30 mil", {patient:"Rey Ana", seller:"orn", items:["Glicolico"], paid:30000}],
  ["ana rey: glicolico y shampoo ketogeno, ornella, efectivo", {patient:"Ana Rey", seller:"orn", items:["Glicolico","Shampoo Ketogeno"], pay:"efectivo"}],
  ["ana rey glicolico + shampoo, ornella", {patient:"Ana Rey", items:["Glicolico","Shampoo Ketogeno"]}],
  ["ana rey glicolico más shampoo ketogeno con ornella", {patient:"Ana Rey", items:["Glicolico","Shampoo Ketogeno"], seller:"orn"}],
  ["ana rey glicolico / shampoo ketogeno / serum vit c", {patient:"Ana Rey", items:["Glicolico","Shampoo Ketogeno","Sérum vitamina C"]}],
  ["ana rey - glicolico - ornella - 30000", {patient:"Ana Rey", items:["Glicolico"], seller:"orn", paid:30000}],
  ["vino ana rey que se hizo glicolico con ornella", {patient:"Ana Rey", items:["Glicolico"], seller:"orn"}],
  ["ana rey vino a hacerse un glicolico con ornella", {patient:"Ana Rey", items:["Glicolico"], seller:"orn"}],
  ["la paciente ana rey se atendió con ornella, consulta", {patient:"Ana Rey", items:["Consulta de ornella"], seller:"orn"}],
  ["ornella atendió a ana rey, consulta, 45000", {patient:"Ana Rey", items:["Consulta de ornella"], seller:"orn", paid:45000}],
  ["atendí a ana rey para ornella, consulta", {patient:"Ana Rey", seller:"orn"}],
  ["consulta ana rey ornella", {patient:"Ana Rey", items:["Consulta de ornella"], seller:"orn"}],
  ["Garaggiola Luca electrocoagulación ornella 95000 tarjeta", {patient:"Garaggiola Luca", items:["Electrocoagulación"], seller:"orn", paid:95000, pay:"tarjeta"}],
  ["electrocoagulacion a garaggiola luca por ornella con débito", {patient:"Garaggiola Luca", items:["Electrocoagulación"], seller:"orn", pay:"tarjeta"}],
  ["Maria de los Angeles Perez, limpieza facial, gabi", {patient:"Maria De Los Angeles Perez", items:["Limpieza facial"], seller:"gab"}],
  ["sra gomez limpieza facial con gabi", {patient:"Gomez", items:["Limpieza facial"], seller:"gab"}],
  ["juan carlos di maría, kinesiologia, paula", {patient:"Juan Carlos Di María", items:["Kinesiologia"], seller:"pau"}],
  // --- cantidades
  ["2 zonas de botox a carla perez, laura", {patient:"Carla Perez", items:["Toxina botulínica (por zona)"], q:[2], seller:"lau"}],
  ["carla perez botox x3 laura", {patient:"Carla Perez", q:[3], seller:"lau"}],
  ["carla perez tres zonas botox laura", {patient:"Carla Perez", q:[3], seller:"lau"}],
  ["26 jeringas y 2 botox, gabi", {items:["Jeringas","?"], q:[26,2]}],
  ["roberto gomez compró 2 shampoo ketogeno y un serum vitamina c, gabi, tarjeta", {patient:"Roberto Gomez", items:["Shampoo Ketogeno","Sérum vitamina C"], q:[2,1], pay:"tarjeta"}],
  ["gabi vendió dos cremas hidratantes", {seller:"gab", items:["Crema hidratante facial"], q:[2]}],
  ["un protector 50 y una crema, gabi", {items:["Protector solar FPS 50","Crema hidratante facial"], q:[1,1]}],
  // --- plata
  ["carla perez limpieza facial gabi 35 lucas", {paid:35000}],
  ["carla perez limpieza facial gabi 35k", {paid:35000}],
  ["carla perez limpieza facial gabi $35.000", {paid:35000}],
  ["carla perez limpieza facial gabi 35.000,00", {paid:35000}],
  ["carla perez limpieza facial gabi treinta y cinco mil", {paid:35000}],
  ["carla perez limpieza facial gabi cuarenta mil", {paid:40000}],
  ["carla perez limpieza facial gabi 1.5 palos", {paid:1500000}],
  ["carla perez limpieza facial, gabi, pagó 20000 en efectivo y 15000 con tarjeta", {split:{efectivo:20000,tarjeta:15000}}],
  ["carla perez limpieza facial, gabi, 20000 efvo y el resto con tarjeta", {paid:20000, restMethod:"tarjeta"}],
  ["carla perez limpieza facial, gabi, mitad efectivo mitad transferencia", {fractions:true}],
  ["carla perez limpieza facial, gabi, pagó con mp", {pay:"transferencia"}],
  ["carla perez limpieza facial, gabi, mercado pago", {pay:"transferencia"}],
  ["carla perez limpieza facial, gabi, posnet", {pay:"tarjeta"}],
  ["carla perez limpieza facial, gabi, qr", {pay:"transferencia"}],
  ["carla perez limpieza facial, gabi, cuenta dni", {pay:"transferencia"}],
  ["carla perez limpieza facial, gabi, pagó 20000 y debe 15000", {paid:20000, debt:15000}],
  ["carla perez limpieza facial, gabi, quedó debiendo 15 mil", {debt:15000}],
  ["carla perez limpieza facial, gabi, no pagó, paga el viernes", {debtAll:true, remind:true}],
  ["carla perez limpieza facial, gabi, le transfirieron a gabi, nos debe 31500", {toProvider:true, owesUs:31500}],
  ["carla perez limpieza facial, le transfirió directo a gabi", {toProvider:true, seller:"gab"}],
  ["carla perez limpieza facial, gabi, a gabi le tocan 5000", {share:5000}],
  ["carla perez limpieza facial, gabi, con abono", {direct:true}],
  // --- typos
  ["carla perez limpiesa fasial gabi", {items:["Limpieza facial"]}],
  ["carla perez glicoliko ornela", {items:["Glicolico"], seller:"orn"}],
  ["carla perez electroporasion marisa", {items:["Electroporación"], seller:"mar"}],
  ["carla perez botx laura", {items:["?"]}],
  ["carla perez kinesio paula", {items:["Kinesiologia"], seller:"pau"}],
  ["carla perez kine paula", {items:["Kinesiologia"], seller:"pau"}],
  ["carla perez venus gabi", {items:["Venus freeze"]}],
  ["carla perez prp laura", {items:["Plasma rico en plaquetas"]}],
  ["carla perez meso laura", {items:["Mesoterapia"]}],
  ["carla perez radio laura", {items:["Radiofrecuencia"]}],
  ["carla perez acido laura", {items:["Ácido hialurónico"]}],
  // --- nombres de profesional con diminutivos / sin cargar
  ["carla perez limpieza facial ornellita", {seller:"orn"}],
  ["carla perez limpieza facial la orne", {seller:"orn"}],
  ["carla perez limpieza facial mari", {seller:"mar"}],
  ["carla perez limpieza facial dra decles", {seller:"lau"}],
  ["carla perez limpieza facial volpe", {seller:"orn"}],
  // --- otros intents
  ["le pagué 50000 a ornella", {intent:"payout", seller:"orn", amount:50000}],
  ["le di 50 lucas a ornella", {intent:"payout", amount:50000}],
  ["le transferí 20 mil a marisa", {intent:"payout", amount:20000, method:"transferencia"}],
  ["transferí 20000 a marisa", {intent:"payout", amount:20000}],
  ["le pagué a gabi su parte", {intent:"payout", seller:"gab", amount:null}],
  ["ornella se llevó 50000", {intent:"payout", amount:50000}],
  ["le quedamos debiendo 131000 a ornella", {intent:"provDebt", seller:"orn", amount:131000}],
  ["a ornella le debemos el resto", {intent:"provDebt", seller:"orn"}],
  ["castucci pagó la deuda", {intent:"debtPay", debt:"d2"}],
  ["florencia cuevas pagó 100000 de lo que debía", {intent:"debtPay", debt:"d1", amount:100000}],
  ["cobré la deuda de florencia", {intent:"debtPay", debt:"d1"}],
  ["compré guantes 5000", {intent:"expense", amount:5000}],
  ["pagué la luz 30000 por transferencia", {intent:"expense", amount:30000, method:"transferencia"}],
  ["gasté 12000 en café y azúcar", {intent:"expense", amount:12000}],
  ["saqué 20000 de la caja para el cambio", {intent:"expense", amount:20000}],
  ["gasto papelera 100000", {intent:"expense", amount:100000}],
  // --- más casos de siempre (que no se rompan)
  ["carla perez botox, laura, 100 dolares", {split:{usd:100}}],
  ["carla perez botox, laura, pagó en dólares", {items:["?"]}],
  ["carla perez limpieza facial, gabi, la mitad en efectivo y el resto con tarjeta", {fractions:true}],
  ["carla perez limpieza facial, gabi, debe todo", {debtAll:true}],
  ["carla perez limpieza facial, gabi, pagó 20000, debe 15000, paga el viernes", {debt:15000, remind:true}],
  ["carla perez limpieza facial x2, gabi", {q:[2]}],
  ["carla perez 2x limpieza facial, gabi", {q:[2]}],
  ["media docena de cremas hidratantes, gabi", {q:[6], items:["Crema hidratante facial"]}],
  ["un par de shampoo ketogeno, gabi", {q:[2], items:["Shampoo Ketogeno"]}],
  ["protector 50 a carla perez, gabi", {items:["Protector solar FPS 50"], q:[1], patient:"Carla Perez"}],
  ["laura vendió 2 protectores y una crema con tarjeta", {seller:"lau", items:["Protector solar FPS 50","Crema hidratante facial"], q:[2,1], pay:"tarjeta"}],
  ["Dra. Decles: carla perez, botox", {seller:"lau", patient:"Carla Perez"}],
  ["laurita le hizo una limpieza facial a carla perez", {seller:"lau", patient:"Carla Perez", items:["Limpieza facial"]}],
  ["vino laura gomez, limpieza facial con gabi", {seller:"gab", patient:"Laura Gomez"}],
  ["carla volpe, consulta, ornella", {patient:"Carla Volpe", seller:"orn"}],
  ["carla perez, limpieza facial, gabi, 35000, a gabi le corresponden 7000", {paid:35000, share:7000}],
  ["carla perez, limpieza facial, gabi, nos debe 30000, le transfirieron a ella", {toProvider:true, owesUs:30000}],
  ["carla perez 45.000 limpieza facial gabi", {paid:45000, items:["Limpieza facial"]}],
  ["limpieza facial gabi", {patient:null, items:["Limpieza facial"], seller:"gab"}],
  ["carla perez, venus freeze, gabi, 20 lucas en efvo y 15 con tarjeta", {paid:35000}],
  ["le pagué 20000 a marisa y le quedamos debiendo el resto", {intent:"provDebt", seller:"mar"}],
  ["le pagué la deuda a carmen", {intent:"payout", seller:"car", debt:true}],
  ["le pagué todo a ornella por transferencia", {intent:"payout", seller:"orn", amount:null, method:"transferencia"}],
  ["carla perez, consulta, ornella, pagó cuarenta y cinco mil por mp", {paid:45000, pay:"transferencia"}],
  ["carla perez, consulta, ornella, pagó con qr 45000", {paid:45000, pay:"transferencia"}],
  ["compré insumos por doscientos mil con tarjeta", {intent:"expense", amount:200000, method:"tarjeta"}],
  // --- dólares: se guardan en US$
  ["rebollo vanina dejó US$ 50 de seña para botox, viene el 10/11", {intent:"deposit", usd:50, method:"dolares"}],
  ["vanina señó 50 dólares para botox", {intent:"deposit", usd:50}],
  ["carla dejó un abono de 5 sesiones de venus freeze, pagó 300 dólares", {intent:"prepaid", usd:300, method:"dolares"}],
  ["pagué 100 dólares de luz", {intent:"expense", usd:100, method:"dolares"}],
  ["compré guantes por usd 40", {intent:"expense", usd:40}],
  ["pagué 5000 de luz", {intent:"expense", amount:5000, direction:"egreso"}],
  ["ingreso extra 15000 de cambio", {intent:"expense", amount:15000, direction:"ingreso"}],
  ["puse 20000 en la caja", {intent:"expense", amount:20000, direction:"ingreso"}],
  ["ingresaron 50 dólares de una venta", {intent:"expense", usd:50, method:"dolares", direction:"ingreso"}],
  ["castucci pagó la deuda en dólares, 150", {intent:"debtPay", debt:"d2", usd:150}],
  ["florencia cuevas trajo US$ 100 de lo que debía", {intent:"debtPay", debt:"d1", usd:100}],
  ["carla perez botox, laura, 100 usd", {intent:"visit", split:{usd:100}}],
  // --- formas de contarlo
  ["ana rey, botox 2 zonas, laura", {patient:"Ana Rey", seller:"lau", q:[2]}],
  ["a ana rey le hicieron limpieza facial, gabi", {patient:"Ana Rey", seller:"gab", items:["Limpieza facial"]}],
  ["limpieza facial para ana rey de gabi", {patient:"Ana Rey", seller:"gab"}],
  ["ana rey (limpieza facial) gabi", {patient:"Ana Rey", seller:"gab", items:["Limpieza facial"]}],
  ["ana rey: limpieza facial. gabi. efectivo.", {patient:"Ana Rey", seller:"gab", pay:"efectivo"}],
  ["ana rey limpieza facial con la dra laura", {seller:"lau"}],
  ["ANA REY LIMPIEZA FACIAL GABI 35000", {patient:"Ana Rey", seller:"gab", paid:35000}],
  ["ana rey limpieza facial gabi 35000$", {paid:35000}],
  ["ana rey limpieza facial gabi 35 mil pesos", {paid:35000, seller:"gab"}],
  ["hoy vino ana rey a limpieza facial con gabi", {patient:"Ana Rey", seller:"gab"}],
  ["ana rey, limpieza facial (gabi) y shampoo ketogeno", {items:["Limpieza facial","Shampoo Ketogeno"], seller:"gab"}],
  ["ana rey compró shampoo, pagó con débito", {patient:"Ana Rey", items:["Shampoo Ketogeno"], pay:"tarjeta"}],
  ["limpieza facial gabi ana rey", {patient:"Ana Rey", seller:"gab"}],
  ["ana rey limpieza facial gabi deja 10000 y paga el resto la semana que viene", {seller:"gab", paid:10000, debtRest:true, remind:true}],
  ["ana rey limpieza facial gabi le quedó debiendo 10000", {intent:"visit", debt:10000}],
  ["ana rey limpieza facial gabi falta pagar 10000", {debt:10000}],
  ["rey, ana - limpieza facial - gabi", {patient:"Rey Ana", seller:"gab", items:["Limpieza facial"]}],
  ["rebollo vanina dejó 25000 de seña para botox, viene el 10/11", {intent:"deposit", amount:25000}],
  ["vanina señó 25 mil para botox el viernes", {intent:"deposit", amount:25000}],
  ["carla dejó un abono de 5 sesiones de venus freeze, pagó 250000", {intent:"prepaid"}],
  ["le debemos 300000 a la distribuidora", {intent:"payable", amount:300000}],
  ["le pagamos 100000 a la distribuidora", {intent:"payablePay"}],
];
const isObj=(x:unknown)=>x&&typeof x==="object";
let ok=0; const fails:string[]=[];
for (const [t, e] of C) {
  const r: any = route(t);
  const errs: string[] = [];
  const intent = e.intent ?? "visit";
  if (r.intent !== intent) errs.push(`intent=${r.intent}`);
  else for (const [k, v] of Object.entries(e)) {
    if (k==="intent") continue;
    if (k==="items") { const got=r.lines.map((l:any)=>l.item); (v as string[]).forEach((x,i)=>{ if(x==="?"? !got[i]?.startsWith("?")&&got[i]!==undefined&&false : got[i]!==x) errs.push(`item${i}=${got[i]}`)}); if(got.length!==(v as string[]).length) errs.push(`nlines=${got.length}:${got.join(";")}`); continue;}
    if (k==="q") { const got=r.lines.map((l:any)=>l.q); if (JSON.stringify(got)!==JSON.stringify(v)) errs.push(`q=${got}`); continue;}
    if (k==="split") { if(!r.split) errs.push("split=null"); else if (isObj(v)) for (const [m,a] of Object.entries(v as object)) if (r.split[m]!==a) errs.push(`split.${m}=${r.split[m]}`); continue;}
    if (k==="remind") { if (!r.remind) errs.push("remind=null"); continue; }
    if (k==="patient") { if (v===null ? r.patient!==null : (r.patient??"").toLowerCase()!==String(v).toLowerCase()) errs.push(`patient=${r.patient}`); continue;}
    if (JSON.stringify(r[k])!==JSON.stringify(v)) errs.push(`${k}=${JSON.stringify(r[k])}`);
  }
  if (errs.length) fails.push(`✗ ${t}\n    ${errs.join(" · ")}\n    → ${JSON.stringify({p:r.patient,s:r.seller,l:r.lines?.map((l:any)=>l.q+"×"+l.item),paid:r.paid,pay:r.pay,amount:r.amount})}`); else ok++;
}
console.log(fails.join("\n")); console.log(`\n${ok}/${C.length} frases bien`);
if (fails.length) process.exit(1);
