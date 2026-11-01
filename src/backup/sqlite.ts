import { createRequire } from "node:module";

/** The few SQLite calls the backup reader needs, on Bun (bun:sqlite) or Node (node:sqlite). */
export type Db = {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  run(sql: string, ...params: unknown[]): void;
  close(): void;
};

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/** Open a SQLite file; read-only unless `write` is set (tests build fixtures with it). */
export function openDb(path: string, opts: { write?: boolean } = {}): Db {
  const req = createRequire(import.meta.url);
  if (isBun) {
    const { Database } = req("bun:sqlite") as { Database: new (p: string, o: object) => BunDb };
    const db = new Database(path, opts.write ? { create: true, readwrite: true } : { readonly: true });
    return {
      all: (sql, ...params) => db.query(sql).all(...params) as never,
      run: (sql, ...params) => void db.query(sql).run(...params),
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string, o: object) => NodeDb };
  const db = new DatabaseSync(path, { readOnly: !opts.write });
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params) as never,
    run: (sql, ...params) => void db.prepare(sql).run(...params),
    close: () => db.close(),
  };
}

type Stmt = { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
type BunDb = { query(sql: string): Stmt; close(): void };
type NodeDb = { prepare(sql: string): Stmt; close(): void };
