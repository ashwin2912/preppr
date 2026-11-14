import { existsSync, readFileSync } from "node:fs";

/** Loads `path` (default `$ENV_FILE`, else ./.env) if present. Variables already set in the shell win. */
export function loadDotEnv(path = process.env.ENV_FILE || ".env") {
  if (!existsSync(path)) return;
  if (typeof process.loadEnvFile === "function") return process.loadEnvFile(path);
  // Runtimes without loadEnvFile (Bun binaries): plain KEY=VALUE lines.
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]!] !== undefined) continue;
    process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
}

/** Sets KEY=VALUE lines in env-file text: replaces existing (also commented-out) keys in place, appends the rest. */
export function setEnvLines(text: string, values: Record<string, string>): string {
  const left = new Map(Object.entries(values));
  const lines = text.split("\n").map((line) => {
    const m = line.match(/^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = m?.[1];
    if (!key || !left.has(key)) return line;
    const v = left.get(key)!;
    left.delete(key);
    return `${key}=${v}`;
  });
  const out = lines.join("\n");
  const extra = [...left].map(([k, v]) => `${k}=${v}`).join("\n");
  return extra ? `${out.trim() ? out.replace(/\n*$/, "\n") : ""}${extra}\n` : out;
}
