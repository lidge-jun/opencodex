import { createHash } from "node:crypto";
import type { OcxConfig } from "../../src/types";
import { messagesSseCases, sseStart, SSE_SENTINEL, type MessagesSseCase } from "./messages-sse-cases";
import { pinnedMessagesObservation } from "./messages-sse-observer";
import { acquireOwnedSpendHome } from "./owned-spend-home";
import { saveCredential } from "../../src/oauth/store";
import { saveConfig } from "../../src/config";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { handleClaudeMessages, handleClaudeCountTokens } from "../../src/server/claude-messages";
import { tapAnthropicSseForLog } from "../../src/server/messages-shared";
import { getRequestLogEntries } from "../../src/server/request-log";
export const sseLanes = ["native", "builtin", "passthrough", "count-tokens", "tap", "fold"] as const;
export type SseLane = typeof sseLanes[number];
export const applicableSseCases = (lane: SseLane) => messagesSseCases.filter(row => lane === "fold" ? row.fold : !row.fold);
export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function runMessagesSseCase(lane: SseLane, input: MessagesSseCase) {
  let readTurn = 0, sends = 0;
  const cancelled: string[] = [], calls: unknown[] = [];
  const wireChunks = (lane === "native" || lane === "builtin" || lane === "fold") && !input.echo ? [sseStart, ...input.chunks] : input.chunks;
  const source = () => {
    let index = 0;
    return new ReadableStream<Uint8Array>({ pull(controller) {
      readTurn++;
      if (index < wireChunks.length) { controller.enqueue(new TextEncoder().encode(wireChunks[index++]!)); return; }
      if (input.fault === "read" || input.fault === "read-overflow") throw new Error(`${input.fault === "read-overflow" ? "prompt is too long " : ""}${SSE_SENTINEL}`);
      if (input.fault === "stall" || input.fault === "cap" || input.fault === "cancel") return;
      controller.close();
    }, cancel(reason) { cancelled.push(reason instanceof Error ? reason.name : typeof reason); } }, { highWaterMark: 0 });
  };
  const ctx: any = { model: "", provider: "" };
  let response: Response;
  const release = acquireOwnedSpendHome();
  const originalFetch = globalThis.fetch;
  try {
    clearKeyCooldowns();
    const fakeFetch = (async () => { sends++; return new Response(source(), { status: lane === "count-tokens" ? 201 : 200, headers: { "content-type": "text/event-stream" } }); }) as typeof fetch;
    if (lane === "builtin") await saveCredential("anthropic", { access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3600000, source: "oauth", accountId: "synthetic-account" });
    const provider = lane === "builtin" ? "anthropic" : "fixture";
    const config = { port: 0, defaultProvider: provider, claudeCode: { bodyStallSec: input.fault === "stall" ? 1 : 0, bodyMaxBytes: input.fault === "cap" ? 32 : 0, anthropicBaseUrl: "http://127.0.0.1:1" },
      providers: { [provider]: { adapter: "anthropic", baseUrl: lane === "builtin" ? "https://api.anthropic.com" : "http://127.0.0.1:1", authMode: lane === "builtin" ? "oauth" : "key", apiKey: "synthetic", fetch: fakeFetch, allowPrivateNetwork: true, models: ["wire-model"] } },
      protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } } } as OcxConfig;
    saveConfig(config);
    const requestId = `sse-${lane}-${input.id}`;
    if (lane === "tap") response = new Response(tapAnthropicSseForLog(source(), ctx, (status, meta) => calls.push({ status, ...meta }), { stallMs: input.fault === "stall" ? 10 : 0, maxBytes: input.fault === "cap" ? 32 : 0 }));
    else {
      const passthrough = lane === "passthrough" || lane === "count-tokens";
      if (passthrough) globalThis.fetch = fakeFetch;
      const req = new Request(`http://localhost/v1/messages${lane === "count-tokens" ? "/count_tokens" : ""}`, { method: "POST", headers: passthrough ? { "x-api-key": "sk-ant-fixture" } : {}, body: JSON.stringify({ model: passthrough ? "claude-fixture" : `${provider}/wire-model`, max_tokens: 16, messages: [{ role: "user", content: "synthetic" }], ...(input.guard ? { tools: [] } : {}), stream: lane !== "fold" }) });
      response = lane === "count-tokens" ? await handleClaudeCountTokens(req, config) : await handleClaudeMessages(req, config, ctx, { requestId, start: Date.now() });
    }
    const chunks: { sha256: string; length: number; turn: number }[] = [];
    const body: Uint8Array[] = [];
    if (input.fault === "cancel") await response.body!.cancel("synthetic cancel");
    else {
      const reader = response.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push({ sha256: digest(value), length: value.length, turn: readTurn }); body.push(value);
      }
    }
    const bytes = Buffer.concat(body);
    const observed = pinnedMessagesObservation(bytes);
    const internal = { calls, cancelled, usage: ctx.usage ?? null, phase: ctx.transportPhase ?? null, source: ctx.terminalSource ?? null,
      streamAborted: ctx.activeAttempt?.streamAborted ?? null,
      settlements: getRequestLogEntries().filter(row => row.requestId === requestId).map(row => ({ status: row.status, terminalStatus: row.terminalStatus ?? null, closeReason: row.closeReason ?? null, mode: row.protocolTrace?.mode ?? null })) };
    return { status: response.status, bodySha256: digest(bytes), bodyLength: bytes.length, chunks, readTurn, sends, internal,
      clientRecognizes: observed.clientRecognizes, wirePhrase: observed.wirePhrase,
      diagnostics: observed.events.filter(row => row.event === "error").map(row => ({ diagnostic: row.diagnostic, recognizes: row.recognizes })),
      bytes };
  } finally { globalThis.fetch = originalFetch; release(); }
}
