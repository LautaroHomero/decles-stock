import postgres from "postgres";

/**
 * Postgres connection. One pooled client per process, cached on `globalThis` so it
 * survives dev hot-reload. Same as Clavdia, except TLS is skipped for a local
 * database (docker compose) — Supabase still gets `ssl: "require"`.
 *
 * - `DATABASE_URL` is the pooled connection string (Supabase transaction pooler,
 *   port 6543) — `prepare: false` is required for that pooler.
 * - Schema lives out-of-band: `npm run db:migrate`, never on the request path.
 */
export type Sql = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as { __sql?: Sql };

export function isLocalDb(url: string): boolean {
  return /@(localhost|127\.0\.0\.1|db)(:\d+)?\//.test(url);
}

export function connect(url: string, max = Number(process.env.DB_POOL_MAX ?? 10)): Sql {
  return postgres(url, {
    prepare: false,
    max,
    idle_timeout: 20,
    connection: { application_name: "decles-stock" },
    ssl: isLocalDb(url) ? false : "require",
    onnotice: () => {},
  });
}

export function getSql(): Sql {
  if (globalForDb.__sql) return globalForDb.__sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL no está configurada. Copiá .env.example a .env.local.");
  }
  globalForDb.__sql = connect(url);
  return globalForDb.__sql;
}
