import { existsSync } from "node:fs";

/** Loads ./.env if present. Variables already set in the shell win. */
export function loadDotEnv(path = ".env") {
  if (existsSync(path)) process.loadEnvFile(path);
}
