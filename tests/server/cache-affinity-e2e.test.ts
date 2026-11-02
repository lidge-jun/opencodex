import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { startServer } from "../../src/server";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { loadConfig, saveConfig } from "../../src/config";
import { addFinalRequestLog, inspectResponseLogJson, nextRequestLogId, type RequestLogContext } from "../../src/server/request-log";
import { boundEntryIdForLane, clearProviderCacheAffinityForTests, recordProviderCacheAffinity } from "../../src/providers/cache-affinity";
import { RequestPacingQueueOverloadError } from "../../src/providers/request-pacing";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { protocolTraceForRequest } from "../../src/protocols/trace";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/key-store";
import { setKeyCooldown } from "../../src/providers/api-key-cooldowns";
import { consultProviderCacheAffinity } from "../../src/providers/cache-affinity";
import {
  fillHermesLogConversationFallback,
  sessionLaneIdFromRequest,
} from "../../src/server/request-log-conversation";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

const REAL_FETCH = globalThis.fetch;
let testDir = "";
let previousHome: string | undefined;
const seenAuth: string[] = [];
const failingKeys = new Set<string>();
// Direct handler calls need the spend-ledger ownership startServer acquires.
const trackedServers = new Set<ReturnType<typeof startServer>>();

function makeConfig(): OcxConfig {
  const config = {
    port: 0,
    providers: {
      "affinity-e2e": {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://upstream.invalid/v1",
        apiKey: "key-a",
        models: ["test"],
        liveModels: false,
        apiKeyPool: [
          { id: "a", key: "key-a" },
          { id: "b", key: "key-b" },
        ],
      },
      "affinity-chat": {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://upstream.invalid/v1",
        apiKey: "key-a",
        models: ["test"],
        liveModels: false,
        apiKeyPool: [
          { id: "a", key: "key-a" },
          { id: "b", key: "key-b" },
        ],
      },
      "affinity-compact": {
        adapter: "openai-responses",
        authMode: "key",
        baseUrl: "https://upstream.invalid/v1",
        apiKey: "key-a",
        models: ["test"],
        liveModels: false,
        apiKeyPool: [
          { id: "a", key: "key-a" },
          { id: "b", key: "key-b" },
        ],
      },
      "affinity-msg": {
        adapter: "anthropic",
        authMode: "key",
        baseUrl: "https://upstream.invalid",
        apiKey: "key-a",
        models: ["claude-test"],
        liveModels: false,
        apiKeyPool: [
          { id: "a", key: "key-a" },
          { id: "b", key: "key-b" },
        ],
      },
    },
  } as unknown as OcxConfig;
  saveConfig(config);
  return loadConfig();
}

async function turn(
  config: OcxConfig,
  threadId: string,
  model = "affinity-e2e/test",
): Promise<RequestLogContext> {
  saveConfig(config);
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": threadId },
      body: JSON.stringify({ model, input: "hello", stream: false, store: false }),
    }),
    config,
    logCtx,
    {},
  );
  expect(response.status).toBe(200);
  await response.text();
  // The ingress layer owns finalization in production; this harness stands in for it.
  addFinalRequestLog(nextRequestLogId(), Date.now(), logCtx, response.status);
  return logCtx;
}

