import { config } from "dotenv";

// Carga un catálogo de PRUEBA (prácticas y productos con stock y vencimientos) en la base LOCAL,
// en el consultorio que ya tengas creado. No borra nada y lo que ya existe (mismo nombre) lo saltea.
//   npm run db:catalogo
config({ path: ".env", quiet: true });
config({ path: ".env.local", override: true, quiet: true });

const url = process.env.DATABASE_URL ?? "";
const { isLocalDb, getSql } = await import("../src/lib/db/connection");
if (!isLocalDb(url)) {
  console.error("db:catalogo es solo para la base local (DATABASE_URL en localhost).");
  process.exit(1);
}

const repo = await import("../src/lib/db/repo");
const { hydrateActor } = await import("../src/lib/auth/actor");
const { createProduct, createPractice, setItemLinks } = await import("../src/lib/domain/products");
const { addStock } = await import("../src/lib/domain/stock");
const { listPriceItems } = await import("../src/lib/db/billing-repo");
const { refreshStockAlerts } = await import("../src/lib/domain/notifications");
const { todayYmd } = await import("../src/lib/db/stock-repo");

const day = (n: number) => {
  const d = new Date(`${todayYmd()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const card = (n: number) => Math.round((n * 1.15) / 100) * 100; // tarjeta: +15 %

// Prácticas de un consultorio de dermatología / estética. [nombre, precio efectivo]
const PRACTICES: [string, number][] = [
  ["Consulta", 25000],
  ["Control", 15000],
  ["Peeling químico", 45000],
  ["Limpieza facial profunda", 38000],
  ["Toxina botulínica (por zona)", 120000],
  ["Ácido hialurónico (1 ml)", 180000],
  ["Mesoterapia facial", 60000],
  ["Microneedling (Dermapen)", 55000],
  ["Radiofrecuencia facial", 50000],
  ["Plasma rico en plaquetas", 70000],
  ["Crioterapia", 20000],
  ["Electrocoagulación", 30000],
  ["Hilos tensores", 250000],
  ["Láser (sesión)", 80000],
];

// Productos: [nombre, precio, mínimo, lotes [cantidad, vence en N días (null = no vence)]]
const PRODUCTS: [string, number, number, [number, number | null][]][] = [
  ["Protector solar FPS 50", 22000, 5, [[12, 320]]],
  ["Protector solar con color FPS 50", 25000, 3, [[6, 280]]],
  ["Crema hidratante facial", 18500, 4, [[3, 20], [8, 240]]], // un lote vence pronto → aviso
  ["Sérum vitamina C", 31000, 2, [[7, 90]]],
  ["Sérum ácido hialurónico", 29000, 2, [[5, 150]]],
  ["Retinol nocturno", 34000, 2, [[4, 200]]],
  ["Gel de limpieza", 12000, 3, [[10, 400]]],
  ["Agua micelar", 14500, 3, [[2, 365]]], // stock bajo → aviso
  ["Contorno de ojos", 26500, 2, [[5, 150]]],
  ["Crema reparadora", 16800, 3, [[9, 210]]],
  ["Exfoliante facial", 15500, 2, [[6, 300]]],
  ["Bálsamo labial", 6500, 5, [[20, null]]],
];

const orgs = (await getSql()`SELECT id, name, admin_ids FROM organizations ORDER BY created_at`) as unknown as {
  id: string;
  name: string;
  admin_ids: string;
}[];
if (!orgs.length) {
  console.error("No hay ningún consultorio. Abrí la app y completá el primer arranque.");
  process.exit(1);
}

for (const org of orgs) {
  const adminId = (JSON.parse(org.admin_ids || "[]") as string[])[0];
  if (!adminId) continue;
  const role = (await repo.membershipsForUser(adminId)).find((m) => m.organizationId === org.id)?.role ?? "recepcion";
  const actor = await hydrateActor({ userId: adminId, role, activeOrgId: org.id, sv: (await repo.getAccount(adminId))?.sessionVersion ?? 0 });
  if (!actor) continue;

  const existing = new Set((await listPriceItems(org.id, true)).map((i) => i.name.toLowerCase()));
  let practices = 0, products = 0;

  const practiceIds: Record<string, string> = {};
  for (const [name, price] of PRACTICES) {
    if (existing.has(name.toLowerCase())) continue;
    const r = await createPractice(actor, { name, price, cardPrice: card(price) });
    if (r.ok) {
      practices++;
      practiceIds[name] = r.itemId;
    } else console.warn(`  ${name}: ${r.error}`);
  }

  for (const [name, price, minQuantity, lots] of PRODUCTS) {
    if (existing.has(name.toLowerCase())) continue;
    const [first, ...rest] = lots;
    const r = await createProduct(actor, {
      name,
      price,
      cardPrice: card(price),
      minQuantity,
      quantity: first[0],
      expiresOn: first[1] === null ? null : day(first[1]),
    });
    if (!r.ok) {
      console.warn(`  ${name}: ${r.error}`);
      continue;
    }
    products++;
    for (const [q, d] of rest) await addStock(actor, { itemId: r.stockItemId, quantity: q, expiresOn: d === null ? null : day(d) });
  }

  // Para probar «solo la hace una médica»: hilos tensores y láser, solo la primera médica (si hay más de una).
  const medicas = (await repo.listOrgMembers(org.id)).filter((m) => m.active && m.role === "medico" && m.providerId);
  let linked = false;
  if (medicas.length > 1) {
    for (const name of ["Hilos tensores", "Láser (sesión)"]) {
      if (practiceIds[name]) {
        await setItemLinks(actor, practiceIds[name], [medicas[0].providerId!]);
        linked = true;
      }
    }
  }

  await refreshStockAlerts(org.id);
  console.log(
    `${org.name}: ${practices} prácticas y ${products} productos nuevos` +
      (linked ? ` · «Hilos tensores» y «Láser» quedaron solo para ${medicas[0].name}` : "") +
      (medicas.length === 0 ? " · Ojo: no hay médicas; sumalas en Equipo para poder anotar." : ""),
  );
}
process.exit(0);
