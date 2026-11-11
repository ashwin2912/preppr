import { eq } from "drizzle-orm";
import type { Q } from "./client";
import { kv } from "./schema";

/** Read a kv value, or null when the key is missing. */
export async function kvGet<T>(db: Q, key: string): Promise<T | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, key));
  return row ? (row.value as T) : null;
}

/** Write (or overwrite) a kv value. */
export async function kvSet(db: Q, key: string, value: unknown, now: Date) {
  await db.insert(kv).values({ key, value, updatedAt: now }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: now } });
}

/** Remove a kv key (no-op when missing). */
export async function kvDelete(db: Q, key: string) {
  await db.delete(kv).where(eq(kv.key, key));
}

/** Insert the key once; true only for the first caller (once-a-day nudges, alerts). */
export async function kvFirstTime(db: Q, key: string, now: Date): Promise<boolean> {
  const rows = await db.insert(kv).values({ key, value: now.toISOString(), updatedAt: now }).onConflictDoNothing().returning();
  return rows.length > 0;
}
