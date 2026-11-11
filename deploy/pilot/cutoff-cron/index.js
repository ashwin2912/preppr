// Cloudflare Worker: calls the cutoff job on a schedule (crons in wrangler.toml).
// The job is idempotent, so extra calls are harmless.

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCutoff(env));
  },
};

async function runCutoff(env) {
  const res = await fetch(`${env.PUBLIC_URL}/internal/cutoff`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.JOB_SECRET}` },
  });
  if (!res.ok) throw new Error(`cutoff failed: ${res.status} ${await res.text()}`);
}
