import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKeyAccountLogLabel } from "../../src/codex/account-label";
import { readUsageEntries, resetUsageReadCacheForTests } from "../../src/usage/log";
import { loadConfig, saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { clearKeyCooldowns, getKeyCooldownUntil, rotateKeyOn429 } from "../../src/providers/key-failover";
import { deriveXaiConvId } from "../../src/providers/xai-transport";
import {
  clearReasoningReplayCacheForTests,
  reasoningReplayDestinationIdentity,
  reasoningReplayKeyCredentialIdentity,
} from "../../src/responses/reasoning-replay-cache";
import {
  bridgeSearchReplayScope,
  clearBridgeSearchReplayCacheForTests,
  rememberBridgeSearchReplay,
} from "../../src/responses/bridge-search-replay-cache";
import { startServer } from "../../src/server";
import { handleResponses } from "../../src/server/responses";
import type { AdapterEvent, OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { managementFetch } from "../helpers/management-auth";
import { resolveContextPrincipal } from "../../src/server/auth-cors";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, setProviderRequestPacingRuntimeForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import { providerApiKeySelectionIsCurrent, resolveCurrentProviderApiKeyTransport, commitProviderApiKeySelection } from "../../src/providers/api-key-selection";
import { routedProviderConfig } from "../../src/router";
import type { OcxProviderTransport } from "../../src/providers/xai-transport";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;

// A test that hangs until Bun's per-test timeout never runs its own `finally`, so a server
// started here would outlive the test still holding the process-wide spend-ledger lease — every
// later file in the same process then fails to start its own server. Track them for the sweep.
const trackedServers = new Set<ReturnType<typeof startServer>>();
// Same reason for fetch: several cases stub it and restore it only in their own `finally`.
const REAL_FETCH = globalThis.fetch;

function startTrackedServer(port = 0): ReturnType<typeof startServer> {
  const server = startServer(port);
  trackedServers.add(server);
  return server;
}

beforeEach(() => {
  // Do not inherit a pacing runtime swapped in by an earlier file or an earlier timed-out test.
  resetProviderRequestPacingForTest();
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-keyfail-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-keyfail-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearKeyCooldowns();
  clearReasoningReplayCacheForTests();
  clearBridgeSearchReplayCacheForTests();
});

afterEach(async () => {
  // Reap before anything else: a server that survives this file keeps the spend-ledger lease.
  // Every stop is attempted even when an earlier one rejects, and the failure is raised only
  // after the rest of this cleanup has run. Re-stopping a server a test already stopped is safe.
  const stopFailures: unknown[] = [];
  for (const server of trackedServers) {
    trackedServers.delete(server);
    try { await server.stop(true); } catch (error) { stopFailures.push(error); }
  }
  resetProviderRequestPacingForTest();
  globalThis.fetch = REAL_FETCH;
  await upstream?.stop(true);
  upstream = null;
  await flushNativeMainStartupReleases();
  await flushConfigDirHardeningForTests();
  // Caller-facing ACL deadlines do not prove that their child released this home.
  if (testDir) await flushWindowsSecretAclReapsBeforeRemoval(testDir);
  if (isolatedCodexHome) await flushWindowsSecretAclReapsBeforeRemoval(isolatedCodexHome.path);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
  clearKeyCooldowns();
  clearReasoningReplayCacheForTests();
  clearBridgeSearchReplayCacheForTests();
  if (stopFailures.length > 0) throw new AggregateError(stopFailures, "tracked server stop failed in afterEach");
});

describe("server 429 key failover (end-to-end)", () => {
  test("physical key selection rejects disabled, removed, and changed-auth providers", () => {
    const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "key", apiKey: "synthetic-first" } as const;
    const config = { providers: { current: { ...provider } } } as unknown as OcxConfig;
    const routed = routedProviderConfig("current", config.providers.current);
    expect(providerApiKeySelectionIsCurrent(config, "current", routed)).toBe(true);
    // A model-level wire override does not change which key was selected.
    expect(providerApiKeySelectionIsCurrent(config, "current", { ...routed, adapter: "openai-responses" })).toBe(true);
    for (const replacement of [{ ...provider, disabled: true }, { ...provider, authMode: "oauth" }, { ...provider, apiKey: undefined }]) {
      config.providers.current = replacement as OcxConfig["providers"][string];
      expect(providerApiKeySelectionIsCurrent(config, "current", routed)).toBe(false);
      expect(resolveCurrentProviderApiKeyTransport(config, "current", routed)).toBeNull();
    }
    delete config.providers.current;
    expect(providerApiKeySelectionIsCurrent(config, "current", routed)).toBe(false);
    expect(resolveCurrentProviderApiKeyTransport(config, "current", routed)).toBeNull();
  });

  test("physical transport refresh keeps its executor and affinity but takes current static headers", () => {
    const config = { providers: { current: {
      adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "key", apiKey: "synthetic-first",
      headers: { "x-old-static": "old" }, apiKeySelectionRevision: "first-revision",
    } } } as unknown as OcxConfig;
    const executor = (async () => Response.json({})) as typeof fetch;
    const routed: OcxProviderTransport = {
      ...routedProviderConfig("current", config.providers.current), fetch: executor,
      headers: { "x-old-static": "old", "x-opencode-session": "runtime-session" },
    };
    config.providers.current = { ...config.providers.current, apiKey: "synthetic-second",
      apiKeySelectionRevision: "second-revision", headers: { "x-new-static": "new" },
    };
    expect(providerApiKeySelectionIsCurrent(config, "current", routed)).toBe(false);
    const current = resolveCurrentProviderApiKeyTransport(config, "current", routed) as OcxProviderTransport;
    expect(current.apiKey).toBe("synthetic-second");
    expect(current.fetch).toBe(executor);
    expect(current.headers).toEqual({ "x-new-static": "new", "x-opencode-session": "runtime-session" });
    expect(providerApiKeySelectionIsCurrent(config, "current", current)).toBe(true);
  });

  test("Responses readmits a refreshed key and waits for its existing concurrency lease", async () => {
    const seen: string[] = [];
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      seen.push(req.headers.get("authorization")!);
      return Response.json({ id: "paced", object: "chat.completion", choices: [
        { index: 0, message: { role: "assistant", content: "readmitted" }, finish_reason: "stop" },
      ] });
    } });
    const config = { port: 0, defaultProvider: "paced", providers: { paced: {
      adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true,
      authMode: "key", apiKey: "synthetic-first",
      apiKeyPool: [{ id: "first", key: "synthetic-first" }, { id: "second", key: "synthetic-second" }],
      requestPacing: { enabled: true, keys: { maxConcurrentRequests: 1 } },
    } } } as OcxConfig;
    saveConfig(config);
    const first = await waitForProviderRequestSlot("paced", config.providers.paced);
    const second = await waitForProviderRequestSlot("paced", { ...config.providers.paced, apiKey: "synthetic-second" });
    const server = startTrackedServer();
    const abort = new AbortController();
    try {
      const pending = fetch(new URL("/v1/responses", server.url), { method: "POST", signal: abort.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "paced/test", input: "hello", stream: false }) });
      for (let i = 0; i < 200 && providerRequestPacingStatus("paced", config.providers.paced).queued === 0; i++) await Bun.sleep(5);
      expect(providerRequestPacingStatus("paced", config.providers.paced).queued).toBe(1);
      const selected = await managementFetch(new URL("/api/providers/keys/active", server.url), {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "paced", id: "second" }),
      });
      expect(selected.status).toBe(200);
      await selected.text();
      first.release();
      await Bun.sleep(30);
      expect(seen).toEqual([]);
      second.release();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("readmitted");
      expect(seen).toEqual(["Bearer synthetic-second"]);
    } finally {
      abort.abort(); first.release(); second.release(); await server.stop(true);
      resetProviderRequestPacingForTest();
    }
  });

  test.each(["responses", "chat/completions"])("%s logs only the key selected after pacing", async surface => {
    resetUsageReadCacheForTests();
    let now = 0;
    let resumePacing: (() => void) | undefined;
    const queued = Promise.withResolvers<void>();
    setProviderRequestPacingRuntimeForTest({
      now: () => now,
      setTimer(callback, delayMs) {
        resumePacing = () => { now += delayMs; callback(); };
        queued.resolve();
        return callback;
      },
      clearTimer() {},
      enqueueMicrotask: queueMicrotask,
    });
    const seen: Headers[] = [];
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      seen.push(new Headers(req.headers));
      return Response.json({ id: "chatcmpl-paced", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "current selection" }, finish_reason: "stop" }],
      });
    } });
    const config = { port: 0, hostname: "127.0.0.1", defaultProvider: "paced", providers: { paced: {
      adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true,
      authMode: "key", apiKey: "synthetic-first", headers: { "x-static-test": "retained" },
      apiKeyPool: [{ id: "first", key: "synthetic-first" }, { id: "second", key: "synthetic-second" }],
      requestPacing: { enabled: true, minIntervalMs: 100 },
    } } } as OcxConfig;
    saveConfig(config);
    const server = startTrackedServer();
    const abort = new AbortController();
    try {
      await waitForProviderRequestSlot("paced", config.providers.paced);
      const pending = fetch(new URL(`/v1/${surface}`, server.url), {
        method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ model: "paced/test", stream: false,
          ...(surface === "responses" ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }] }) }),
      });
      await queued.promise;
      expect(seen).toHaveLength(0);
      const selected = await managementFetch(new URL("/api/providers/keys/active", server.url), {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "paced", id: "second" }),
      });
      expect(selected.status).toBe(200);
      await selected.text();
      resumePacing!();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("current selection");
      expect(seen.map(headers => headers.get("authorization"))).toEqual(["Bearer synthetic-second"]);
      expect(seen[0]!.get("x-static-test")).toBe("retained");
      const rows = readUsageEntries();
      expect(rows).toHaveLength(1);
      expect(rows[0].attempts).toHaveLength(1);
      expect(rows[0].attempts?.[0]).toMatchObject({ sendCount: 1,
        accountLogLabel: apiKeyAccountLogLabel("paced", { entryId: "second", reference: "synthetic-second" }) });
    } finally {
      abort.abort();
      await server.stop(true);
      resetProviderRequestPacingForTest();
    }
  });

  test.each(["responses", "chat/completions"])("%s carries the configured env-key identity through 429 recovery", async inbound => {
    const seen: string[] = [];
    process.env.OCX_SELECTION_E2E_KEY = "synthetic-env-first";
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      seen.push(req.headers.get("authorization") ?? "");
      if (seen.length === 1) return Response.json({ error: { message: "rate limited" } }, { status: 429 });
      return Response.json({ id: "chatcmpl-env", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    } });
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "pooled", providers: { pooled: {
      adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true,
      authMode: "key", apiKey: "${OCX_SELECTION_E2E_KEY}", apiKeyPool: [
        { id: "first", key: "${OCX_SELECTION_E2E_KEY}" }, { id: "second", key: "synthetic-second" },
      ],
    } } } as OcxConfig);
    const server = startTrackedServer();
    try {
      const response = await fetch(new URL(`/v1/${inbound}`, server.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pooled/test", stream: false,
          ...(inbound === "responses" ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }] }),
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("recovered");
      expect(seen).toEqual(["Bearer synthetic-env-first", "Bearer synthetic-second"]);
      expect(loadConfig().providers.pooled.apiKey).toBe("synthetic-second");
      expect(loadConfig().providers.pooled._apiKeyAttempt).toBeUndefined();
    } finally {
      await server.stop(true);
      delete process.env.OCX_SELECTION_E2E_KEY;
    }
  });

  test("xAI API-key rotation preserves cache affinity and never adds OAuth CLI headers", async () => {
    const originalFetch = globalThis.fetch;
    const promptCacheKey = "codex-session-high-entropy-429-e2e";
    const seenHeaders: Headers[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://api.x.ai/v1/chat/completions") {
        const headers = new Headers(init?.headers);
        seenHeaders.push(headers);
        if (seenHeaders.length === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "retry-after": "30", "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          id: "chatcmpl-xai-rotate",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok after rotate" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    let server: ReturnType<typeof startServer> | null = null;
    try {
      const config: OcxConfig = {
        port: 0,
        hostname: "127.0.0.1",
        defaultProvider: "xai",
        providers: {
          xai: {
            adapter: "openai-chat",
            baseUrl: "https://api.x.ai/v1",
            authMode: "key",
            apiKey: "key-alpha-000111222333",
            apiKeyPool: [
              { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
              { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
            ],
          },
        },
      } as OcxConfig;
      saveConfig(config);
      server = startTrackedServer();
      const res = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "xai/grok-4.5",
          input: "hello",
          stream: false,
          prompt_cache_key: promptCacheKey,
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { output?: { type: string; content?: { text?: string }[] }[] };
      expect(json.output?.find(o => o.type === "message")?.content?.[0]?.text).toBe("ok after rotate");
      expect(seenHeaders).toHaveLength(2);
      expect(seenHeaders.map(headers => headers.get("authorization"))).toEqual([
        "Bearer key-alpha-000111222333",
        "Bearer key-beta-444555666777",
      ]);
      for (const headers of seenHeaders) {
        expect(headers.get("x-grok-conv-id")).toBe(deriveXaiConvId(promptCacheKey));
        expect(headers.get("x-grok-client-identifier")).toBeNull();
        expect(headers.get("x-grok-client-version")).toBeNull();
        expect(headers.get("x-xai-token-auth")).toBeNull();
        for (const [name, value] of headers.entries()) {
          expect(name).not.toContain(promptCacheKey);
          expect(value).not.toContain(promptCacheKey);
        }
      }
    } finally {
      await server?.stop(true);
      globalThis.fetch = originalFetch;
    }
  });

  test("key rotation keeps registry-backfilled prompt_cache_key on the retried request", async () => {
    // Regression: the persisted kimi-code config predates the registry `promptCacheKey`
    // scalar, so routedProviderConfig backfills it at request time. The 429 retry used to
    // rebuild route.provider from the raw persisted config, silently dropping the backfill
    // (and every other registry merge) — the rotated attempt then omitted prompt_cache_key.
    const originalFetch = globalThis.fetch;
    const promptCacheKey = "kimi-session-high-entropy-429-e2e";
    const seen: { auth: string | null; body: { prompt_cache_key?: string } }[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://api.kimi.com/coding/v1/chat/completions") {
        seen.push({
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)) as { prompt_cache_key?: string },
        });
        if (seen.length === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "retry-after": "30", "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          id: "chatcmpl-kimi-rotate",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok after rotate" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    let server: ReturnType<typeof startServer> | null = null;
    try {
      const config: OcxConfig = {
        port: 0,
        hostname: "127.0.0.1",
        defaultProvider: "kimi-code",
        providers: {
          // Deliberately NO promptCacheKey here: the registry backfill is what must survive.
          "kimi-code": {
            adapter: "openai-chat",
            baseUrl: "https://api.kimi.com/coding/v1",
            authMode: "key",
            apiKey: "key-alpha-000111222333",
            apiKeyPool: [
              { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
              { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
            ],
          },
        },
      } as OcxConfig;
      saveConfig(config);
      server = startTrackedServer();
      const res = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-code/kimi-k2.7-code",
          input: "hello",
          stream: false,
          prompt_cache_key: promptCacheKey,
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { output?: { type: string; content?: { text?: string }[] }[] };
      expect(json.output?.find(o => o.type === "message")?.content?.[0]?.text).toBe("ok after rotate");
      expect(seen).toHaveLength(2);
      expect(seen.map(s => s.auth)).toEqual([
        "Bearer key-alpha-000111222333",
        "Bearer key-beta-444555666777",
      ]);
      // Both attempts — the rotated retry especially — must carry the cache key.
      expect(seen.map(s => s.body.prompt_cache_key)).toEqual([promptCacheKey, promptCacheKey]);
    } finally {
      await server?.stop(true);
      globalThis.fetch = originalFetch;
    }
  });

  for (const surface of ["combo", "responses", "chat", "image"] as const) for (const meteredFailure of [false, true]) for (const streaming of [false, true]) {
  if (surface === "image" && !streaming) continue;
  test(`${surface} key rotation attributes each send (failed usage reported: ${meteredFailure}, streaming: ${streaming})`, async () => {
    resetUsageReadCacheForTests();
    const seenAuth: string[] = [];
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const body = await req.json() as { stream?: boolean };
        seenAuth.push(req.headers.get("authorization") ?? "");
        if (seenAuth.length === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" }, ...(meteredFailure ? { usage: { prompt_tokens: 10, completion_tokens: 4 } } : {}) }), {
            status: 429, headers: { "retry-after": "30", "content-type": "application/json" },
          });
        }
        if (body.stream) {
          const chunks = [
            { id: "chatcmpl-1", choices: [{ index: 0, delta: { role: "assistant", content: "ok after rotate" }, finish_reason: null }] },
            { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
          ];
          return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(JSON.stringify({
          id: "chatcmpl-1", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok after rotate" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "pooled",
      combos: { fixture: { strategy: "failover", targets: [{ provider: "pooled", model: "some-model" }] } },
      images: { bridgeEnabled: surface === "image" },
      providers: {
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "synthetic-unused-image-key" },
        pooled: {
          adapter: "openai-chat", ...(meteredFailure ? { authMode: "key" as const } : {}),
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          apiKeyPool: [
            { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
            { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
          ],
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startTrackedServer();
    try {
      const res = await fetch(new URL(surface === "chat" ? "/v1/chat/completions" : "/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(surface === "chat"
          ? { model: "pooled/some-model", messages: [{ role: "user", content: "hello" }], stream: streaming }
          : { model: surface === "combo" ? "combo/fixture" : "pooled/some-model", input: "hello", stream: streaming,
            ...(surface === "image" ? { tools: [{ type: "image_generation" }] } : {}) }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("ok after rotate");
      expect(seenAuth[0]).toBe("Bearer key-alpha-000111222333");
      expect(seenAuth[1]).toBe("Bearer key-beta-444555666777");
      expect(seenAuth).toHaveLength(2);
      const rows = readUsageEntries();
      expect(rows).toHaveLength(1);
      const attempts = rows[0].attempts!;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({ ordinal: 1, provider: "pooled", model: "some-model", status: 429,
        accountLogLabel: apiKeyAccountLogLabel("pooled", { entryId: "k1", reference: "key-alpha-000111222333" }),
        usageStatus: meteredFailure ? "reported" : "unreported" });
      if (meteredFailure) expect(attempts[0].usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
      else expect(attempts[0].usage).toBeUndefined();
      expect(attempts[1]).toMatchObject({ ordinal: 2, provider: "pooled", model: "some-model", status: 200,
        accountLogLabel: apiKeyAccountLogLabel("pooled", { entryId: "k2", reference: "key-beta-444555666777" }),
        usage: { inputTokens: 3, outputTokens: 2 } });
      const raw = readFileSync(join(testDir, "usage.jsonl"), "utf8");
      expect(raw).not.toContain("key-alpha-000111222333");
      expect(raw).not.toContain("key-beta-444555666777");
    } finally {
      await server.stop(true);
    }
  });
  }


  test("Responses continuation keeps hidden successful A usage when a later 429 rotates to B", async () => {
    resetUsageReadCacheForTests();
    const seen: string[] = [];
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      seen.push(req.headers.get("authorization") ?? "");
      if (seen.length === 2) return Response.json({ error: { message: "rate limited" },
        usage: { prompt_tokens: 7, completion_tokens: 1 } }, { status: 429 });
      return Response.json({ id: "chatcmpl-hidden", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: seen.length === 1 ? "" : "recovered" }, finish_reason: "stop" }],
        usage: { prompt_tokens: seen.length === 1 ? 100 : 200, completion_tokens: seen.length === 1 ? 10 : 20 } });
    } });
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "pooled", emptyCompletionRetry: true,
      combos: { hidden: { strategy: "failover", targets: [{ provider: "pooled", model: "test" }] } },
      providers: { pooled: { adapter: "openai-chat", authMode: "key",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true,
        apiKey: "synthetic-first", apiKeyPool: [{ id: "first", key: "synthetic-first" }, { id: "second", key: "synthetic-second" }] } },
    } as OcxConfig);
    const server = startTrackedServer();
    try {
      const response = await fetch(new URL("/v1/responses", server.url), { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pooled/test", input: "hello", stream: false }) });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("recovered");
      expect(seen).toEqual(["Bearer synthetic-first", "Bearer synthetic-first", "Bearer synthetic-second"]);
      const rows = readUsageEntries();
      expect(rows).toHaveLength(1);
      expect(rows[0].attempts).toHaveLength(2);
      expect(rows[0].attempts?.[0]).toMatchObject({ sendCount: 2, usage: { inputTokens: 107, outputTokens: 11 },
        accountLogLabel: apiKeyAccountLogLabel("pooled", { entryId: "first", reference: "synthetic-first" }) });
      expect(rows[0].attempts?.[1]).toMatchObject({ sendCount: 1, usage: { inputTokens: 200, outputTokens: 20 },
        accountLogLabel: apiKeyAccountLogLabel("pooled", { entryId: "second", reference: "synthetic-second" }) });
      expect(rows[0].attempts?.reduce((sum, attempt) => sum + (attempt.usage?.inputTokens ?? 0), 0)).toBe(307);
    } finally { await server.stop(true); }
  });

  for (const adapter of ["command-code", "openai-chat"] as const) for (const error of [false, true]) {
  test(`${adapter} records one usage observation for a nested parser or HTTP-200 error (${error})`, async () => {
    resetUsageReadCacheForTests();
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      if (adapter === "command-code") return new Response([
        { type: "text-delta", text: "synthetic answer" },
        { type: "finish", finishReason: error ? "error" : "stop", totalUsage: { inputTokens: 100, outputTokens: 20 } },
      ].map(row => JSON.stringify(row) + "\n").join(""), { headers: { "content-type": "application/x-ndjson" } });
      return Response.json({ id: "chatcmpl-error", object: "chat.completion",
        ...(error ? { error: { message: "synthetic failure", type: "server_error" } }
          : { choices: [{ index: 0, message: { role: "assistant", content: "synthetic answer" }, finish_reason: "stop" }] }),
        usage: { prompt_tokens: 100, completion_tokens: 20 } });
    } });
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "metered", providers: {
      metered: { adapter, authMode: "key", apiKey: "synthetic-key", allowPrivateNetwork: true,
        baseUrl: `http://127.0.0.1:${upstream.port}` },
    } } as OcxConfig);
    const server = startTrackedServer();
    try {
      const response = await fetch(new URL("/v1/responses", server.url), { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "metered/test", input: "hello", stream: false }) });
      await response.text();
      const rows = readUsageEntries();
      expect(rows).toHaveLength(1);
      expect(rows[0].attempts).toHaveLength(1);
      expect(rows[0].attempts?.[0]).toMatchObject({ usage: { inputTokens: 100, outputTokens: 20 },
        accountLogLabel: apiKeyAccountLogLabel("metered", { reference: "synthetic-key" }) });
    } finally { await server.stop(true); }
  });
  }

  test("a 429 dated in the body parks the failed key until that instant, outranking Retry-After", async () => {
    // #4024 regression, through the real dispatch path. The unit tests cover
    // parseQuotaResetAt/readQuotaResetAt in isolation; nothing exercised
    // adapter-dispatch actually READING the body and handing quotaResetAt to
    // rotateProviderTransportOn429. Dropping it there would leave every unit
    // test green while the key came back after the header's 30s and took the
    // same 429 again — which is the bug.
    const resetAt = new Date(Date.now() + 6 * 60 * 60_000);
    const stamp = resetAt.toISOString().replace("T", " ").slice(0, 19); // bare form, read as UTC
    const seenAuth: string[] = [];
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req) {
        seenAuth.push(req.headers.get("authorization") ?? "");
        if (seenAuth.length === 1) {
          return new Response(JSON.stringify({
            error: { code: "rate_limit_error", message: `Weekly Limit Exhausted. Your limit will reset at ${stamp}` },
          }), { status: 429, headers: { "retry-after": "30", "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          id: "chatcmpl-dated", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok after dated rotate" }, finish_reason: "stop" }],
        }), { headers: { "content-type": "application/json" } });
      },
    });
    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "dated",
      providers: {
        dated: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-dated-000111222333",
          apiKeyPool: [
            { id: "d1", key: "key-dated-000111222333", addedAt: 1 },
            { id: "d2", key: "key-dated-444555666777", addedAt: 2 },
          ],
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startTrackedServer();
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "dated/some-model", input: "hello", stream: false }),
      });
      expect(res.status).toBe(200);
      await res.json();
      expect(seenAuth[1]).toBe("Bearer key-dated-444555666777");

      const cooldownUntil = getKeyCooldownUntil("dated", "d1");
      expect(cooldownUntil).not.toBeNull();
      // The body's instant, not the header's 30s. Compared with a wide window
      // because the cooldown is anchored to the server's Date.now(), not ours.
      expect(cooldownUntil!).toBeGreaterThan(Date.now() + 5 * 60 * 60_000);
      expect(cooldownUntil!).toBeLessThanOrEqual(resetAt.getTime() + 60_000);
    } finally {
      await server.stop(true);
    }
  });

  test("client cancellation during the 429 body peek does not rotate or cool the key", async () => {
    const bodyRead = Promise.withResolvers<void>();
    const bodyCancelled = Promise.withResolvers<void>();
    const seenAuth: string[] = [];
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req) {
        seenAuth.push(req.headers.get("authorization") ?? "");
        let pulls = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode('{"error":{"code":"rate_limit_error","message":"Weekly Limit Exhausted.'));
              return;
            }
            bodyRead.resolve();
            return new Promise<void>(() => {});
          },
          cancel() {
            bodyCancelled.resolve();
          },
        }), { status: 429, headers: { "content-type": "application/json" } });
      },
    });
    const config = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "cancelled",
      providers: {
        cancelled: {
          adapter: "openai-chat", authMode: "key",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true,
          apiKey: "key-canc-000111222333",
          apiKeyPool: [
            { id: "c1", key: "key-canc-000111222333", addedAt: 1 },
            { id: "c2", key: "key-cancelled-444555666777", addedAt: 2 },
          ],
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const abort = new AbortController();
    const pending = handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cancelled/some-model", input: "hello", stream: false }),
    }), config, { model: "", provider: "" }, { abortSignal: abort.signal });

    await bodyRead.promise;
    abort.abort(new DOMException("client closed", "AbortError"));
    const response = await pending;

    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error: { code: "client_cancelled" } });
    await bodyCancelled.promise;
    expect(seenAuth).toEqual(["Bearer key-canc-000111222333"]);
    expect(getKeyCooldownUntil("cancelled", "c1")).toBeNull();
    expect(loadConfig().providers.cancelled?.apiKey).toBe("key-canc-000111222333");
  });

  test.each(["authenticated", "keyless"] as const)("reasoning replay misses after a 429 rotates to a different physical key (%s)", async (caller) => {
    const model = "reasoning-model";
    const callId = "call_key_rotation";
    const privateReasoning = "reasoning from physical key A";
    const callerKey = "synthetic-reasoning-replay-caller";
    const seen: Array<{ auth: string; messages: Array<Record<string, unknown>> }> = [];
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const body = await req.json() as { messages?: Array<Record<string, unknown>> };
        seen.push({
          auth: req.headers.get("authorization") ?? "",
          messages: body.messages ?? [],
        });
        if (seen.length === 1) {
          return Response.json({
            id: "chatcmpl-reasoning-seed",
            object: "chat.completion",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: null,
                reasoning_content: privateReasoning,
                tool_calls: [{
                  id: callId,
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                }],
              },
              finish_reason: "tool_calls",
            }],
          });
        }
        if (seen.length === 2) {
          return Response.json(
            { error: { message: "rotate key" } },
            { status: 429, headers: { "retry-after": "30" } },
          );
        }
        return Response.json({
          id: "chatcmpl-reasoning-rotated",
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "ok after isolated retry" },
            finish_reason: "stop",
          }],
        });
      },
    });
    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "reasoning-pool",
      ...(caller === "authenticated" ? { apiKeys: [{
        id: "reasoning-caller", name: "reasoning-caller", key: callerKey, createdAt: "2026-01-01",
      }] } : {}),
      providers: {
        "reasoning-pool": {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          apiKeyPool: [
            { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
            { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
          ],
          preserveReasoningContentModels: [model],
          requiresReasoningPlaceholderModels: [model],
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startTrackedServer();
    const headers = {
      "content-type": "application/json",
      "x-codex-parent-thread-id": "thread-key-rotation",
      ...(caller === "authenticated" ? { "x-opencodex-api-key": callerKey } : {}),
    };
    try {
      const first = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: `reasoning-pool/${model}`,
          input: "inspect the repo",
          stream: false,
          tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
        }),
      });
      expect(first.status).toBe(200);
      await first.json();

      const second = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: `reasoning-pool/${model}`,
          stream: false,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "inspect the repo" }] },
            { type: "function_call", call_id: callId, name: "read_file", arguments: "{}" },
            { type: "function_call_output", call_id: callId, output: "contents" },
          ],
        }),
      });
      expect(second.status).toBe(200);
      await second.json();

      expect(seen.map(entry => entry.auth)).toEqual([
        "Bearer key-alpha-000111222333",
        "Bearer key-alpha-000111222333",
        "Bearer key-beta-444555666777",
      ]);
      const replayed = seen[1]!.messages.find(message => Array.isArray(message.tool_calls));
      const rotated = seen[2]!.messages.find(message => Array.isArray(message.tool_calls));
      expect(replayed?.reasoning_content).toBe(caller === "authenticated" ? privateReasoning : " ");
      expect(rotated?.reasoning_content).toBe(" ");
      expect(rotated?.reasoning_content).not.toBe(privateReasoning);
    } finally {
      await server.stop(true);
    }
  });

  test("network failure after a 429 key rotation surfaces the retry error", async () => {
    const originalFetch = globalThis.fetch;
    let upstreamAttempts = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://fault-injected.example/v1/chat/completions") {
        upstreamAttempts += 1;
        if (upstreamAttempts === 1) {
          return new Response(JSON.stringify({ error: { message: "original rate limit" } }), {
            status: 429,
            headers: { "retry-after": "30", "content-type": "application/json" },
          });
        }
        throw new TypeError("rotated retry socket reset");
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "pooled-network-failure",
      providers: {
        "pooled-network-failure": {
          adapter: "openai-chat",
          baseUrl: "https://fault-injected.example/v1",
          apiKey: "key-alpha-000111222333",
          apiKeyPool: [
            { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
            { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
          ],
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startTrackedServer();
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pooled-network-failure/some-model", input: "hello", stream: false }),
      });
      const json = await res.json() as { error?: { message?: string } };

      expect(upstreamAttempts).toBe(2);
      expect(res.status).toBe(502);
      expect(json.error?.message).toContain("rotated retry socket reset");
      expect(json.error?.message).not.toContain("original rate limit");
    } finally {
      await server.stop(true);
      globalThis.fetch = originalFetch;
    }
  });

  test("noVisionModels model with no sidecar plan gets images stripped fail-closed", async () => {
    let upstreamBody = "";
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        upstreamBody = await req.text();
        return new Response(JSON.stringify({
          id: "chatcmpl-2", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "text only" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "textonly",
      providers: {
        textonly: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        // No forward provider in config → planVisionSidecar cannot run.
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startTrackedServer();
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "textonly/blind-model", stream: false,
          input: [{ type: "message", role: "user", content: [
            { type: "input_text", text: "describe this" },
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          ]}],
        }),
      });
      expect(res.status).toBe(200);
      expect(upstreamBody).toContain("[image omitted");
      expect(upstreamBody).not.toContain("aGVsbG8=");
    } finally {
      await server.stop(true);
    }
  });

  test("Google AI Studio apiKeyPool rotates on 429 without redundant single-key retries (A sent once, B sent once)", async () => {
    const originalFetch = globalThis.fetch;
    const seenKeys: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("generativelanguage.googleapis.com")) {
        const headers = new Headers(init?.headers);
        const key = headers.get("x-goog-api-key") ?? "";
        seenKeys.push(key);
        if (seenKeys.length === 1) {
          return new Response(JSON.stringify({
            error: { code: 429, message: "Rate limit exceeded", status: "RESOURCE_EXHAUSTED" },
          }), {
            status: 429,
            headers: { "retry-after": "30", "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          candidates: [{
            content: { role: "model", parts: [{ text: "response from key B" }] },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
        }), { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "google-direct",
      providers: {
        "google-direct": {
          adapter: "google",
          baseUrl: "https://generativelanguage.googleapis.com",
          authMode: "key",
          apiKey: "key-alpha-111",
          apiKeyPool: [
            { id: "k1", key: "key-alpha-111", addedAt: 1 },
            { id: "k2", key: "key-beta-222", addedAt: 2 },
          ],
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startTrackedServer();
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "google-direct/gemini-2.5-flash", input: "hi", stream: false }),
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { output?: Array<{ content?: Array<{ text?: string }> }> };
      expect(json.output?.[0]?.content?.[0]?.text).toBe("response from key B");
      expect(seenKeys).toEqual(["key-alpha-111", "key-beta-222"]);
    } finally {
      await server.stop(true);
      globalThis.fetch = originalFetch;
    }
  });
});

  /**
   * Both cases land on the same state: the committed key is already cooling when a request
   * arrives. That is not exotic -- it is what an operator has after the pool rotated and a
   * restart, a manual edit or a config reload pointed `apiKey` back at the spent key.
   */
  async function cooledCommittedKeySetup(strategy?: "round-robin" | "fill-first") {
    const seen: string[] = [];
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      seen.push(req.headers.get("authorization") ?? "");
      return Response.json({ id: "chatcmpl-warm", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "warm" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    } });
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "pooled", providers: { pooled: {
      adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true,
      authMode: "key", apiKey: "synthetic-first",
      ...(strategy ? { apiKeyPoolStrategy: strategy } : {}),
      apiKeyPool: [{ id: "first", key: "synthetic-first" }, { id: "second", key: "synthetic-second" }],
    } } } as OcxConfig);
    // Cool the committed key exactly the way a real 429 does, then point the stored selection
    // back at it. Cooldowns are process-local, so the server started below shares this state.
    const live = loadConfig();
    rotateKeyOn429(live, "pooled", null, Date.now(), "synthetic-first");
    const restored = loadConfig();
    restored.providers.pooled!.apiKey = "synthetic-first";
    saveConfig(restored);
    return seen;
  }

  test("a cooled committed key is replaced before the first attempt", async () => {
    const seen = await cooledCommittedKeySetup("round-robin");
    const server = startTrackedServer();
    try {
      const response = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pooled/test", stream: false, messages: [{ role: "user", content: "hello" }] }),
      });
      expect(response.status).toBe(200);
      // ONE attempt, on the warm key. Reactive rotation alone cannot produce this: it needs a
      // 429 first, so without the pre-dispatch pick the upstream would see the cooled key here
      // and the request would be spent earning a refusal the runtime could already predict.
      expect(seen).toEqual(["Bearer synthetic-second"]);
    } finally {
      await server.stop(true);
    }
  });

  test("without a configured strategy the cooled key is still used", async () => {
    const seen = await cooledCommittedKeySetup();
    const server = startTrackedServer();
    try {
      const response = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pooled/test", stream: false, messages: [{ role: "user", content: "hello" }] }),
      });
      expect(response.status).toBe(200);
      // The other half of the contract: rotation stays reactive-only for an install that never
      // asked for a strategy, so the committed key is honoured even when it is cooling.
      expect(seen).toEqual(["Bearer synthetic-first"]);
    } finally {
      await server.stop(true);
    }
  });

  /**
   * The two cases above pin the behaviour but not the PATH: an `openai-chat` provider sends
   * /v1/chat/completions through `handleNativeChatCompletions`, so the pick in
   * `responses/core.ts` never runs in either of them. This one goes through /v1/responses, so
   * the independently changed core call site is actually covered.
   *
   * The pool keys are stored as `\${VAR}` references on purpose. Reference resolution is one of
   * the backfills `routedProviderConfig` applies and the adapter does not, so the upstream
   * bearer proves the route the core path dispatched was a rebuilt one rather than the
   * picker's persisted snapshot.
   *
   * Red control: remove the pick from core.ts and the upstream sees `Bearer resolved-cooled`,
   * because the committed selection still points at the cooled key.
   *
   * What this case does NOT prove is the Transport-vs-snapshot distinction on this path:
   * `refreshDispatchAdapter` re-derives the transport from config before dispatch, so the
   * Responses core self-heals a wholesale assignment. That contract is pinned as a unit in
   * tests/adapters/key-failover.test.ts, where it has a red control that actually fails.
   */
  test("the Responses core pick reaches the warm key through /v1/responses", async () => {
    const seen: string[] = [];
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      seen.push(req.headers.get("authorization") ?? "");
      return Response.json({ id: "chatcmpl-warm", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "warm" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    } });
    process.env.OCX_KEYFAIL_COOLED = "resolved-cooled";
    process.env.OCX_KEYFAIL_WARM = "resolved-warm";
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "env-pooled", providers: { "env-pooled": {
      adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true,
      authMode: "key", apiKey: "\${OCX_KEYFAIL_COOLED}", apiKeyPoolStrategy: "round-robin",
      apiKeyPool: [
        { id: "cooled", key: "\${OCX_KEYFAIL_COOLED}" },
        { id: "warm", key: "\${OCX_KEYFAIL_WARM}" },
      ],
    } } } as OcxConfig);
    const live = loadConfig();
    rotateKeyOn429(live, "env-pooled", null, Date.now(), "\${OCX_KEYFAIL_COOLED}");
    const restored = loadConfig();
    restored.providers["env-pooled"]!.apiKey = "\${OCX_KEYFAIL_COOLED}";
    saveConfig(restored);
    const server = startTrackedServer();
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "env-pooled/test", input: "hi", stream: false }),
      });
      expect(response.status).toBe(200);
      expect(seen).toEqual(["Bearer resolved-warm"]);
    } finally {
      await server.stop(true);
      delete process.env.OCX_KEYFAIL_COOLED;
      delete process.env.OCX_KEYFAIL_WARM;
    }
  });

