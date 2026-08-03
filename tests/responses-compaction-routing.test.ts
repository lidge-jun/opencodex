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
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import { updateAccountQuota } from "../src/codex/auth-api";
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

/** Two-account pool: the alternate-attempt tests need somewhere for the retry to go. */
function twoAccountPoolConfig(): OcxConfig {
  const config = nativePoolConfig();
  config.codexAccounts = [
    { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
    { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
  ] as OcxConfig["codexAccounts"];
  return config;
}

function compactionRequest(
  body: Record<string, unknown>,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
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

/**
 * #913: `/v1/responses` already tries one eligible alternate account inside the same
 * logical request after a pre-stream 429/402. Compact did not, so a pool rejection
 * reached the client, which retried the compact task OUTSIDE the logical request and
 * could report exhausted retries while another account sat idle.
 *
 * The send count is the activation proof throughout: one send means the branch never
 * fired, three means it recursed.
 */
describe("compact alternate-account attempt (#913)", () => {
  function withPoolEnv<T>(name: string, run: (config: OcxConfig) => Promise<T>): Promise<T> {
    const testDir = mkdtempSync(join(tmpdir(), name));
    const previousOpencodexHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = testDir;
    process.env.CODEX_HOME = testDir;
    clearCodexUpstreamHealth();
    for (const id of ["pool-a", "pool-b"]) {
      saveCodexAccountCredential(id, {
        accessToken: `${id}-access-token`,
        refreshToken: `${id}-refresh-token`,
        expiresAt: Date.now() + 300_000,
        chatgptAccountId: id === "pool-a" ? "pool_acc_a" : "pool_acc_b",
      });
    }
    return run(twoAccountPoolConfig()).finally(() => {
      globalThis.fetch = originalFetch;
      clearCodexUpstreamHealth();
      rmSync(testDir, { recursive: true, force: true });
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    });
  }

  for (const rejection of [429, 402] as const) {
    test(`a pre-body ${rejection} tries exactly one alternate account`, async () => {
      await withPoolEnv(`ocx-compact-alt-${rejection}-`, async config => {
        const bearers: string[] = [];
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
          const auth = new Headers(init?.headers).get("authorization") ?? "";
          bearers.push(auth);
          if (bearers.length === 1) {
            return Response.json({ error: { message: "pool exhausted" } }, {
              status: rejection,
              headers: { "retry-after": "42" },
            });
          }
          return jsonResponse(completedPayload("alternate compact response"));
        }) as typeof fetch;

        const res = await handleResponsesCompact(
          compactionRequest(baseCompactionBody({})),
          config,
          { model: "", provider: "" },
        );

        // Two sends, not one and not three: the alternate ran once and did not recurse.
        expect(bearers).toHaveLength(2);
        expect(bearers[0]).not.toBe(bearers[1]);
        expect(res.status).toBe(200);
      });
    });

    test(`the alternate after a ${rejection} gets one send even when it returns a transient 5xx`, async () => {
      // Activation proof for the two recovery modes. The first account keeps
      // fetchWithTransientRetry (up to three status attempts); the alternate must run
      // as a single direct send. Without `recovery: "single"` the 503 below would be
      // retried and the alternate's share of the send count would be three.
      await withPoolEnv(`ocx-compact-alt-${rejection}-5xx-`, async config => {
        const bearers: string[] = [];
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
          const auth = new Headers(init?.headers).get("authorization") ?? "";
          bearers.push(auth);
          if (bearers.length === 1) {
            return Response.json({ error: { message: "pool exhausted" } }, { status: rejection });
          }
          return Response.json({ error: { message: "upstream busy" } }, { status: 503 });
        }) as typeof fetch;

        const res = await handleResponsesCompact(
          compactionRequest(baseCompactionBody({})),
          config,
          { model: "", provider: "" },
        );

        expect(bearers).toHaveLength(2);
        expect(bearers[0]).not.toBe(bearers[1]);
        expect(res.status).toBe(503);
      });
    });
  }

  test("a bound thread at 100% local quota still sends once, with no alternate attempt", async () => {
    // The scope guard. The alternate path must trigger on an actual upstream 429/402,
    // never on a local quota reading: a cached 100% is what the affined account looked
    // like last time, not a rejection. If the gate ever widened to consult quota, this
    // request would resolve an alternate and send twice.
    await withPoolEnv("ocx-compact-quota-100-", async config => {
      const affined = resolveCodexAccountForThread("compact-quota-thread", config);
      updateAccountQuota(affined, 100);
      const bearers: string[] = [];
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        bearers.push(new Headers(init?.headers).get("authorization") ?? "");
        return jsonResponse(completedPayload("compact response at full quota"));
      }) as typeof fetch;

      const res = await handleResponsesCompact(
        compactionRequest(baseCompactionBody({}), undefined, {
          "x-codex-parent-thread-id": "compact-quota-thread",
        }),
        config,
        { model: "", provider: "" },
      );

      // Exactly one send, and the upstream succeeded, so nothing rotated.
      expect(bearers).toHaveLength(1);
      expect(res.status).toBe(200);
    });
  });

  test("with no eligible alternate the first rejection is returned with its backoff headers", async () => {
    await withPoolEnv("ocx-compact-alt-none-", async config => {
      // Single-account pool: nothing to fail over to.
      config.codexAccounts = [config.codexAccounts![0]];
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        return Response.json({ error: { message: "pool exhausted" } }, {
          status: 429,
          headers: { "retry-after": "77", "x-codex-primary-reset-at": "1900000000" },
        });
      }) as typeof fetch;

      const res = await handleResponsesCompact(
        compactionRequest(baseCompactionBody({})),
        config,
        { model: "", provider: "" },
      );

      expect(sends).toBe(1);
      expect(res.status).toBe(429);
      // The buffered response is rebuilt from scratch, so these have to be carried
      // deliberately. Dropping them left the client with no basis to back off.
      expect(res.headers.get("retry-after")).toBe("77");
      expect(res.headers.get("x-codex-primary-reset-at")).toBe("1900000000");
    });
  });

  test("when the alternate also rejects, both sends happen and its rejection is returned", async () => {
    await withPoolEnv("ocx-compact-alt-both-", async config => {
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        return Response.json({ error: { message: `rejection ${sends}` } }, {
          status: 429,
          headers: { "retry-after": String(sends) },
        });
      }) as typeof fetch;

      const res = await handleResponsesCompact(
        compactionRequest(baseCompactionBody({})),
        config,
        { model: "", provider: "" },
      );

      expect(sends).toBe(2);
      expect(res.status).toBe(429);
      // The SECOND rejection is what the client sees, headers included.
      expect(res.headers.get("retry-after")).toBe("2");
    });
  });

  test("a non-quota rejection does not trigger an alternate", async () => {
    await withPoolEnv("ocx-compact-alt-400-", async config => {
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        return Response.json({ error: { message: "bad request" } }, { status: 400 });
      }) as typeof fetch;

      const res = await handleResponsesCompact(
        compactionRequest(baseCompactionBody({})),
        config,
        { model: "", provider: "" },
      );

      // Recognition is 429/402 only, matching the regular path's deliberate narrowness.
      expect(sends).toBe(1);
      expect(res.status).toBe(400);
    });
  });

  test("an abort between attempts prevents the alternate send", async () => {
    await withPoolEnv("ocx-compact-alt-abort-", async config => {
      const abort = new AbortController();
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        abort.abort();
        return Response.json({ error: { message: "pool exhausted" } }, { status: 429 });
      }) as typeof fetch;

      await handleResponsesCompact(
        compactionRequest(baseCompactionBody({}), abort.signal),
        config,
        { model: "", provider: "" },
      );

      expect(sends).toBe(1);
    });
  });

  test("the alternate sends once even against a transient 5xx", async () => {
    // The two-mode crux. Compact's normal send wraps fetchWithTransientRetry, which
    // retries a 5xx up to three times. The alternate must NOT inherit that ladder:
    // it is a last bounded try, not a second retry stack. Without the mode split this
    // reads four sends (one from A, three from B's ladder).
    await withPoolEnv("ocx-compact-alt-single-", async config => {
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        if (sends === 1) {
          return Response.json({ error: { message: "pool exhausted" } }, { status: 429 });
        }
        return Response.json({ error: { message: "upstream flaked" } }, { status: 503 });
      }) as typeof fetch;

      const res = await handleResponsesCompact(
        compactionRequest(baseCompactionBody({})),
        config,
        { model: "", provider: "" },
      );

      expect(sends).toBe(2);
      expect(res.status).toBe(503);
    });
  });

  test("the first account keeps its transient-retry ladder", async () => {
    // The control for the test above: A's recovery is unchanged, so a transient 5xx
    // on A is still retried in place rather than treated as a reason to fail over.
    await withPoolEnv("ocx-compact-alt-ladder-", async config => {
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        if (sends === 1) return Response.json({ error: { message: "flake" } }, { status: 503 });
        return jsonResponse(completedPayload("recovered on retry"));
      }) as typeof fetch;

      const res = await handleResponsesCompact(
        compactionRequest(baseCompactionBody({})),
        config,
        { model: "", provider: "" },
      );

      // Two sends, both to A — a 503 is not 429/402, so no alternate is involved.
      expect(sends).toBe(2);
      expect(res.status).toBe(200);
    });
  });

  test("each account's health records its own outcome", async () => {
    // Attribution: A's rejection belongs to A and B's belongs to B. Recording B's
    // outcome against A would soft-avoid the wrong account and defeat the failover.
    await withPoolEnv("ocx-compact-alt-attrib-", async config => {
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        return sends === 1
          ? Response.json({ error: { message: "a exhausted" } }, { status: 429 })
          : Response.json({ error: { message: "b rejected" } }, { status: 402 });
      }) as typeof fetch;

      await handleResponsesCompact(
        compactionRequest(baseCompactionBody({})),
        config,
        { model: "", provider: "" },
      );

      const health = (id: string) => getCodexUpstreamHealth(id) as { lastFailureStatus?: number } | null;
      // Whichever account routing picked first carries the 429; the other carries B's 402.
      const statuses = ["pool-a", "pool-b"].map(id => health(id)?.lastFailureStatus).sort();
      expect(statuses).toEqual([402, 429]);
    });
  });
});
