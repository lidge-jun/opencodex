import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { startServer } from "../../src/server";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { loadConfig, saveConfig } from "../../src/config";
import { addFinalRequestLog, inspectResponseLogJson, nextRequestLogId, type RequestLogContext } from "../../src/server/request-log";
import { boundEntryIdForLane, clearProviderCacheAffinityForTests, reconcileProviderCacheAffinity, recordProviderCacheAffinity as recordAffinity } from "../../src/providers/cache-affinity";
import { capturedCacheAffinityIdentity, currentCacheAffinityIdentity } from "../../src/providers/cache-affinity-identity";
import { routedProviderConfig } from "../../src/providers/routed-config";
import { stampApiKeyAccountLabel } from "../../src/providers/label";
import { RequestPacingQueueOverloadError } from "../../src/providers/request-pacing";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { protocolTraceForRequest } from "../../src/protocols/trace";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/key-store";
import { invalidateResolvedProviderKeyCache } from "../../src/providers/api-key-resolve";
import { setKeyCooldown } from "../../src/providers/api-key-cooldowns";
import { consultProviderCacheAffinity } from "../../src/providers/cache-affinity";
import {
  fillHermesLogConversationFallback,
  sessionLaneIdFromRequest,
} from "../../src/server/request-log-conversation";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import { resolveDataPlaneAdmissionSecret, type DataPlaneAdmission } from "../../src/server/auth-cors";

const REAL_FETCH = globalThis.fetch;
let testDir = "";
let previousHome: string | undefined;
const seenAuth: string[] = [];
const failingKeys = new Set<string>();
// Direct handler calls need the spend-ledger ownership startServer acquires.
const trackedServers = new Set<ReturnType<typeof startServer>>();