test.each([false, true])("chat-native attributes same-key 429 usage then the rotated key (stream=%s)", async (streaming) => {
  const { clearRequestLogsForTests, getRequestLogEntries } = await import("../../src/server/request-log");
  const { clearKeyCooldowns } = await import("../../src/providers/key-failover");
  clearRequestLogsForTests();
  clearKeyCooldowns("mock");
  const authorizations: Array<string | null> = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      authorizations.push(req.headers.get("authorization"));
      if (authorizations.length === 1) {
        return Response.json({ error: { message: "rate limited" }, usage: { prompt_tokens: 10, completion_tokens: 1 } }, {
          status: 429, headers: { "retry-after": "0", "content-type": "application/json" },
        });
      }
      if (authorizations.length === 2) {
        return Response.json({ error: { message: "rate limited" }, usage: { prompt_tokens: 7, completion_tokens: 0 } }, {
          status: 429, headers: { "retry-after": "0", "content-type": "application/json" },
        });
      }
      if (streaming) {
        const chunks = [
          { id: "chatcmpl-1", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
          { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
        ];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "chatcmpl-1", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      });
    },
  });
  saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "mock", providers: { mock: {
    adapter: "openai-chat", allowPrivateNetwork: true,
    baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
    authMode: "key",
    apiKey: "key-one",
    apiKeyPool: [{ id: "one", key: "key-one" }, { id: "two", key: "key-two" }],
    retryOn429: { attempts: 1, intervalMs: 100, maxIntervalMs: 100, respectRetryAfter: false },
  } } } as OcxConfig);
  const server = startTrackedServer();
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: streaming, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
    expect(authorizations).toEqual(["Bearer key-one", "Bearer key-one", "Bearer key-two"]);
    const entry = getRequestLogEntries().at(-1);
    expect(entry?.attempts).toHaveLength(2);
    expect(entry?.attempts?.[0]).toMatchObject({ sendCount: 2, usage: { inputTokens: 17, outputTokens: 1 } });
    expect(entry?.attempts?.[1]).toMatchObject({ sendCount: 1, usage: { inputTokens: 3, outputTokens: 2 } });
  } finally {
    await server.stop(true);
    upstream.stop(true);
    clearKeyCooldowns("mock");
  }
});

