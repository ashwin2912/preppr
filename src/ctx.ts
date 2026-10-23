import type { Config } from "./config";
import type { Q } from "./db/client";
import type { Llm } from "./llm/types";
import type { WaClient } from "./wa/client";

/** Everything a handler needs. `db` is the open transaction while handling a message. */
export type Ctx = {
  db: Q;
  wa: WaClient;
  llm: Llm;
  cfg: Config;
  now: () => Date;
};