function recordProviderCacheAffinity(input: Omit<Parameters<typeof recordAffinity>[0], "identity">) {
  recordAffinity({ ...input, identity: currentCacheAffinityIdentity(input.providerName, loadConfig().providers[input.providerName], input.entryId ?? "") });
}

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
  admission?: DataPlaneAdmission,
  finalize = true,
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
    { admission },
  );
  expect(response.status).toBe(200);
  await response.text();
  // The ingress layer owns finalization in production; this harness stands in for it.
  if (finalize) addFinalRequestLog(nextRequestLogId(), Date.now(), logCtx, response.status);
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

  test("different authenticated principals cannot share a client-supplied lane", async () => {
    const config = makeConfig();
    config.apiKeys = [
      { id: "client-a", name: "A", createdAt: "2026-01-01", key: "synthetic-client-a" },
      { id: "client-b", name: "B", createdAt: "2026-01-01", key: "synthetic-client-b" },
    ];
    const a = resolveDataPlaneAdmissionSecret("synthetic-client-a", config)!;
    const b = resolveDataPlaneAdmissionSecret("synthetic-client-b", config)!;
    await turn(config, "shared-thread", undefined, a);
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    await turn(config, "shared-thread", undefined, b);
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-b"]);
  });

  test.each(["responses", "compact", "chat", "messages", "combo", "chat-combo", "messages-combo"])(
    "%s scopes cache affinity to the admitted caller", async (wire) => {
      const config = makeConfig();
      config.apiKeys = [
        { id: "client-a", name: "A", createdAt: "2026-01-01", key: "synthetic-client-a" },
        { id: "client-b", name: "B", createdAt: "2026-01-01", key: "synthetic-client-b" },
      ];
      config.protocols = { rollout: { nativeChatCombos: true, managedMessagesNative: true } };
      const provider = wire.includes("messages") ? "affinity-msg" : wire.includes("chat") ? "affinity-chat"
        : wire === "compact" ? "affinity-compact" : "affinity-e2e";
      const model = wire === "messages-combo" ? "claude-sonnet-4-6" : wire.includes("messages") ? "claude-test" : "test";
      if (wire === "messages-combo") {
        config.providers[provider]!.baseUrl = "https://api.anthropic.com";
        config.providers[provider]!.models = [model];
      }
      config.combos = { affinity: { strategy: "failover", reasoningEffortMode: "strict", targets: [{ provider, model }] } };
      const a = resolveDataPlaneAdmissionSecret("synthetic-client-a", config, "bearer")!;
      const aDedicated = resolveDataPlaneAdmissionSecret("synthetic-client-a", config, "dedicated")!;
      const b = resolveDataPlaneAdmissionSecret("synthetic-client-b", config)!;
      const send = async (admission: DataPlaneAdmission) => {
        saveConfig(config);
        const log: RequestLogContext = { model: "", provider: "" };
        const ids = { requestId: nextRequestLogId(), start: Date.now(), admission };
        const req = new Request("http://localhost/v1/test", {
          method: "POST", headers: { "content-type": "application/json", "thread-id": "shared-thread" },
          body: JSON.stringify({ model: wire.includes("combo") ? "combo/affinity" : `${provider}/${model}`,
            input: "hello", max_tokens: 16, messages: [{ role: "user", content: "hello" }], stream: false }),
        });
        const response = wire === "compact" ? await handleResponsesCompact(req, config, log, undefined, admission)
          : wire.includes("chat") ? await handleChatCompletions(req, config, log, ids)
          : wire.includes("messages") ? await handleClaudeMessages(req, config, log, ids)
          : await handleResponses(req, config, log, { admission });
        expect(response.status).toBe(200);
        await response.text();
        if (wire.includes("chat") || wire.includes("messages")) expect(protocolTraceForRequest(log, log.attempts)?.mode).toBe("native");
        if (!wire.includes("chat") && !wire.includes("messages")) addFinalRequestLog(ids.requestId, ids.start, log, response.status);
        return log;
      };
      const first = await send(a);
      expect(first.cacheAffinity).toBe("bound");
      config.providers[provider]!.apiKey = "key-b";
      const same = await send(aDedicated);
      expect(same.cacheAffinity).toBe("kept");
      const other = await send(b);
      expect(other.cacheAffinity).toBe("bound");
      expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-a", "Bearer key-b"]);
      expect(first.affinityLane).not.toBe(other.affinityLane);
      expect(first.affinityLane).not.toContain("synthetic-client-a");
    },
  );

  test("loopback credentials and an authenticated admission without a principal cannot borrow a lane", async () => {
    const config = makeConfig();
    config.apiKeys = [{ id: "client-a", name: "A", createdAt: "2026-01-01", key: "synthetic-client-a" }];
    const { affinityLaneFromRequest } = await import("../../src/server/request-log-conversation");
    const headers = { "thread-id": "shared-thread", "x-opencodex-api-key": "synthetic-client-a" };
    const req = new Request("http://localhost/", { headers });
    const slot = {};
    const loopback = { kind: "loopback", source: "loopback" } as const;
    const admitted = resolveDataPlaneAdmissionSecret("synthetic-client-a", config)!;
    const namedLane = affinityLaneFromRequest(req, slot, config, admitted);
    expect(affinityLaneFromRequest(req, slot, config, loopback)).toBe(namedLane);
    expect(affinityLaneFromRequest(new Request("http://localhost/", { headers: { "thread-id": "shared-thread" } }), slot, config, loopback)).not.toBe(namedLane);
    expect(affinityLaneFromRequest(req, slot, config, { kind: "configured", keyId: "client-a", source: "bearer" })).toBeUndefined();
    config.apiKeys[0]!.key = "synthetic-client-rotated";
    const rotated = resolveDataPlaneAdmissionSecret("synthetic-client-rotated", config)!;
    expect(affinityLaneFromRequest(req, slot, config, rotated)).not.toBe(namedLane);
  });

  test("HTTP ingress scopes voluntary loopback credentials", async () => {
    const config = makeConfig();
    config.apiKeys = [
      { id: "client-a", name: "A", createdAt: "2026-01-01", key: "synthetic-client-a" },
      { id: "client-b", name: "B", createdAt: "2026-01-01", key: "synthetic-client-b" },
    ];
    saveConfig(config);
    const server = startServer(0);
    trackedServers.add(server);
    const send = async (key: string) => {
      const response = await REAL_FETCH(`http://127.0.0.1:${server.port}/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json", "thread-id": "shared-http", "x-opencodex-api-key": key },
        body: JSON.stringify({ model: "affinity-e2e/test", input: "hello", stream: false }),
      });
      expect(response.status).toBe(200);
      await response.text();
    };
    await send("synthetic-client-a");
    await send("synthetic-client-a");
    const { affinityLaneFromRequest } = await import("../../src/server/request-log-conversation");
    const req = new Request("http://localhost/", { headers: { "thread-id": "shared-http" } });
    const admission = resolveDataPlaneAdmissionSecret("synthetic-client-b", config)!;
    const lane = affinityLaneFromRequest(req, {}, config, admission)!;
    recordProviderCacheAffinity({ lane, providerName: "affinity-e2e", entryId: "b", model: "test", cacheWrite: 4000 });
    await send("synthetic-client-b");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-a", "Bearer key-b"]);
  });

  test.each(["chat", "messages"])("%s translated combo retains the loopback caller scope", async (wire) => {
    const config = makeConfig();
    const mockFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      await mockFetch(input, init);
      const chunks = [
        { id: "fixture", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
        { id: "fixture", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4000 } } },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    config.apiKeys = [
      { id: "client-a", name: "A", createdAt: "2026-01-01", key: "synthetic-client-a" },
      { id: "client-b", name: "B", createdAt: "2026-01-01", key: "synthetic-client-b" },
    ];
    config.combos = { affinity: { strategy: "failover", targets: [{ provider: "affinity-e2e", model: "test" }] } };
    const send = async (key: string) => {
      saveConfig(config);
      const log: RequestLogContext = { model: "", provider: "" };
      const req = new Request("http://localhost/v1/test", {
        method: "POST", headers: { "content-type": "application/json", "thread-id": "shared-loopback", "x-opencodex-api-key": key },
        body: JSON.stringify({ model: "combo/affinity", max_tokens: 16, stream: false, messages: [{ role: "user", content: "hello" }] }),
      });
      const ids = { requestId: nextRequestLogId(), start: Date.now(), admission: { kind: "loopback", source: "loopback" } as const };
      const response = wire === "chat" ? await handleChatCompletions(req, config, log, ids) : await handleClaudeMessages(req, config, log, ids);
      expect(response.status).toBe(200);
      await response.text();
      expect(protocolTraceForRequest(log, log.attempts)?.mode).toBe("legacy-bridge");
    };
    await send("synthetic-client-a");
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    await send("synthetic-client-a");
    await send("synthetic-client-b");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-a", "Bearer key-b"]);
  });

  test("a replacement credential under the same entry id cannot inherit cache evidence", async () => {
    const config = makeConfig();
    await turn(config, "replacement-thread");
    config.providers["affinity-e2e"]!.apiKeyPool![0]!.key = "replacement-key";
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    await turn(config, "replacement-thread");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-b"]);
  });

  test("an old in-flight success cannot bind a replaced credential", async () => {
    const config = makeConfig();
    const oldAttempt = await turn(config, "in-flight-thread", undefined, undefined, false);
    config.providers["affinity-e2e"]!.apiKeyPool![0]!.key = "replacement-key";
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    saveConfig(config);
    addFinalRequestLog(nextRequestLogId(), Date.now(), oldAttempt, 200);
    await turn(config, "in-flight-thread");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-b"]);
  });

  test("principal lanes survive replacement and disable while an old success completes", async () => {
    const config = makeConfig();
    config.apiKeys = [
      { id: "client-a", name: "A", createdAt: "2026-01-01", key: "synthetic-client-a" },
      { id: "client-b", name: "B", createdAt: "2026-01-01", key: "synthetic-client-b" },
    ];
    const a = resolveDataPlaneAdmissionSecret("synthetic-client-a", config)!;
    const b = resolveDataPlaneAdmissionSecret("synthetic-client-b", config)!;
    const old = await turn(config, "shared-replacement", undefined, a, false);
    const provider = config.providers["affinity-e2e"]!;
    provider.apiKey = "key-b";
    const other = await turn(config, "shared-replacement", undefined, b);
    provider.apiKeyPool![0]!.key = "replacement-key";
    provider.apiKeyPool![0]!.disabled = true;
    saveConfig(config);
    addFinalRequestLog(nextRequestLogId(), Date.now(), old, 200);
    const first = await turn(config, "shared-replacement", undefined, a);
    const again = await turn(config, "shared-replacement", undefined, b);
    expect(first.affinityLane).not.toBe(other.affinityLane);
    expect(first.cacheAffinity).toBe("bound");
    expect(again.cacheAffinity).toBe("kept");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-b", "Bearer key-b", "Bearer key-b"]);
  });

  test("destination replacement discards old evidence and fences old success", async () => {
    const config = makeConfig();
    await turn(config, "destination-bound");
    const old = await turn(config, "destination-flight", undefined, undefined, false);
    config.providers["affinity-e2e"]!.baseUrl = "https://other.invalid/v1";
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    saveConfig(config);
    addFinalRequestLog(nextRequestLogId(), Date.now(), old, 200);
    await turn(config, "destination-bound");
    await turn(config, "destination-flight");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-a", "Bearer key-b", "Bearer key-b"]);
  });

  test.each([200, 401, 429])("old %s completion cannot replace or release newer credential binding", async status => {
    const config = makeConfig();
    const old = await turn(config, "newer-binding", undefined, undefined, false);
    const provider = config.providers["affinity-e2e"]!;
    provider.apiKeyPool![0]!.key = "replacement-key";
    provider.apiKey = "replacement-key";
    await turn(config, "newer-binding");
    addFinalRequestLog(nextRequestLogId(), Date.now(), old, status);
    provider.apiKey = "key-b";
    await turn(config, "newer-binding");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer replacement-key", "Bearer replacement-key"]);
  });

  test("unchanged in-flight credential binds despite committed selection movement", async () => {
    const config = makeConfig();
    const old = await turn(config, "unchanged-flight", undefined, undefined, false);
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    saveConfig(config);
    addFinalRequestLog(nextRequestLogId(), Date.now(), old, 200);
    await turn(config, "unchanged-flight");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-a"]);
  });

  test("reconciled credential change and reversion fences an old in-flight success", async () => {
    const config = makeConfig();
    const old = await turn(config, "reverted-flight", undefined, undefined, false);
    const identity = capturedCacheAffinityIdentity(old);
    expect(identity).toBeDefined();
    expect(JSON.stringify(old)).not.toContain(identity!);
    const provider = config.providers["affinity-e2e"]!;
    const context = { generation: 1, providerNames: new Set(Object.keys(config.providers)), comboIds: new Set<string>(),
      comboTargets: new Set<string>(), codexAccountIds: new Set<string>(), oauthAccountKeys: new Set<string>(), configRoots: new Set<string>() };
    provider.apiKeyPool![0]!.key = "replacement-key";
    reconcileProviderCacheAffinity(context, config.providers);
    provider.apiKeyPool![0]!.key = "key-a";
    provider.apiKey = "key-b";
    reconcileProviderCacheAffinity({ ...context, generation: 2 }, config.providers);
    saveConfig(config);
    addFinalRequestLog(nextRequestLogId(), Date.now(), old, 200);
    await turn(config, "reverted-flight");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-b"]);
  });

  test.each([200, 401, 429])("old affinity-selected %s completion preserves a newer binding after reversion", async status => {
    const config = makeConfig();
    await turn(config, "reverted-affinity-flight");
    const old = await turn(config, "reverted-affinity-flight", undefined, undefined, false);
    expect(old.cacheAffinity).toBe("kept");
    const provider = config.providers["affinity-e2e"]!;
    const context = { generation: 1, providerNames: new Set(Object.keys(config.providers)), comboIds: new Set<string>(),
      comboTargets: new Set<string>(), codexAccountIds: new Set<string>(), oauthAccountKeys: new Set<string>(), configRoots: new Set<string>() };
    provider.apiKeyPool![0]!.key = "replacement-key";
    reconcileProviderCacheAffinity(context, config.providers);
    provider.apiKeyPool![0]!.key = "key-a";
    provider.apiKey = "key-b";
    reconcileProviderCacheAffinity({ ...context, generation: 2 }, config.providers);
    await turn(config, "reverted-affinity-flight");
    addFinalRequestLog(nextRequestLogId(), Date.now(), old, status);
    await turn(config, "reverted-affinity-flight");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-a", "Bearer key-b", "Bearer key-b"]);
  });

  test("stale affinity failure cannot trigger a paced same-key retry", async () => {
    const config = makeConfig();
    const provider = config.providers["affinity-e2e"]!;
    provider.requestPacing = { enabled: true, keySelection: "round-robin" };
    provider.retryOn429 = { attempts: 1, intervalMs: 1000, maxIntervalMs: 1000 };
    await turn(config, "stale-retry");
    let sends = 0;
    globalThis.fetch = (async () => {
      sends++;
      const context = { generation: 1, providerNames: new Set(Object.keys(config.providers)), comboIds: new Set<string>(),
        comboTargets: new Set<string>(), codexAccountIds: new Set<string>(), oauthAccountKeys: new Set<string>(), configRoots: new Set<string>() };
      provider.apiKeyPool![0]!.key = "replacement-key";
      reconcileProviderCacheAffinity(context, config.providers);
      provider.apiKeyPool![0]!.key = "key-a";
      provider.apiKey = "key-b";
      reconcileProviderCacheAffinity({ ...context, generation: 2 }, config.providers);
      saveConfig(config);
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } });
    }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "thread-id": "stale-retry" },
      body: JSON.stringify({ model: "affinity-e2e/test", input: "hello", stream: false, store: false }),
    }), config, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(429);
    expect(sends).toBe(1);
  });

  test("a stale affinity selection cannot send again inside a turn", async () => {
    const config = makeConfig();
    await turn(config, "stale-inner-send");
    const provider = config.providers["affinity-e2e"]!;
    let sends = 0;
    globalThis.fetch = (async () => { sends++; return new Response("ok"); }) as typeof fetch;
    const create = ADAPTER_REGISTRY["openai-chat"].create;
    const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({
      ...create(...args),
      async runTurn(_parsed, incoming, emit) {
        expect(args[0]._apiKeyAttempt?.cacheAffinity).toBe(true);
        await (await incoming.providerFetch!("https://upstream.invalid/v1/messages", { method: "POST" })).text();
        const context = { generation: 1, providerNames: new Set(Object.keys(config.providers)), comboIds: new Set<string>(),
          comboTargets: new Set<string>(), codexAccountIds: new Set<string>(), oauthAccountKeys: new Set<string>(), configRoots: new Set<string>() };
        provider.apiKeyPool![0]!.key = "replacement-key";
        reconcileProviderCacheAffinity(context, config.providers);
        provider.apiKeyPool![0]!.key = "key-a";
        reconcileProviderCacheAffinity({ ...context, generation: 2 }, config.providers);
        await expect(incoming.providerFetch!("https://upstream.invalid/v1/messages", { method: "POST" })).rejects.toThrow("unavailable during the turn");
        emit({ type: "text_delta", text: "ok" }); emit({ type: "done" });
      },
    }));
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json", "thread-id": "stale-inner-send" },
        body: JSON.stringify({ model: "affinity-e2e/test", input: "hello", stream: false, store: false }),
      }), config, { model: "", provider: "" });
      await response.text();
      expect(sends).toBe(1);
    } finally { override.mockRestore(); }
  });

  test("changed resolved environment credential does not inherit evidence", async () => {
    const previous = process.env.OCX_AFFINITY_TEST_KEY;
    try {
      process.env.OCX_AFFINITY_TEST_KEY = "key-a";
      const config = makeConfig();
      const provider = config.providers["affinity-e2e"]!;
      provider.apiKeyPool![0]!.key = "$OCX_AFFINITY_TEST_KEY";
      provider.apiKey = "$OCX_AFFINITY_TEST_KEY";
      await turn(config, "env-change");
      process.env.OCX_AFFINITY_TEST_KEY = "replacement-key";
      provider.apiKey = "key-b";
      await turn(config, "env-change");
      expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-b"]);
    } finally {
      if (previous === undefined) delete process.env.OCX_AFFINITY_TEST_KEY;
      else process.env.OCX_AFFINITY_TEST_KEY = previous;
    }
  });

  test("changed resolved keychain credential does not inherit evidence", async () => {
    let credential = "key-a";
    setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => credential, setPassword() {}, deletePassword: () => true }));
    const config = makeConfig();
    const provider = config.providers["affinity-e2e"]!;
    provider.apiKeyPool![0]!.key = "keychain:affinity-e2e/a";
    provider.apiKey = "keychain:affinity-e2e/a";
    await turn(config, "keychain-change");
    credential = "replacement-key";
    invalidateResolvedProviderKeyCache();
    provider.apiKey = "key-b";
    await turn(config, "keychain-change");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-b"]);
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

  test.each(["budget", "pacing"])("passthrough retry %s refusal preserves the binding", async kind => {
    const config = makeConfig();
    const providerName = "affinity-compact";
    const provider = config.providers[providerName]!;
    provider.transientRetryOn5xx = { enabled: true, attempts: 2 };
    saveConfig(config);
    const lane = sessionLaneIdFromRequest(new Headers({ "thread-id": "passthrough-refusal" }));
    recordProviderCacheAffinity({ lane, providerName, entryId: "a", model: "test", cacheWrite: 4000 });
    let sends = 0;
    globalThis.fetch = (async () => {
      if (++sends === 1) return Response.json({ error: { message: "temporary" } }, { status: 503, headers: { "retry-after": "0" } });
      throw kind === "budget" ? new SendBudgetExhaustedError() : new RequestPacingQueueOverloadError(providerName, "queue_full", 1);
    }) as typeof globalThis.fetch;
    const log: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "thread-id": "passthrough-refusal" },
      body: JSON.stringify({ model: `${providerName}/test`, input: "hello", stream: false, store: false }),
    }), config, log, {});
    expect(response.status).toBe(429);
    await response.text();
    expect(sends).toBe(2);
    expect(log.affinityKeyEntryId).toBe("a");
    addFinalRequestLog(nextRequestLogId(), Date.now(), log, response.status);
    expect(boundEntryIdForLane(lane)).toBe("a");
    expect(log.terminalSource).toBe("synthetic");
    expect(log.cacheAffinity).not.toBe("released");
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
    const config = makeConfig();
    const lane = "structured-failure";
    if (bound) recordProviderCacheAffinity({ lane, providerName: "affinity-e2e", entryId: "a", model: "test", cacheWrite: 4000 });
    const log: RequestLogContext = {
      model: "test", provider: "affinity-e2e", affinityLane: lane,
      affinityKeyEntryId: "b", affinityProviderName: "affinity-e2e", cacheAffinityApplicable: true,
    };
    stampApiKeyAccountLabel(log, "affinity-e2e", routedProviderConfig("affinity-e2e", { ...config.providers["affinity-e2e"]!, apiKey: "key-b" }));
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
