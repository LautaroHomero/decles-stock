import { config } from "dotenv";

// Deja la base LOCAL lista para una demo: borra lo anotado (ventas, prácticas, egresos, ingresos extras,
// pagos a profesionales, caja del día y sus avisos). Conserva consultorio, equipo, prácticas, productos y stock.
//   npm run db:demo-reset
config({ path: ".env", quiet: true });
config({ path: ".env.local", override: true, quiet: true });

const url = process.env.DATABASE_URL ?? "";
const { isLocalDb, getSql } = await import("../src/lib/db/connection");
if (!isLocalDb(url)) {
  console.error("db:demo-reset es solo para la base local (DATABASE_URL en localhost). No toca producción.");
  process.exit(1);
}

const sql = getSql();
const counts = await sql.begin(async (tx) => {
  const [s] = await tx`SELECT count(*)::int AS n FROM sales`;
  await tx`UPDATE stock_movements SET sale_id = NULL WHERE sale_id IS NOT NULL`;
  await tx`DELETE FROM sales`;
  const [e] = await tx`SELECT count(*)::int AS n FROM expenses`;
  await tx`DELETE FROM expenses`;
  await tx`DELETE FROM provider_payouts`;
  await tx`DELETE FROM day_cash`;
  await tx`UPDATE stock_items SET owed = 0 WHERE owed <> 0`;
  await tx`DELETE FROM notifications WHERE kind IN ('pendiente', 'sin_stock')`;
  return { sales: s.n as number, expenses: e.n as number };
});
console.log(`Listo para la demo: se borraron ${counts.sales} renglones anotados y ${counts.expenses} egresos/ingresos extras.`);
console.log("Quedan el consultorio, el equipo, las prácticas, los productos y el stock.");
process.exit(0);
