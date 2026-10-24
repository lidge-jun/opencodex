import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { getRequestLogEntries } from "../../src/server/request-log";
import { activeRegistryMetrics, getActiveTurnCount, tryAdmitTurn } from "../../src/server/lifecycle";
import { saveCredential } from "../../src/oauth/store";
import { clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum } from "../../src/oauth/anthropic-routing";
import { configureSharedSpendLedger, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

type Rec = Record<string, unknown>;
const source = {
  model: "combo/waterfall", max_tokens: 64, top_k: 7,
  system: [{ type: "text", text: "stable system prefix", cache_control: { type: "ephemeral", ttl: "1h" } }],
  tools: [{ name: "lookup", description: "stable tool", input_schema: { type: "object", properties: { query: { type: "string" } } }, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "stable user prefix", cache_control: { type: "ephemeral" } }] }],
};
const message = {
  id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-6",
  content: [{ type: "text", text: "native reply" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 9 },
};
const frame = (type: string, data: Rec = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const prelude = frame("message_start", { message: { ...message, content: [], stop_reason: null } });
const textStart = frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
const textDelta = frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "native reply" } });
const terminal = frame("content_block_stop", { index: 0 }) + frame("message_delta", {
  delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 },
}) + frame("message_stop");
const stream = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });
const refusal = frame("error", { error: { type: "overloaded_error", message: "fixture overloaded" } });

let home = "";
let previousHome: string | undefined;
let codex: IsolatedCodexHome;
let releaseSpend: () => void;
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let seen: { url: string; body: Rec; headers: Headers }[];
let answer: (body: Rec, native: boolean) => Response;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-native-messages-combo-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("ocx-native-messages-combo-codex-");
  releaseSpend = acquireOwnedSpendHome();
  clearComboSelectionState(); clearComboTargetCooldowns(); clearComboRecallForTests(); clearKeyCooldowns(); clearAnthropicAccountPoolState(); forgetAnthropicFailoverQuorum(); clearResponseStateForTests();
  seen = [];
  answer = body => body.stream === true ? stream(prelude + textStart + textDelta + terminal) : Response.json(message);
  // All destinations, including canonical Anthropic, are intercepted: no paid generation.
  const physicalFetch = globalThis.fetch;
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === "127.0.0.1") return physicalFetch(request);
    const body = await request.json() as Rec;
    seen.push({ url: request.url, body, headers: request.headers });
    const native = new URL(request.url).hostname === "api.anthropic.com";
    if (native) return answer(body, true);
    return Response.json({ id: "resp_backup", object: "response", status: "completed", model: "fallback",
      output: [{ id: "msg_backup", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fallback reply", annotations: [] }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });
  });
});
afterEach(async () => {
  fetchMock.mockRestore();
  releaseSpend();
  await flushResponseState(); clearResponseStateForTests();
  clearComboSelectionState(); clearComboTargetCooldowns(); clearComboRecallForTests(); clearKeyCooldowns(); clearAnthropicAccountPoolState(); forgetAnthropicFailoverQuorum();
  codex.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
function config(on = true): OcxConfig {
  return { port: 0, defaultProvider: "anth", providers: {
    anth: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "fixture-managed-key", models: ["claude-sonnet-4-6"] },
    backup: { adapter: "openai-responses", baseUrl: "https://backup.fixture.invalid/v1", authMode: "key", apiKey: "fixture-backup-key", models: ["fallback"] },
  }, combos: { waterfall: { strategy: "failover", targets: [{ provider: "anth", model: "claude-sonnet-4-6" }, { provider: "backup", model: "fallback" }] } },
  protocols: { rollout: { managedMessagesNative: on } } };
}
async function send(options: { stream?: boolean; config?: OcxConfig; messages?: unknown; tools?: unknown } = {}) {
  const requestId = `native-combo-${crypto.randomUUID()}`;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-admission", "x-api-key": "fixture-caller" },
    body: JSON.stringify({ ...source, stream: options.stream ?? true, ...(options.messages ? { messages: options.messages } : {}), ...(options.tools ? { tools: options.tools } : {}) }),
  }), options.config ?? config(), { model: "", provider: "" }, { requestId, start: Date.now() });
  const text = await response.text();
  return { response, text, rows: getRequestLogEntries().filter(row => row.requestId === requestId) };
}

