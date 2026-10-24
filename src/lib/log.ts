type ErrorSink = (message: string, fields: Record<string, unknown>) => void;
let errorSink: ErrorSink | null = null;

/** Also send every ERROR somewhere else (Sentry, see src/lib/sentry.ts). */
export const setErrorSink = (sink: ErrorSink | null) => {
  errorSink = sink;
};

/** Structured JSON logs (Cloud Logging parses `severity` and `message`). */
function emit(severity: string, message: string, fields?: Record<string, unknown>) {
  const line = JSON.stringify({ severity, message, ...fields });
  if (severity === "ERROR") {
    console.error(line);
    try {
      errorSink?.(message, fields ?? {});
    } catch {
      // never let error reporting break the caller
    }
  } else console.log(line);
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>) => emit("INFO", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("WARNING", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("ERROR", message, fields),
};

export const errFields = (e: unknown) =>
  e instanceof Error ? { error: e.message, stack: e.stack } : { error: String(e) };
