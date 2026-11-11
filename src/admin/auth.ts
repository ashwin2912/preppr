import { createHmac } from "node:crypto";
import { secretEquals } from "../wa/signature";

export const LINK_TTL_MS = 12 * 60 * 60 * 1000;
/** The kitchen page link (APP command) stays valid longer: it's the owner's day-to-day page. */
export const KITCHEN_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const mac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64url");

/** `<owner>.<expiry ms>.<hmac>`, all URL-safe. */
export function signViewerToken(secret: string, owner: string, now: Date, ttlMs = LINK_TTL_MS): string {
  const body = `${Buffer.from(owner).toString("base64url")}.${now.getTime() + ttlMs}`;
  return `${body}.${mac(secret, body)}`;
}

/** The owner number if the token is genuine and unexpired, else null. */
export function verifyViewerToken(secret: string, token: string | undefined, now: Date): string | null {
  const parts = token?.split(".");
  if (!parts || parts.length !== 3) return null;
  const [who, exp, sig] = parts as [string, string, string];
  if (!secretEquals(sig, mac(secret, `${who}.${exp}`))) return null;
  if (!/^\d+$/.test(exp) || Number(exp) <= now.getTime()) return null;
  return Buffer.from(who, "base64url").toString();
}

/** Expiry (ms) written in a token; only meaningful after verifyViewerToken accepted it. */
export const tokenExpiry = (token: string) => Number(token.split(".")[1]);
