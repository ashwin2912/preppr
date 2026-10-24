import * as Sentry from "@sentry/node";
import { setErrorSink } from "./log";

/** Fields that can carry customer message text; kept out of Sentry. */
const DROP = new Set(["stack", "body", "raw", "text"]);

/**
 * Every `log.error` becomes a Sentry event, grouped by message (and alert
 * name), tagged `alert=<name>` when the caller set one. Set up an alert rule
 * in Sentry on new issues and on the `alert` tag.
 */
export function initSentry(dsn: string, environment = "production") {
  Sentry.init({ dsn, environment, tracesSampleRate: 0 });
  setErrorSink((message, fields) => {
    Sentry.withScope((scope) => {
      const alert = typeof fields.alert === "string" ? fields.alert : undefined;
      if (alert) scope.setTag("alert", alert);
      scope.setFingerprint([message, alert ?? ""]);
      scope.setExtras(Object.fromEntries(Object.entries(fields).filter(([k]) => !DROP.has(k))));
      if (typeof fields.stack === "string") {
        const err = new Error(`${message}: ${String(fields.error ?? "")}`);
        err.stack = fields.stack;
        Sentry.captureException(err);
      } else {
        Sentry.captureMessage(message, "error");
      }
    });
  });
}

export const flushSentry = () => Sentry.flush(2000);
