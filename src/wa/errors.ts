export class WaSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly retryable: boolean,
    /** config: bad key/token, permissions or billing — a person must fix the setup. */
    readonly kind: "transient" | "rejected" | "config" = retryable ? "transient" : "rejected",
  ) {
    super(message);
    this.name = "WaSendError";
  }
}

/** Cloud API codes worth retrying: throughput limit, pair rate limit, temporary error. */
export const RETRYABLE_CODES = new Set([130429, 131056, 131000, 2]);
/** Graph codes for a broken setup: expired/invalid token, missing permission. */
export const CONFIG_CODES = new Set([190, 10, 200]);
/**
 * Not retried, not a setup problem: 131047 window closed (re-engagement),
 * 131026 undeliverable, 131030 recipient not allowed (test number list).
 * Listed for readers; anything not retryable or config falls here.
 */
export const REJECTED_CODES = new Set([131047, 131026, 131030]);

/**
 * Maps an error response from either provider to a WaSendError. Meta (and
 * 360dialog, passing Meta through) send `{error:{code,message}}`; 360dialog's
 * own errors are `{error:"..."}` or `{code:"insufficient_balance", error}`.
 */
export function classifySendError(provider: string, status: number, body: unknown): WaSendError {
  const b = (body ?? {}) as { error?: unknown; code?: unknown };
  const err = b.error && typeof b.error === "object" ? (b.error as { code?: unknown }) : null;
  const code = typeof err?.code === "number" ? err.code : null;
  const retryable = status >= 500 || status === 429 || (code !== null && RETRYABLE_CODES.has(code));
  const kind =
    status === 401 || status === 403 || b.code === "insufficient_balance" || (code !== null && CONFIG_CODES.has(code))
      ? "config"
      : retryable
        ? "transient"
        : "rejected";
  return new WaSendError(`${provider} ${status}: ${JSON.stringify(body).slice(0, 500)}`, status, code, retryable, kind);
}
