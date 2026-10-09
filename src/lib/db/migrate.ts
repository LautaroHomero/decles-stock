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
  await lockPublicApi(sql);
  return ran;
}

/**
 * Supabase expone el schema `public` por su API REST (PostgREST) a cualquiera que tenga la
 * clave pública ("anon"). Esta app no usa esa API — se conecta directo con el usuario dueño
 * de las tablas — así que se activa RLS sin políticas en TODAS las tablas: la API no ve nada
 * y la app sigue igual (el dueño de la tabla no pasa por RLS). Corre en cada migrate, así
 * cubre también las tablas que se agreguen después. En un Postgres común es inofensivo.
 */
async function lockPublicApi(sql: Sql): Promise<void> {
  await sql.unsafe(`
    DO $$
    DECLARE t record;
    BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
      END LOOP;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
        EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated';
      END IF;
    END $$;`);
}
