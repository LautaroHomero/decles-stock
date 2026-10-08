import { config } from "dotenv";
import { connect } from "../src/lib/db/connection";
import { migrate } from "../src/lib/db/migrate";

// Como Next.js: valores reales en `.env.local`, que pisa a `.env`.
config({ path: ".env", quiet: true });
config({ path: ".env.local", override: true, quiet: true });

const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL_DIRECT (o DATABASE_URL). Ver .env.example.");
  process.exit(1);
}

const sql = connect(url, 1);
try {
  const ran = await migrate(sql);
  console.log(ran.length ? `Migraciones aplicadas: ${ran.join(", ")}` : "Nada pendiente.");
} finally {
  await sql.end();
}
