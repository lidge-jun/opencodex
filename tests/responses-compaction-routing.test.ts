/**
 * Issue #422: a Responses-shaped wire does not imply support for Codex's private
 * `compaction_trigger` item. Only the canonical ChatGPT backend speaks that
 * contract; every other gateway has to be driven as a plain summarizer, or Codex
 * fatals on a compaction turn that came back as an ordinary message.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, handleResponsesCompact } from "../src/server/responses";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import {
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  clearCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import {
  releaseCodexAuthContextProbeLease,
  resolveCodexAuthContext,
} from "../src/codex/auth-context";
import { supportsNativeResponsesCompactEndpoint } from "../src/providers/openai-tiers";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function keyProviderConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    defaultProvider: "gw",
    providers: {
      gw: {
        adapter: "openai-responses",
        baseUrl: "https://gateway.example/v1",
        authMode: "key",
        apiKey: "test-key",
        ...overrides,
      },
    },
  } as unknown as OcxConfig;
}

function nativePoolConfig(): OcxConfig {
  return {
    defaultProvider: "openai",
    activeCodexAccountId: "pool-a",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: [{
      id: "pool-a",
      email: "pool@example.test",
      isMain: false,
      chatgptAccountId: "pool_acc",
    }],
  } as OcxConfig;
}

function compactionRequest(body: Record<string, unknown>, signal?: AbortSignal): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

function baseCompactionBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gw/some-model",
    stream: false,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "earlier turn" }] },
      { type: "compaction_trigger" },
    ],
    tools: [{ type: "function", name: "shell" }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    ...extra,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function completedPayload(text: string): Record<string, unknown> {
  return {
    id: "resp_1",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map(e => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("supportsNativeResponsesCompactEndpoint (#422)", () => {
  const canonicalForward = {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward",
  } as OcxProviderConfig;
  const officialApi = {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authMode: "key",
  } as OcxProviderConfig;

  test("accepts the canonical ChatGPT backend and the official OpenAI API", () => {
    expect(supportsNativeResponsesCompactEndpoint("openai", canonicalForward)).toBe(true);
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", officialApi)).toBe(true);
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", {
      ...officialApi,
      baseUrl: "https://api.openai.com/v1/",
    })).toBe(true);
  });

  test("rejects any other Responses-shaped gateway", () => {
    expect(supportsNativeResponsesCompactEndpoint("gw", {
      adapter: "openai-responses",
      baseUrl: "https://gateway.example/v1",
      authMode: "key",
    } as OcxProviderConfig)).toBe(false);
    // Right provider id, wrong destination.
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", {
      ...officialApi,
      baseUrl: "https://gateway.example/v1",
    })).toBe(false);
  });
});

describe("native Codex pool compaction", () => {
  test("keeps a Spark reset cooldown separate from a Terra compact request (#590)", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "ocx-compact-scope-"));
    const previousOpencodexHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    const config = nativePoolConfig();
    const resetAt = Math.floor((Date.now() + 4 * 24 * 60 * 60_000) / 1_000);
    let sparkPhase = true;
    try {
      process.env.OPENCODEX_HOME = testDir;
      process.env.CODEX_HOME = testDir;
      clearCodexUpstreamHealth();
      saveCodexAccountCredential("pool-a", {
        accessToken: "pool-access-token",
        refreshToken: "pool-refresh-token",
        expiresAt: Date.now() + 300_000,
        chatgptAccountId: "pool_acc",
      });
      globalThis.fetch = (async () => {
        if (sparkPhase) {
          return Response.json({ error: { message: "Spark quota exhausted" } }, {
            status: 429,
            headers: { "x-codex-primary-reset-at": String(resetAt) },
          });
        }
        return jsonResponse(completedPayload("Terra compact response"));
      }) as typeof fetch;
      const spark = await handleResponsesCompact(
        compactionRequest(baseCompactionBody({ model: "gpt-5.3-codex-spark" })),
        config,
        { model: "", provider: "" },
      );
      expect(spark.status).toBe(429);

      sparkPhase = false;
      const cooledSpark = await handleResponsesCompact(
        compactionRequest(baseCompactionBody({ model: "gpt-5.3-codex-spark" })),
        config,
        { model: "", provider: "" },
      );
      expect(cooledSpark.status).toBe(429);

      const terra = await handleResponsesCompact(
        compactionRequest(baseCompactionBody({ model: "gpt-5.6-terra" })),
        config,
        { model: "", provider: "" },
      );
      expect(terra.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
      clearCodexUpstreamHealth();
      rmSync(testDir, { recursive: true, force: true });
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  test("a cancelled Spark recovery probe releases its compact lease (#590)", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "ocx-compact-probe-"));
    const previousOpencodexHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const config = nativePoolConfig();
    const abort = new AbortController();
    let markReadStarted!: () => void;
    let releaseBody!: () => void;
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
    const bodyReleased = new Promise<void>(resolve => { releaseBody = resolve; });
    try {
      process.env.OPENCODEX_HOME = testDir;
      process.env.CODEX_HOME = testDir;
      Date.now = () => now;
      clearCodexUpstreamHealth();
      saveCodexAccountCredential("pool-a", {
        accessToken: "pool-access-token",
        refreshToken: "pool-refresh-token",
        expiresAt: now + 30 * 60_000,
        chatgptAccountId: "pool_acc",
      });
      recordCodexUpstreamOutcome(config, "pool-a", 429, {
        now,
        resetAt: Math.floor((now + 4 * 24 * 60 * 60_000) / 1_000),
        modelId: "gpt-5.3-codex-spark",
      });
      Date.now = () => probeAt;
      globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          markReadStarted();
          await bodyReleased;
          controller.enqueue(new TextEncoder().encode("{\"partial\":"));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
      const pending = handleResponsesCompact(
        compactionRequest(baseCompactionBody({ model: "gpt-5.3-codex-spark" }), abort.signal),
        config,
        { model: "", provider: "" },
      );
      await readStarted;
      abort.abort();
      releaseBody();
      const cancelled = await pending;
      expect(cancelled.status).toBe(499);

      Date.now = () => probeAt + CODEX_QUOTA_PROBE_INTERVAL_MS;
      const nextProbe = await resolveCodexAuthContext(
        new Headers({ authorization: "Bearer main-token" }),
        config,
        "pool",
        { modelId: "gpt-5.3-codex-spark" },
      );
      expect(nextProbe).toMatchObject({ probeQuotaScope: "spark" });
      releaseCodexAuthContextProbeLease(nextProbe);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
      clearCodexUpstreamHealth();
      rmSync(testDir, { recursive: true, force: true });
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  test("a Spark recovery probe releases its compact lease when connect is cancelled (#590)", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "ocx-compact-connect-probe-"));
    const previousOpencodexHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const config = nativePoolConfig();
    const abort = new AbortController();
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
    try {
      process.env.OPENCODEX_HOME = testDir;
      process.env.CODEX_HOME = testDir;
      Date.now = () => now;
      clearCodexUpstreamHealth();
      saveCodexAccountCredential("pool-a", {
        accessToken: "pool-access-token",
        refreshToken: "pool-refresh-token",
        expiresAt: now + 30 * 60_000,
        chatgptAccountId: "pool_acc",
      });
      recordCodexUpstreamOutcome(config, "pool-a", 429, {
        now,
        resetAt: Math.floor((now + 4 * 24 * 60 * 60_000) / 1_000),
        modelId: "gpt-5.3-codex-spark",
      });
      Date.now = () => probeAt;
      globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("expected compact request abort signal");
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        markFetchStarted();
      })) as typeof fetch;
      const pending = handleResponsesCompact(
        compactionRequest(baseCompactionBody({ model: "gpt-5.3-codex-spark" }), abort.signal),
        config,
        { model: "", provider: "" },
      );
      await fetchStarted;
      abort.abort();
      const cancelled = await pending;
      expect(cancelled.status).toBe(499);

      Date.now = () => probeAt + CODEX_QUOTA_PROBE_INTERVAL_MS;
      const nextProbe = await resolveCodexAuthContext(
        new Headers({ authorization: "Bearer main-token" }),
        config,
        "pool",
        { modelId: "gpt-5.3-codex-spark" },
      );
      expect(nextProbe).toMatchObject({ probeQuotaScope: "spark" });
      releaseCodexAuthContextProbeLease(nextProbe);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
      clearCodexUpstreamHealth();
      rmSync(testDir, { recursive: true, force: true });
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });
});

describe("routed compaction for key-mode openai-responses (#422)", () => {
  test("rewrites the wire: no trigger, no tools, summarizer prompt present", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse(completedPayload("handoff summary"));
    }) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(baseCompactionBody()),
      keyProviderConfig(),
      { model: "", provider: "" },
    );

    expect(bodies.length).toBe(1);
    const sent = bodies[0]!;
    const input = sent.input as Array<Record<string, unknown>>;
    // The adapter builds from _rawBody, so checking parsed.context would miss this.
    expect(input.some(item => item.type === "compaction_trigger")).toBe(false);
    expect(sent.tools).toBeUndefined();
    expect(sent.tool_choice).toBeUndefined();
    expect(sent.parallel_tool_calls).toBeUndefined();
    expect(JSON.stringify(input)).toContain("CONTEXT CHECKPOINT COMPACTION");

    const json = await res.json() as { output?: Array<{ type?: string }> };
    const compactionItems = (json.output ?? []).filter(item => item.type === "compaction");
    expect(compactionItems.length).toBe(1);
  });

  test("strips additional_tools even when top-level tools are absent", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse(completedPayload("summary"));
    }) as typeof fetch;

    const body = baseCompactionBody();
    delete body.tools;
    (body.input as unknown[]).splice(1, 0, { type: "additional_tools", tools: [{ name: "shell" }] });

    await handleResponses(compactionRequest(body), keyProviderConfig(), { model: "", provider: "" });

    const input = bodies[0]!.input as Array<Record<string, unknown>>;
    expect(input.some(item => item.type === "additional_tools")).toBe(false);
  });

  test("raw input_image never reaches the upstream", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse(completedPayload("summary"));
    }) as typeof fetch;

    const body = baseCompactionBody();
    (body.input as unknown[]).unshift({
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    });
    // Also nested inside a tool result, which the recursive strip must reach.
    (body.input as unknown[]).unshift({
      type: "function_call_output",
      output: { content: [{ type: "input_image", image_url: "data:image/png;base64,BBBB" }] },
    });

    await handleResponses(compactionRequest(body), keyProviderConfig(), { model: "", provider: "" });

    expect(JSON.stringify(bodies[0]!.input)).not.toContain("input_image");
    expect(JSON.stringify(bodies[0]!.input)).not.toContain("base64,AAAA");
  });

  test("noncanonical forward providers still get the rewrite", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse(completedPayload("summary"));
    }) as typeof fetch;

    // authMode "forward" on a non-ChatGPT base URL: an authMode check would skip the
    // rewrite here while the server still routes it as a summarizer turn.
    await handleResponses(
      compactionRequest(baseCompactionBody()),
      keyProviderConfig({ authMode: "forward" }),
      { model: "", provider: "" },
    );

    const input = bodies[0]!.input as Array<Record<string, unknown>>;
    expect(input.some(item => item.type === "compaction_trigger")).toBe(false);
    expect(bodies[0]!.tools).toBeUndefined();
  });
});

describe("compaction terminal handling (#422)", () => {
  test("an upstream failure does not become an empty compaction", async () => {
    globalThis.fetch = (async () => jsonResponse({
      id: "resp_1",
      status: "failed",
      error: { message: "upstream exploded" },
      output: [],
    })) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(baseCompactionBody()),
      keyProviderConfig(),
      { model: "", provider: "" },
    );

    const json = await res.json() as { status?: string; output?: Array<{ type?: string }> };
    expect((json.output ?? []).some(item => item.type === "compaction")).toBe(false);
  });

  test("an incomplete turn produces no compaction item", async () => {
    globalThis.fetch = (async () => jsonResponse({
      id: "resp_1",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] }],
    })) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(baseCompactionBody()),
      keyProviderConfig(),
      { model: "", provider: "" },
    );

    const json = await res.json() as { output?: Array<{ type?: string }> };
    // A truncated summary must not be installed as replacement history.
    expect((json.output ?? []).some(item => item.type === "compaction")).toBe(false);
  });

  test("streamed text is recovered from output_text.done without deltas", async () => {
    globalThis.fetch = (async () => sseResponse([
      { type: "response.output_text.done", text: "summary from done" },
      { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
    ])) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(baseCompactionBody({ stream: true })),
      keyProviderConfig(),
      { model: "", provider: "" },
    );
    const text = await res.text();

    // A delta-only parser would emit an empty compaction and silently drop the context.
    expect(text).toContain("\"type\":\"compaction\"");
  });

  test("streamed text is recovered from the completed snapshot", async () => {
    globalThis.fetch = (async () => sseResponse([
      {
        type: "response.completed",
        response: completedPayload("summary from snapshot"),
      },
    ])) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(baseCompactionBody({ stream: true })),
      keyProviderConfig(),
      { model: "", provider: "" },
    );

    expect(await res.text()).toContain("\"type\":\"compaction\"");
  });
});
