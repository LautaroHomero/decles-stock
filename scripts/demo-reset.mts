import { config } from "dotenv";

// Deja la base LOCAL lista para una demo: borra todo lo anotado (ventas, prácticas, egresos, ingresos extras,
// pagos y deudas con profesionales, deudas de pacientes, abonos, señas, lo que debe el consultorio, atenciones por obra social,
// caja y sus avisos). Conserva consultorio, equipo, prácticas, productos, stock y obras sociales.
//   npm run db:demo-reset            → todo lo anotado
//   npm run db:demo-reset -- --hoy   → solo lo de hoy
config({ path: ".env", quiet: true });
config({ path: ".env.local", override: true, quiet: true });

const url = process.env.DATABASE_URL ?? "";
const { isLocalDb, getSql } = await import("../src/lib/db/connection");
if (!isLocalDb(url)) {
  console.error("db:demo-reset es solo para la base local (DATABASE_URL en localhost). No toca producción.");
  process.exit(1);
}

const sql = getSql();

// Si falta alguna migración, el borrado fallaría entero (y no borraría nada): avisar antes.
const need = ["debts", "provider_debts", "prepaids", "payables", "insurer_visits", "deposits"];
const missing = [];
for (const t of need) {
  const [r] = await sql`SELECT to_regclass(${"public." + t}) AS t`;
  if (!r.t) missing.push(t);
}
if (missing.length) {
  console.error(`Faltan tablas (${missing.join(", ")}): corré primero  npm run db:migrate  y después este comando de nuevo.`);
  process.exit(1);
}
console.log(`Base: ${url.replace(/\/\/[^@]*@/, "//***@")}`);

