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
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import { handleResponses } from "../../src/server/responses/core";
import { createProtocolEnvelope } from "../../src/protocols/envelope";
import { createTranslatorBudget } from "../../src/lib/translator-budget";

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
async function send(options: { stream?: boolean; config?: OcxConfig; messages?: unknown; tools?: unknown; admission?: DataPlaneAdmission; extra?: Rec } = {}) {
  const requestId = `native-combo-${crypto.randomUUID()}`;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-admission", "x-api-key": "fixture-caller" },
    body: JSON.stringify({ ...source, stream: options.stream ?? true, ...(options.messages ? { messages: options.messages } : {}), ...(options.tools ? { tools: options.tools } : {}), ...options.extra }),
  }), options.config ?? config(), { model: "", provider: "" }, { requestId, start: Date.now(), admission: options.admission });
  const text = await response.text();
  return { response, text, rows: getRequestLogEntries().filter(row => row.requestId === requestId) };
}

describe("native Messages candidates in a combo", () => {
  for (const [name, raw, replayable] of [
    ["empty prelude", prelude + frame("ping"), true],
    ["unknown frame", prelude + frame("fixture_unknown"), false],
    ["empty data", prelude + "data:\n\n", false],
    ["malformed error", prelude + frame("error"), false],
    ["nonempty message start", frame("message_start", { message }), false],
    ["unfinished frame", prelude + "event: content_block_start\n", false],
  ] as const) {
    test(`rewrite failure preserves raw replay evidence: ${name}`, async () => {
      const budgets = await import("../../src/lib/translator-budget");
      const create = budgets.createTranslatorBudget;
      let refused = false;
      const spy = spyOn(budgets, "createTranslatorBudget").mockImplementation(options => {
        const budget = create(options);
        const reserve = budget.reserveTransient.bind(budget);
        budget.reserveTransient = (bytes, scope) => {
          if (!refused && scope.kind === "live_transient") {
            refused = true;
            throw new budgets.TranslatorBudgetExceededError(scope.kind, 1);
          }
          return reserve(bytes, scope);
        };
        return budget;
      });
      try {
        answer = () => stream(raw);
        const { text } = await send({ tools: [] });
        expect(refused).toBe(true);
        expect(text.includes("fallback reply")).toBe(replayable);
        expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(replayable ? ["api.anthropic.com", "backup.fixture.invalid"] : ["api.anthropic.com"]);
      } finally { spy.mockRestore(); }
    });
  }
  for (const streamed of [true, false]) for (const budgetFailure of [true, false]) {
    test(`a rewrite ${budgetFailure ? "budget refusal" : "read failure"} after raw tool output cannot replay (${streamed ? "stream" : "fold"})`, async () => {
      const budgets = await import("../../src/lib/translator-budget");
      const create = budgets.createTranslatorBudget;
      let refused = 0;
      const spy = spyOn(budgets, "createTranslatorBudget").mockImplementation(options => {
        const budget = create(options);
        const charge = budget.chargeRetained.bind(budget);
        budget.chargeRetained = (bytes, scope) => {
          if (scope.kind === "live_transient" && bytes === 32) {
            refused++;
            if (budgetFailure) throw new budgets.TranslatorBudgetExceededError(scope.kind, 1);
            throw new Error("fixture rewrite failure");
          }
          charge(bytes, scope);
        };
        return budget;
      });
      try {
        answer = () => stream(prelude + frame("content_block_start", { index: 0, content_block: { type: "server_tool_use", id: "fixture", name: "web_search", input: {} } }) + terminal);
        const { text } = await send({ stream: streamed, tools: [] });
        expect(refused).toBe(1);
        expect(text).not.toContain("fallback reply");
        expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com"]);
      } finally { spy.mockRestore(); }
    });
  }
  for (const streamed of [true, false]) {
    test(`OAuth error and content in one upstream read cannot replay (${streamed ? "stream" : "fold"})`, async () => {
      await saveCredential("anthropic", { access: "synthetic-combo-access", refresh: "synthetic-combo-refresh", expires: Date.now() + 3_600_000, accountId: "synthetic-combo-uuid", source: "oauth" });
      const settings = config();
      settings.providers.anthropic = { ...settings.providers.anth!, authMode: "oauth", apiKey: undefined };
      delete settings.providers.anth;
      settings.defaultProvider = "anthropic";
      settings.combos!.waterfall!.targets[0]!.provider = "anthropic";
      settings.anthropicAccountPool = { enabled: true };
      settings.protocols!.rollout!.managedMessagesNativeOAuth = true;
      answer = () => stream(prelude + refusal + textStart + textDelta + terminal);
      const { text } = await send({ config: settings, stream: streamed });
      expect(text).not.toContain("fallback reply");
      expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com"]);
    });
    test(`error followed by an incomplete ping frame cannot replay (${streamed ? "stream" : "fold"})`, async () => {
      answer = () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(prelude + refusal + "event: ping\n"));
          controller.enqueue(enc.encode(textStart + textDelta + terminal));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
      const { text } = await send({ stream: streamed });
      expect(text).not.toContain("fallback reply");
      expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com"]);
    });
    test(`error followed by an empty named content frame cannot replay (${streamed ? "stream" : "fold"})`, async () => {
      answer = () => stream(prelude + refusal + "event: content_block_start\ndata:\n\n");
      const { text } = await send({ stream: streamed });
      expect(text).not.toContain("fallback reply");
      expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com"]);
    });
    test(`error followed by empty data cannot replay (${streamed ? "stream" : "fold"})`, async () => {
      answer = () => stream(prelude + refusal + "data:\n\n");
      const { text } = await send({ stream: streamed });
      expect(text).not.toContain("fallback reply");
      expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com"]);
    });
    test(`complete ping after an error remains replayable (${streamed ? "stream" : "fold"})`, async () => {
      answer = () => stream(prelude + refusal + frame("ping"));
      const { text } = await send({ stream: streamed });
      expect(text).toContain("fallback reply");
      expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com", "backup.fixture.invalid"]);
    });
  }
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
  for (const streamed of [true, false]) {
    test(`mixed-case SSE content type permits pre-output failover (${streamed ? "stream" : "fold"})`, async () => {
      answer = () => new Response(prelude + refusal, { headers: { "content-type": "Text/Event-Stream" } });
      const { text } = await send({ stream: streamed });
      expect(text).toContain("fallback reply");
      expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com", "backup.fixture.invalid"]);
    });
  }
  test("pre-output streamed refusal falls back without leaking rejected child's prelude", async () => {
    answer = () => stream(prelude + refusal);
    const { response, text, rows } = await send();
    expect(response.status).toBe(200);
    expect(text).toContain("fallback reply");
    expect(text).not.toContain("overloaded_error");
    expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com", "backup.fixture.invalid"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toHaveLength(2);
    expect(rows[0]!.attempts![0]!.usage).toMatchObject({ cacheReadInputTokens: 9 });
    expect(rows[0]!.spend).toMatchObject({ sends: 2, unresolved: 0 });
    expect(seen[1]!.headers.get("authorization")).toBe("Bearer fixture-backup-key");
    expect(seen[1]!.headers.get("x-api-key")).toBeNull();
  });
  for (const allowedModels of [[], ["anth/claude-sonnet-4-6"], ["anth/claude-sonnet-4-6", "anth/claude-haiku-4-5"]]) {
    test(`native failover enforces the caller model scope with ${allowedModels.length} allowed destinations`, async () => {
      const settings = config();
      settings.providers.anth!.models!.push("claude-haiku-4-5");
      settings.combos!.waterfall!.targets[1] = { provider: "anth", model: "claude-haiku-4-5" };
      settings.apiKeys = [{ id: "caller", name: "fixture", key: "ocx_data_" + "c".repeat(40),
        createdAt: "2026-01-01T00:00:00.000Z", allowedProviders: allowedModels.length ? ["anth"] : ["backup"], allowedModels }];
      answer = body => body.model === "claude-sonnet-4-6" ? stream(prelude + refusal) : Response.json(message);
      const { response, text } = await send({ config: settings, stream: false,
        admission: { kind: "configured", keyId: "caller", source: "dedicated" } });
      expect(response.status).toBe(allowedModels.length === 2 ? 200 : 403);
      expect(seen).toHaveLength(allowedModels.length);
      if (allowedModels.length < 2) expect(text).toContain("not allowed for this API key");
      for (const child of seen) expect(child.body.top_k).toBe(source.top_k);
      if (allowedModels.length === 2) {
        expect(seen[1]!.body).toEqual({ ...source, model: "claude-haiku-4-5", stream: false });
        expect(seen[1]!.body.system).toEqual(seen[0]!.body.system);
      }
    });
  }
  test("captured scope overrides broad host admission for a native Messages sibling", async () => {
    const { createNativeMessagesComboSource } = await import("../../src/server/messages-native");
    const settings = config();
    settings.providers.anth!.models!.push("claude-haiku-4-5");
    settings.combos!.waterfall!.targets[1] = { provider: "anth", model: "claude-haiku-4-5" };
    settings.apiKeys = [{ id: "host", name: "host", key: "ocx_data_" + "h".repeat(40), createdAt: "2026-01-01T00:00:00.000Z" }];
    const admissionScope = { providers: ["anth"], models: ["anth/claude-sonnet-4-6"] };
    const translatorBudget = createTranslatorBudget();
    const req = new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ ...source, stream: false }) });
    const logCtx = { model: source.model, provider: "combo" };
    const protocolSource = createNativeMessagesComboSource({ req, config: settings, logCtx,
      envelope: createProtocolEnvelope({ inbound: "messages", body: { ...source, stream: false }, translatorBudget }),
      requestedModel: source.model, translatorBudget, modelScope: admissionScope });
    answer = () => stream(prelude + refusal);
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ model: source.model, input: "fixture question", stream: false }) }),
    settings, logCtx, { protocolSource, admissionScope, admission: { kind: "configured", keyId: "host", source: "dedicated" }, inboundWire: "anthropic" });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("not allowed for this API key");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.top_k).toBe(source.top_k);
  });
  for (const committed of [textStart + textDelta, frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} } })]) {
    test(`never replays after ${committed.includes("tool_use") ? "tool" : "text"} commitment`, async () => {
      answer = () => stream(prelude + committed + refusal);
      const { text, rows } = await send();
      expect(text).toContain("overloaded_error");
      expect(seen).toHaveLength(1);
      expect(rows).toHaveLength(1);
    });
  }
  for (const [tool, portable] of [[{ type: "bash_20250124", name: "bash" }, false], [{ type: "web_search_20250305", name: "web_search" }, true]] as const) {
    test(`${portable ? "portable" : "native-only"} ${tool.name} tool ${portable ? "may" : "never"} fall back to a translated child`, async () => {
      answer = () => stream(prelude + refusal);
      const { text } = await send({ tools: [...source.tools, tool] });
      expect(text).toContain(portable ? "fallback reply" : "overloaded_error");
      expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(portable ? ["api.anthropic.com", "backup.fixture.invalid"] : ["api.anthropic.com"]);
    });
  }
  for (const name of ["advisor", undefined, "", 42]) test(`an inline system-message tool declaration (name ${JSON.stringify(name)}) never falls back to a translated child`, async () => {
    const definition = { type: "advisor_20260301", ...(name === undefined ? {} : { name }), model: "claude-haiku-4-5" };
    const addition = { role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition } }] };
    answer = () => stream(prelude + refusal);
    const { text } = await send({ messages: [addition, ...source.messages] });
    expect(seen[0]!.body.messages).toEqual([addition, ...source.messages]);
    expect(text).toContain("overloaded_error");
    expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com"]);
  });
  for (const clearAt of [undefined, "never", "end_of_turn"]) test(`withdrawing a top-level tool inline (clear_at ${clearAt ?? "unset"}) never falls back to a translated child`, async () => {
    const removal = { role: "system", ...(clearAt ? { clear_at: clearAt } : {}), content: [{ type: "tool_removal", tool: { type: "tool_reference", name: "lookup" } }] };
    answer = () => stream(prelude + refusal);
    const { text } = await send({ messages: [removal, ...source.messages] });
    expect(text).toContain("overloaded_error");
    expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com"]);
  });
  test("a permanently withdrawn inline-only definition may still fall back to a translated child", async () => {
    const definition = { name: "inline_only", description: "inline", input_schema: { type: "object" } };
    const addition = { role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition } }] };
    const removal = { role: "system", content: [{ type: "tool_removal", tool: { type: "tool_reference", name: "inline_only" } }] };
    answer = () => stream(prelude + refusal);
    const { text } = await send({ messages: [addition, removal, ...source.messages] });
    expect(text).toContain("fallback reply");
    expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com", "backup.fixture.invalid"]);
  });
  test("non-streaming caller retains exact native body and one final row", async () => {
    const { response, text, rows } = await send({ stream: false });
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ...message, model: source.model });
    expect(seen[0]!.body).toEqual({ ...source, model: "claude-sonnet-4-6", stream: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spend).toMatchObject({ sends: 1, unresolved: 0 });
  });
  test("pre-output refusal keeps upstream account and prompt echoes out of the final diagnostic", async () => {
    const echo = "fixture-private-account: private fixture prompt";
    answer = () => stream(prelude + frame("error", { error: { type: "overloaded_error", message: echo } }));
    const warnings: unknown[][] = [];
    const warning = spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args); });
    let result: Awaited<ReturnType<typeof send>>;
    try { result = await send({ tools: [{ type: "bash_20250124", name: "bash" }] }); }
    finally { warning.mockRestore(); }
    const { response, text, rows } = result;
    expect(response.status).toBe(529);
    expect(text).toContain("overloaded_error");
    expect(text).not.toContain(echo);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.errorCode).toBe("server_is_overloaded");
    expect(JSON.stringify(rows[0])).not.toContain(echo);
    expect(JSON.stringify(warnings)).not.toContain(echo);
    expect(seen).toHaveLength(1);
  });
  for (const output of [false, true]) test(`non-streaming fold ${output ? "never replays output" : "hops before output"}`, async () => {
    answer = () => stream(prelude + (output ? textStart + textDelta : "") + refusal);
    const { text } = await send({ stream: false });
    expect(text).toContain(output ? "overloaded_error" : "fallback reply");
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
  test("stream cancellation releases attached lease exactly once", async () => {
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
  for (const streaming of [true, false]) test(`first output waits for a content frame (${streaming ? "stream" : "fold"})`, async () => {
    const empty = frame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } }) + frame("message_stop");
    answer = () => stream(prelude + empty);
    const silent = await send({ stream: streaming });
    expect(silent.rows[0]!.firstOutputMs).toBeUndefined();
    expect(silent.rows[0]!.attempts![0]!.firstOutputMs).toBeUndefined();
    answer = () => stream(prelude + textStart + textDelta + terminal);
    const spoken = await send({ stream: streaming });
    expect(spoken.rows[0]!.firstOutputMs).toBeNumber();
    expect(spoken.rows[0]!.attempts![0]!.firstOutputMs).toBeNumber();
  });
  test("a fold committed by a non-content frame still never replays", async () => {
    answer = () => stream(prelude + frame("fixture_unknown") + refusal);
    const { text } = await send({ stream: false });
    expect(text).toContain("overloaded_error");
    expect(seen).toHaveLength(1);
  });
  test("judging candidates leaves only the dispatched native body copy charged", async () => {
    const { createComboProtocolLanes } = await import("../../src/server/responses/core-combo-native");
    const { routeConcreteModel } = await import("../../src/router");
    const { createRequestExecutionBudget } = await import("../../src/lib/request-execution-budget");
    const { jsonUtf8Bytes } = await import("../../src/lib/json-byte-size");
    const settings = config();
    settings.providers.anth!.models!.push("claude-haiku-4-5");
    settings.providers.pinned = { ...settings.providers.anth!, models: ["claude-sonnet-4-6"], pinnedReasoningEffort: "low" };
    const targets = [{ provider: "anth", model: "claude-sonnet-4-6" }, { provider: "anth", model: "claude-haiku-4-5" },
      { provider: "pinned", model: "claude-sonnet-4-6" }, { provider: "backup", model: "fallback" }];
    settings.combos!.waterfall!.targets = targets;
    const translatorBudget = createTranslatorBudget();
    const body = { ...source, stream: true };
    const envelope = createProtocolEnvelope({ inbound: "messages", body, translatorBudget });
    const lanes = createComboProtocolLanes({
      source: { inbound: "messages", envelope, dispatchNativeChild: async () => new Response() },
      req: new Request("http://localhost/v1/messages"), config: settings, logCtx: { model: "", provider: "" },
      admissionScope: undefined, comboId: "waterfall", targets,
    })!;
    for (const target of targets) expect(lanes.pickable(target)).toBe(true);
    expect(translatorBudget.snapshot().currentBytes).toBe(0);
    expect(lanes.nativeChild(targets[2]!, routeConcreteModel(settings, "pinned/claude-sonnet-4-6"), createRequestExecutionBudget())).toBeUndefined();
    expect(translatorBudget.snapshot().currentBytes).toBe(0);
    const plan = lanes.nativeChild(targets[0]!, routeConcreteModel(settings, "anth/claude-sonnet-4-6"), createRequestExecutionBudget());
    expect(plan).toBeDefined();
    expect(translatorBudget.snapshot().currentBytes).toBe(jsonUtf8Bytes(body));
    // A failed child hands its copy back before failover, so the next target's copy fits again.
    const { dispatchNativeComboChild } = await import("../../src/server/responses/core-combo-native");
    const failed = await dispatchNativeComboChild({
      source: { inbound: "messages", envelope, dispatchNativeChild: async () => new Response("{}", { status: 503 }) },
      plan: plan!, logCtx: { model: "", provider: "" }, childLog: { model: "", provider: "" }, attempt: {} as never, startedAt: Date.now(),
      onFirstOutput: () => {}, callbacks: { onTerminal: () => {}, onCancel: () => {}, onResponseComplete: () => {} },
    });
    expect(failed.status).toBe(503);
    expect(translatorBudget.snapshot().currentBytes).toBe(0);
    // A budget with no room for one more copy still judges every candidate: judging reads in place.
    const tight = createTranslatorBudget({ maxTurnBytes: jsonUtf8Bytes(body) - 1 });
    const tightLanes = createComboProtocolLanes({
      source: { inbound: "messages", envelope: createProtocolEnvelope({ inbound: "messages", body, translatorBudget: tight }), dispatchNativeChild: async () => new Response() },
      req: new Request("http://localhost/v1/messages"), config: settings, logCtx: { model: "", provider: "" },
      admissionScope: undefined, comboId: "waterfall", targets,
    })!;
    for (const target of targets) expect(tightLanes.pickable(target)).toBe(true);
    expect(tight.snapshot().currentBytes).toBe(0);
  });
  test("a declared web_fetch never falls back to a translated child that drops it", async () => {
    answer = () => stream(prelude + refusal);
    const { text } = await send({ tools: [...source.tools, { type: "web_fetch_20250910", name: "web_fetch" }] });
    expect(text).not.toContain("fallback reply");
    expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com"]);
  });
  test("a restricted web_search falls back only to a child that carries its restriction", async () => {
    answer = () => stream(prelude + refusal);
    const restricted = [...source.tools, { type: "web_search_20250305", name: "web_search", allowed_domains: ["example.com"] }];
    const blocked = await send({ tools: restricted });
    expect(blocked.text).not.toContain("fallback reply");
    expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com"]);
    seen = [];
    clearComboTargetCooldowns();
    const open = await send({ tools: [...source.tools, { type: "web_search_20250305", name: "web_search" }] });
    expect(open.text).toContain("fallback reply");
    // A first-party Anthropic bridge child carries the typed original, so it stays a fallback.
    seen = [];
    clearComboTargetCooldowns();
    const settings = config();
    settings.providers.pinned = { ...settings.providers.anth!, pinnedReasoningEffort: "low" };
    settings.combos!.waterfall!.targets = [{ provider: "anth", model: "claude-sonnet-4-6" }, { provider: "pinned", model: "claude-sonnet-4-6" }];
    answer = (_body, _native) => seen.length === 1 ? stream(prelude + refusal) : stream(prelude + textStart + textDelta + terminal);
    const bridged = await send({ config: settings, tools: restricted });
    expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com", "api.anthropic.com"]);
    expect(seen[1]!.body.tools).toContainEqual(expect.objectContaining({ type: "web_search_20250305", allowed_domains: ["example.com"] }));
    expect(bridged.response.status).toBe(200);
  });
  test("a combo chosen by an ocx-route directive answers with the caller's model", async () => {
    const system = [...source.system, { type: "text", text: "<!-- ocx-route: combo/waterfall -->" }];
    const { response, text } = await send({ stream: false, extra: { model: "claude-haiku-4-5", system } });
    expect(response.status).toBe(200);
    expect(JSON.parse(text).model).toBe("claude-haiku-4-5");
  });
  test("a JSON answer with no content blocks records no first output", async () => {
    answer = () => Response.json({ ...message, content: [] });
    const { rows } = await send({ stream: false });
    expect(rows[0]!.firstOutputMs).toBeUndefined();
    expect(rows[0]!.attempts![0]!.firstOutputMs).toBeUndefined();
  });
  test("a large body on a combo without a native child is not charged a replay copy", async () => {
    // 7 MiB fits the translated path's budget but not one extra retained copy of the body.
    for (const on of [false, true]) {
      const settings = config(on);
      settings.combos!.waterfall!.targets = [{ provider: "backup", model: "fallback" }];
      const { response } = await send({ config: settings, stream: false, messages: [{ role: "user", content: "x".repeat(7 * 1024 * 1024) }] });
      expect(response.status).toBe(200);
    }
  });
  for (const folded of ["event: error\ndata: {oops\n\n", `event: error\ndata: ${JSON.stringify({ type: "ping" })}\n\n`]) {
    test(`a fold committed by a malformed error event never replays (${folded.includes("oops") ? "bad JSON" : "type mismatch"})`, async () => {
      answer = () => stream(prelude + folded + frame("message_stop"));
      const { response } = await send({ stream: false });
      expect(response.status).not.toBe(200);
      expect(seen).toHaveLength(1);
    });
  }
  for (const committing of [textStart + textDelta, frame("fixture_unknown")]) {
    test(`a buffer refusal cannot replay ${committing.includes("unknown") ? "an unknown event" : "a content frame"}`, async () => {
      const budgets = await import("../../src/lib/translator-budget");
      const create = budgets.createTranslatorBudget;
      // Only the prelude's chunk fits; a committing chunk must be held without a charge.
      let charges = 0;
      const spy = spyOn(budgets, "createTranslatorBudget").mockImplementation(options => {
        const budget = create(options);
        const charge = budget.chargeRetained.bind(budget);
        budget.chargeRetained = (delta, scope) => {
          if (scope.kind === "retained_collectors" && ++charges === 2) throw new budgets.TranslatorBudgetExceededError(scope.kind, 1);
          charge(delta, scope);
        };
        return budget;
      });
      try {
        answer = () => stream(prelude + committing + terminal);
        const { text } = await send();
        expect(text).not.toContain("fallback reply");
        expect(seen).toHaveLength(1);
      } finally { spy.mockRestore(); }
    });
  }
  for (const [following, streamed] of [[textStart, true], [textStart, false], [textStart.slice(0, 30), true], [textStart.slice(0, 30), false]] as const) {
    test(`a ${following === textStart ? "complete" : "partial"} frame read with a refusal never replays (${streamed ? "stream" : "fold"})`, async () => {
      answer = () => stream(prelude + refusal + following);
      const { text } = await send({ stream: streamed });
      expect(text).not.toContain("fallback reply");
      expect(seen).toHaveLength(1);
    });
  }
  test("a streamed error after content is a failed child, not a completion", async () => {
    answer = () => stream(prelude + textStart + textDelta + refusal);
    const { text, rows } = await send();
    expect(text).toContain("overloaded_error");
    expect(rows[0]!.status).toBe(503);
    expect(rows[0]!.terminalStatus).toBe("failed");
  });
  test("an observe-only workflow root counts one native send once", async () => {
    const { resetWorkflowBudgetsForTest, workflowBudgetSnapshot } = await import("../../src/lib/workflow-budget");
    const { bindWorkflowBudgetConfig } = await import("../../src/lib/workflow-budget-config");
    resetWorkflowBudgetsForTest();
    const settings = config();
    settings.workflowBudget = { maxPhysicalSends: 2 };
    bindWorkflowBudgetConfig(settings);
    const headers = { "content-type": "application/json", "x-codex-parent-thread-id": "native-messages-root" };
    // The HTTP ingress opens the root turn; this direct call opens it the same way.
    expect((await import("../../src/server/workflow-refusal")).admitHttpWorkflowTurn(new Headers(headers))?.admitted).toBe(true);
    try {
      answer = () => Response.json({ type: "error", error: { type: "api_error", message: "fixture" } }, { status: 503, headers: { "retry-after": "0" } });
      const requestId = `native-combo-${crypto.randomUUID()}`;
      await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers, body: JSON.stringify({ ...source, stream: false }),
      }), settings, { model: "", provider: "" }, { requestId, start: Date.now() });
      // Counted twice, the native send would leave the two-send root no room for the fallback.
      expect(seen.map(entry => new URL(entry.url).hostname)).toEqual(["api.anthropic.com", "backup.fixture.invalid"]);
      expect(workflowBudgetSnapshot("native-messages-root")?.sends).toBe(2);
    } finally { bindWorkflowBudgetConfig(null); resetWorkflowBudgetsForTest(); }
  });
  test("native disabled keeps existing translated path", async () => {
    const { response } = await send({ config: config(false) });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).not.toHaveProperty("top_k");
  });
});
