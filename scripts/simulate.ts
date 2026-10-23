/**
 * Full-day dry run, in process: in-memory Postgres, signed fake webhooks,
 * outbound messages printed instead of sent to Meta.
 *
 *   pnpm simulate            # deterministic fake parser
 *   ANTHROPIC_API_KEY=... pnpm simulate   # real Claude parser
 *   LLM_PROVIDER=openrouter LLM_API_KEY=... LLM_MODEL=... pnpm simulate
 *
 * Reads .env if present.
 */
import { runCutoff } from "../src/jobs/cutoff";
import { loadDotEnv } from "../src/lib/env";
import { llmFromEnv } from "../src/llm";
import { harness, OWNER } from "../test/helpers";

loadDotEnv();
const picked = llmFromEnv();
const real = !!picked;
const h = await harness({ printOutbound: true, llm: picked?.llm });
console.log(`Parser: ${picked ? picked.label : "fake (set ANTHROPIC_API_KEY or LLM_* for a real model)"}`);

const PRIYA = "+12015550001";
const RAHUL = "+12015550002";
const MEERA = "+12015550003";
const MIN = 60 * 1000;

const step = (title: string) => console.log(`\n\n━━━━━━━━ ${title} ━━━━━━━━`);
async function say(from: string, input: Parameters<typeof h.say>[1]) {
  const shown = typeof input === "string" ? input : "replyId" in input ? `[tap ${input.title ?? input.replyId}]` : `[${input.type}]`;
  console.log(`\n>> ${from === OWNER ? "OWNER" : from}: ${shown}`);
  const out = await h.say(from, input);
  h.advance(MIN);
  return out;
}
const tap = async (from: string, out: Awaited<ReturnType<typeof say>>, title: string) => {
  const b = h.buttonsOf(out).find((x) => x.title.startsWith(title));
  if (!b) throw new Error(`no "${title}" button in: ${JSON.stringify(out)}`);
  return say(from, { replyId: b.id, title: b.title });
};

step("Owner sets today's menu");
const preview = await say(OWNER, "MENU Mon: Dal makhani 6, Jeera rice 4, Roti 1 each, Paneer bhurji 7, Gulab jamun 2. Cutoff 10:30");
await tap(OWNER, preview, "Publish");

step("New customers onboard");
await say(PRIYA, "Order");
await say(PRIYA, "Priya");
await say(PRIYA, { replyId: "area:0", title: "Journal Square" });
await say(PRIYA, "Apt 12C, buzz 12");
await say(RAHUL, "hi");
await say(RAHUL, "Rahul");
await say(RAHUL, { replyId: "area:1", title: "Newport" });
await say(RAHUL, "skip");
await say(MEERA, "Order");
await say(MEERA, "Meera");
await say(MEERA, "heights");
await say(MEERA, "Blue house on Palisade");

step("Orders");
let s = await say(PRIYA, real ? "do dal makhani aur char roti, no onion in dal" : "2 dal (no onion), 4 roti");
await tap(PRIYA, s, "Confirm");
s = await say(RAHUL, real ? "two paneer and 3 rotis" : "2 paneer, 3 roti");
await tap(RAHUL, s, "Change");
s = await say(RAHUL, real ? "actually make it 1 paneer and add a gulab jamun" : "1 paneer, 3 roti, 1 jamun");
await tap(RAHUL, s, "Confirm");
await say(MEERA, real ? "2 dal and 1 chicken biryani" : "2 dal, 1 biryani");
s = await say(MEERA, real ? "ok no biryani, just the dal then" : "2 dal");
await say(MEERA, { type: "audio" });
await say(MEERA, "what is the cutoff?");

step("Cancel, then handoff");
s = await say(PRIYA, real ? "aaj nahi chahiye, cancel kar do" : "cancel");
s = await say(PRIYA, real ? "sorry I do want it, 2 dal 4 roti" : "2 dal, 4 roti");
await tap(PRIYA, s, "Confirm");
await say(RAHUL, "can I talk to aunty about payment");
await say(RAHUL, "hello?? (bot stays silent)");
await say(OWNER, `RESUME ${RAHUL}`);

step("Owner checks orders");
await say(OWNER, "ORDERS");

step("Cutoff passes: late order + summary");
h.advance(3 * 60 * MIN);
await say(MEERA, real ? "1 more dal please" : "1 dal");
console.log("\n>> Cloud Scheduler: POST /jobs/cutoff");
console.log(JSON.stringify(await runCutoff({ db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, now: () => h.clock.now })));
process.exit(0);
