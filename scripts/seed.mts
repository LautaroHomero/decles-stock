import { config } from "dotenv";

// Datos de DEMO para desarrollo local. Se niega a correr contra una base que no sea local.
//   npm run db:seed
config({ path: ".env", quiet: true });
config({ path: ".env.local", override: true, quiet: true });

const url = process.env.DATABASE_URL ?? "";
const { isLocalDb, getSql } = await import("../src/lib/db/connection");
if (!isLocalDb(url)) {
  console.error("db:seed es solo para la base local (DATABASE_URL en localhost). En producción el admin se crea en la pantalla de primer arranque.");
  process.exit(1);
}

const repo = await import("../src/lib/db/repo");
const { hashPassword } = await import("../src/lib/auth/password");
const { hydrateActor } = await import("../src/lib/auth/actor");
const { createProduct, createPractice } = await import("../src/lib/domain/products");
const { recordVisit } = await import("../src/lib/domain/visits");
const { addStock } = await import("../src/lib/domain/stock");
const { recordSale } = await import("../src/lib/domain/billing");
const { refreshStockAlerts } = await import("../src/lib/domain/notifications");
const { todayYmd } = await import("../src/lib/db/stock-repo");

const ORG = "Consultorio Decles";
if (await repo.getOrganizationByName(ORG)) {
  console.log(`"${ORG}" ya existe; no se vuelve a sembrar. Para empezar de cero: docker compose down -v`);
  process.exit(0);
}
const org = await repo.createOrganization({ name: ORG, city: "Buenos Aires" });

async function person(name: string, username: string, role: "recepcion" | "medico", opts: { admin?: boolean; commission?: number } = {}) {
  const u = await repo.createUser({ name, username, role, password: hashPassword("decles123"), mustChangePassword: false });
  const providerId = role === "medico" ? (await repo.createProvider(org.id, name, "Dermatología")).id : undefined;
  if (providerId && opts.commission) await repo.setProviderCommission(providerId, opts.commission);
  await repo.addMembership({ userId: u.id, organizationId: org.id, role, providerId });
  if (opts.admin) await repo.setOrgAdmin(org.id, u.id, true);
  return { ...u, providerId };
}

const admin = await person("Admin Decles", "admin", "recepcion", { admin: true });
const secretaria = await person("Sofía Gómez", "sofia", "recepcion");
const laura = await person("Dra. Laura Decles", "laura", "medico", { commission: 10 });
const paula = await person("Dra. Paula Ríos", "paula", "medico", { commission: 8 });

const adminActor = (await hydrateActor({ userId: admin.id, role: "recepcion", activeOrgId: org.id, sv: 0 }))!;
const secActor = (await hydrateActor({ userId: secretaria.id, role: "recepcion", activeOrgId: org.id, sv: 0 }))!;