test("chat-native preserves same-key retry, key rotation, usage, and request logging", async () => {
  const { clearRequestLogsForTests, getRequestLogEntries } = await import("../../src/server/request-log");
  const { clearKeyCooldowns } = await import("../../src/providers/key-failover");
  clearRequestLogsForTests();
  clearKeyCooldowns("mock");
  const authorizations: Array<string | null> = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      authorizations.push(req.headers.get("authorization"));
      if (authorizations.length < 3) {
        return Response.json({ error: { message: "rate limited", type: "rate_limit_error" } }, {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return Response.json({
        id: "chatcmpl_retry",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      });
    },
  });
  saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "mock", providers: { mock: {
    adapter: "openai-chat", allowPrivateNetwork: true,
    baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
    authMode: "key",
    apiKey: "key-one",
    apiKeyPool: [{ id: "one", key: "key-one" }, { id: "two", key: "key-two" }],
    retryOn429: { attempts: 1, intervalMs: 100, maxIntervalMs: 100, respectRetryAfter: false },
  } } } as OcxConfig);
  const server = startTrackedServer();
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(authorizations).toEqual(["Bearer key-one", "Bearer key-one", "Bearer key-two"]);
    const entry = getRequestLogEntries().at(-1);
    expect(entry?.status).toBe(200);
    expect(entry?.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 });
    expect(entry?.attempts).toHaveLength(2);
    expect(entry?.attempts?.[0]?.recoveryKinds).toEqual(["rate-limit-429"]);
    expect(entry?.attempts?.[0]?.sendCount).toBe(2);
    expect(entry?.attempts?.[1]?.recoveryKinds).toEqual(["key-429"]);
    expect(entry?.attempts?.[1]?.sendCount).toBe(1);
  } finally {
    await server.stop(true);
    upstream.stop(true);
    clearKeyCooldowns("mock");
  }
});

