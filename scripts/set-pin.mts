import { config } from "dotenv";

// Solo para PRUEBAS en tu base de desarrollo: le pone un PIN a un usuario (por DNI o email)
// para entrar sin pasar por «Me lo olvidé».
//   npm run user:set-pin -- 30111222 4321
config({ path: ".env", quiet: true });
config({ path: ".env.local", override: true, quiet: true });

const [who, pin] = process.argv.slice(2);
if (!who || !/^\d{4}$/.test(pin ?? "")) {
  console.error("Uso: npm run user:set-pin -- <DNI o email> <PIN de 4 dígitos>");
  process.exit(1);
}
const { getUserByDni, getUserByEmail, updateUserPin } = await import("../src/lib/db/repo");
const { hashPin } = await import("../src/lib/auth/pin");

const user = who.includes("@") ? await getUserByEmail(who) : await getUserByDni(who);
if (!user) {
  console.error(`No encontré a nadie con "${who}".`);
  process.exit(1);
}
await updateUserPin(user.id, hashPin(pin));
console.log(`Listo: ${user.name} (${user.role}) ya puede entrar con ${who} y ese PIN.`);
process.exit(0);
