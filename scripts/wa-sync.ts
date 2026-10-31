/**
 * Coexistence only: ask Meta to send the owner's WhatsApp Business app
 * contacts and chat history (last 6 months) to the webhook.
 *
 *   pnpm wa:sync
 *
 * Run within 24 hours of onboarding the number, with the app running and
 * the webhook subscribed to smb_app_state_sync and history. Each sync can be
 * requested once per onboarding; after 24 h the number must be onboarded
 * again. Needs WA_TOKEN and WA_PHONE_NUMBER_ID (Graph API, not a BSP proxy).
 */
export {};

const { WA_TOKEN, WA_PHONE_NUMBER_ID, WA_GRAPH_VERSION = "v23.0" } = process.env;
if (!WA_TOKEN || !WA_PHONE_NUMBER_ID) {
  console.error("Set WA_TOKEN and WA_PHONE_NUMBER_ID");
  process.exit(1);
}

for (const syncType of ["smb_app_state_sync", "history"]) {
  const res = await fetch(`https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/smb_app_data`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", sync_type: syncType }),
  });
  const json = await res.json().catch(() => ({}));
  console.log(`${syncType}: ${res.status} ${JSON.stringify(json)}`);
  if (!res.ok) process.exit(1);
}
console.log("Requested. Contacts and history arrive on the webhook over the next minutes; watch the app logs.");
process.exit(0);