describe("provider cache affinity (end-to-end)", () => {
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-cache-affinity-e2e-"));
    process.env.OPENCODEX_HOME = testDir;
    saveConfig(makeConfig());
    trackedServers.add(startServer(0));
    clearKeyCooldowns();
    clearProviderCacheAffinityForTests();
    seenAuth.length = 0;
    failingKeys.clear();
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization") ?? (headers.get("x-api-key") ? `Bearer ${headers.get("x-api-key")}` : "");
      seenAuth.push(auth);
      const key = auth.replace("Bearer ", "");
      if (failingKeys.has(key)) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429, headers: { "content-type": "application/json" },
        });
      }
      if (_url.toString().includes("/responses")) {
        return new Response(JSON.stringify({
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture reply" }] }],
          usage: { input_tokens: 5000, output_tokens: 10, input_tokens_details: { cached_tokens: 4000 } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (_url.toString().includes("/messages")) {
        // The native Messages path consumes an Anthropic SSE stream.
        const sse = [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-test","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"usage":{"input_tokens":5000,"output_tokens":1,"cache_read_input_tokens":4000,"cache_creation_input_tokens":0}}}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
          'event: message_stop\ndata: {"type":"message_stop"}',
        ].join("\n\n") + "\n\n";
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 5000,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 4000, cache_write_tokens: 4000 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }, SERVER_BUDGET_MS);

  afterEach(async () => {
    const stopFailures: unknown[] = [];
    for (const server of trackedServers) {
      trackedServers.delete(server);
      try { await server.stop(true); } catch (error) { stopFailures.push(error); }
    }
    globalThis.fetch = REAL_FETCH;
    setProviderKeychainEntryFactoryForTests(null);
    clearKeyCooldowns();
    clearProviderCacheAffinityForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (testDir) removeTreeWithRetry(testDir);
    if (stopFailures.length > 0) throw new AggregateError(stopFailures, "tracked server stop failed in afterEach");
  }, SERVER_BUDGET_MS);

  test("a conversation stays on the credential that warmed its cache after the committed key moves", async () => {
    const config = makeConfig();
    const first = await turn(config, "conv-1");
    expect(seenAuth).toEqual(["Bearer key-a"]);
    expect(first.cacheAffinity).toBe("bound");

    // Another conversation (or an operator) moved the provider's committed key.
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    saveConfig(config);

    const second = await turn(config, "conv-1");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-a"]);
    expect(second.cacheAffinity).toBe("kept");
    expect(second.cacheAffinityReason).toBe("cache");

    // A different conversation is placed by ordinary selection: the moved key.
    await turn(config, "conv-2");
    expect(seenAuth.at(-1)).toBe("Bearer key-b");
  });

  test.each(["env", "keychain"])(
    "%s pool references survive affinity dispatch re-reads",
    async (kind) => {
      const previous = process.env.OCX_AFFINITY_TEST_KEY;
      process.env.OCX_AFFINITY_TEST_KEY = "key-a";
      setProviderKeychainEntryFactoryForTests((_service, account) => ({
        getPassword: () => (account.endsWith("/a") ? "key-a" : "key-b"),
        setPassword() {},
        deletePassword: () => true,
      }));
      try {
        const config = makeConfig();
        const pool = config.providers["affinity-e2e"]!;
        const a = kind === "env" ? "$OCX_AFFINITY_TEST_KEY" : "keychain:affinity-e2e/a";
        pool.apiKey = a;
        pool.apiKeyPool = [
          { id: "a", key: a },
          { id: "b", key: "key-b" },
        ];
        await turn(config, "referenced-conversation");
        pool.apiKey = "key-b";
        const second = await turn(config, "referenced-conversation");
        expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-a"]);
        expect(second.cacheAffinity).toBe("kept");
      } finally {
        if (previous === undefined) delete process.env.OCX_AFFINITY_TEST_KEY;
        else process.env.OCX_AFFINITY_TEST_KEY = previous;
      }
    },
  );

  test("combo turns retain the serving provider's key binding", async () => {
    const config = makeConfig();
    config.combos = {
      affinity: { strategy: "failover", targets: [{ provider: "affinity-e2e", model: "test" }] },
    };
    await turn(config, "combo-conversation", "combo/affinity");
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    const second = await turn(config, "combo-conversation", "combo/affinity");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-a"]);
    expect(second.provider).toBe("combo");
    expect(second.cacheAffinity).toBe("kept");
  });

  test.each(["responses", "chat", "messages", "compact", "combo"])(
    "a Hermes-only identity is log-only on %s",
    async (wire) => {
      const config = makeConfig();
      config.combos = {
        affinity: { strategy: "failover", targets: [{ provider: "affinity-e2e", model: "test" }] },
      };
      const send = async () => {
        saveConfig(config);
        const log: RequestLogContext = { model: "", provider: "" };
        const ids = { requestId: nextRequestLogId(), start: Date.now() };
        const headers = {
          "content-type": "application/json",
          "x-hermes-conversation-id": "hermes-only",
        };
        // The HTTP ingress fills this log slot before invoking these handlers.
        fillHermesLogConversationFallback(log, new Headers(headers));
        const req = new Request(`http://localhost/v1/${wire}`, {
          method: "POST",
          headers,
          body: JSON.stringify(
            wire === "responses" || wire === "compact" || wire === "combo"
              ? {
                  model:
                    wire === "combo"
                      ? "combo/affinity"
                      : `${wire === "compact" ? "affinity-compact" : "affinity-e2e"}/test`,
                  input: "hello",
                  stream: false,
                }
              : {
                  model: wire === "messages" ? "affinity-msg/claude-test" : "affinity-chat/test",
                  max_tokens: 16,
                  messages: [{ role: "user", content: "hello" }],
                },
          ),
        });
        const response =
          wire === "responses" || wire === "combo"
            ? await handleResponses(req, config, log, {})
            : wire === "compact"
              ? await handleResponsesCompact(req, config, log)
              : wire === "chat"
                ? await handleChatCompletions(req, config, log, ids)
                : await handleClaudeMessages(req, config, log, ids);
        expect(response.status).toBe(200);
        await response.text();
        if (wire === "responses" || wire === "compact" || wire === "combo")
          addFinalRequestLog(ids.requestId, ids.start, log, response.status);
        expect(log.conversationId).toBeDefined();
        expect(log.affinityLane).toBeUndefined();
        expect(log.cacheAffinity).toBeUndefined();
      };
      await send();
      for (const provider of Object.values(config.providers)) provider.apiKey = "key-b";
      await send();
      expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-b"]);
    },
  );

  test.each([499, 503])(
    "another request's cooldown does not release a binding on status %s",
    async (status) => {
      const config = makeConfig();
      const log = await turn(config, "unrelated-cooldown");
      setKeyCooldown("affinity-e2e", "a", Date.now() + 60_000);
      delete log.cacheAffinity;
      delete log.cacheAffinityReason;
      addFinalRequestLog(nextRequestLogId(), Date.now(), log, status);
      clearKeyCooldowns();
      expect(log.cacheAffinity).not.toBe("released");
      expect(
        consultProviderCacheAffinity({
          lane: sessionLaneIdFromRequest(new Headers({ "thread-id": "unrelated-cooldown" })),
          providerName: "affinity-e2e",
          provider: config.providers["affinity-e2e"]!,
          model: "test",
        })?.entryId,
      ).toBe("a");
    },
  );

  test.each(["chat", "messages"])("%s local send refusals preserve cache affinity", async (wire) => {
    const config = makeConfig();
    config.protocols = { rollout: { managedMessagesNative: true } };
    const providerName = wire === "chat" ? "affinity-chat" : "affinity-msg";
    const model = wire === "chat" ? "test" : "claude-test";
    const lane = sessionLaneIdFromRequest(new Headers({ "thread-id": "send-refusal" }));
    recordProviderCacheAffinity({ lane, providerName, entryId: "a", model, cacheWrite: 4000 });
    const fetch = globalThis.fetch;
    try {
      for (const error of [new RequestPacingQueueOverloadError(providerName, "queue_full", 1), new SendBudgetExhaustedError()]) {
        globalThis.fetch = (async () => { throw error; }) as typeof globalThis.fetch;
        const log: RequestLogContext = { model: "", provider: "" };
        const request = new Request(`http://localhost/v1/${wire}`, {
          method: "POST", headers: { "content-type": "application/json", "thread-id": "send-refusal" },
          body: JSON.stringify({ model: `${providerName}/${model}`, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
        });
        const ids = { requestId: nextRequestLogId(), start: Date.now() };
        const response = wire === "chat"
          ? await handleChatCompletions(request, config, log, ids)
          : await handleClaudeMessages(request, config, log, ids);
        expect(response.status).toBe(429);
        await response.text();
        expect(protocolTraceForRequest(log, log.attempts)?.mode).toBe("native");
        expect(log.terminalSource).toBe("synthetic");
        expect(consultProviderCacheAffinity({ lane, providerName, provider: config.providers[providerName]!, model })?.entryId).toBe("a");
      }
    } finally {
      globalThis.fetch = fetch;
    }
  });

  test.each([401, 402, 429, 400])("a synthetic %s preserves the healthy binding", async (status) => {
    const config = makeConfig();
    const log = await turn(config, "local-refusal");
    log.terminalSource = "synthetic";
    log.providerAdapter = "anthropic";
    log.upstreamError = "Your credit balance is too low to access the Anthropic API.";
    log.upstreamErrorType = "invalid_request_error";
    addFinalRequestLog(nextRequestLogId(), Date.now(), log, status);
    expect(log.cacheAffinity).not.toBe("released");
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    const next = await turn(config, "local-refusal");
    expect(next.cacheAffinity).toBe("kept");
    expect(seenAuth.at(-1)).toBe("Bearer key-a");
  });

  test.each([false, true])("HTTP 200 structured failure does not bind or replace affinity (bound=%s)", (bound) => {
    const lane = "structured-failure";
    if (bound) recordProviderCacheAffinity({ lane, providerName: "affinity-e2e", entryId: "a", model: "test", cacheWrite: 4000 });
    const log: RequestLogContext = {
      model: "test", provider: "affinity-e2e", affinityLane: lane,
      affinityKeyEntryId: "b", affinityProviderName: "affinity-e2e", cacheAffinityApplicable: true,
    };
    inspectResponseLogJson(log, JSON.stringify({
      status: "failed", error: { code: "request_send_budget_exhausted", message: "Local send budget exhausted" },
      usage: { input_tokens: 5000, output_tokens: 0 },
    }));
    expect(log.observedTerminalStatus).toBe("failed");
    addFinalRequestLog(nextRequestLogId(), Date.now(), log, 200);
    expect(boundEntryIdForLane(lane)).toBe(bound ? "a" : undefined);
    expect(log.cacheAffinity).toBeUndefined();
    // A completed structured turn still binds the serving entry.
    delete log.observedTerminalStatus;
    inspectResponseLogJson(log, JSON.stringify({ status: "completed" }));
    addFinalRequestLog(nextRequestLogId(), Date.now(), log, 200);
    expect(boundEntryIdForLane(lane)).toBe("b");
    expect(log.cacheAffinity).toBe("bound");
  });

  test.each(["compact-pacing-pick", "compact-pacing-send", "compact-budget", "adapter-initial", "adapter-recovery"])(
    "%s local refusal preserves affinity and carries synthetic attribution", async (kind) => {
      const config = makeConfig();
      const compact = kind.startsWith("compact");
      const providerName = compact ? "affinity-compact" : "affinity-e2e";
      const provider = config.providers[providerName]!;
      // Explicitly exercise native compact rather than the gateway summarizer fallback.
      if (compact) provider.supportsNativeCompactEndpoint = true;
      if (kind === "compact-pacing-pick") provider.requestPacing = { enabled: true, keySelection: "round-robin" };
      provider.retryOn429 = { attempts: 1, intervalMs: 1000, maxIntervalMs: 1000 };
      saveConfig(config);
      const lane = sessionLaneIdFromRequest(new Headers({ "thread-id": "local-responses-refusal" }));
      recordProviderCacheAffinity({ lane, providerName, entryId: "a", model: "test", cacheWrite: 4000 });
      if (kind === "compact-pacing-pick") {
        for (const entry of provider.apiKeyPool!) setKeyCooldown(providerName, entry.id, Date.now() + 60_000);
      }
      let sends = 0;
      globalThis.fetch = (async (input) => {
        sends++;
        if (compact) expect(String(input)).toBe("https://upstream.invalid/v1/responses/compact");
        if (kind === "adapter-recovery" && sends === 1) return Response.json({ error: { message: "rate limited" } }, {
          status: 429, headers: { "retry-after": "0" },
        });
        if (kind === "compact-pacing-send") throw new RequestPacingQueueOverloadError(providerName, "queue_full", 1);
        throw new SendBudgetExhaustedError();
      }) as typeof globalThis.fetch;
      const log: RequestLogContext = { model: "", provider: "" };
      const request = new Request(`http://localhost/v1/responses${compact ? "/compact" : ""}`, {
        method: "POST", headers: { "content-type": "application/json", "thread-id": "local-responses-refusal" },
        body: JSON.stringify({ model: `${providerName}/test`, input: "hello", stream: false, store: false }),
      });
      const response = compact ? await handleResponsesCompact(request, config, log) : await handleResponses(request, config, log, {});
      expect(response.status).toBe(429);
      await response.text();
      addFinalRequestLog(nextRequestLogId(), Date.now(), log, response.status);
      // Inspect the actual binding before attribution, so release defects fail visibly too.
      expect(boundEntryIdForLane(lane)).toBe("a");
      expect(log.cacheAffinity).not.toBe("released");
      expect(log.terminalSource).toBe("synthetic");
      expect(sends).toBe(kind === "compact-pacing-pick" ? 0 : kind === "adapter-recovery" ? 2 : 1);
    },
  );

  test.each(["provider", "entry"])("a refusal from another %s preserves the healthy binding", async (identity) => {
    const config = makeConfig();
    const log = await turn(config, "other-credential-refusal");
    if (identity === "provider") log.affinityProviderName = "affinity-chat";
    else log.affinityKeyEntryId = "b";
    addFinalRequestLog(nextRequestLogId(), Date.now(), log, 429);
    expect(log.cacheAffinity).toBe("bound");
    expect(log.cacheAffinityReason).toBe("new");
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    const next = await turn(config, "other-credential-refusal");
    expect(next.cacheAffinity).toBe("kept");
    expect(seenAuth.at(-1)).toBe("Bearer key-a");
  });

  test.each([401, 402, 429])("a real %s releases the serving credential even with a quota error code", async (status) => {
    const config = makeConfig();
    const log = await turn(config, "real-refusal");
    log.errorCode = "usage_limit_reached";
    addFinalRequestLog(nextRequestLogId(), Date.now(), log, status);
    expect(log.cacheAffinity).toBe("released");
    expect(consultProviderCacheAffinity({
      lane: log.affinityLane, providerName: "affinity-e2e",
      provider: config.providers["affinity-e2e"]!, model: "test",
    })).toBeNull();
  });

  test("an exact Anthropic credit refusal releases its binding without a shared cooldown", async () => {
    const config = makeConfig();
    const log = await turn(config, "billing-refusal");
    log.providerAdapter = "anthropic";
    log.upstreamError = "Your credit balance is too low to access the Anthropic API.";
    log.upstreamErrorType = "invalid_request_error";
    addFinalRequestLog(nextRequestLogId(), Date.now(), log, 400);
    expect(log.cacheAffinity).toBe("released");
    expect(log.cacheAffinityReason).toBe("quota");
    expect(
      consultProviderCacheAffinity({
        lane: log.affinityLane,
        providerName: "affinity-e2e",
        provider: config.providers["affinity-e2e"]!,
        model: "test",
      }),
    ).toBeNull();
  });

  test("provider POST preserves an omitted cache-affinity mode but accepts an explicit replacement", async () => {
    const config = makeConfig();
    config.providers["affinity-chat"]!.cacheAffinity = "off";
    config.providers["affinity-chat"]!.baseUrl = "http://127.0.0.1:11434/v1";
    config.providers["affinity-chat"]!.allowPrivateNetwork = true;
    saveConfig(config);
    const url = new URL("http://localhost/api/providers");
    for (const mode of [undefined, "session"] as const) {
      const response = await handleManagementAPI(
        new ManagementRequest(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "affinity-chat",
            provider: {
              adapter: "openai-chat",
              authMode: "key",
              baseUrl: "http://127.0.0.1:11434/v1",
              allowPrivateNetwork: true,
              liveModels: false,
              models: ["test"],
              ...(mode ? { cacheAffinity: mode } : {}),
            },
          }),
        }),
        url,
        config,
      );
      expect(response?.status).toBe(200);
      expect(loadConfig().providers["affinity-chat"]!.cacheAffinity).toBe(mode ?? "off");
    }
  });
  test("a 429 on the bound key rotates, and the conversation rebinds to the spare", async () => {
    const config = makeConfig();
    await turn(config, "conv-1");
    expect(seenAuth).toEqual(["Bearer key-a"]);

    failingKeys.add("key-a");
    const rotated = await turn(config, "conv-1");
    expect(seenAuth.at(-1)).toBe("Bearer key-b");
    expect(rotated.cacheAffinity).toBe("bound");

    failingKeys.clear();
    const third = await turn(config, "conv-1");
    expect(seenAuth.at(-1)).toBe("Bearer key-b");
    expect(third.cacheAffinity).toBe("kept");
  });

  test("when every key fails, the cooled binding survives scoped release and the next turn rebinds", async () => {
    const config = makeConfig();
    await turn(config, "conv-1");
    failingKeys.add("key-a");
    failingKeys.add("key-b");
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "conv-1" },
      body: JSON.stringify({ model: "affinity-e2e/test", input: "hello", stream: false, store: false }),
    }), config, logCtx, {});
    await response.text();
    addFinalRequestLog(nextRequestLogId(), Date.now(), logCtx, response.status);
    expect(response.status).toBe(429);
    expect(logCtx.cacheAffinity).toBe("kept");
    expect(consultProviderCacheAffinity({
      lane: logCtx.affinityLane, providerName: "affinity-e2e",
      provider: config.providers["affinity-e2e"]!, model: "test",
    })?.entryId).toBe("a");

    failingKeys.clear();
    seenAuth.length = 0;
    const fresh = await turn(config, "conv-1");
    // The failed turn's rotation committed key-b, so fresh placement starts
    // there; the cooled binding does not drag the conversation back to a.
    expect(seenAuth[0]).toBe("Bearer key-b");
    expect(fresh.cacheAffinity).toBe("bound");
  });

  test("cacheAffinity off restores plain committed-key behavior", async () => {
    const config = makeConfig();
    config.providers["affinity-e2e"]!.cacheAffinity = "off";
    await turn(config, "conv-1");
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    await turn(config, "conv-1");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-b"]);
    // Requests made while off must not leave a latent binding to key-a.
    config.providers["affinity-e2e"]!.cacheAffinity = "auto";
    const enabled = await turn(config, "conv-1");
    expect(seenAuth.at(-1)).toBe("Bearer key-b");
    expect(enabled.cacheAffinity).toBe("bound");
  });

  describe("lane wiring on the chat and messages paths", () => {
    test("chat completions: the second turn of a conversation stays on its key", async () => {
      const config = makeConfig();
      const turn = async (): Promise<RequestLogContext> => {
        const logCtx: RequestLogContext = { model: "", provider: "" };
        const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", "thread-id": "chat-conv-1" },
          body: JSON.stringify({ model: "affinity-chat/test", messages: [{ role: "user", content: "hi" }] }),
        }), config, logCtx, { requestId: nextRequestLogId(), start: Date.now() });
        expect(response.status).toBe(200);
        await response.text();
        return logCtx;
      };
      const first = await turn();
      expect(seenAuth).toEqual(["Bearer key-a"]);
      expect(first.cacheAffinity).toBe("bound");
      config.providers["affinity-chat"]!.apiKey = "key-b";
      saveConfig(config);
      const second = await turn();
      expect(seenAuth.at(-1)).toBe("Bearer key-a");
      expect(second.cacheAffinity).toBe("kept");
    });

    test("responses compact: the second turn of a conversation stays on its key", async () => {
      const config = makeConfig();
      const turn = async (): Promise<RequestLogContext> => {
        saveConfig(config);
        const logCtx: RequestLogContext = { model: "", provider: "" };
        const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
          method: "POST",
          headers: { "content-type": "application/json", "thread-id": "compact-conv-1" },
          body: JSON.stringify({
            model: "affinity-compact/test",
            input: [{ role: "user", content: "fixture question" }],
            stream: false,
          }),
        }), config, logCtx);
        expect(response.status).toBe(200);
        await response.text();
        addFinalRequestLog(nextRequestLogId(), Date.now(), logCtx, response.status);
        return logCtx;
      };
      const first = await turn();
      expect(seenAuth).toEqual(["Bearer key-a"]);
      expect(first.cacheAffinity).toBe("bound");
      config.providers["affinity-compact"]!.apiKey = "key-b";
      saveConfig(config);
      const second = await turn();
      expect(seenAuth.at(-1)).toBe("Bearer key-a");
      expect(second.cacheAffinity).toBe("kept");
    });

    test("claude messages: the second turn of a conversation stays on its key", async () => {
      const config = makeConfig();
      const turn = async (): Promise<RequestLogContext> => {
        const logCtx: RequestLogContext = { model: "", provider: "" };
        const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "session_id": "msg-conv-1" },
          body: JSON.stringify({
            model: "affinity-msg/claude-test", max_tokens: 16,
            messages: [{ role: "user", content: "hi" }],
          }),
        }), config, logCtx, { requestId: nextRequestLogId(), start: Date.now() });
        expect(response.status).toBe(200);
        await response.text();
        return logCtx;
      };
      const first = await turn();
      expect(seenAuth).toEqual(["Bearer key-a"]);
      expect(first.cacheAffinity).toBe("bound");
      config.providers["affinity-msg"]!.apiKey = "key-b";
      saveConfig(config);
      const second = await turn();
      expect(seenAuth.at(-1)).toBe("Bearer key-a");
      expect(second.cacheAffinity).toBe("kept");
    });
  });
});
