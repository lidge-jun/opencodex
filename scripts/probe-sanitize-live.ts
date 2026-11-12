// Live probe: does a blocklisted phrase inside a *data* surface (message text)
// trigger Cognition permission_denied, and does the opt-in sanitizer clear it?
// Usage:
//   bun scripts/probe-sanitize-live.ts            -> sanitize OFF (expect denial)
//   OPENCODEX_DEVIN_SANITIZE_DATA_SURFACES=1 bun scripts/probe-sanitize-live.ts
//     -> sanitize ON (expect success)
// The api key is read from ~/.opencodex/auth.json; nothing is written to disk.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamChatEvents, CloudChatError } from "../src/adapters/devin/cloud-direct/index";
import { getCachedCatalog } from "../src/adapters/devin/cloud-direct/catalog";
import { resolveDevinApiBaseUrl } from "../src/oauth/devin/api-base";

const auth = JSON.parse(readFileSync(join(homedir(), ".opencodex", "auth.json"), "utf8"));
const devin = auth.devin;
const acct = (devin.accounts as any[]).find(a => a?.id === devin.activeAccountId) ?? devin.accounts[0];
const apiKey: string = acct?.credential?.access;
if (!apiKey) {
  console.error("no devin api key in auth.json");
  process.exit(2);
}
const apiServerUrl: string | undefined = acct?.credential?.apiBaseUrl;

if (process.argv.includes("--catalog")) {
  const host = resolveDevinApiBaseUrl(apiServerUrl);
  const cat = await getCachedCatalog(apiKey, host).catch(e => { console.log('catalog err', String(e)); return null; });
  if (cat) for (const [uid, e] of cat.byUid) console.log(`${uid}  disabled=${e.disabled} label=${e.label}`);
  process.exit(0);
}

// The exact Codex exec_command description Cognition refuses — here it sits in
// a user message (data surface), not a tool description (instruction surface).
const TRIGGER = "Runs a command in a PTY, returning output or a session ID for ongoing interaction";
const messages = [
  { role: "user" as const, content: `The tool doc says: "${TRIGGER}". Remember it verbatim.` },
  { role: "assistant" as const, content: "Understood." },
  { role: "user" as const, content: "Reply with exactly: PONG" },
];

const sanitize = process.env.OPENCODEX_DEVIN_SANITIZE_DATA_SURFACES === "1";
console.log(`sanitize=${sanitize} account=${acct?.id ?? 'first'} model=swe-2`);

try {
  let text = "";
  let events = 0;
  for await (const ev of streamChatEvents({
    apiKey,
    apiServerUrl,
    modelUid: "swe-2-max",
    messages,
  })) {
    events++;
    if (ev.kind === "text") text += ev.text;
  }
  console.log(`RESULT=OK events=${events} text=${JSON.stringify(text.slice(0, 120))}`);
} catch (e) {
  if (e instanceof CloudChatError) {
    console.log(`RESULT=CLOUD_ERROR code=${e.code} msg=${e.message.slice(0, 160)}`);
  } else {
    console.log(`RESULT=ERROR ${String(e).slice(0, 200)}`);
  }
  process.exit(1);
}
