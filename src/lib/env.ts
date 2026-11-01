import { existsSync, readFileSync } from "node:fs";

/** Loads ./.env (or `path`) if present. Variables already set in the shell win. */
export function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  if (typeof process.loadEnvFile === "function") return process.loadEnvFile(path);
  // Runtimes without loadEnvFile (Bun binaries): plain KEY=VALUE lines.
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]!] !== undefined) continue;
    process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
}
