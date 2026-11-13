import type { Context } from "hono";

/**
 * Refuse form posts from another site (cookies here are SameSite=Lax; this is the
 * second check). Browsers send `Origin: null` when the page's referrer policy hides
 * it, so Sec-Fetch-Site decides when present.
 */
export function sameOrigin(c: Context): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = c.req.header("origin");
  if (!origin || origin === "null") return true; // old browsers; the Lax cookie already blocks cross-site posts
  try {
    return new URL(origin).host === (c.req.header("host") ?? new URL(c.req.url).host);
  } catch {
    return false;
  }
}

/** A urlencoded or multipart form: first value per field, and all string values per field. */
export async function readForm(c: Context) {
  const body = await c.req.parseBody({ all: true });
  const one: Record<string, string> = {};
  const all: Record<string, string[]> = {};
  const files: Record<string, File> = {};
  for (const [k, v] of Object.entries(body)) {
    const vals = Array.isArray(v) ? v : [v];
    const strs = vals.filter((x): x is string => typeof x === "string");
    all[k] = strs;
    one[k] = strs[0] ?? "";
    const file = vals.find((x): x is File => typeof x === "object" && x !== null && "arrayBuffer" in x);
    if (file) files[k] = file;
  }
  return { one, all, files };
}

/**
 * The caller's IP for rate limits. Behind Railway's proxy the last
 * X-Forwarded-For hop is the one the proxy added (earlier hops are client-supplied).
 */
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  const last = xff?.split(",").map((s) => s.trim()).filter(Boolean).pop();
  return last || c.req.header("x-real-ip") || "unknown";
}
