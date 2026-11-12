// Bisect a dumped denied request to find the blocklist trigger.
// Usage: bun scripts/bisect-denied.ts <dump.json> <mode> [args]
//   modes: full | sys | msgs A B | sysonly
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamChatEvents, CloudChatError } from "../src/adapters/devin/cloud-direct/index";
import { resolveDevinApiBaseUrl } from "../src/oauth/devin/api-base";

const dump = JSON.parse(readFileSync(process.argv[2], "utf8"));
const mode = process.argv[3] ?? "full";
const A = parseInt(process.argv[4] ?? "0", 10);
const B = parseInt(process.argv[5] ?? String(dump.messages.length), 10);

const auth = JSON.parse(readFileSync(join(homedir(), ".opencodex", "auth.json"), "utf8"));
const acct = auth.devin.accounts.find((a: any) => a?.id === auth.devin.activeAccountId) ?? auth.devin.accounts[0];
const apiKey: string = acct?.credential?.access;
const apiServerUrl: string | undefined = acct?.credential?.apiBaseUrl;

process.env.OPENCODEX_DEVIN_SANITIZE_DATA_SURFACES = "1"; // production-identical

function toMsgs(list: any[]) {
  return list.map((m: any) => ({
    role: m.role === "tool" ? "user" : m.role,
    content: m.role === "tool" ? "<tool-result>\n" + m.text + "\n</tool-result>" : m.text,
  }));
}

async function probe(label: string, msgs: any[], tools: any[], sys: string) {
  try {
    let n = 0;
    for await (const ev of streamChatEvents({
      apiKey, apiServerUrl, modelUid: "swe-2-max",
      messages: [{ role: "system", content: sys }, ...msgs],
      tools,
    } as any)) { if (ev.kind === "text") n += ev.text.length; }
    console.log(label + " => OK textLen=" + n);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const denied = /permission_denied/.test(msg);
    console.log(label + " => " + (denied ? "DENIED" : "ERR " + msg.slice(0, 140)));
    return !denied;
  }
}

const tools = dump.tools.map((t: any) => ({ name: t.name, description: t.description }));

if (mode === "full") {
  await probe("full", toMsgs(dump.messages), tools, dump.systemPrompt);
} else if (mode === "sys") {
  await probe("sys+tools+hi", [{ role: "user", content: "hi" }], tools, dump.systemPrompt);
} else if (mode === "sysonly") {
  await probe("sys-only+hi", [{ role: "user", content: "hi" }], [], dump.systemPrompt);
} else if (mode === "toolsonly") {
  await probe("tools-only+hi", [{ role: "user", content: "hi" }], tools, "");
} else if (mode === "msgs") {
  await probe("msgs[" + A + ".." + B + "]", toMsgs(dump.messages.slice(A, B)), [], "");
} else if (mode === "lit") {
  // Read candidate literal strings from file (one per line) given in argv[4].
  const cand = readFileSync(process.argv[4], "utf8").split("\n").filter((s: string) => s.trim().length > 0);
  for (const c of cand) {
    await probe(JSON.stringify(c.slice(0, 80)), [{ role: "user", content: "hi" }], [], c);
  }
} else if (mode === "syspart") {
  await probe("sys[" + A + ".." + B + "]", [{ role: "user", content: "hi" }], [], dump.systemPrompt.slice(A, B));
} else if (mode === "full-sys-half") {
  const h = Math.floor(dump.systemPrompt.length / 2);
  await probe("sys-first-half", [{ role: "user", content: "hi" }], [], dump.systemPrompt.slice(0, h));
  await probe("sys-second-half", [{ role: "user", content: "hi" }], [], dump.systemPrompt.slice(h));
}
