/**
 * In-memory fixed-window counter (one app instance). `hit` counts a request and
 * says whether it's still under the limit. Time is passed in (tests use a fake clock).
 */
export function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { start: number; n: number }>();
  return {
    hit(key: string, now: Date): boolean {
      const t = now.getTime();
      // Drop stale windows now and then so the map can't grow without end.
      if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      const w = hits.get(key);
      if (!w || t - w.start >= windowMs) {
        hits.set(key, { start: t, n: 1 });
        return true;
      }
      w.n++;
      return w.n <= max;
    },
  };
}

export type RateLimiter = ReturnType<typeof rateLimiter>;
