import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "./connection";

/**
 * Forward-only migration runner. Applies every `src/lib/db/migrations/*.sql`
 * file that hasn't run yet, in filename order, each in its own transaction,
 * recording it in `_migrations`. Idempotent: a second run does nothing.
 *
 * Run it with `npm run db:migrate` (see `scripts/migrate.mts`), pointing
 * `DATABASE_URL_DIRECT` at the target environment.
 */
const MIGRATIONS_DIR = join(process.cwd(), "src/lib/db/migrations");

export async function migrate(sql: Sql): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (id text PRIMARY KEY, applied_at text NOT NULL)`;

  const appliedRows = (await sql`SELECT id FROM _migrations`) as unknown as { id: string }[];
  const applied = new Set(appliedRows.map((r) => r.id));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    if (applied.has(id)) continue;
    const ddl = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO _migrations (id, applied_at) VALUES (${id}, ${new Date().toISOString()})`;
    });
    ran.push(id);
  }
  return ran;
}
