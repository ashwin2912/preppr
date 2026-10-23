import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify Meta's X-Hub-Signature-256 header ("sha256=<hex>") against the raw body. */
export function verifySignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const sign = (rawBody: string, appSecret: string) =>
  `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;

/** Constant-time string compare for shared secrets. */
export function secretEquals(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
