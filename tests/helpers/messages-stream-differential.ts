import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoPath, repoRoot } from "./repo-root";
import type { OcxConfig } from "../../src/types";

const [mode, scratch, output] = process.argv.slice(2) as [string, string, string];
function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot() });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
if (mode !== "head" && mode !== "--generate-base") throw new Error("Expected head or --generate-base");
if (mode === "--generate-base") {
  // Overlay exact git-show bytes at the original module identities so relative imports resolve identically.
  const existing = new Set(git("ls-tree", "-r", "--name-only", "895a85989", "--", "src").trim().split("\n"));
  const changed = [...new Set(["src/server/messages-native.ts", "src/server/messages-native-tool-guard.ts", "src/server/messages-shared.ts", "src/server/claude-messages.ts", "src/server/sse-payload-rewrite.ts", "src/lib/messages-error-body.ts", ...git("diff", "--name-only", "895a85989", "--", "src").trim().split("\n").filter(path => existing.has(path))])];
  if (!changed.length) throw new Error("The differential fixture requires changed baseline modules");
  const overlays = new Map<string, string>();
  for (const path of changed) {
    const target = join(scratch, "baseline", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git("show", `895a85989:${path}`));
    overlays.set(repoPath(path), target);
  }
  const filter = new RegExp(`^(?:${[...overlays.keys()].map(path => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`);
  Bun.plugin({ name: "Messages baseline modules", setup(build) {
    build.onLoad({ filter }, ({ path }) => ({ contents: readFileSync(overlays.get(path)!, "utf8"), loader: "ts" }));
  } });
}
// Production imports must occur after the baseline overlay is registered.
const { acquireOwnedSpendHome } = await import("./owned-spend-home");
const { saveCredential } = await import("../../src/oauth/store");
const { saveConfig } = await import("../../src/config");
const { handleClaudeMessages } = await import("../../src/server/claude-messages");
const { clearKeyCooldowns } = await import("../../src/providers/key-failover");
const { getRequestLogEntries } = await import("../../src/server/request-log");
const { tapAnthropicSseForLog } = await import("../../src/server/messages-shared");
const sentinel = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const ev = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const error = (type: string, message: string) => ev("error", { type: "error", error: { type, message }, request_id: sentinel });
const start = ev("message_start", { type: "message_start", message: { id: "msg_fixture", role: "assistant", content: [], model: "wire-model", usage: { input_tokens: 5, output_tokens: 0 } } });
const done = ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) + ev("message_stop", { type: "message_stop" });
const streams: [string, string][] = [
  ["overflow", error("request_too_large", `prompt is too long ${sentinel}`)],
  ["throughput", error("rate_limit_error", `too many tokens per minute ${sentinel}`)],
  ["guard", start + ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "fixture", name: "undeclared" } })],
  ["eof", start], ["stop-error", start + ev("message_delta", { type: "message_delta", delta: { stop_reason: "error" } })],
  ["complete", start + done], ["cap", start + done], ["stall", start], ["read-error", start], ["cancel", start],
];
function source(name: string, raw: string, cancelled: string[]): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(raw)); return; }
    if (name === "read-error") throw new Error("fixture stream read failure");
    if (name !== "stall" && name !== "cancel" && name !== "cap") controller.close();
  }, cancel(reason) { cancelled.push(reason instanceof Error ? reason.name : typeof reason); } });
}
const { upstreamMessagesRequestIdHeaders } = await import("../../src/server/messages-response-headers");
const overlayProbe = upstreamMessagesRequestIdHeaders(new Headers({ "request-id": "req_fixture" }));
const results: Record<string, unknown> = {};
const release = acquireOwnedSpendHome();
try {
  await saveCredential("anthropic", { access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3600000, source: "oauth", accountId: "synthetic-account" });
  for (const [name, raw] of streams) {
    const tapCancelled: string[] = [];
    const calls: unknown[] = []; const ctx: any = { model: "fixture", provider: "fixture" };
    const tapped = tapAnthropicSseForLog(source(name, raw, tapCancelled), ctx, (status, meta) => calls.push({ status, ...meta }), { stallMs: name === "stall" ? 10 : 5000, maxBytes: name === "cap" ? 32 : 0 });
    const bytes = name === "cancel" ? (await tapped.cancel("fixture client cancel"), "") : await new Response(tapped).text();
    results[`tap-${name}`] = { bytes, calls, cancelled: tapCancelled, usage: ctx.usage, phase: ctx.transportPhase, source: ctx.terminalSource };
    for (const providerName of ["fixture", "anthropic"]) {
      const cancelled: string[] = []; let sends = 0;
      clearKeyCooldowns();
      const config = { claudeCode: { bodyStallSec: 1, bodyMaxBytes: name === "cap" ? 32 : 0 }, port: 0, defaultProvider: providerName, providers: { [providerName]: { adapter: "anthropic", baseUrl: providerName === "anthropic" ? "https://api.anthropic.com" : "http://127.0.0.1:1", authMode: providerName === "anthropic" ? "oauth" : "key", apiKey: "fixture", fetch: async () => { sends++; return new Response(source(name, raw, cancelled), { headers: { "content-type": "text/event-stream" } }); }, allowPrivateNetwork: true, models: ["wire-model"] } }, protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } } } as OcxConfig;
      saveConfig(config);
      const ctx: any = { model: "", provider: "" };
      const requestId = `diff-${providerName}-${name}`;
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: `${providerName}/wire-model`, max_tokens: 16, messages: [{ role: "user", content: "hi" }], tools: [], stream: true }) }), config, ctx, { requestId, start: Date.now() });
      const bytes = name === "cancel" ? (await response.body!.cancel("fixture client cancel"), "") : await response.text();
      const settlements = getRequestLogEntries().filter(row => row.requestId === requestId).map(row => ({ status: row.status, terminalStatus: row.terminalStatus, closeReason: row.closeReason, mode: row.protocolTrace?.mode }));
      results[`native-${providerName}-${name}`] = { status: response.status, bytes, sends, cancelled, usage: ctx.usage, phase: ctx.transportPhase, source: ctx.terminalSource, streamAborted: ctx.activeAttempt?.streamAborted, settlements };
    }
  }
} finally { release(); }
if (mode === "--generate-base" && overlayProbe["request-id"] !== undefined) {
  throw new Error("Baseline module overlay did not execute the original header writer");
}
await Bun.write(output, JSON.stringify({ ...(mode === "--generate-base" ? { baseCommit: "895a859893147d3056ebd1881ec398ab03b037d2" } : {}), results }, null, 2) + "\n");
