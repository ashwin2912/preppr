import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/** Works for both node-postgres (prod) and PGlite (tests, local simulate). */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

const MIGRATIONS = process.env.MIGRATIONS_DIR ?? `${process.cwd()}/drizzle`;

export async function connectPostgres(url: string, migrate = true): Promise<DB> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString: url, max: 10 });
  const db = drizzle(pool, { schema });
  if (migrate) {
    const { migrate: run } = await import("drizzle-orm/node-postgres/migrator");
    await run(db, { migrationsFolder: MIGRATIONS });
  }
  return db as unknown as DB;
}

/** In-memory Postgres (PGlite) with migrations applied. */
export async function connectPglite(): Promise<DB> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return db as unknown as DB;
}

export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
/** Anything queries can run against: the root DB or an open transaction. */
export type Q = DB | Tx;