const day = (n: number) => {
  const d = new Date(`${todayYmd()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function must<T>(r: ({ ok: true } & T) | { ok: false; error: string }, what: string): { ok: true } & T {
  if (!r.ok) throw new Error(`${what}: ${r.error}`);
  return r;
}

const crema = must(
  await createProduct(adminActor, { name: "Crema hidratante facial", price: 18500, cardPrice: 21300, minQuantity: 4, quantity: 6, expiresOn: day(18), lotCode: "CH-0925" }),
  "crema",
);
must(await addStock(adminActor, { itemId: crema.stockItemId, quantity: 10, expiresOn: day(240), lotCode: "CH-0426" }), "crema lote 2");

must(await createProduct(adminActor, { name: "Protector solar FPS 50", price: 22000, cardPrice: 25300, minQuantity: 5, quantity: 3, expiresOn: day(300) }), "protector");
must(await createProduct(adminActor, { name: "Sérum vitamina C", price: 31000, cardPrice: 35600, minQuantity: 2, quantity: 8, expiresOn: day(75), lotCode: "VC-12" }), "serum");
const gel = must(await createProduct(adminActor, { name: "Gel de limpieza", price: 12000, cardPrice: 13800, minQuantity: 3, quantity: 9, expiresOn: day(400) }), "gel");
must(await createProduct(adminActor, { name: "Crema Pindonga", price: 15900, cardPrice: 18300, minQuantity: 3, quantity: 12, expiresOn: day(200) }), "pindonga");
must(await createProduct(adminActor, { name: "Contorno de ojos", price: 26500, cardPrice: 30500, minQuantity: 2, quantity: 5, expiresOn: day(150) }), "contorno");

// Prácticas (lo que la médica hace en la consulta), con precio efectivo y con tarjeta.
const practice = async (name: string, price: number, cardPrice: number) => must(await createPractice(adminActor, { name, price, cardPrice }), name).itemId;
const atencion = await practice("Atención", 25000, 28800);
const peeling = await practice("Peeling", 40000, 46000);
const botox = await practice("Aplicación de botox", 120000, 138000);
const limpieza = await practice("Limpieza facial", 35000, 40300);
// Peeling y botox solo los hace Laura; el resto, cualquiera.
const { setItemLinks } = await import("../src/lib/domain/products");
must(await setItemLinks(adminActor, peeling, [laura.providerId!]), "peeling → laura");
must(await setItemLinks(adminActor, botox, [laura.providerId!]), "botox → laura");

// Un lote ya vencido (la app no deja ingresarlo así; se mete directo para la demo).
await getSql()`
  INSERT INTO stock_lots (id, organization_id, item_id, lot_code, quantity, initial_quantity, expires_on, received_at, created_by)
  VALUES ('stl_seedexp', ${org.id}, ${gel.stockItemId}, 'GL-0225', 2, 4, ${day(-5)}, ${day(-200) + "T10:00:00"}, ${admin.id})`;

// Un par de ventas de hoy.
must(await recordSale(secActor, { itemId: crema.priceItemId, quantity: 1, providerId: laura.providerId, paymentMethod: "tarjeta" }), "venta 1");
must(await recordSale(secActor, { itemId: crema.priceItemId, quantity: 1, providerId: laura.providerId, expiresOn: day(240) }), "venta 2");

// Pacientes de hoy.
must(await recordVisit(secActor, { patientName: "María López", providerId: laura.providerId, paymentMethod: "efectivo", lines: [{ itemId: atencion }, { itemId: peeling }] }), "visita 1");
must(await recordVisit(secActor, { patientName: "Ana Gómez", providerId: paula.providerId, lines: [{ itemId: atencion }] }), "visita 2");
must(await recordVisit(secActor, { patientName: "Rosa Díaz", providerId: laura.providerId, paymentMethod: "tarjeta", lines: [{ itemId: limpieza }, { itemId: crema.priceItemId }] }), "visita 3");

// Historial de las últimas 3 semanas para ver Ventas por semana y por mes (fechas corridas a mano).
{
  const items = (await getSql()`SELECT id FROM price_list_items WHERE organization_id = ${org.id} AND kind = 'producto'`) as unknown as { id: string }[];
  const practiceIds = [atencion, peeling, botox, limpieza];
  const names = ["Laura Paz", "Julia Romero", "Carla Méndez", "Sofía Ruiz", "Inés Torres", "Lucía Vega", "Marta Gil", "Paula Sosa"];
  // Stock extra para que el historial no deje la demo sin unidades.
  for (const it of await getSql()`SELECT stock_item_id FROM price_list_items WHERE organization_id = ${org.id} AND kind = 'producto'`)
    await addStock(adminActor, { itemId: it.stock_item_id as string, quantity: 20, expiresOn: day(500) });
  // PRNG con semilla fija (mulberry32): la demo sale igual cada vez.
  let s = 20261008;
  const rnd = (n: number) => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n);
  };
  for (let back = 21; back >= 1; back--) {
    const n = rnd(4); // 0 a 3 ventas por día
    for (let k = 0; k < n; k++) {
      const r = await recordSale(secActor, {
        itemId: items[rnd(items.length)].id,
        quantity: 1 + rnd(2),
        providerId: rnd(2) ? laura.providerId : paula.providerId,
        paymentMethod: ["efectivo", "tarjeta", null][rnd(3)],
      });
      if (r.ok) {
        const hh = String(9 + rnd(9)).padStart(2, "0");
        const mm = String(rnd(60)).padStart(2, "0");
        await getSql()`UPDATE sales SET created_at = ${`${day(-back)}T${hh}:${mm}:00`} WHERE id = ${r.saleId}`;
      }
    }
    // 1 a 4 pacientes por día, con 1 o 2 prácticas.
    for (let k = 0, n2 = 1 + rnd(4); k < n2; k++) {
      const lines = [{ itemId: atencion }, ...(rnd(2) ? [{ itemId: practiceIds[1 + rnd(3)] }] : [])];
      const v = await recordVisit(secActor, {
        patientName: names[rnd(names.length)],
        providerId: rnd(2) ? laura.providerId : paula.providerId,
        paymentMethod: ["efectivo", "tarjeta", null][rnd(3)],
        lines,
      });
      if (v.ok) {
        const at = `${day(-back)}T${String(9 + rnd(9)).padStart(2, "0")}:${String(rnd(60)).padStart(2, "0")}:00`;
        await getSql()`UPDATE sales SET created_at = ${at} WHERE visit_id = ${v.visitId}`;
      }
    }
  }
}

const created = await refreshStockAlerts(org.id);
// La demo ya tiene todo cargado: "Primeros pasos" arranca cerrado (se reabre desde el menú de la cuenta).
await getSql()`UPDATE organizations SET onboarding_done = TRUE WHERE id = ${org.id}`;

console.log(`
Listo: ${ORG} con 6 productos, 4 prácticas, 3 semanas de pacientes y ventas, y ${created} avisos.
Todas las contraseñas de la demo: decles123

  Usuario   Rol
  admin     Admin (secretaría)
  sofia     Secretaría
  laura     Médica (10% comisión)
  paula     Médica (8% comisión)
`);
process.exit(0);