test.each([false, true])("key refetch retains transient recovery metadata (stream=%s)", async stream => {
  resetUsageReadCacheForTests();
  const seen: Array<string | null> = [];
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    seen.push(req.headers.get("authorization"));
    if (seen.length < 3) return Response.json({ error: { message: seen.length === 1 ? "rate limited" : "temporarily unavailable" },
      usage: { prompt_tokens: seen.length, completion_tokens: 0 } }, {
      status: seen.length === 1 ? 429 : 503, headers: { "retry-after": "0" },
    });
    const usage = { prompt_tokens: 10, completion_tokens: 2 };
    if (stream) return new Response([
      { id: "chatcmpl-refetch", choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: null }] },
      { id: "chatcmpl-refetch", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    return Response.json({ id: "chatcmpl-refetch", object: "chat.completion", usage,
      choices: [{ index: 0, message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }] });
  } });
  saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "refetch", providers: { refetch: {
    adapter: "openai-chat", authMode: "key", allowPrivateNetwork: true, baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    apiKey: "synthetic-refetch-a", apiKeyPool: [{ id: "a", key: "synthetic-refetch-a" }, { id: "b", key: "synthetic-refetch-b" }],
    transientRetryOn5xx: { attempts: 3 }, retryOn429: { attempts: 0 },
  } } } as OcxConfig);
  const server = startTrackedServer();
  try {
    const response = await fetch(new URL("/v1/responses", server.url), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "refetch/test", input: "hello", stream }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("recovered");
    expect(seen).toEqual(["Bearer synthetic-refetch-a", "Bearer synthetic-refetch-b", "Bearer synthetic-refetch-b"]);
    const attempts = readUsageEntries()[0]?.attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts?.[0]).toMatchObject({ sendCount: 1, usage: { inputTokens: 1, outputTokens: 0 } });
    expect(attempts?.[1]).toMatchObject({ sendCount: 2, recoveryKinds: ["key-429", "transient-5xx"],
      usage: { inputTokens: 12, outputTokens: 2 } });
  } finally { await server.stop(true); }
});