// «--hoy»: borra solo lo anotado HOY (y devuelve el stock de lo vendido hoy). Lo de días anteriores queda.
if (process.argv.includes("--hoy")) {
  const { realNowIso } = await import("../src/lib/domain/clock");
  const today = realNowIso().slice(0, 10);
  const [before] = await sql`
    SELECT (SELECT count(*) FROM sales WHERE substr(created_at, 1, 10) = ${today})::int AS sales,
           (SELECT count(*) FROM expenses WHERE substr(created_at, 1, 10) = ${today})::int AS expenses`;
  console.log(`Hoy es ${today}: hay ${before.sales} renglones anotados y ${before.expenses} ingresos/egresos de hoy.`);
  const r = await sql.begin(async (tx) => {
    const day = (col: string) => tx`substr(${tx(col)}, 1, 10) = ${today}`;
    const saleIds = ((await tx`SELECT id FROM sales WHERE ${day("created_at")}`) as unknown as { id: string }[]).map((x) => x.id);
    const visitIds = ((await tx`SELECT DISTINCT visit_id FROM sales WHERE ${day("created_at")} AND visit_id IS NOT NULL`) as unknown as { visit_id: string }[]).map((x) => x.visit_id);
    if (saleIds.length) {
      // Stock: lo que movieron las ventas de hoy (neto) vuelve a su lote (o baja lo vendido sin stock).
      const net = (await tx`
        SELECT item_id, lot_id, SUM(delta)::int AS d FROM stock_movements WHERE sale_id IN ${tx(saleIds)} GROUP BY item_id, lot_id`) as unknown as {
        item_id: string;
        lot_id: string | null;
        d: number;
      }[];
      for (const m of net) {
        if (!m.d) continue;
        if (m.lot_id) await tx`UPDATE stock_lots SET quantity = quantity - ${m.d} WHERE id = ${m.lot_id}`;
        else await tx`UPDATE stock_items SET owed = GREATEST(owed + ${m.d}, 0) WHERE id = ${m.item_id}`;
      }
      await tx`DELETE FROM stock_movements WHERE sale_id IN ${tx(saleIds)}`;
    }
    if (visitIds.length) {
      await tx`UPDATE deposits SET visit_id = NULL WHERE visit_id IN ${tx(visitIds)}`;
      await tx`DELETE FROM visit_payments WHERE visit_id IN ${tx(visitIds)}`;
      await tx`DELETE FROM insurer_visits WHERE visit_id IN ${tx(visitIds)}`;
      await tx`DELETE FROM prepaid_uses WHERE visit_id IN ${tx(visitIds)}`;
    }
    // Deudas de pacientes anotadas hoy (y sus cobros); cobros de hoy de deudas viejas (vuelven a quedar abiertas).
    await tx`DELETE FROM debt_payments WHERE debt_id IN (SELECT id FROM debts WHERE ${day("created_at")}) OR date = ${today}`;
    await tx`DELETE FROM debts WHERE ${day("created_at")}`;
    await tx`UPDATE debts SET status = 'open', paid_at = NULL WHERE status = 'paid' AND substr(paid_at, 1, 10) = ${today}`;
    // Pagos y deudas con profesionales de hoy.
    await tx`DELETE FROM provider_payouts WHERE date = ${today} OR ${day("created_at")}`;
    await tx`DELETE FROM provider_debts WHERE date = ${today}`;
    await tx`UPDATE provider_debts SET status = 'open', paid_at = NULL WHERE status = 'paid' AND substr(paid_at, 1, 10) = ${today}`;
    // Egresos / ingresos de hoy, con lo que cuelga de ellos (abonos de hoy, pagos de lo que debemos).
    const exp = ((await tx`SELECT id FROM expenses WHERE ${day("created_at")}`) as unknown as { id: string }[]).map((x) => x.id);
    if (exp.length) await tx`DELETE FROM payable_payments WHERE expense_id IN ${tx(exp)}`;
    await tx`DELETE FROM prepaid_uses WHERE prepaid_id IN (SELECT id FROM prepaids WHERE ${day("created_at")})`;
    await tx`DELETE FROM prepaids WHERE ${day("created_at")}`;
    await tx`DELETE FROM deposits WHERE ${day("created_at")}`;
    await tx`DELETE FROM payable_payments WHERE payable_id IN (SELECT id FROM payables WHERE ${day("created_at")})`;
    await tx`DELETE FROM payables WHERE ${day("created_at")}`;
    await tx`UPDATE payables SET paid_at = NULL WHERE substr(paid_at, 1, 10) = ${today}`;
    await tx`DELETE FROM expenses WHERE ${day("created_at")}`;
    await tx`DELETE FROM day_cash WHERE date = ${today}`;
    if (saleIds.length) await tx`DELETE FROM sales WHERE id IN ${tx(saleIds)}`;
    await tx`DELETE FROM notifications WHERE kind IN ('pendiente', 'sin_stock', 'deuda', 'deuda_cobrar', 'pagar')`;
    return { sales: saleIds.length, expenses: exp.length };
  });
  console.log(`Hoy (${today}) quedó en blanco: se borraron ${r.sales} renglones anotados y ${r.expenses} egresos/ingresos, con sus deudas, pagos, abonos y la caja.`);
  console.log("Lo de días anteriores, el equipo, las prácticas, los productos, el stock y las obras sociales quedan igual.");
  process.exit(0);
}

const counts = await sql.begin(async (tx) => {
  const [s] = await tx`SELECT count(*)::int AS n FROM sales`;
  await tx`UPDATE stock_movements SET sale_id = NULL WHERE sale_id IS NOT NULL`;
  await tx`DELETE FROM sales`;
  const [e] = await tx`SELECT count(*)::int AS n FROM expenses`;
  await tx`DELETE FROM expenses`;
  await tx`DELETE FROM provider_payouts`;
  await tx`DELETE FROM provider_debts`;
  await tx`DELETE FROM visit_payments`;
  await tx`DELETE FROM debt_payments`;
  await tx`DELETE FROM debts`;
  await tx`DELETE FROM prepaid_uses`;
  await tx`DELETE FROM prepaids`;
  await tx`DELETE FROM payable_payments`;
  await tx`DELETE FROM payables`;
  await tx`DELETE FROM insurer_visits`;
  await tx`DELETE FROM deposits`;
  await tx`DELETE FROM day_cash`;
  await tx`UPDATE stock_items SET owed = 0 WHERE owed <> 0`;
  await tx`DELETE FROM notifications WHERE kind IN ('pendiente', 'sin_stock', 'deuda', 'deuda_cobrar', 'pagar')`;
  return { sales: s.n as number, expenses: e.n as number };
});
console.log(`Listo para la demo: se borraron ${counts.sales} renglones anotados y ${counts.expenses} egresos/ingresos extras.`);
console.log("Quedan el consultorio, el equipo, las prácticas, los productos, el stock y las obras sociales.");
process.exit(0);