describe("native Messages candidates in a combo", () => {
  test("canonical child preserves source system/messages/tools/cache prefix and managed auth", async () => {
    const { response, text, rows } = await send();
    expect(response.status).toBe(200);
    expect(text).toContain("native reply");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toEqual({ ...source, model: "claude-sonnet-4-6", stream: true });
    expect(seen[0]!.headers.get("x-api-key")).toBe("fixture-managed-key");
    expect(seen[0]!.headers.get("authorization")).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe("combo");
    expect(rows[0]!.attempts).toHaveLength(1);
    expect(rows[0]!.attempts![0]!.usage).toMatchObject({ cacheReadInputTokens: 9, outputTokens: 3 });
    expect(rows[0]!.spend).toMatchObject({ sends: 1, unresolved: 0 });
    expect(rows[0]!.protocolTrace?.attempts?.[0]?.requestPath).toEqual(["messages", "messages"]);
  });
  test("stable serialized cache prefix survives an appended turn", async () => {
    await send();
    const prefix = JSON.stringify({ system: seen[0]!.body.system, tools: seen[0]!.body.tools, messages: seen[0]!.body.messages });
    await send({ messages: [...source.messages, { role: "assistant", content: "previous" }, { role: "user", content: "next" }] });
    expect(JSON.stringify({ system: seen[1]!.body.system, tools: seen[1]!.body.tools, messages: (seen[1]!.body.messages as unknown[]).slice(0, 1) })).toBe(prefix);
    expect(seen[1]!.body.system).toEqual(source.system);
    expect(seen[1]!.body.tools).toEqual(source.tools);
  });
  test("pre-output streamed refusal falls back without leaking rejected child's prelude", async () => {
    answer = () => stream(prelude + refusal);
    const { response, text, rows } = await send();
    expect(response.status).toBe(200);
    expect(text).toContain("fallback reply");
    expect(text).not.toContain("fixture overloaded");
    expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com", "backup.fixture.invalid"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toHaveLength(2);
    expect(rows[0]!.attempts![0]!.usage).toMatchObject({ cacheReadInputTokens: 9 });
    expect(rows[0]!.spend).toMatchObject({ sends: 2, unresolved: 0 });
  });
  for (const committed of [textStart + textDelta, frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} } })]) {
    test(`never replays after ${committed.includes("tool_use") ? "tool" : "text"} commitment`, async () => {
      answer = () => stream(prelude + committed + refusal);
      const { text, rows } = await send();
      expect(text).toContain("fixture overloaded");
      expect(seen).toHaveLength(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe(503);
    });
  }
  for (const [tool, portable] of [[{ type: "bash_20250124", name: "bash" }, false], [{ type: "web_search_20250305", name: "web_search" }, true]] as const) {
    test(`${portable ? "portable" : "native-only"} ${tool.name} tool ${portable ? "may" : "never"} fall back to a translated child`, async () => {
      answer = () => stream(prelude + refusal);
      const { text } = await send({ tools: [...source.tools, tool] });
      expect(text).toContain(portable ? "fallback reply" : "fixture overloaded");
      expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(portable ? ["api.anthropic.com", "backup.fixture.invalid"] : ["api.anthropic.com"]);
    });
  }
  test("non-streaming caller retains exact native body and one final row", async () => {
    const { response, text, rows } = await send({ stream: false });
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ...message, model: source.model });
    expect(seen[0]!.body).toEqual({ ...source, model: "claude-sonnet-4-6", stream: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spend).toMatchObject({ sends: 1, unresolved: 0 });
  });
  for (const output of [false, true]) test(`non-streaming fold ${output ? "never replays output" : "hops before output"}`, async () => {
    answer = () => stream(prelude + (output ? textStart + textDelta : "") + refusal);
    const { text } = await send({ stream: false });
    expect(text).toContain(output ? "fixture overloaded" : "fallback reply");
    expect(seen).toHaveLength(output ? 1 : 2);
  });
  test("ineligible pinned-effort route keeps translated policy", async () => {
    const settings = config();
    settings.providers.anth!.pinnedReasoningEffort = "low";
    const { response } = await send({ config: settings });
    expect(response.status).toBe(200);
    expect(seen[0]!.body).not.toHaveProperty("top_k");
    expect(seen[0]!.body.thinking).toMatchObject({ type: "enabled" });
  });
  test("stream cancellation retains usage and releases attached lease exactly once", async () => {
    let upstreamCancelled = false;
    answer = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(prelude + textStart + textDelta)); },
      cancel() { upstreamCancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    const caller = new AbortController();
    const lease = tryAdmitTurn(undefined, caller.signal);
    if (!lease) throw new Error("fixture admission unavailable");
    let releases = 0;
    lease.attach({ release() { releases++; } });
    const misses = activeRegistryMetrics().activeTurns!.releaseMisses;
    const requestId = `native-combo-${crypto.randomUUID()}`;
    try {
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...source, stream: true }), signal: caller.signal,
      }), config(), { model: "", provider: "" }, { requestId, start: Date.now(), turnAdmissionLease: lease });
      expect(getActiveTurnCount()).toBe(1);
      expect(releases).toBe(0);
      const reader = response.body!.getReader();
      await reader.read();
      caller.abort(new Error("fixture cancel"));
      await reader.cancel();
      await Bun.sleep(10);
      expect(upstreamCancelled).toBe(true);
      expect(releases).toBe(1);
      expect(getActiveTurnCount()).toBe(0);
      expect(activeRegistryMetrics().activeTurns!.releaseMisses).toBe(misses);
      const rows = getRequestLogEntries().filter(row => row.requestId === requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe(499);
      expect(rows[0]!.attempts![0]!.usage).toMatchObject({ cacheReadInputTokens: 9 });
      expect(seen).toHaveLength(1);
    } finally { lease.release(); }
    expect(releases).toBe(1);
  });
  test("eligible OAuth child reuses native credential binding and tool-name policy", async () => {
    await saveCredential("anthropic", { access: "synthetic-combo-access", refresh: "synthetic-combo-refresh", expires: Date.now() + 3_600_000, accountId: "synthetic-combo-uuid", source: "oauth" });
    const settings = config();
    settings.providers.anthropic = { ...settings.providers.anth!, authMode: "oauth", apiKey: undefined };
    delete settings.providers.anth;
    settings.defaultProvider = "anthropic";
    settings.combos!.waterfall!.targets[0]!.provider = "anthropic";
    settings.anthropicAccountPool = { enabled: true };
    settings.protocols!.rollout!.managedMessagesNativeOAuth = true;
    const { response, rows } = await send({ config: settings, stream: false });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer synthetic-combo-access");
    expect(seen[0]!.headers.get("x-api-key")).toBeNull();
    expect(seen[0]!.body.messages).toEqual(source.messages);
    expect(seen[0]!.body.top_k).toBe(7);
    expect((seen[0]!.body.tools as Rec[])[0]!.cache_control).toEqual(source.tools[0]!.cache_control);
    expect(rows[0]!.attempts).toHaveLength(1);
    expect(rows[0]!.spend).toMatchObject({ sends: 1, unresolved: 0 });
  });
  test("a refused native child cannot settle the lease held by its accepted native sibling", async () => {
    const settings = config();
    settings.providers.anth!.models!.push("claude-haiku-4-5");
    settings.combos!.waterfall!.targets[1] = { provider: "anth", model: "claude-haiku-4-5" };
    let close!: () => void;
    answer = body => body.model === "claude-sonnet-4-6" ? stream(prelude + refusal)
      : new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(prelude + textStart + textDelta)); close = () => { controller.enqueue(new TextEncoder().encode(terminal)); controller.close(); }; },
      }), { headers: { "content-type": "text/event-stream" } });
    const lease = tryAdmitTurn();
    if (!lease) throw new Error("fixture admission unavailable");
    let releases = 0;
    lease.attach({ release() { releases++; } });
    try {
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...source, stream: true }),
      }), settings, { model: "", provider: "" }, { requestId: `lease-${crypto.randomUUID()}`, start: Date.now(), turnAdmissionLease: lease });
      expect(seen).toHaveLength(2);
      expect(releases).toBe(0);
      expect(getActiveTurnCount()).toBe(1);
      close();
      await response.text();
      expect(releases).toBe(1);
    } finally { lease.release(); }
    expect(releases).toBe(1);
  });
  test("enforced shared send ceiling counts one physical send and never doubles its prepaid permit", async () => {
    configureSharedSpendLedger(spendPolicyFromConfig({ pool: { maxTokens: 100_000 } }, undefined, ["anth", "backup"]));
    const { response, rows } = await send();
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(rows[0]!.spend).toMatchObject({ sends: 1, unresolved: 0 });
  });
  test("real HTTP ingress serves native combo bytes with synthetic canonical egress", async () => {
    const settings = config();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handleClaudeMessages(
      request, settings, { model: "", provider: "" }, { requestId: `http-${crypto.randomUUID()}`, start: Date.now() },
    ) });
    try {
      const response = await fetch(new URL("/v1/messages", server.url), { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ ...source, stream: true }) });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("native reply");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body).toEqual({ ...source, model: "claude-sonnet-4-6", stream: true });
    } finally { await server.stop(true); }
  });
  test("native disabled keeps existing translated path", async () => {
    const { response } = await send({ config: config(false) });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).not.toHaveProperty("top_k");
  });
});
