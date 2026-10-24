import type { Config } from "./config";
import type { Q } from "./db/client";
import type { Llm } from "./llm/types";
import type { SheetSink } from "./sheets/client";
import type { WaClient } from "./wa/client";

/** Everything a handler needs. `db` is the open transaction while handling a message. */
export type Ctx = {
  db: Q;
  wa: WaClient;
  llm: Llm;
  cfg: Config;
  now: () => Date;
  /** Google Sheet export; unset = sync off. */
  sheets?: SheetSink;
  /**
   * Idempotency keys for queued replies: `<prefix>:<n>`. The worker sets the
   * prefix to the inbound wamid, so a retried handler can't queue a reply twice.
   */
  out?: { prefix: string; n: number };
  /** Wake the worker after queueing work. */
  kick?: () => void;
};
