import type { OcxConfig } from "../../src/types";
import { continuationLanes, continuationTails, continuationCase } from "./messages-sse-continuation-cases";
import { sseStart } from "./messages-sse-cases";
const mode = process.argv[2]!;
const tail = process.argv[3] === "eof" ? ["eof", ""] as const : continuationTails.find(row => row[0] === process.argv[3]);
const direct = mode.startsWith("direct-");
if ((direct ? !["direct-rewrite", "direct-tap", "direct-reader"].includes(mode) : !continuationLanes.includes(mode as typeof continuationLanes[number])) || !tail) throw new Error("Unknown split-CRLF fixture");
const input = tail[0] === "eof" ? [continuationCase(continuationTails[0]).chunks[0]!, "\n"] : continuationCase(tail as typeof continuationTails[number]).chunks;
const native = mode === "native" || mode === "builtin";
const chunks = native ? [sseStart, ...input] : input;
let index = 0, readTurn = 0, sawEof = false, sends = 0;
const source = () => new ReadableStream<Uint8Array>({ pull(controller) {
  readTurn++;
  if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]!));
  else { sawEof = true; controller.close(); }
} }, { highWaterMark: 0 });
let response: Response;
let cleanup = () => {};
const originalFetch = globalThis.fetch;
try {
  if (direct) {
    const { createTranslatorBudget } = await import("../../src/lib/translator-budget");
    const { createMessagesSseErrorFilter, filterMessagesSseErrors } = await import("../../src/server/messages-sse-error-filter");
    const { relaySseWithPayloadRewrite } = await import("../../src/server/sse-payload-rewrite");
    const { tapAnthropicSseForLog } = await import("../../src/server/messages-shared");
    const budget = createTranslatorBudget(); cleanup = () => budget.dispose();
    const filter = createMessagesSseErrorFilter();
    const stream = mode === "direct-rewrite" ? relaySseWithPayloadRewrite(source(), value => value, budget, undefined, filter)
      : mode === "direct-tap" ? tapAnthropicSseForLog(source(), {}, () => {}, { stallMs: 0, maxBytes: 0 }, undefined, filter)
      : filterMessagesSseErrors(source());
    response = new Response(stream);
  } else {
    const { acquireOwnedSpendHome } = await import("./owned-spend-home");
    cleanup = acquireOwnedSpendHome();
    const { saveCredential } = await import("../../src/oauth/store");
    const { saveConfig } = await import("../../src/config");
    const { handleClaudeMessages, handleClaudeCountTokens } = await import("../../src/server/claude-messages");
    if (mode === "builtin") await saveCredential("anthropic", { access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3600000, source: "oauth", accountId: "synthetic-account" });
    const fakeFetch = (async () => { sends++; return new Response(source(), { status: mode === "count-tokens" ? 201 : 200, headers: { "content-type": "text/event-stream" } }); }) as typeof fetch;
    const provider = mode === "builtin" ? "anthropic" : "fixture";
    const config = { port: 0, defaultProvider: provider, claudeCode: { bodyStallSec: 0, bodyMaxBytes: 0, anthropicBaseUrl: "http://127.0.0.1:1" }, providers: { [provider]: { adapter: "anthropic", baseUrl: mode === "builtin" ? "https://api.anthropic.com" : "http://127.0.0.1:1", authMode: mode === "builtin" ? "oauth" : "key", apiKey: "synthetic", fetch: fakeFetch, allowPrivateNetwork: true, models: ["wire-model"] } }, protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } } } as OcxConfig;
    saveConfig(config);
    if (!native) globalThis.fetch = fakeFetch;
    const req = new Request(`http://localhost/v1/messages${mode === "count-tokens" ? "/count_tokens" : ""}`, { method: "POST", headers: native ? {} : { "x-api-key": "sk-ant-fixture" }, body: JSON.stringify({ model: native ? `${provider}/wire-model` : "claude-fixture", max_tokens: 16, messages: [{ role: "user", content: "synthetic" }], stream: true }) });
    response = mode === "count-tokens" ? await handleClaudeCountTokens(req, config) : await handleClaudeMessages(req, config, { model: "", provider: "" });
  }
  // Native response consumption exercises its demand schedule; a manual read loop masks the stall.
  const bytes = Buffer.from(await response.arrayBuffer());
  await Bun.write(process.argv[4]!, JSON.stringify({ body: bytes.toString("base64"), status: response.status, readTurn, sawEof, sends }) + "\n");
} finally { globalThis.fetch = originalFetch; cleanup(); }