const BRIDGE_CALLER_KEY = "synthetic-bridge-caller-key";
const BRIDGE_THREAD = "thread-keyrace";
const BRIDGE_CELL = "ws_keyrace";

function bridgedReplayConfig(baseUrl: string, pacing: boolean): OcxConfig {
  return {
    port: 0, hostname: "127.0.0.1", defaultProvider: "pooled",
    apiKeys: [{ id: "bridge-caller", name: "bridge-caller", key: BRIDGE_CALLER_KEY, createdAt: "2026-01-01" }],
    providers: { pooled: {
      adapter: "openai-responses", baseUrl, allowPrivateNetwork: true,
      authMode: "key", apiKey: "synthetic-first",
      apiKeyPool: [{ id: "first", key: "synthetic-first" }, { id: "second", key: "synthetic-second" }],
      webSearchBridge: { enabled: true, backend: "ollama" },
      ...(pacing ? { requestPacing: { enabled: true, minIntervalMs: 100 } } : {}),
    } },
  } as OcxConfig;
}

/** The principal the server derives for a loopback caller that presents the fixture key. */
function bridgeCallerPrincipal(config: OcxConfig): string {
  const principal = resolveContextPrincipal(
    new Request("http://127.0.0.1/v1/responses", { headers: { "x-opencodex-api-key": BRIDGE_CALLER_KEY } }),
    config,
    { kind: "loopback", source: "loopback" },
  );
  if (!principal) throw new Error("the fixture caller key must resolve to a principal");
  return principal;
}

