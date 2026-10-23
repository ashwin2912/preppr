import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Normalize any phone input to E.164 ("+15551234567"), or null if invalid.
 * WhatsApp webhooks send digits without "+" ("15551234567"); those are
 * treated as already including the country code.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  // Bare digits longer than a US national number already carry a country code.
  const candidate =
    !digits.startsWith("+") && digits.replace(/\D/g, "").length > 10 ? `+${digits}` : digits;
  const parsed = parsePhoneNumberFromString(candidate, "US");
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.number;
}

/** Graph API and wa.me links want digits only. */
export const toWaId = (e164: string) => e164.replace(/^\+/, "");

export const waLink = (e164: string, text?: string) =>
  `https://wa.me/${toWaId(e164)}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
