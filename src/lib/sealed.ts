import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const key = (secret: string, purpose: string) => Buffer.from(hkdfSync("sha256", secret, "", `preppr:${purpose}`, 32));

/** Encrypts `text` with AES-256-GCM under a key derived from `secret` + `purpose`. Output: "v1.<iv>.<tag>.<data>" (base64url). */
export function seal(secret: string, purpose: string, text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret, purpose), iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** Reverses `seal`; null if the blob is malformed or the secret/purpose is wrong. */
export function unseal(secret: string, purpose: string, blob: string): string | null {
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1" || !iv || !tag || data === undefined) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key(secret, purpose), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
