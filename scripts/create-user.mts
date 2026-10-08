import { config } from "dotenv";

// Alta de una persona del equipo (producción incluida). Crea el consultorio si no existe.
// La persona elige su PIN con «Me lo olvidé» (código al email): nadie reparte PINs.
//
//   npm run user:create -- --org "Consultorio Decles" --name "Ana Pérez" --dni 30111222 \
//     --email ana@decles.com --role recepcion [--admin] [--specialty Dermatología]
//
//   --role   recepcion | medico   (médico: se crea también como profesional del consultorio)
//   --admin  puede cargar stock y precios, anular ventas
config({ path: ".env", quiet: true });
config({ path: ".env.local", override: true, quiet: true });

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const org = opt("org");
const name = opt("name");
const dni = opt("dni");
const email = opt("email") ?? "";
const role = opt("role");
const specialty = opt("specialty") ?? "Médico/a";
const isAdmin = args.includes("--admin");

if (!org || !name || !dni || (role !== "recepcion" && role !== "medico")) {
  console.error('Uso: npm run user:create -- --org "<consultorio>" --name "<nombre>" --dni <dni> --email <email> --role recepcion|medico [--admin]');
  process.exit(1);
}

const repo = await import("../src/lib/db/repo");
const o = (await repo.getOrganizationByName(org)) ?? (await repo.createOrganization({ name: org }));
if (await repo.getUserByDni(dni)) {
  console.error(`Ya existe un usuario con DNI ${dni}.`);
  process.exit(1);
}
const user = await repo.createUser({ name, email, dni, role, pinHash: "", pinSalt: "" });
const providerId = role === "medico" ? (await repo.createProvider(o.id, name, specialty)).id : undefined;
await repo.addMembership({ userId: user.id, organizationId: o.id, role, providerId });
if (isAdmin) await repo.setOrgAdmin(o.id, user.id, true);
console.log(`Listo: ${name} (${role}${isAdmin ? ", admin" : ""}) en ${o.name}. Entra con «Me lo olvidé» para elegir su PIN.`);
process.exit(0);
