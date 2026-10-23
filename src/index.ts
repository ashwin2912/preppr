import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { connectPglite, connectPostgres } from "./db/client";
import { log } from "./lib/log";
import { loadDotEnv } from "./lib/env";
import { llmFromEnv } from "./llm";
import { DryRunWaClient, GraphWaClient } from "./wa/client";

loadDotEnv();
const cfg = loadConfig();
const db = cfg.databaseUrl ? await connectPostgres(cfg.databaseUrl) : await connectPglite();
if (!cfg.databaseUrl) log.warn("DATABASE_URL not set: using in-memory PGlite, data is lost on restart");

const wa = cfg.waDryRun ? new DryRunWaClient() : new GraphWaClient(cfg.waToken, cfg.waPhoneNumberId, cfg.waGraphVersion);
const picked = llmFromEnv();
if (!picked) throw new Error("No parser API key: set ANTHROPIC_API_KEY, or LLM_PROVIDER + LLM_API_KEY + LLM_MODEL");
const { llm, label } = picked;
const { app } = createApp({ db, wa, llm, cfg, now: () => new Date() });

serve({ fetch: app.fetch, port: cfg.port }, (info) => log.info("listening", { port: info.port, dryRun: cfg.waDryRun, parser: label }));