/** Record one executed bridged search as the FIRST pool key would have served it. */
function seedBridgedSearch(baseUrl: string, clientPrincipalId: string): void {
  rememberBridgeSearchReplay(
    bridgeSearchReplayScope({
      clientPrincipalId,
      clientThreadId: BRIDGE_THREAD,
      current: {
        providerName: "pooled",
        providerDestinationIdentity: reasoningReplayDestinationIdentity(baseUrl),
        adapterName: "openai-responses",
        modelId: "test",
        credentialIdentity: reasoningReplayKeyCredentialIdentity({ apiKey: "synthetic-first" }),
      },
    }),
    BRIDGE_CELL,
    { callId: "call_ws_1", name: "web_search",
      argumentsText: "{\"query\":\"opencodex release\"}", output: "cached bridged result" },
  );
}

type SeenUpstreamTurn = { authorization: string | null; input: Record<string, unknown>[] };

function serveBridgedUpstream(seen: SeenUpstreamTurn[]): string {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { input?: unknown };
    seen.push({
      authorization: req.headers.get("authorization"),
      input: Array.isArray(body.input) ? body.input as Record<string, unknown>[] : [],
    });
    return Response.json({
      id: "resp_keyrace", object: "response", status: "completed", model: "test",
      output: [{ type: "message", id: "msg_keyrace", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "done", annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  } });
  return `http://127.0.0.1:${upstream.port}/v1`;
}

function bridgedReplayRequest(callerKey: string | undefined, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "thread-id": BRIDGE_THREAD,
      ...(callerKey ? { "x-opencodex-api-key": callerKey } : {}),
    },
    ...(signal ? { signal } : {}),
    body: JSON.stringify({
      model: "pooled/test", stream: false,
      tools: [{ type: "web_search" }],
      input: [
        { role: "user", content: [{ type: "input_text", text: "what is the latest release?" }] },
        { type: "web_search_call", id: BRIDGE_CELL, status: "completed",
          action: { type: "search", query: "opencodex release", queries: ["opencodex release"] } },
      ],
    }),
  };
}

function hostedCellReachedUpstream(turn: SeenUpstreamTurn): boolean {
  return turn.input.some(item => item.type === "web_search_call" && item.id === BRIDGE_CELL);
}

function recordedResultRestored(turn: SeenUpstreamTurn): boolean {
  return turn.input.some(item => item.call_id === "call_ws_1");
}

