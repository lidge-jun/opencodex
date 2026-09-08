import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { deriveXaiConvId } from "../../src/providers/xai-transport";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { managementFetch } from "../helpers/management-auth";
import { resetProviderRequestPacingForTest, setProviderRequestPacingRuntimeForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import { providerApiKeySelectionIsCurrent, resolveCurrentProviderApiKeyTransport } from "../../src/providers/api-key-selection";
import { routedProviderConfig } from "../../src/router";
import type { OcxProviderTransport } from "../../src/providers/xai-transport";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-keyfail-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-keyfail-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearKeyCooldowns();
  clearReasoningReplayCacheForTests();
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
  clearKeyCooldowns();
  clearReasoningReplayCacheForTests();
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

  test("native Chat rebuilds a queued request after a manual key selection during pacing", async () => {
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
    const server = startServer(0);
    const abort = new AbortController();
    try {
      await waitForProviderRequestSlot("paced", config.providers.paced);
      const pending = fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ model: "paced/test", stream: false, messages: [{ role: "user", content: "hello" }] }),
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
    const server = startServer(0);
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
      server = startServer(0);
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
      server = startServer(0);
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

  test("routed 429 rotates to the pool's next key and succeeds", async () => {
    const seenAuth: string[] = [];
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req) {
        seenAuth.push(req.headers.get("authorization") ?? "");
        if (seenAuth.length === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429, headers: { "retry-after": "30", "content-type": "application/json" },
          });
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
      providers: {
        pooled: {
          adapter: "openai-chat",
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
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pooled/some-model", input: "hello", stream: false }),
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { output?: { type: string; content?: { text?: string }[] }[] };
      const message = json.output?.find(o => o.type === "message");
      expect(message?.content?.[0]?.text).toBe("ok after rotate");
      expect(seenAuth[0]).toBe("Bearer key-alpha-000111222333");
      expect(seenAuth[1]).toBe("Bearer key-beta-444555666777");
    } finally {
      await server.stop(true);
    }
  });

  test("reasoning replay misses after a 429 rotates to a different physical key", async () => {
    const model = "reasoning-model";
    const callId = "call_key_rotation";
    const privateReasoning = "reasoning from physical key A";
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
    const server = startServer(0);
    const headers = {
      "content-type": "application/json",
      "x-codex-parent-thread-id": "thread-key-rotation",
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
      expect(replayed?.reasoning_content).toBe(privateReasoning);
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
    const server = startServer(0);
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
    const server = startServer(0);
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
    const server = startServer(0);
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
