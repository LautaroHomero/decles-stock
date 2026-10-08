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
const { createProduct } = await import("../src/lib/domain/products");
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
await person("Dra. Paula Ríos", "paula", "medico", { commission: 8 });

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
  await createProduct(adminActor, { name: "Crema hidratante facial", price: 18500, minQuantity: 4, quantity: 6, expiresOn: day(18), lotCode: "CH-0925" }),
  "crema",
);
must(await addStock(adminActor, { itemId: crema.stockItemId, quantity: 10, expiresOn: day(240), lotCode: "CH-0426" }), "crema lote 2");

must(await createProduct(adminActor, { name: "Protector solar FPS 50", price: 22000, minQuantity: 5, quantity: 3, expiresOn: day(300) }), "protector");
must(await createProduct(adminActor, { name: "Sérum vitamina C", price: 31000, minQuantity: 2, quantity: 8, expiresOn: day(75), lotCode: "VC-12" }), "serum");
const gel = must(await createProduct(adminActor, { name: "Gel de limpieza", price: 12000, minQuantity: 3, quantity: 9, expiresOn: day(400) }), "gel");
must(await createProduct(adminActor, { name: "Crema Pindonga", price: 15900, minQuantity: 3, quantity: 12, expiresOn: day(200) }), "pindonga");
must(await createProduct(adminActor, { name: "Contorno de ojos", price: 26500, minQuantity: 2, quantity: 5, expiresOn: day(150) }), "contorno");

// Un lote ya vencido (la app no deja ingresarlo así; se mete directo para la demo).
await getSql()`
  INSERT INTO stock_lots (id, organization_id, item_id, lot_code, quantity, initial_quantity, expires_on, received_at, created_by)
  VALUES ('stl_seedexp', ${org.id}, ${gel.stockItemId}, 'GL-0225', 2, 4, ${day(-5)}, ${day(-200) + "T10:00:00"}, ${admin.id})`;

// Un par de ventas de hoy.
must(await recordSale(secActor, { itemId: crema.priceItemId, quantity: 1, providerId: laura.providerId }), "venta 1");
must(await recordSale(secActor, { itemId: crema.priceItemId, quantity: 1, providerId: laura.providerId, expiresOn: day(240) }), "venta 2");

const created = await refreshStockAlerts(org.id);

console.log(`
Listo: ${ORG} con 6 productos, 2 ventas y ${created} avisos para las médicas.
Todas las contraseñas de la demo: decles123

  Usuario   Rol
  admin     Admin (secretaría)
  sofia     Secretaría
  laura     Médica (10% comisión)
  paula     Médica (8% comisión)
`);
process.exit(0);