test("a keyed caller's bridged search is restored on its next turn", async () => {
  // Positive control for the two refusals below: the same seed, principal, thread and
  // credential does restore, so a miss there is the scope doing its job, not a broken fixture.
  const seen: SeenUpstreamTurn[] = [];
  const baseUrl = serveBridgedUpstream(seen);
  const config = bridgedReplayConfig(baseUrl, false);
  saveConfig(config);
  seedBridgedSearch(baseUrl, bridgeCallerPrincipal(config));
  const server = startTrackedServer();
  try {
    const response = await fetch(new URL("/v1/responses", server.url), bridgedReplayRequest(BRIDGE_CALLER_KEY));
    expect(response.status).toBe(200);
    await response.text();
    expect(seen).toHaveLength(1);
    expect(recordedResultRestored(seen[0]!)).toBe(true);
    expect(hostedCellReachedUpstream(seen[0]!)).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("a keyless loopback caller neither restores nor shares a bridged search", async () => {
  // A caller that presents no opencodex key has no principal. It must not fall into a shared
  // bucket: seed both the keyed caller's cell and the literal bucket a fallback would have used.
  const seen: SeenUpstreamTurn[] = [];
  const baseUrl = serveBridgedUpstream(seen);
  const config = bridgedReplayConfig(baseUrl, false);
  saveConfig(config);
  seedBridgedSearch(baseUrl, bridgeCallerPrincipal(config));
  seedBridgedSearch(baseUrl, "loopback");
  const server = startTrackedServer();
  try {
    const response = await fetch(new URL("/v1/responses", server.url), bridgedReplayRequest(undefined));
    expect(response.status).toBe(200);
    await response.text();
    expect(seen).toHaveLength(1);
    expect(recordedResultRestored(seen[0]!)).toBe(false);
    expect(hostedCellReachedUpstream(seen[0]!)).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("a dispatch-time key switch rebuilds the bridged-search restore under the new credential", async () => {
  // Regression for the oauthDispatch rebuild order: the Responses adapter restores a replayed
  // web_search_call from the memo keyed by _reasoningReplayScope, so the rebuild must rebind
  // that scope to the refreshed credential BEFORE buildRequest runs. Restoring under the key
  // whose selection just lapsed, then sending under the newly selected key, would hand the
  // first credential's recorded result to the second credential's upstream.
  let now = 0;
  let resumePacing: (() => void) | undefined;
  const queued = Promise.withResolvers<void>();
  setProviderRequestPacingRuntimeForTest({
    now: () => now,
    setTimer(callback, delayMs) {
      resumePacing = () => { now += delayMs; callback(); };
      queued.resolve();
      return callback;
    },
    clearTimer() {},
    enqueueMicrotask: queueMicrotask,
  });
  const seen: SeenUpstreamTurn[] = [];
  const baseUrl = serveBridgedUpstream(seen);
  const config = bridgedReplayConfig(baseUrl, true);
  saveConfig(config);

  // Seed the memo under the identity the FIRST key binds: the same caller principal and thread
  // the request below carries, but the credential whose selection is about to lapse.
  seedBridgedSearch(baseUrl, bridgeCallerPrincipal(config));

  const server = startTrackedServer();
  const abort = new AbortController();
  try {
    await waitForProviderRequestSlot("pooled", config.providers.pooled);
    const pending = fetch(new URL("/v1/responses", server.url), bridgedReplayRequest(BRIDGE_CALLER_KEY, abort.signal));
    await queued.promise;
    const selected = await managementFetch(new URL("/api/providers/keys/active", server.url), {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pooled", id: "second" }),
    });
    expect(selected.status).toBe(200);
    await selected.text();
    resumePacing!();
    const response = await pending;
    expect(response.status).toBe(200);
    await response.text();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authorization).toBe("Bearer synthetic-second");
    // Rebound before rebuild: the memo lookup misses under the new credential, so the hosted
    // cell reaches the second key's upstream verbatim instead of the first key's result.
    expect(hostedCellReachedUpstream(seen[0]!)).toBe(true);
    expect(recordedResultRestored(seen[0]!)).toBe(false);
  } finally {
    abort.abort();
    await server.stop(true);
    resetProviderRequestPacingForTest();
  }
});


// Real CLI adapters with an injected child; no provider process or upstream request is made.
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import * as runTurnResolver from "../../src/server/adapter-resolve";
import * as runTurnKeyPool from "../../src/providers/key-failover";
import { createQoderAdapter } from "../../src/adapters/qoder/adapter";
import { createCodeBuddyAdapter } from "../../src/adapters/codebuddy/adapter";
import { clearQoderBinaryCache } from "../../src/adapters/qoder/profiles";
import { clearCodeBuddyBinaryCache } from "../../src/adapters/codebuddy/profiles";
import { createRequestExecutionBudget, CODEX_TEXT_GUARDED_BUDGET_POLICY } from "../../src/lib/request-execution-budget";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { RequestLogContext } from "../../src/server/request-log";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";

async function cliKeyRecoveryCase(options: {
  adapter?: "qoder" | "codebuddy"; stream?: boolean; vendorCode?: number; result?: string;
  exitCode?: number; stderr?: string; prefix?: AdapterEvent;
  poolSize?: number; allFail?: boolean; manualSwitch?: boolean; cancel?: boolean;
  budget?: "total" | "hop";
  stallFirstEvent?: boolean; stallTimeoutSec?: number; healthyFirst?: boolean;
} = {}) {
  const adapterName = options.adapter ?? "qoder";
  clearQoderBinaryCache(); clearCodeBuddyBinaryCache();
  const config = { port: 0, defaultProvider: "cli-pool",
    ...(options.stallTimeoutSec ? { stallTimeoutSec: options.stallTimeoutSec } : {}),
    providers: { "cli-pool": {
    adapter: adapterName, authMode: "key", baseUrl: adapterName === "qoder" ? "https://qoder.com" : "https://www.codebuddy.ai",
    apiKey: "synthetic-cli-a", models: ["test"], liveModels: false,
    apiKeyPool: [
      { id: "a", key: "synthetic-cli-a" }, { id: "b", key: "synthetic-cli-b" },
    ].slice(0, options.poolSize ?? 2),
  } } } as OcxConfig;
  saveConfig(config);
  const sent = Promise.withResolvers<void>();
  const releaseFailure = Promise.withResolvers<void>();
  const seen: string[] = [];
  const order: string[] = [];
  const errors: Array<Extract<AdapterEvent, { type: "error" }>> = [];
  const abort = new AbortController();
  const budget = createRequestExecutionBudget(options.budget === "total"
    ? { ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0 }
    : undefined);
  const reserve = budget.reserveDispatch.bind(budget);
  if (options.budget === "hop") budget.reserveDispatch = intent => intent.sendClass === "auth-recovery"
    ? { allowed: false, reason: "alternate-target-exhausted" } : reserve(intent);
  const releaseOwner = acquireOwnedSpendHome();
  const rotate401 = spyOn(runTurnKeyPool, "rotateProviderTransportOn401");
  const rotate429 = spyOn(runTurnKeyPool, "rotateProviderTransportOn429");
  const original = runTurnResolver.resolveAdapter;
  const resolver = spyOn(runTurnResolver, "resolveAdapter").mockImplementation((provider, retention, providerId) => {
    if (providerId !== "cli-pool" && provider.adapter !== adapterName) return original(provider, retention, providerId);
    const create = adapterName === "qoder" ? createQoderAdapter : createCodeBuddyAdapter;
    const adapter = create(provider, { which: () => "/synthetic/cli", killGraceMs: 100,
      spawn: (_file, _args, childOptions) => {
        const key = String(childOptions.env?.[adapterName === "qoder" ? "QODER_PERSONAL_ACCESS_TOKEN" : "CODEBUDDY_API_KEY"]);
        seen.push(key);
        const failing = options.allFail || (key === "synthetic-cli-a" && !options.healthyFirst);
        const child = new EventEmitter() as ChildProcess;
        child.exitCode = null;
        child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
        child.stderr = Readable.from(failing && options.stderr ? [options.stderr] : []);
        child.kill = () => true;
        child.stdout = Readable.from((async function* () {
          if (failing || options.healthyFirst) {
            sent.resolve();
            if (options.manualSwitch || options.stallFirstEvent) await releaseFailure.promise;
            order.push("cli-output");
          }
          if (failing) {
            if (options.exitCode === undefined) yield Buffer.from(JSON.stringify({
              type: "result", is_error: true, error_code: options.vendorCode,
              result: options.result ?? "invalid personal access token",
            }) + "\n");
          } else {
            yield Buffer.from(JSON.stringify({ type: "assistant", message: { content: [
              { type: "text", text: options.healthyFirst ? "healthy on A" : "recovered on B" },
            ] } }) + "\n");
            yield Buffer.from('{"type":"result","is_error":false}\n');
          }
          child.exitCode = failing ? options.exitCode ?? 0 : 0;
          child.emit("close", child.exitCode);
        })());
        return child;
      },
    });
    const run = adapter.runTurn!;
    adapter.runTurn = (parsed, incoming, emit) => run(parsed, incoming, event => {
      if (event.type === "error") {
        errors.push(event);
        if (options.prefix) emit(options.prefix);
        if (options.cancel) abort.abort();
        emit(event);
      } else emit(event);
    });
    return adapter;
  });
  const logCtx: RequestLogContext = { model: "", provider: "" };
  try {
    const request = new Request("http://localhost/v1/responses", { method: "POST", signal: abort.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cli-pool/test", input: "synthetic recovery fixture", stream: options.stream ?? false, store: false }) });
    const pending = handleResponses(request, config, logCtx, { sendBudget: budget, abortSignal: abort.signal });
    if (options.manualSwitch) {
      await sent.promise;
      const current = loadConfig();
      const outcome = commitProviderApiKeySelection(current, "cli-pool", row => {
        row.apiKey = "synthetic-cli-b";
        return { changed: true, value: undefined };
      });
      expect(outcome.status).toBe("committed");
      releaseFailure.resolve();
    }
    const response = await pending;
    order.push("response");
    if (options.stallFirstEvent) releaseFailure.resolve();
    const body = await response.text();
    return { seen, errors, body, budgetUsed: budget.used, logCtx, order,
      failedSelections: [...rotate401.mock.calls, ...rotate429.mock.calls].map(call => ({
        key: call[3]?.attemptedKey, entry: call[3]?.attemptedSelection?.entryId,
        reference: call[3]?.attemptedSelection?.reference,
      })),
      active: loadConfig().providers["cli-pool"]!.apiKey,
      aCooldown: getKeyCooldownUntil("cli-pool", "a"), bCooldown: getKeyCooldownUntil("cli-pool", "b") };
  } finally {
    releaseFailure.resolve();
    abort.abort(); resolver.mockRestore(); rotate401.mockRestore(); rotate429.mockRestore();
    releaseOwner(); closeRequestHistoryIndex();
    await flushResponseState(); clearResponseStateForTests();
  }
}

describe("runTurn API-key recovery", () => {
  test.each([
    { exitCode: 1, stderr: "QoderAuthError: QODER_PERSONAL_ACCESS_TOKEN contains a token that was rejected", stream: false, status: 401 },
    { result: "You've reached your daily usage limit for Chat. Come back tomorrow...", stream: true, status: 429 },
  ])("real CLI evidence recovers %j", async fixture => {
    const result = await cliKeyRecoveryCase(fixture);
    expect(result.errors[0]).toMatchObject({ status: fixture.status, apiKeyRecovery: true });
    expect(result.errors[0]!.code).toBe(fixture.status === 401 ? "invalid_api_key"
      : "insufficient_quota");
    expect(result.seen).toEqual(["synthetic-cli-a", "synthetic-cli-b"]);
    expect(result.body).toContain("recovered on B");
    expect(result.body).not.toContain("apiKeyRecovery");
    expect(result.active).toBe("synthetic-cli-b");
    expect(result.aCooldown).not.toBeNull();
    expect(result.bCooldown).toBeNull();
    expect(result.budgetUsed).toBe(2);
  });

  test("CodeBuddy multi-key healthy stream starts SSE without key-pool preflight", async () => {
    const queueModule = await import("../../src/adapters/run-turn-queue");
    const preflight = spyOn(queueModule, "preflightAdapterEvents");
    try {
      // The CLI cannot release output until the Response exists; no timing race is involved.
      const result = await cliKeyRecoveryCase({ adapter: "codebuddy", stream: true,
        healthyFirst: true, stallFirstEvent: true, stallTimeoutSec: 1 });
      expect(preflight).not.toHaveBeenCalled();
      expect(result.order).toEqual(["response", "cli-output"]);
      expect(result.body).toContain("healthy on A");
      expect(result.seen).toEqual(["synthetic-cli-a"]);
      expect(result.errors).toEqual([]);
      expect(result.budgetUsed).toBe(1);
      expect(result.aCooldown).toBeNull();
      expect(result.bCooldown).toBeNull();
    } finally {
      preflight.mockRestore();
    }
  });

  test.each([401, 429])("late %s from sent A preserves manually selected B", async status => {
    const result = await cliKeyRecoveryCase({ manualSwitch: true, vendorCode: status === 401 ? 105 : 118 });
    expect(result.seen).toEqual(["synthetic-cli-a", "synthetic-cli-b"]);
    expect(result.active).toBe("synthetic-cli-b");
    expect(result.bCooldown).toBeNull();
    expect(result.failedSelections).toEqual([{
      key: "synthetic-cli-a", entry: "a", reference: "synthetic-cli-a",
    }]);
    // A stale revision cannot file health against the newly selected credential.
    expect(result.aCooldown).toBeNull();
    expect(result.body).toContain("recovered on B");
  });

  test("rechecks the failed key after adapter refresh before applying key recovery", async () => {
    const transportModule = await import("../../src/server/responses/request-transport");
    const prepare = transportModule.prepareResponsesTransport;
    const refreshEntered = Promise.withResolvers<void>();
    const resumeRefresh = Promise.withResolvers<void>();
    let refreshConfig: OcxConfig | undefined;
    let refreshed: { key?: string; runnable: boolean; binding: unknown } | undefined;
    let refreshes = 0;
    const transportSpy = spyOn(transportModule, "prepareResponsesTransport").mockImplementation(async (...args) => {
      const transport = await prepare(...args);
      if (transport instanceof Response) return transport;
      const refresh = transport.refreshRunTurnAdapter;
      transport.refreshRunTurnAdapter = async parsed => {
        refreshes++;
        refreshConfig = args[0].config;
        refreshEntered.resolve();
        await resumeRefresh.promise;
        const adapter = await refresh(parsed);
        // Assert outside recovery: its catch must not swallow a failed test assertion.
        refreshed = { key: args[2].route.provider.apiKey, runnable: !!adapter.runTurn,
          binding: transport.adapterBindings.get(adapter) };
        return adapter;
      };
      return transport;
    });
    const pending = cliKeyRecoveryCase({ vendorCode: 105 });
    try {
      await Promise.race([
        refreshEntered.promise,
        pending.then(() => { throw new Error("recovery completed without entering adapter refresh"); }),
      ]);
      // Rotation passed the first guard; publish the manual selection to this request and disk.
      expect(refreshConfig!.providers["cli-pool"]!.apiKey).toBe("synthetic-cli-b");
      expect(loadConfig().providers["cli-pool"]!.apiKey).toBe("synthetic-cli-b");
      expect(commitProviderApiKeySelection(refreshConfig!, "cli-pool", row => {
        row.apiKey = "synthetic-cli-a";
        return { changed: true, value: undefined };
      }).status).toBe("committed");
      resumeRefresh.resolve();
      const result = await pending;
      expect(refreshed).toMatchObject({ key: "synthetic-cli-a", runnable: true,
        binding: { kind: "api-key", provider: { apiKey: "synthetic-cli-a", _apiKeyAttempt: { entryId: "a" } } } });
      expect(refreshes).toBe(1);
      expect(result.seen).toEqual(["synthetic-cli-a"]);
      expect(result.active).toBe("synthetic-cli-a");
      expect(result.bCooldown).toBeNull();
      expect(result.body).toContain("invalid_api_key");
      // The later attempt guard also prevents sending A; only this guard refunds the unused hop.
      expect(result.budgetUsed).toBe(1);
    } finally {
      resumeRefresh.resolve();
      await pending.catch(() => {});
      transportSpy.mockRestore();
    }
  });

  test.each([
    ["Team daily usage limit reached", { result: "Team daily usage limit reached" }],
    ["This model's credit usage limit reached", { result: "This model's credit usage limit reached" }],
    ["Shared daily usage limit reached", { result: "Shared daily usage limit reached" }],
    ["999 + supported account daily text", { vendorCode: 999, result: "You've reached your daily usage limit for Chat. Come back tomorrow..." }],
    ["999 + authentication text", { vendorCode: 999, result: "invalid personal access token" }],
  ])("nonrecoverable qoder failure (%s) prevents key failover", async (_name, fixture) => {
    const result = await cliKeyRecoveryCase(fixture);
    expect(result.seen).toEqual(["synthetic-cli-a"]);
    expect(result.active).toBe("synthetic-cli-a");
    expect(result.aCooldown).toBeNull();
    expect(result.bCooldown).toBeNull();
    expect(result.budgetUsed).toBe(1);
  });

  test.each([
    { type: "text_delta", text: "already visible" },
    { type: "heartbeat", replayUnsafe: true },
  ] satisfies AdapterEvent[])("output boundary %j forbids recovery", async prefix => {
    const result = await cliKeyRecoveryCase({ prefix, stream: true });
    expect(result.seen).toEqual(["synthetic-cli-a"]);
    expect(result.aCooldown).toBeNull(); expect(result.bCooldown).toBeNull();
  });

  test.each(["total", "hop"] as const)("exhausted %s budget keeps original error and key health", async budget => {
    const result = await cliKeyRecoveryCase({ budget });
    expect(result.seen).toEqual(["synthetic-cli-a"]);
    expect(result.aCooldown).toBeNull(); expect(result.bCooldown).toBeNull();
    expect(result.body).toContain("invalid_api_key");
    expect(result.budgetUsed).toBe(1);
  });

  test("cancellation forbids recovery and cooldown", async () => {
    const result = await cliKeyRecoveryCase({ cancel: true });
    expect(result.seen).toEqual(["synthetic-cli-a"]);
    expect(result.aCooldown).toBeNull(); expect(result.bCooldown).toBeNull();
  });

  test("a single key does not replay", async () => {
    const result = await cliKeyRecoveryCase({ poolSize: 1 });
    expect(result.seen).toEqual(["synthetic-cli-a"]);
    expect(result.aCooldown).toBeNull();
    expect(result.body).toContain("invalid_api_key");
  });

  test("both keys failing stops at two physical sends", async () => {
    const result = await cliKeyRecoveryCase({ allFail: true, vendorCode: 118 });
    expect(result.seen).toEqual(["synthetic-cli-a", "synthetic-cli-b"]);
    expect(result.body).toContain("insufficient_quota");
    expect(result.aCooldown).not.toBeNull(); expect(result.bCooldown).not.toBeNull();
    expect(result.budgetUsed).toBe(2);
  });

  test("a silent first event cannot hold the SSE response past the stall bound", async () => {
    const result = await cliKeyRecoveryCase({ stream: true, vendorCode: 105, stallFirstEvent: true, stallTimeoutSec: 1 });
    expect(result.order).toEqual(["response", "cli-output"]);
    expect(result.seen).toEqual(["synthetic-cli-a", "synthetic-cli-b"]);
    expect(result.body).toContain("recovered on B");
    expect(result.aCooldown).not.toBeNull();
  });
});
