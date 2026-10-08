import { config } from "dotenv";

// Emergencia: si el único admin perdió su contraseña. Genera una temporal y la muestra.
//   npm run user:reset-password -- admin
config({ path: ".env", quiet: true });
config({ path: ".env.local", override: true, quiet: true });

const [username] = process.argv.slice(2);
if (!username) {
  console.error("Uso: npm run user:reset-password -- <usuario>");
  process.exit(1);
}
const { resetPasswordByUsername } = await import("../src/lib/domain/accounts");
const r = await resetPasswordByUsername(username);
if (!r.ok) {
  console.error(r.error);
  process.exit(1);
}
console.log(`Listo: ${r.name} entra con «${username}» y la contraseña temporal  ${r.temporaryPassword}  (la cambia al entrar).`);
process.exit(0);
