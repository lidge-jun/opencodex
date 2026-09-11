import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { sessionLaneIdFromRequest } from "../../src/server/request-log-conversation";
/**
 * Issue #422: a Responses-shaped wire does not imply support for Codex's private
 * `compaction_trigger` item. Only the canonical ChatGPT backend speaks that
 * contract; every other gateway has to be driven as a plain summarizer, or Codex
 * fatals on a compaction turn that came back as an ordinary message.
 */
import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { OPAQUE_COMPACTION_NOTE, SUMMARY_PREFIX } from "../../src/responses/compaction";
import { externalTaskInputContent } from "../../src/responses/task-input";
import { looksLikeBackendCiphertext } from "../../src/server/responses/encrypted-payload";
import * as adapterResolveModule from "../../src/server/adapter-resolve";
import * as visionModule from "../../src/vision";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import {
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  clearCodexUpstreamHealth,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThread,
} from "../../src/codex/routing";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID, MainAccountTokenRefreshError } from "../../src/codex/main-account";
import { NativeProfileError } from "../../src/codex/native-profile-types";
import { fallbackCodexAccountLogLabel } from "../../src/codex/account-label";
import * as authContextModule from "../../src/codex/auth-context";
import {
  releaseCodexAuthContextProbeLease,
  resolveCodexAuthContext,
} from "../../src/codex/auth-context";
import { clearUpstreamHostHealth } from "../../src/codex/upstream-host-health";
import { supportsNativeResponsesCompactEndpoint } from "../../src/providers/openai-tiers";
import type { RequestLogContext } from "../../src/server/request-log";
import { acquireNativeMainProfileDrain, tryAdmitTurn } from "../../src/server/lifecycle";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { clearComboRecallForTests, recallComboForLane, rememberComboForLane } from "../../src/server/responses/combo-session-recall";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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

describe("Codex auth-context error parity (#2392)", () => {
  const cases: Array<{
    label: string;
    createError: () => Error;
    status: number;
    retryAfter?: string;
    regularLog: boolean;
  }> = [
    {
      label: "account cooldown",
      createError: () => new authContextModule.CodexAccountCooldownError(
        "sensitive-account-id",
        Date.now() + 120_000,
        "retry-after",
      ),
      status: 429,
      regularLog: false,
    },
    {
      label: "native-main drain",
      createError: () => new authContextModule.CodexMainProfileDrainingError(),
      status: 503,
      retryAfter: "1",
      regularLog: false,
    },
    {
      label: "expired thread affinity",
      createError: () => new authContextModule.CodexThreadAffinityExpiredError("sensitive-account-id"),
      status: 409,
      regularLog: false,
    },
    {
      label: "pool credential refresh failure",
      createError: () => new authContextModule.CodexAuthContextError(
        "sensitive-account-id",
        new Error("private refresh detail"),
      ),
      status: 401,
      regularLog: true,
    },
    {
      label: "native-main claim contention",
      createError: () => new authContextModule.CodexAuthContextError(
        MAIN_CODEX_ACCOUNT_ID,
        new NativeProfileError(
          "NATIVE_MAIN_CLAIM_BUSY",
          "Native-main credentials are in use.",
          503,
          true,
        ),
      ),
      status: 503,
      retryAfter: "1",
      regularLog: true,
    },
    {
      label: "native-main claim timeout",
      createError: () => new authContextModule.CodexAuthContextError(
        MAIN_CODEX_ACCOUNT_ID,
        new MainAccountTokenRefreshError("transient"),
      ),
      status: 503,
      retryAfter: "1",
      regularLog: true,
    },
    {
      label: "pool authentication failure",
      createError: () => new authContextModule.CodexPoolAuthenticationError("Pool credential is unavailable"),
      status: 401,
      regularLog: false,
    },
    {
      label: "direct authentication failure",
      createError: () => new authContextModule.CodexDirectAuthenticationError(),
      status: 401,
      regularLog: false,
    },
    {
      label: "main credential substitution failure",
      createError: () => new authContextModule.CodexMainSubstitutionUnavailableError(),
      status: 401,
      regularLog: false,
    },
  ];

  function regularAuthRequest(): Request {
    return compactionRequest({ model: "gpt-5.5", input: "hello", stream: false });
  }

  function compactAuthRequest(): Request {
    return compactionRequest(baseCompactionBody({ model: "gpt-5.5" }));
  }

  test.each(cases)("maps $label identically on regular and compact Responses", async testCase => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return jsonResponse(completedPayload("unexpected upstream response"));
    }) as typeof fetch;
    const error = testCase.createError();
    const authSpy = spyOn(authContextModule, "resolveCodexAuthContext").mockRejectedValue(error);
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const regular = await handleResponses(regularAuthRequest(), nativePoolConfig(), { model: "", provider: "" });
      const regularLogCount = errorLog.mock.calls.length;
      const compact = await handleResponsesCompact(compactAuthRequest(), nativePoolConfig(), { model: "", provider: "" });

      expect(regular.status).toBe(testCase.status);
      expect(compact.status).toBe(testCase.status);
      expect(regular.headers.get("content-type")).toBe("application/json");
      expect(compact.headers.get("content-type")).toBe("application/json");
      expect(await regular.text()).toBe(await compact.text());
      expect(compact.headers.get("retry-after")).toBe(regular.headers.get("retry-after"));
      if (testCase.retryAfter) expect(regular.headers.get("retry-after")).toBe(testCase.retryAfter);
      if (testCase.label === "account cooldown") expect(regular.headers.get("retry-after")).not.toBeNull();
      if (testCase.label === "main credential substitution failure") expect(upstreamCalls).toBe(0);

      expect(regularLogCount).toBe(testCase.regularLog ? 1 : 0);
      expect(errorLog.mock.calls.length).toBe(regularLogCount);
      if (testCase.regularLog) {
        const line = errorLog.mock.calls[0]!.join(" ");
        expect(line).toContain("[codex-auth] Pool account openai token failed; reauthentication required");
        expect(line).not.toContain("sensitive-account-id");
        expect(line).not.toContain("private refresh detail");
      }
    } finally {
      errorLog.mockRestore();
      authSpy.mockRestore();
    }
  });

  test("unknown auth-resolution errors reject on both handlers instead of being mapped", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return jsonResponse(completedPayload("unexpected upstream response"));
    }) as typeof fetch;
    const authSpy = spyOn(authContextModule, "resolveCodexAuthContext");
    try {
      const regularError = new Error("unmapped regular auth failure");
      authSpy.mockRejectedValueOnce(regularError);
      await expect(handleResponses(
        regularAuthRequest(),
        nativePoolConfig(),
        { model: "", provider: "" },
      )).rejects.toBe(regularError);

      const compactError = new Error("unmapped compact auth failure");
      authSpy.mockRejectedValueOnce(compactError);
      await expect(handleResponsesCompact(
        compactAuthRequest(),
        nativePoolConfig(),
        { model: "", provider: "" },
      )).rejects.toBe(compactError);
      expect(upstreamCalls).toBe(0);
    } finally {
      authSpy.mockRestore();
    }
  });
});

describe("native compact usage reporting", () => {
  test("the buffered upstream body fills the request log usage and stays intact for the client", async () => {
    const config = {
      defaultProvider: "openai-apikey",
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          apiKey: "sk-test",
        },
      },
    } as unknown as OcxConfig;
    globalThis.fetch = (async () => jsonResponse(completedPayload("native summary"))) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponsesCompact(
      compactionRequest(baseCompactionBody({ model: "openai-apikey/gpt-5.5" })),
      config,
      logCtx,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { usage?: Record<string, unknown> };
    expect(body.usage).toMatchObject({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    expect(logCtx.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  test("main-pool and legacy added accounts carry their effective usage labels", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "ocx-compact-account-label-"));
    const previousOpencodexHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = testDir;
    process.env.CODEX_HOME = testDir;
    try {
      const mainConfig = nativePoolConfig();
      mainConfig.codexAccounts = [];
      mainConfig.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
      writeFileSync(join(testDir, "auth.json"), JSON.stringify({
        tokens: { access_token: "main-access-token", account_id: "main-account" },
      }));
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 0);
      globalThis.fetch = (async () => jsonResponse(completedPayload("main compact"))) as typeof fetch;
      const mainLog: RequestLogContext = { model: "", provider: "" };
      expect((await handleResponsesCompact(compactionRequest(baseCompactionBody({})), mainConfig, mainLog)).status).toBe(200);
      expect(mainLog.accountLogLabel).toBe("main");

      const poolConfig = nativePoolConfig();
      saveCodexAccountCredential("pool-a", {
        accessToken: "pool-access-token",
        refreshToken: "pool-refresh-token",
        expiresAt: Date.now() + 300_000,
        chatgptAccountId: "pool_acc",
      });
      updateAccountQuota("pool-a", 0);
      const poolLog: RequestLogContext = { model: "", provider: "" };
      expect((await handleResponsesCompact(compactionRequest(baseCompactionBody({})), poolConfig, poolLog)).status).toBe(200);
      expect(poolLog.accountLogLabel).toBe(fallbackCodexAccountLogLabel("pool-a"));
    } finally {
      globalThis.fetch = originalFetch;
      clearAccountQuota();
      removeTreeWithRetry(testDir);
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
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
      globalThis.fetch = (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/backend-api/codex/models") {
          const accountId = request.headers.get("chatgpt-account-id");
          const slugs = accountId === "pool_acc" ? ["gpt-5.6-terra"] : [];
          return Response.json({
            models: slugs.map(slug => ({ slug, supported_in_api: true, visibility: "list" })),
          });
        }
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
      removeTreeWithRetry(testDir);
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
      removeTreeWithRetry(testDir);
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
      removeTreeWithRetry(testDir);
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
      compactionRequest(baseCompactionBody({
        text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
      })),
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
    // The summarizer must stay prose: a surviving text.format would force schema JSON.
    expect(sent.text).toBeUndefined();
    expect(JSON.stringify(input)).toContain("CONTEXT CHECKPOINT COMPACTION");

    const json = await res.json() as { output?: Array<{ type?: string }> };
    const compactionItems = (json.output ?? []).filter(item => item.type === "compaction");
    expect(compactionItems.length).toBe(1);
  });

  test("routed chat compaction drops the structured-output format", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse({
        choices: [{ index: 0, message: { role: "assistant", content: "handoff summary" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(baseCompactionBody({ text: { format: { type: "json_object" } } })),
      keyProviderConfig({ adapter: "openai-chat" }),
      { model: "", provider: "" },
    );

    expect(bodies.length).toBe(1);
    // The compaction turn is a prose summary; the caller's structured-output request must not
    // constrain it (core.ts routedCompaction deletes options.textFormat).
    expect(bodies[0]!.response_format).toBeUndefined();
    const json = await res.json() as { output?: Array<{ type?: string }> };
    expect((json.output ?? []).filter(item => item.type === "compaction").length).toBe(1);
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

describe("bare native compaction model without canonical openai (#2901)", () => {
  /** A GitHub-Copilot-style operator: one third-party provider, no `openai` row at all. */
  function copilotOnlyConfig(): OcxConfig {
    return {
      defaultProvider: "gw",
      providers: {
        gw: {
          adapter: "openai-chat",
          baseUrl: "https://api.githubcopilot.com",
          authMode: "key",
          apiKey: "ghu_test",
          models: ["gpt-5.6-sol"],
        },
      },
    } as unknown as OcxConfig;
  }

  function chatCompletionPayload(text: string): Record<string, unknown> {
    return {
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }

  test("v2 compaction_trigger turn summarizes through the default provider instead of 404", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return jsonResponse(chatCompletionPayload("handoff summary"));
    }) as typeof fetch;

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const res = await handleResponses(
      compactionRequest(baseCompactionBody({ model: "gpt-5.6-sol" })),
      copilotOnlyConfig(),
      logCtx,
    );

    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url.startsWith("https://api.githubcopilot.com")).toBe(true);
    expect(calls[0]!.body.model).toBe("gpt-5.6-sol");
    // Still the summarizer contract: no private trigger leaks to the third-party gateway.
    expect(JSON.stringify(calls[0]!.body)).not.toContain("compaction_trigger");
    expect(JSON.stringify(calls[0]!.body.messages)).toContain("CONTEXT CHECKPOINT COMPACTION");
    expect(logCtx.provider).toBe("gw");
    expect(logCtx.routeDecision?.selected).toMatchObject({ provider: "gw", reason: "compaction-default-provider" });
    const json = await res.json() as { output?: Array<{ type?: string }> };
    expect((json.output ?? []).filter(item => item.type === "compaction").length).toBe(1);
  });

  test("v1 /responses/compact takes the same fallback", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return jsonResponse(chatCompletionPayload("handoff summary"));
    }) as typeof fetch;

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const res = await handleResponsesCompact(
      compactionRequest(baseCompactionBody({ model: "gpt-5.6-sol" })),
      copilotOnlyConfig(),
      logCtx,
    );

    expect(res.status).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(logCtx.provider).toBe("gw");
    expect(logCtx.requestedModel).toBe("gpt-5.6-sol");
  });

  test("ordinary turns on the same config keep the canonical-openai reservation", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return jsonResponse(chatCompletionPayload("must not be reached"));
    }) as typeof fetch;

    const body = baseCompactionBody({ model: "gpt-5.6-sol" });
    body.input = (body.input as Array<Record<string, unknown>>).filter(item => item.type !== "compaction_trigger");
    const res = await handleResponses(compactionRequest(body), copilotOnlyConfig(), { model: "", provider: "" });

    expect(res.status).toBe(404);
    expect(upstreamCalls).toBe(0);
  });

  test("an account-qualified native selector still fails closed on compaction", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return jsonResponse(chatCompletionPayload("must not be reached"));
    }) as typeof fetch;

    const config = copilotOnlyConfig();
    (config as { codexAccountNamespaces?: Record<string, string> }).codexAccountNamespaces = { side: "side-account-id" };
    const res = await handleResponsesCompact(
      compactionRequest(baseCompactionBody({ model: "side/gpt-5.6-sol" })),
      config,
      { model: "", provider: "" },
    );

    expect(res.status).toBe(404);
    expect(upstreamCalls).toBe(0);
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
    clearUpstreamHostHealth();
    clearAccountQuota();
    for (const id of ["pool-a", "pool-b"]) {
      saveCodexAccountCredential(id, {
        accessToken: `${id}-access-token`,
        refreshToken: `${id}-refresh-token`,
        expiresAt: Date.now() + 300_000,
        chatgptAccountId: id === "pool-a" ? "pool_acc_a" : "pool_acc_b",
      });
      updateAccountQuota(id, id === "pool-a" ? 10 : 20);
    }
    return run(twoAccountPoolConfig()).finally(() => {
      globalThis.fetch = originalFetch;
      clearCodexUpstreamHealth();
      clearUpstreamHostHealth();
      clearAccountQuota();
      removeTreeWithRetry(testDir);
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    });
  }

  for (const version of ["v1", "v2"] as const) {
    test(`${version} recalled native combo reselects the current account and respects admission refusal`, async () => {
      await withPoolEnv("ocx-combo-recall-account-", async config => {
        clearComboRecallForTests();
        clearComboSelectionState();
        clearComboTargetCooldowns();
        config.combos = { native: { targets: [{ provider: "openai", model: "gpt-5.5" }] } };
        config.codexAccountNamespaces = { side: "pool-a" };
        const headers = { session_id: "account-recall" };
        const accounts: Array<string | null> = [];
        // Fix the selected account deterministically while retaining the real credential
        // and admission owner; an explicit namespace still owns its account selection.
        const resolver = authContextModule.resolveCodexAuthContext;
        const authSpy = spyOn(authContextModule, "resolveCodexAuthContext").mockImplementation(
          (incoming, liveConfig, mode, options = {}) => resolver(incoming, liveConfig, mode, {
            ...options, accountId: options.accountId ?? liveConfig.activeCodexAccountId,
          }),
        );
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          accounts.push(request.headers.get("chatgpt-account-id"));
          const body = await request.json() as { input?: Array<{ type?: string }> };
          if (request.url.endsWith("/responses/compact")) {
            return jsonResponse({ output: [{ type: "compaction", encrypted_content: "native-recall-ciphertext" }] });
          }
          const compact = Array.isArray(body.input) && body.input.some(item => item.type === "compaction_trigger");
          return sseResponse([{ type: "response.completed", response: {
            ...completedPayload("native answer"), model: "gpt-5.5",
            ...(compact ? { output: [{ type: "compaction", encrypted_content: "native-recall-ciphertext" }] } : {}),
          } }]);
        }) as typeof fetch;
        const client = new AbortController();
        let completionTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          let complete!: () => void;
          const completed = new Promise<void>(resolve => { complete = resolve; });
          const seedWork = (async () => {
            const seed = await handleResponses(compactionRequest({ model: "combo/native", stream: true, input: "hello" }, client.signal, headers),
              config, { model: "", provider: "" }, { onResponseComplete: complete, abortSignal: client.signal });
            expect(seed.status).toBe(200);
            await seed.text();
            await completed;
          })();
          await Promise.race([
            seedWork,
            new Promise<never>((_, reject) => {
              completionTimer = setTimeout(() => reject(new Error("native combo seed did not complete")), 10_000);
            }),
          ]);
          clearTimeout(completionTimer);
          completionTimer = undefined;
          expect(recallComboForLane(config, sessionLaneIdFromRequest(new Headers({ session_id: "account-recall" })), "gpt-5.5")).toBe("native");
          config.activeCodexAccountId = "pool-b";
          const compact = version === "v1" ? handleResponsesCompact : handleResponses;
          const log: RequestLogContext = { model: "", provider: "" };
          const response = await compact(compactionRequest(baseCompactionBody({ model: "gpt-5.5", stream: true }), client.signal, headers), config, log);
          expect(response.status).toBe(200);
          await response.text();
          expect(log.comboId).toBe("native");
          expect(accounts).toEqual(["pool_acc_a", "pool_acc_b"]);

          const explicitLog: RequestLogContext = { model: "", provider: "" };
          const explicit = await compact(compactionRequest(baseCompactionBody({ model: "side/gpt-5.5", stream: true }), client.signal, headers), config, explicitLog);
          expect(explicit.status).toBe(200);
          await explicit.text();
          expect(explicitLog.comboId).toBeUndefined();
          expect(accounts.at(-1)).toBe("pool_acc_a");
          const sends = accounts.length;
          authSpy.mockRejectedValue(new authContextModule.CodexMainProfileDrainingError());
          const refused = await compact(compactionRequest(baseCompactionBody({ model: "gpt-5.5", stream: true }), client.signal, headers), config, { model: "", provider: "" });
          expect(refused.status).toBe(503);
          expect(accounts).toHaveLength(sends);
        } finally {
          if (completionTimer !== undefined) clearTimeout(completionTimer);
          client.abort();
          authSpy.mockRestore();
          clearComboRecallForTests();
          clearComboSelectionState();
          clearComboTargetCooldowns();
        }
      });
    });
  }

  for (const [model, account] of [["gpt-5.5", "pool-a"], ["side/gpt-5.5", "pool-b"]] as const) {
    test(`native 404 falls back to canonical SSE with ${model} account and session identity`, async () => {
      await withPoolEnv("ocx-compact-404-canonical-", async config => {
        config.codexAccountNamespaces = { side: "pool-b" };
        const item = { type: "compaction", id: "cmp_native_3769", encrypted_content: "native-opaque-3769" };
        const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          calls.push({ url: request.url, headers: request.headers, body: await request.json() as Record<string, unknown> });
          if (request.url.endsWith("/responses/compact")) return Response.json({ detail: "Not Found" }, { status: 404 });
          return sseResponse([{ type: "response.completed", response: {
            id: "resp_compact_3769", status: "completed", output: [item],
          } }]);
        }) as typeof fetch;
        const headers = { "session-id": "compact-3769-session", "thread-id": `compact-3769-${account}`, "x-codex-parent-thread-id": "compact-3769-parent" };
        const response = await handleResponsesCompact(compactionRequest({
          model, input: [{ role: "user", content: "retain this history" }],
        }, undefined, headers), config, { model: "", provider: "" });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toEqual({ output: [item] });
        expect(calls.map(call => call.url)).toEqual([
          "https://chatgpt.com/backend-api/codex/responses/compact",
          "https://chatgpt.com/backend-api/codex/responses",
        ]);
        expect(calls[1]!.body.stream).toBe(true);
        expect(calls[1]!.body.model).toBe("gpt-5.5");
        expect((calls[1]!.body.input as Array<{ type?: string }>).filter(value => value.type === "compaction_trigger")).toHaveLength(1);
        for (const call of calls) {
          expect(call.headers.get("authorization")).toBe(`Bearer ${account}-access-token`);
          expect(call.headers.get("chatgpt-account-id")).toBe(account === "pool-a" ? "pool_acc_a" : "pool_acc_b");
          for (const [name, value] of Object.entries(headers)) expect(call.headers.get(name)).toBe(value);
        }
      });
    });
  }

  test("official key-auth native 404 decodes synthetic fallback into replacement user history", async () => {
    const config = { providers: { "openai-apikey": {
      adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key", apiKey: "test-key",
    } } } as OcxConfig;
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({ url: request.url, body: await request.json() as Record<string, unknown> });
      return request.url.endsWith("/responses/compact")
        ? Response.json({ detail: "Not Found" }, { status: 404 })
        : jsonResponse(completedPayload("handoff-3769"));
    }) as typeof fetch;
    const response = await handleResponsesCompact(compactionRequest({
      model: "openai-apikey/gpt-5.5", input: [{ role: "user", content: "retain-3769" }],
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
    }), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "retain-3769" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nhandoff-3769` }] },
    ] });
    expect(calls.map(call => call.url)).toEqual(["https://api.openai.com/v1/responses/compact", "https://api.openai.com/v1/responses"]);
    expect(calls[1]!.body.tools).toBeUndefined();
    expect(JSON.stringify(calls[1]!.body.input)).not.toContain("compaction_trigger");
    expect(JSON.stringify(calls[1]!.body.input)).toContain("CONTEXT CHECKPOINT COMPACTION");
  });

  for (const status of [200, 400]) {
    test(`native compact ${status} retains its body without the 404 fallback`, async () => {
      await withPoolEnv("ocx-compact-404-control-", async config => {
        const payload = status === 200 ? { output: [{ type: "compaction", encrypted_content: "native-control" }] } : { error: { message: "invalid compact" } };
        const urls: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
          urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
          return Response.json(payload, { status });
        }) as typeof fetch;
        const response = await handleResponsesCompact(compactionRequest({ model: "gpt-5.5", input: [] }), config, { model: "", provider: "" });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(payload);
        expect(urls).toEqual(["https://chatgpt.com/backend-api/codex/responses/compact"]);
      });
    });
  }

  for (const status of ["failed", "incomplete"] as const) {
    test(`native 404 followed by ${status} SSE does not install replacement history`, async () => {
      await withPoolEnv("ocx-compact-404-terminal-", async config => {
        let calls = 0;
        globalThis.fetch = (async () => {
          calls++;
          if (calls === 1) return Response.json({ detail: "Not Found" }, { status: 404 });
          return sseResponse([{ type: `response.${status}`, response: {
            id: "resp_compact_rejected_3769", status, output: [],
          } }]);
        }) as typeof fetch;
        const response = await handleResponsesCompact(compactionRequest({ model: "gpt-5.5", input: [] }), config, { model: "", provider: "" });
        expect(response.status).toBe(502);
        const payload = await response.json() as { output?: unknown; error?: unknown };
        expect(payload.output).toBeUndefined();
        expect(payload.error).toBeDefined();
        expect(calls).toBe(2);
      });
    });
  }

  test("404 fallback records the compaction serving account for subsequent opaque replay", async () => {
    await withPoolEnv("ocx-compact-404-replay-", async config => {
      config.codexAccountNamespaces = { side: "pool-b", first: "pool-a" };
      const headers = { "thread-id": `compact-replay-${crypto.randomUUID()}` };
      const item = { type: "compaction", encrypted_content: "native-account-b-3769" };
      const calls: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
      let compacting = false;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/responses/compact")) return Response.json({ detail: "Not Found" }, { status: 404 });
        calls.push({ body: await request.json() as Record<string, unknown>, headers: request.headers });
        return sseResponse([{ type: "response.completed", response: compacting
          ? { id: "resp_identity_compact_3769", status: "completed", output: [item] }
          : completedPayload("ordinary turn") }]);
      }) as typeof fetch;
      const turn = async (model: string, input: unknown[]) => {
        const response = await handleResponses(compactionRequest({ model, input, stream: true, store: false }, undefined, headers), config, { model: "", provider: "" });
        expect(response.status).toBe(200);
        await response.text();
      };
      await turn("first/gpt-5.5", [{ role: "user", content: "seed account A" }]);
      compacting = true;
      const compact = await handleResponsesCompact(compactionRequest({ model: "side/gpt-5.5", input: [{ role: "user", content: "compact on B" }] }, undefined, headers), config, { model: "", provider: "" });
      expect(compact.status).toBe(200);
      const output = (await compact.json() as { output: unknown[] }).output;
      expect(output).toEqual([item]);
      compacting = false;
      await turn("side/gpt-5.5", [...output, { role: "user", content: "continue on B" }]);
      expect(calls.at(-1)!.headers.get("authorization")).toBe("Bearer pool-b-access-token");
      expect(JSON.stringify(calls.at(-1)!.body.input)).toContain("native-account-b-3769");
      await turn("first/gpt-5.5", [...output, { role: "user", content: "switch back to A" }]);
      expect(calls.at(-1)!.headers.get("authorization")).toBe("Bearer pool-a-access-token");
      expect(JSON.stringify(calls.at(-1)!.body.input)).not.toContain("native-account-b-3769");
      expect(JSON.stringify(calls.at(-1)!.body.input)).toContain(OPAQUE_COMPACTION_NOTE);
      expect(calls).toHaveLength(4);
    });
  });

  test("native compact headers followed by a stalled body return 504 without retry and release account cleanup", async () => {
    await withPoolEnv("ocx-compact-body-deadline-", async config => {
      config.stallTimeoutSec = 2;
      const readStarted = Promise.withResolvers<void>();
      let sends = 0;
      let cancelled = 0;
      let acceptedBody = false;
      const body = new ReadableStream<Uint8Array>({
        pull() { readStarted.resolve(); },
        cancel() { cancelled++; return new Promise<void>(() => {}); },
      }, { highWaterMark: 0 });
      globalThis.fetch = (async () => {
        sends++;
        return new Response(body, { headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const releaseSpy = spyOn(authContextModule, "releaseCodexAuthContextProbeLease");
      const client = new AbortController();
      // Same scoped, non-concurrent Bun timer control as responses/ws-upstream.test.ts.
      jest.useFakeTimers();
      const pending = handleResponsesCompact(
        compactionRequest({ model: "gpt-5.5", input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "earlier turn" }] },
        ] }, client.signal), config, { model: "", provider: "" },
        undefined, undefined, { onRequestBodyRead: () => { acceptedBody = true; } },
      );
      try {
        await Promise.race([
          readStarted.promise,
          pending.then(response => { throw new Error(`compact returned ${response.status} before reading its body`); }),
        ]);
        expect(acceptedBody).toBe(true);
        expect(sends).toBe(1);
        jest.advanceTimersByTime(2_000);
        const response = await pending;
        expect(response.status).toBe(504);
        expect(await response.json()).toMatchObject({ error: { code: "upstream_stall_timeout" } });
        expect(sends).toBe(1);
        expect(cancelled).toBe(1);
        expect(body.locked).toBe(false);
        expect(releaseSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: "pool", accountId: "pool-a" }));
      } finally {
        client.abort();
        try { await pending; } finally {
          jest.clearAllTimers();
          jest.useRealTimers();
          releaseSpy.mockRestore();
        }
      }
    });
  });

  test("canonical trailing slashes are pinned before native compact sends pool credentials", async () => {
    await withPoolEnv("ocx-compact-canonical-url-", async config => {
      config.providers.openai!.baseUrl = "https://chatgpt.com/backend-api/codex///";
      let observedUrl = "";
      let observedHeaders = new Headers();
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        observedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        observedHeaders = new Headers(init?.headers);
        return jsonResponse(completedPayload("canonical compact response"));
      }) as typeof fetch;

      const res = await handleResponsesCompact(
        compactionRequest(baseCompactionBody({ model: "gpt-5.5" })),
        config,
        { model: "", provider: "" },
      );

      expect(res.status).toBe(200);
      expect(observedUrl).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
      expect(observedHeaders.get("authorization")).toBe("Bearer pool-a-access-token");
      expect(observedHeaders.get("chatgpt-account-id")).toBe("pool_acc_a");
    });
  });

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

        const logCtx: RequestLogContext = { model: "", provider: "" };
        const res = await handleResponsesCompact(
          compactionRequest(baseCompactionBody({})),
          config,
          logCtx,
        );

        // Two sends, not one and not three: the alternate ran once and did not recurse.
        expect(bearers).toEqual(["Bearer pool-a-access-token", "Bearer pool-b-access-token"]);
        expect(res.status).toBe(200);
        expect(logCtx.accountLogLabel).toBe(fallbackCodexAccountLogLabel("pool-b"));
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

    test(`an exact account selector preserves the original ${rejection} without an alternate send`, async () => {
      await withPoolEnv(`ocx-compact-exact-${rejection}-`, async config => {
        config.codexAccountNamespaces = { side: "pool-a" };
        const bearers: string[] = [];
        const accountIds: string[] = [];
        const body = JSON.stringify({ error: { message: "selected account exhausted" } });
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          bearers.push(headers.get("authorization") ?? "");
          accountIds.push(headers.get("chatgpt-account-id") ?? "");
          return new Response(body, {
            status: rejection,
            headers: {
              "content-type": "application/json",
              "retry-after": "42",
              "x-codex-primary-reset-at": "1900000000",
            },
          });
        }) as typeof fetch;

        const res = await handleResponsesCompact(
          compactionRequest(baseCompactionBody({ model: "side/gpt-5.5" })),
          config,
          { model: "", provider: "" },
        );

        expect(bearers).toEqual(["Bearer pool-a-access-token"]);
        expect(accountIds).toEqual(["pool_acc_a"]);
        expect(res.status).toBe(rejection);
        expect(res.headers.get("retry-after")).toBe("42");
        expect(res.headers.get("x-codex-primary-reset-at")).toBe("1900000000");
        expect(await res.text()).toBe(body);
        expect(config.activeCodexAccountId).toBe("pool-a");
        expect(getCodexUpstreamHealth("pool-b")).toBeNull();
      });
    });
  }

  test("a native-main drain starting between attempts preserves the first rejection", async () => {
    await withPoolEnv("ocx-compact-alt-main-drain-", async config => {
      // Keep native main as A's only alternate. This makes the fixture fail closed
      // only when the second auth selection receives the same admitted-turn lease.
      config.codexAccounts = [config.codexAccounts![0]!];
      config.activeCodexAccountId = "pool-a";
      writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({
        tokens: {
          access_token: "main-access-token",
          account_id: "main-account",
        },
      }));
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 0);

      const turn = tryAdmitTurn();
      expect(turn).not.toBeNull();
      let profileDrain: ReturnType<typeof acquireNativeMainProfileDrain> = null;
      const accounts: Array<string | null> = [];
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        accounts.push(new Headers(init?.headers).get("chatgpt-account-id"));
        if (accounts.length === 1) {
          profileDrain = acquireNativeMainProfileDrain("compact-between-attempts");
          expect(profileDrain).not.toBeNull();
          return Response.json({ error: { message: "pool exhausted" } }, {
            status: 429,
            headers: { "retry-after": "47" },
          });
        }
        return jsonResponse(completedPayload("unexpected native-main alternate"));
      }) as typeof fetch;

      try {
        const res = await handleResponsesCompact(
          compactionRequest(baseCompactionBody({})),
          config,
          { model: "", provider: "" },
          turn!,
        );

        expect(accounts).toEqual(["pool_acc_a"]);
        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("47");
      } finally {
        profileDrain?.release();
        turn?.release();
      }
    });
  });

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

  test("a quota-blocked previous-model compact retries the same thread's successful routed handoff target (#2723)", async () => {
    await withPoolEnv("ocx-compact-routed-handoff-", async config => {
      config.providers.deepseek = {
        adapter: "openai-chat",
        baseUrl: "https://api.deepseek.com",
        authMode: "key",
        apiKey: "deepseek-test-key",
        models: ["deepseek-v4-flash"],
      };
      config.providers["openai-apikey"] = {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        apiKey: "openai-test-key",
        models: ["gpt-5.6-sol"],
      };
      const headers = { "x-codex-parent-thread-id": "compact-routed-handoff-thread" };
      const calls: Array<{ model: string; nativeCompact: boolean }> = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        const nativeCompact = url.endsWith("/responses/compact");
        calls.push({ model: body.model ?? "", nativeCompact });
        if (nativeCompact) {
          return Response.json({ error: { message: "The usage limit has been reached" } }, {
            status: 502,
          });
        }
        return jsonResponse(completedPayload("DeepSeek handoff summary"));
      }) as typeof fetch;

      const manual = await handleResponsesCompact(
        compactionRequest(
          baseCompactionBody({ model: "deepseek/deepseek-v4-flash" }),
          undefined,
          headers,
        ),
        config,
        { model: "", provider: "" },
      );
      expect(manual.status).toBe(200);
      expect(calls).toEqual([{ model: "deepseek-v4-flash", nativeCompact: false }]);
      calls.length = 0;

      const unrelated = await handleResponsesCompact(
        compactionRequest(
          baseCompactionBody({ model: "openai-apikey/gpt-5.6-sol" }),
          undefined,
          { "x-codex-parent-thread-id": "different-compact-thread" },
        ),
        config,
        { model: "", provider: "" },
      );
      expect(unrelated.status).toBe(502);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(call => call.model === "gpt-5.6-sol" && call.nativeCompact)).toBe(true);
      calls.length = 0;

      const logCtx: RequestLogContext = { model: "", provider: "" };
      const automatic = await handleResponsesCompact(
        compactionRequest(
          baseCompactionBody({ model: "openai-apikey/gpt-5.6-sol" }),
          undefined,
          headers,
        ),
        config,
        logCtx,
      );

      expect(automatic.status).toBe(200);
      const output = await automatic.json() as { output?: unknown[] };
      expect(output.output?.length).toBeGreaterThan(0);
      expect(logCtx.provider).toBe("deepseek");
      expect(calls.at(-1)).toEqual({ model: "deepseek-v4-flash", nativeCompact: false });
      expect(calls.slice(0, -1).length).toBeGreaterThan(0);
      expect(calls.slice(0, -1).every(call => (
        call.model === "gpt-5.6-sol" && call.nativeCompact
      ))).toBe(true);
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

  test("a pre-send build failure releases the Codex probe lease with host circuit disabled", async () => {
    await withPoolEnv("ocx-regular-build-probe-release-", async config => {
      config.upstreamHostCircuitThreshold = 0;
      const probeAuth = {
        kind: "pool" as const,
        accountId: "pool-a",
        writerGeneration: 1,
        generation: 1,
        accessToken: "probe-token",
        chatgptAccountId: "pool_acc_a",
        probeLeaseId: "probe-lease",
        quotaScope: "shared" as const,
      };
      const authSpy = spyOn(authContextModule, "resolveCodexAuthContext").mockResolvedValue(probeAuth);
      const releaseSpy = spyOn(authContextModule, "releaseCodexAuthContextProbeLease");
      const adapterSpy = spyOn(adapterResolveModule, "resolveAdapter").mockReturnValue({
        name: "openai-responses",
        passthrough: true,
        buildRequest: async () => { throw new Error("synthetic build failure"); },
      } as ReturnType<typeof adapterResolveModule.resolveAdapter>);
      try {
        const request = new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: false }),
        });
        await expect(handleResponses(request, config, { model: "", provider: "" }))
          .rejects.toThrow("synthetic build failure");
        expect(releaseSpy).toHaveBeenCalledWith(probeAuth);
      } finally {
        adapterSpy.mockRestore();
        releaseSpy.mockRestore();
        authSpy.mockRestore();
      }
    });
  });

  test("an opt-in regular circuit blocks before selecting another pool account", async () => {
    await withPoolEnv("ocx-regular-host-circuit-", async config => {
      config.upstreamHostCircuitThreshold = 1;
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      }) as typeof fetch;

      const request = () => new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: false }),
      });
      const authSpy = spyOn(authContextModule, "resolveCodexAuthContext");
      try {
        const first = await handleResponses(request(), config, { model: "", provider: "" });
        const selectionsAfterFirst = authSpy.mock.calls.length;
        const second = await handleResponses(request(), config, { model: "", provider: "" });
        expect(first.status).toBe(502);
        expect(second.status).toBe(503);
        expect(second.headers.get("retry-after")).toBe("30");
        expect(sends).toBe(1);
        expect(authSpy.mock.calls.length).toBe(selectionsAfterFirst);
        expect(getCodexUpstreamHealth("pool-a")).toBeNull();
        expect(getCodexUpstreamHealth("pool-b")).toBeNull();
      } finally {
        authSpy.mockRestore();
      }
    });
  });

  test("an opt-in compact circuit blocks before selecting another pool account", async () => {
    await withPoolEnv("ocx-compact-host-circuit-", async config => {
      config.upstreamHostCircuitThreshold = 1;
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      }) as typeof fetch;

      const authSpy = spyOn(authContextModule, "resolveCodexAuthContext");
      try {
        const first = await handleResponsesCompact(
          compactionRequest(baseCompactionBody({})),
          config,
          { model: "", provider: "" },
        );
        const selectionsAfterFirst = authSpy.mock.calls.length;
        const second = await handleResponsesCompact(
          compactionRequest(baseCompactionBody({})),
          config,
          { model: "", provider: "" },
        );
        expect(first.status).toBe(502);
        expect(second.status).toBe(503);
        expect(second.headers.get("retry-after")).toBe("30");
        expect(sends).toBe(1);
        expect(authSpy.mock.calls.length).toBe(selectionsAfterFirst);
        expect(getCodexUpstreamHealth("pool-a")).toBeNull();
        expect(getCodexUpstreamHealth("pool-b")).toBeNull();
      } finally {
        authSpy.mockRestore();
      }
    });
  });
});

describe("compaction combo recall after combo switch (#3891)", () => {
  afterEach(() => clearComboRecallForTests());

  function comboTestConfig(): OcxConfig {
    return {
      defaultProvider: "gw",
      providers: {
        gw: {
          adapter: "openai-chat",
          baseUrl: "https://gw-primary.example/v1",
          authMode: "key",
          apiKey: "key-gw",
          models: ["gpt-5.6-terra"],
        },
        alt: {
          adapter: "openai-chat",
          baseUrl: "https://gw-alt.example/v1",
          authMode: "key",
          apiKey: "key-alt",
          models: ["gpt-5.6-luna"],
        },
      },
      combos: {
        terra: { strategy: "failover", targets: [{ provider: "gw", model: "gpt-5.6-terra" }] },
      },
    } as unknown as OcxConfig;
  }

  function chatCompletionPayload(text: string): Record<string, unknown> {
    return {
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }

  // The routed compact turn dispatches combo children as SSE (stream is forced
  // when route.combo is set), so streaming-capable mocks answer the chat wire.
  function chatStreamResponse(text: string): Response {
    return new Response([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  }

  test("bare native model after combo switch routes through the remembered combo", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return jsonResponse(chatCompletionPayload("handoff summary"));
    }) as typeof fetch;

    const config = comboTestConfig();
    const laneHeaders = { "session_id": "lane-combo-recall" };

    // Step 1: an ordinary combo turn succeeds, populating the recall map.
    const comboRes = await handleResponses(
      compactionRequest({ model: "combo/terra", stream: false, input: "hello" }, undefined, laneHeaders),
      config,
      { model: "", provider: "" },
    );
    expect(comboRes.status).toBe(200);

    // Step 2: compaction arrives with the bare native model on the same lane.
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const res = await handleResponses(
      compactionRequest(baseCompactionBody({ model: "gpt-5.6-terra" }), undefined, laneHeaders),
      config,
      logCtx,
    );

    expect(res.status).toBe(200);
    expect(logCtx.provider).toBe("combo");
    expect(logCtx.comboId).toBe("terra");
    expect(logCtx.requestedModel).toBe("combo/terra");
    const json = await res.json() as { output?: Array<{ type?: string }> };
    expect((json.output ?? []).filter(item => item.type === "compaction").length).toBe(1);
  });

  test("v1 /responses/compact takes the same recall path", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.json() as { stream?: boolean };
      return body.stream === true
        ? chatStreamResponse("handoff summary")
        : jsonResponse(chatCompletionPayload("handoff summary"));
    }) as typeof fetch;

    const config = comboTestConfig();
    const laneHeaders = { "session_id": "lane-compact-recall" };

    const comboRes = await handleResponses(
      compactionRequest({ model: "combo/terra", stream: false, input: "hello" }, undefined, laneHeaders),
      config,
      { model: "", provider: "" },
    );
    expect(comboRes.status).toBe(200);

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const compactRes = await handleResponsesCompact(
      compactionRequest(baseCompactionBody({ model: "gpt-5.6-terra" }), undefined, laneHeaders),
      config,
      logCtx,
    );

    expect(compactRes.status).toBe(200);
    expect(logCtx.provider).toBe("combo");
  });

  test("a different lane does not borrow the remembered combo", async () => {
    globalThis.fetch = (async () => jsonResponse(chatCompletionPayload("handoff summary"))) as typeof fetch;

    const config = comboTestConfig();

    // Populate recall on lane A.
    await handleResponses(
      compactionRequest({ model: "combo/terra", stream: false, input: "hello" }, undefined, { "session_id": "lane-A" }),
      config,
      { model: "", provider: "" },
    );

    // Compaction on lane B: the bare model should NOT be rewritten to the combo.
    // It falls through to the compaction default-provider fallback (#2901) and lands on gw.
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const res = await handleResponses(
      compactionRequest(baseCompactionBody({ model: "gpt-5.6-terra" }), undefined, { "session_id": "lane-B" }),
      config,
      logCtx,
    );

    expect(res.status).toBe(200);
    expect(logCtx.provider).toBe("gw");
    expect(logCtx.comboId).toBeUndefined();
  });

  test("a non-matching bare model is not rewritten", async () => {
    globalThis.fetch = (async () => jsonResponse(chatCompletionPayload("handoff summary"))) as typeof fetch;

    const config = comboTestConfig();
    const laneHeaders = { "session_id": "lane-no-match" };

    await handleResponses(
      compactionRequest({ model: "combo/terra", stream: false, input: "hello" }, undefined, laneHeaders),
      config,
      { model: "", provider: "" },
    );

    // Bare model "gpt-5.6-luna" does not match terra combo target "gpt-5.6-terra".
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const res = await handleResponses(
      compactionRequest(baseCompactionBody({ model: "gpt-5.6-luna" }), undefined, laneHeaders),
      config,
      logCtx,
    );

    expect(res.status).toBe(200);
    expect(logCtx.provider).toBe("gw");
    expect(logCtx.comboId).toBeUndefined();
  });

  test("recall routes before the bare model can 404 without an openai provider", async () => {
    // Maintainer review: with no canonical openai row, the bare model dies in
    // routeCompactionModel before any combo logic unless the recall rewrite
    // also reaches the routed identity, not only the raw body model.
    const config = {
      defaultProvider: "openai",
      providers: {
        gw: {
          adapter: "openai-chat",
          baseUrl: "https://gw-primary.example/v1",
          authMode: "key",
          apiKey: "key-gw",
          models: ["gpt-5.6-terra"],
        },
      },
      combos: {
        terra: { strategy: "failover", targets: [{ provider: "gw", model: "gpt-5.6-terra" }] },
      },
    } as unknown as OcxConfig;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.json() as Record<string, unknown>;
      bodies.push(body);
      return body.stream === true
        ? chatStreamResponse("handoff summary")
        : jsonResponse(chatCompletionPayload("handoff summary"));
    }) as typeof fetch;

    const laneHeaders = { "session_id": "lane-recall-404" };
    const comboRes = await handleResponses(
      compactionRequest({ model: "combo/terra", stream: false, input: "hello" }, undefined, laneHeaders),
      config,
      { model: "", provider: "" },
    );
    expect(comboRes.status).toBe(200);

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const res = await handleResponsesCompact(
      compactionRequest(baseCompactionBody({ model: "gpt-5.6-terra" }), undefined, laneHeaders),
      config,
      logCtx,
    );

    expect(res.status).toBe(200);
    expect(logCtx.provider).toBe("combo");
    expect(logCtx.comboId).toBe("terra");
    // The internal combo turn goes out streaming through the combo dispatch.
    expect(bodies[1]!.stream).toBe(true);
    await res.text();
  });

  test("recall keeps a native-compact target on the combo /responses path", async () => {
    // CodeRabbit review: the recalled target itself can live on a provider
    // that supports the native /responses/compact endpoint. Without the
    // routed identity sync, the bare model would go straight to the native
    // compact endpoint and bypass combo dispatch entirely.
    const config = {
      defaultProvider: "openai-apikey",
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          apiKey: "test-key",
        },
      },
      combos: {
        terra: { strategy: "failover", targets: [{ provider: "openai-apikey", model: "gpt-5.6-terra" }] },
      },
    } as unknown as OcxConfig;
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/responses/compact")) {
        return Response.json({ detail: "Not Found" }, { status: 404 });
      }
      calls.push({ url: request.url, body: await request.json() as Record<string, unknown> });
      return calls.at(-1)!.body.stream === true
        ? sseResponse([{ type: "response.completed", response: { ...completedPayload("handoff summary"), model: "gpt-5.6-terra" } }])
        : jsonResponse({ ...completedPayload("handoff summary"), model: "gpt-5.6-terra" });
    }) as typeof fetch;

    const laneHeaders = { "session_id": "lane-recall-native" };
    const comboRes = await handleResponses(
      compactionRequest({ model: "combo/terra", stream: false, input: "hello" }, undefined, laneHeaders),
      config,
      { model: "", provider: "" },
    );
    expect(comboRes.status).toBe(200);

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const res = await handleResponsesCompact(
      compactionRequest(baseCompactionBody({ model: "gpt-5.6-terra" }), undefined, laneHeaders),
      config,
      logCtx,
    );

    expect(res.status).toBe(200);
    expect(logCtx.provider).toBe("combo");
    expect(logCtx.comboId).toBe("terra");
    // Both upstream calls take the plain /responses path; the native compact
    // endpoint (which this provider supports) must never be hit.
    expect(calls.map(call => call.url)).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses",
    ]);
    expect(calls[1]!.body.stream).toBe(true);
    await res.text();
  });

  function installRecallChatFixture(): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = await new Request(input, init).json() as { stream?: boolean };
      return body.stream ? chatStreamResponse("summary") : jsonResponse(chatCompletionPayload("answer"));
    }) as typeof fetch;
  }

  async function seedRecall(config: OcxConfig, lane: string | undefined = "recall-lane"): Promise<void> {
    const response = await handleResponses(compactionRequest(
      { model: "combo/terra", stream: false, input: "hello" }, undefined,
      lane ? { session_id: lane } : {},
    ), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed", model: "gpt-5.6-terra" });
  }

  for (const version of ["v1", "v2"] as const) {
    const compact = version === "v1" ? handleResponsesCompact : handleResponses;
    const dispatch = async (config: OcxConfig, model: string, lane: string | undefined = "recall-lane") => {
      const log: RequestLogContext = { model: "", provider: "" };
      const response = await compact(compactionRequest(baseCompactionBody({ model }), undefined,
        lane ? { session_id: lane } : {}), config, log);
      expect(response.status).toBe(200);
      await response.text();
      return log;
    };

    test(`${version} explicit bare nativeAlias beats a different remembered combo`, async () => {
      installRecallChatFixture();
      const config = comboTestConfig();
      config.combos!.explicit = {
        alias: "gpt-5.6-terra", nativeAlias: true,
        targets: [{ provider: "alt", model: "gpt-5.6-luna" }],
      };
      await seedRecall(config);
      expect(recallComboForLane(config, sessionLaneIdFromRequest(new Headers({ session_id: "recall-lane" })), "gpt-5.6-terra")).toBe("terra");
      const log = await dispatch(config, "gpt-5.6-terra");
      expect(log.comboId).toBe("explicit");
      expect(log.resolvedModel).toBe("gpt-5.6-luna");
    });

    test(`${version} explicit provider and combo selectors beat recall`, async () => {
      installRecallChatFixture();
      const config = comboTestConfig();
      config.combos!.explicit = { targets: [{ provider: "alt", model: "gpt-5.6-luna" }] };
      await seedRecall(config);
      expect((await dispatch(config, "alt/gpt-5.6-luna")).provider).toBe("alt");
      expect((await dispatch(config, "combo/explicit")).comboId).toBe("explicit");
    });

    for (const mutation of ["delete", "rename", "replace-target", "delete-provider", "disable-provider"] as const) {
      test(`${version} ${mutation} invalidates remembered ownership before fallback`, async () => {
        installRecallChatFixture();
        const config = comboTestConfig();
        await seedRecall(config);
        // The default is distinct from the original target and remains usable.
        config.defaultProvider = "alt";
        if (mutation === "rename") config.combos!.renamed = config.combos!.terra!;
        if (mutation === "delete" || mutation === "rename") delete config.combos!.terra;
        if (mutation === "replace-target") config.combos!.terra!.targets = [{ provider: "alt", model: "gpt-5.6-luna" }];
        if (mutation === "delete-provider") delete config.providers.gw;
        if (mutation === "disable-provider") config.providers.gw!.disabled = true;
        const log = await dispatch(config, "gpt-5.6-terra");
        expect(log.comboId).toBeUndefined();
        expect(log.provider).toBe("alt");
      });
    }

    test(`${version} missing and sibling lanes cannot borrow a completed selection`, async () => {
      installRecallChatFixture();
      const config = comboTestConfig();
      await seedRecall(config);
      expect((await dispatch(config, "gpt-5.6-terra", "sibling")).comboId).toBeUndefined();
      // Empty lane explicitly omits the header (undefined would use the helper default).
      expect((await dispatch(config, "gpt-5.6-terra", "")).comboId).toBeUndefined();
      clearComboRecallForTests();
      await seedRecall(config, "");
      expect((await dispatch(config, "gpt-5.6-terra")).comboId).toBeUndefined();
    });

    test(`${version} recall expires at thirty minutes and evicts the oldest of 257 lanes`, async () => {
      installRecallChatFixture();
      const config = comboTestConfig();
      let now = 100_000;
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      try {
        await seedRecall(config);
        now += 30 * 60 * 1000 - 1;
        expect(recallComboForLane(config, sessionLaneIdFromRequest(new Headers({ session_id: "recall-lane" })), "gpt-5.6-terra")).toBe("terra");
        now += 1;
        expect((await dispatch(config, "gpt-5.6-terra")).comboId).toBeUndefined();
        const target = { provider: "gw", model: "gpt-5.6-terra" };
        for (let index = 0; index < 257; index += 1) {
          rememberComboForLane(sessionLaneIdFromRequest(new Headers({ session_id: `lane-${index}` })), "terra", target, "gpt-5.6-terra", captureConfigGeneration());
        }
        expect((await dispatch(config, "gpt-5.6-terra", "lane-0")).comboId).toBeUndefined();
        expect((await dispatch(config, "gpt-5.6-terra", "lane-1")).comboId).toBe("terra");
        expect((await dispatch(config, "gpt-5.6-terra", "lane-256")).comboId).toBe("terra");
      } finally {
        clock.mockRestore();
      }
    });

    test(`${version} virtual Pro target recalls the emitted base model`, async () => {
      const config = comboTestConfig();
      config.providers["openai-apikey"] = {
        adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key", apiKey: "test-key",
      };
      config.combos!.terra!.targets = [{ provider: "openai-apikey", model: "gpt-5.6-terra-pro" }];
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = await request.json() as Record<string, unknown>;
        calls.push({ url: request.url, body });
        const completed = { ...completedPayload("summary"), model: "gpt-5.6-terra" };
        return body.stream ? sseResponse([{ type: "response.completed", response: completed }]) : jsonResponse(completed);
      }) as typeof fetch;
      await seedRecall(config);
      expect(calls[0]!.body).toMatchObject({ model: "gpt-5.6-terra", reasoning: { mode: "pro" } });
      expect(recallComboForLane(config, sessionLaneIdFromRequest(new Headers({ session_id: "recall-lane" })), "gpt-5.6-terra-pro")).toBeUndefined();
      expect((await dispatch(config, "gpt-5.6-terra")).comboId).toBe("terra");
      expect(calls.every(call => call.url.endsWith("/responses"))).toBe(true);
    });

    test(`${version} recalled combo resolves the current key rather than retaining a credential`, async () => {
      const config = comboTestConfig();
      const auth: Array<string | null> = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        auth.push(request.headers.get("authorization"));
        const body = await request.json() as { stream?: boolean };
        return body.stream ? chatStreamResponse("summary") : jsonResponse(chatCompletionPayload("answer"));
      }) as typeof fetch;
      await seedRecall(config);
      config.providers.gw!.apiKey = "key-current";
      expect((await dispatch(config, "gpt-5.6-terra")).comboId).toBe("terra");
      expect(auth).toEqual(["Bearer key-gw", "Bearer key-current"]);
    });
  }

});

test("a no-eligible policy compact request persists the evaluation trace", async () => {
  const config = {
    ...keyProviderConfig(),
    routingProfiles: {
      strict: {
        candidates: [{ provider: "gw", model: "gpt-5.5" }],
        require: { minContextWindow: 128000 },
      },
    },
  } as unknown as OcxConfig;
  globalThis.fetch = (async () => {
    throw new Error("compact must not send upstream when policy evaluation has no eligible candidate");
  }) as typeof fetch;
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponsesCompact(
    compactionRequest(baseCompactionBody({ model: "policy/strict" })),
    config,
    logCtx,
  );
  expect(response.status).toBe(404);
  expect(logCtx.routeDecision).toBeDefined();
  expect(logCtx.routeDecision!.selected.reason).toBe("no-eligible-candidate");
  expect(logCtx.routeDecision!.candidates).toHaveLength(1);
});

/**
 * Issue #3259: a tool result is PAIRED by call_id. inputItemSchema's permissive catch-all
 * (schema.ts:106) accepts a tool item whose strict alternative failed only for a missing
 * call_id, and parser.ts:738 then assigns it unchecked, so a translating adapter consumes
 * `toolCallId: string` holding undefined. Anthropic is the worst case: it does not throw,
 * it sends "[tool_result without adjacent tool_use: undefined]" upstream.
 *
 * The guard cannot live in the schema. parseRequest runs before the passthrough branch, and
 * passthrough / routed compaction build from _rawBody, never reading context.messages — they
 * already degrade an unpaired output to "[tool output for unknown call]" on their own.
 */
describe("computer screenshot output translation boundary", () => {
  const screenshot = {
    type: "computer_call_output", call_id: "call_screen",
    output: { type: "computer_screenshot", image_url: "https://example.com/screen.png" },
  };
  const ordinaryImage = {
    type: "message", role: "user",
    content: [{ type: "input_image", image_url: "https://example.com/ordinary.png" }],
  };

  test("rejects before an otherwise active vision description", async () => {
    const config = keyProviderConfig({ adapter: "openai-chat", noVisionModels: ["model"] });
    config.visionSidecar = { enabled: true, backend: "routed", model: "vision/seeing" };
    config.providers.vision = { adapter: "openai-chat", baseUrl: "https://vision.example/v1", apiKey: "test-key" };
    // Routed vision needs no live OpenAI account for this controlled description dependency.
    const resolveAuth = spyOn(visionModule, "shouldResolveOpenAiVisionSidecar").mockReturnValue(false);
    const describe = spyOn(visionModule, "describeImagesInPlace").mockImplementation(async () => {});
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return jsonResponse({ id: "chat_vision_control", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch;
    try {
      const control = await handleResponses(compactionRequest({
        model: "gw/model", stream: false, input: [ordinaryImage],
      }), config, { model: "", provider: "" });
      expect(control.status).toBe(200);
      await control.text();
      expect(describe).toHaveBeenCalledTimes(1);
      expect(fetches).toBe(1);
      describe.mockClear();
      fetches = 0;
      const rejected = await handleResponses(compactionRequest({
        model: "gw/model", stream: false, input: [screenshot, ordinaryImage],
      }), config, { model: "", provider: "" });
      expect(rejected.status).toBe(400);
      await rejected.text();
      expect(describe).not.toHaveBeenCalled();
      expect(fetches).toBe(0);
    } finally {
      describe.mockRestore();
      resolveAuth.mockRestore();
    }
  });

  test("rejects translated computer outputs before upstream or vision work", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("unsupported computer output must not reach upstream");
    }) as typeof fetch;
    const res = await handleResponses(compactionRequest({
      model: "gw/model", stream: false, input: [screenshot, ordinaryImage],
    }), keyProviderConfig({ adapter: "openai-chat" }), { model: "", provider: "" });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: { type: string; message: string } };
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.message).toBe("computer_call_output requires a Responses passthrough route; send screenshots as user input_image content on translated routes.");
    expect(JSON.stringify(json)).not.toContain("example.com");
    expect(fetches).toBe(0);
  });

  test("keeps the exact screenshot output on a Responses passthrough route", async () => {
    const captured: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return jsonResponse(completedPayload("ok"));
    }) as typeof fetch;
    const res = await handleResponses(compactionRequest({
      model: "gw/model", stream: false, input: [screenshot, ordinaryImage],
    }), keyProviderConfig(), { model: "", provider: "" });
    expect(res.status).toBe(200);
    await res.text();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.input).toEqual([screenshot, ordinaryImage]);
  });

  test("ordinary user image input remains accepted by translated routes", async () => {
    const captured: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return jsonResponse({ id: "chat_probe", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch;
    const res = await handleResponses(compactionRequest({
      model: "gw/model", stream: false, input: [ordinaryImage],
    }), keyProviderConfig({ adapter: "openai-chat" }), { model: "", provider: "" });
    expect(res.status).toBe(200);
    await res.text();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.messages).toEqual([{ role: "user", content: [
      { type: "image_url", image_url: { url: "https://example.com/ordinary.png" } },
    ] }]);
  });
});

describe("external task-input envelopes (#3735)", () => {
  // Synthetic charset/length fixture: short plaintext in this slot is deliberately
  // normalized to input_text before parsing, so it cannot exercise opaque rejection.
  const opaqueOutput = `g${"A".repeat(127)}`;
  const external = (output: unknown = "external task input") => ({
    type: "function_call_output", id: "external-fixture", name: "handoff_input", namespace: "task_inbox", output,
  });
  const body = (item: Record<string, unknown>) => ({
    model: "gw/model", stream: false, input: [item],
  });

  test("opaque negative fixtures survive the plaintext-slot classifier", () => {
    expect(looksLikeBackendCiphertext(opaqueOutput)).toBe(true);
  });

  test("sends a complete envelope as user text without an orphan-tool marker", async () => {
    const captured: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return jsonResponse({ id: "chat_external", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch;
    const res = await handleResponses(compactionRequest(body(external("  preserve this input\n"))),
      keyProviderConfig({ adapter: "openai-chat" }), { model: "", provider: "" });
    expect(res.status).toBe(200);
    await res.text();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.messages).toEqual([{ role: "user", content: "  preserve this input\n" }]);
    expect(JSON.stringify(captured)).not.toContain("[tool output for unknown call]");
  });

  test("preserves ordered text and image content through translation", async () => {
    const captured: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return jsonResponse({ id: "chat_external_image", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch;
    const res = await handleResponses(compactionRequest(body(external([
      { type: "output_text", text: "inspect " },
      { type: "input_image", image_url: "https://example.com/task.png", detail: "original" },
      { type: "input_text", text: " then continue" },
    ]))), keyProviderConfig({ adapter: "openai-chat" }), { model: "", provider: "" });
    expect(res.status).toBe(200);
    await res.text();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.messages).toEqual([{ role: "user", content: [
      { type: "text", text: "inspect " },
      { type: "image_url", image_url: { url: "https://example.com/task.png", detail: "high" } },
      { type: "text", text: " then continue" },
    ] }]);
  });

  test("retains existing plaintext-slot normalization before task-input admission", async () => {
    const captured: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return jsonResponse({ id: "chat_plaintext_slot", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch;
    const res = await handleResponses(compactionRequest(body(external([
      { type: "encrypted_content", encrypted_content: "plaintext task" },
    ]))), keyProviderConfig({ adapter: "openai-chat" }), { model: "", provider: "" });
    expect(res.status).toBe(200);
    await res.text();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.messages).toEqual([{ role: "user", content: "plaintext task" }]);
  });

  test("an empty or null call_id is task input, not a rejection (#3807 supersedes)", async () => {
    // These two shapes were in the invalid list above until #3807 showed they are the same
    // seed as the absent-field form: neither value can pair with a `function_call`, and a
    // Codex desktop sub-agent seed emitted with an explicit `call_id: null` was answered
    // 400 for a turn that is really external task input. A wrong-TYPED key stays rejected.
    const captured: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return jsonResponse({ id: "chat_seed", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch;
    for (const callId of [null, ""]) {
      captured.length = 0;
      const res = await handleResponses(compactionRequest(body({ ...external("seeded task"), call_id: callId })),
        keyProviderConfig({ adapter: "openai-chat" }), { model: "", provider: "" });
      expect(res.status).toBe(200);
      await res.text();
      expect(captured[0]!.messages).toEqual([{ role: "user", content: "seeded task" }]);
    }
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ["numeric call id", { ...external(), call_id: 42 }],
    ["incomplete metadata", { ...external(), namespace: "" }],
    ["custom output", { ...external(), type: "custom_tool_call_output" }],
    ["blank output", external("  ")],
    ["empty output array", external([])],
    ["opaque output", external([{ type: "encrypted_content", encrypted_content: opaqueOutput }])],
    ["mixed opaque output", external([{ type: "input_text", text: "retained input" }, { type: "encrypted_content", encrypted_content: opaqueOutput }])],
    ["malformed image", external([{ type: "input_image", image_url: 42 }])],
  ];
  for (const [name, item] of invalid) {
    test(`rejects ${name} before upstream work`, async () => {
      let fetches = 0;
      globalThis.fetch = (async () => { fetches++; throw new Error("invalid envelope reached upstream"); }) as typeof fetch;
      const res = await handleResponses(compactionRequest(body(item)),
        keyProviderConfig({ adapter: "openai-chat" }), { model: "", provider: "" });
      expect(res.status).toBe(400);
      const error = await res.json() as { error?: { message?: string } };
      expect(error.error?.message).toBe("tool result requires a non-empty string call_id");
      expect(fetches).toBe(0);
      expect(JSON.stringify(error)).not.toContain("retained input");
    });
  }
});

describe("established-history external task input (#3807)", () => {
  // Synthetic complete envelope from the #3735 contract; #3807's history rendering
  // is not a captured outbound request. Keep the real tool pair distinct from delivery.
  const deliveryText = "  Follow up on the earlier tool result.\n";
  const acknowledged = "Delivery acknowledged.";
  const continuationText = "Continue the established task.";
  const summary = "Earlier tool returned 7; follow-up delivery is pending.";
  const history = () => [
    { type: "message", role: "user", content: "Read the earlier value." },
    { type: "function_call", call_id: "call_history", name: "read_value", arguments: "{}" },
    { type: "function_call_output", call_id: "call_history", output: "earlier value: 7" },
    { type: "message", role: "assistant", content: "Earlier result recorded." },
    {
      type: "function_call_output", id: "fco_external_followup",
      name: "send_message_to_thread", namespace: "codex_app", output: deliveryText,
    },
  ];
  const requestBody = () => ({
    model: "gw/model", stream: false, store: false, input: history(),
    tools: [{ type: "function", name: "read_value", parameters: { type: "object", properties: {} } }],
  });
  const wireHistory = [
    { role: "user", content: "Read the earlier value." },
    { role: "assistant", tool_calls: [{ id: "call_history", type: "function", function: { name: "read_value", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_history", content: "earlier value: 7" },
    { role: "assistant", content: "Earlier result recorded." },
    { role: "user", content: deliveryText },
  ];

  function captureChat(text: string): Array<Record<string, unknown>> {
    const captured: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }) as typeof fetch;
    return captured;
  }

  function expectHistory(
    sent: Record<string, unknown>,
    tail: Array<Record<string, unknown>> = [],
    withToolCatalog = true,
  ) {
    const messages = sent.messages as Array<Record<string, unknown>>;
    // Ordinary non-OpenAI chat turns prepend catalog guidance; compaction removes
    // context.tools before translation. Require that exact prefix, not arbitrary extras.
    const prefix = withToolCatalog ? [{
      role: "system",
      content: expect.stringContaining("Valid tool names for this turn are exactly `read_value`."),
    }] : [];
    expect(messages).toHaveLength(prefix.length + wireHistory.length + tail.length);
    expect(messages).toMatchObject([...prefix, ...wireHistory, ...tail]);
    // Exactly one original pair: delivery must not acquire a synthesized tool identity.
    expect(messages.flatMap(message => message.tool_calls ?? [])).toEqual(wireHistory[1]!.tool_calls);
    expect(messages.filter(message => message.role === "tool")).toEqual([wireHistory[2]]);
    expect(JSON.stringify(sent)).not.toContain("[tool output for unknown call]");
  }

  test("ordinary response preserves inter-task delivery after an established tool pair", async () => {
    const captured = captureChat(acknowledged);
    const res = await handleResponses(compactionRequest(requestBody()),
      keyProviderConfig({ adapter: "openai-chat" }), { model: "", provider: "" });
    expect(res.status).toBe(200);
    const json = await res.json() as { status?: string };
    expect(json.status).toBe("completed");
    expect(captured).toHaveLength(1);
    expectHistory(captured[0]!);
  });

  test("stored-ID continuation replays the established tool pair and inter-task delivery in order", async () => {
    const captured = captureChat(acknowledged);
    const config = keyProviderConfig({ adapter: "openai-chat" });
    const first = await handleResponses(compactionRequest({ ...requestBody(), store: true }),
      config, { model: "", provider: "" });
    expect(first.status).toBe(200);
    const saved = await first.json() as { id: string; status?: string };
    expect(saved.status).toBe("completed");
    expect(typeof saved.id).toBe("string");
    expect(saved.id.length).toBeGreaterThan(0);
    expect(captured).toHaveLength(1);
    expectHistory(captured[0]!);

    // Send only the new user turn: the handler must retrieve the previous raw history.
    const res = await handleResponses(compactionRequest({
      ...requestBody(), previous_response_id: saved.id,
      input: [{ type: "message", role: "user", content: continuationText }],
    }), config, { model: "", provider: "" });
    expect(res.status).toBe(200);
    const json = await res.json() as { status?: string };
    expect(json.status).toBe("completed");
    expect(captured).toHaveLength(2);
    expectHistory(captured[1]!, [
      { role: "assistant", content: acknowledged },
      { role: "user", content: continuationText },
    ]);
  });

  for (const version of ["v2 trigger", "v1 compact"] as const) {
    test(`${version} preserves established-history delivery and pairing before summarization`, async () => {
      const captured = captureChat(summary);
      const config = keyProviderConfig({ adapter: "openai-chat" });
      const res = version === "v2 trigger"
        ? await handleResponses(compactionRequest({
          ...requestBody(), input: [...history(), { type: "compaction_trigger" }],
        }), config, { model: "", provider: "" })
        : await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody()),
        }), config, { model: "", provider: "" });
      expect(res.status).toBe(200);
      const json = await res.json() as { output: Array<Record<string, unknown>> };
      expect(captured).toHaveLength(1);
      expectHistory(captured[0]!, [
        { role: "user", content: expect.stringContaining("CONTEXT CHECKPOINT COMPACTION") },
      ], false);
      expect(captured[0]!.tools).toBeUndefined();
      expect(JSON.stringify(captured)).not.toContain("compaction_trigger");
      if (version === "v2 trigger") {
        expect(json.output.filter(item => item.type === "compaction")).toEqual([{
          type: "compaction", id: expect.stringMatching(/^cmp_/),
          encrypted_content: `ocx1:${Buffer.from(summary, "utf8").toString("base64")}`,
        }]);
      } else {
        expect(json.output).toEqual([
          { type: "message", role: "user", content: [{ type: "input_text", text: "Read the earlier value." }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: expect.stringContaining(`\n${summary}`) }] },
        ]);
      }
    });
  }
});

describe("unpaired tool result boundary (#3259)", () => {
  function unpairedBody(item: Record<string, unknown>): Record<string, unknown> {
    return {
      model: "gw/some-model",
      stream: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "do the task" }] },
        item,
      ],
    };
  }

  const anthropicConfig = () => ({
    defaultProvider: "gw",
    providers: {
      gw: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "key",
        apiKey: "test-key",
      },
    },
  } as unknown as OcxConfig);

  test("a translating adapter rejects a call_id-less tool result with 400 and sends nothing upstream", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("the guard must reject before any upstream request");
    }) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(unpairedBody({ type: "function_call_output", output: "bootstrap result" })),
      anthropicConfig(),
      { model: "", provider: "" },
    );

    expect(res.status).toBe(400);
    const json = await res.json() as { error?: { message?: string; type?: string; code?: string } };
    expect(json.error?.message).toBe("tool result requires a non-empty string call_id");
    expect(json.error?.type).toBe("invalid_request_error");
    expect(json.error?.code).toBe("invalid_request_error");
    // The tool output itself must never be interpolated into a client-visible message.
    expect(JSON.stringify(json)).not.toContain("bootstrap result");
    expect(fetches).toBe(0);
  });

  test("an empty-string call_id is rejected identically (it can never pair)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("the guard must reject before any upstream request");
    }) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(unpairedBody({ type: "custom_tool_call_output", call_id: "", output: "x" })),
      anthropicConfig(),
      { model: "", provider: "" },
    );
    expect(res.status).toBe(400);
  });

  test("a paired tool result on the same translating route still reaches the upstream", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return jsonResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as typeof fetch;

    const res = await handleResponses(
      compactionRequest({
        model: "gw/some-model",
        stream: false,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "do the task" }] },
          { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "paired result" },
        ],
      }),
      anthropicConfig(),
      { model: "", provider: "" },
    );

    expect(res.status).toBe(200);
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain("paired result");
    expect(bodies[0]).not.toContain("undefined");
  });

  test("the same unpaired body on a passthrough route stays 200 and self-degrades", async () => {
    // This contrast is the core claim of the design: passthrough builds from _rawBody, is
    // unaffected by the defect, and must not be killed by the guard.
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return jsonResponse(completedPayload("ok"));
    }) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(unpairedBody({ type: "function_call_output", output: "bootstrap result" })),
      keyProviderConfig(),
      { model: "", provider: "" },
    );

    expect(res.status).toBe(200);
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain("[tool output for unknown call]");
    expect(bodies[0]).not.toContain("undefined");
  });
});

describe("unusable-call_id task-input seed (#3807)", () => {
  const seed = (extra: Record<string, unknown>) => ({
    type: "function_call_output", id: "fc_seed", name: "create_thread", namespace: "codex",
    output: "<codex_delegation>continue</codex_delegation>", ...extra,
  });

  test("a seed carrying call_id: null is admitted as task input", () => {
    // `null` is not a pairing key, so the item is the same external seed the absent-field
    // form already carries. Rejecting it produced the reported 400 on clients that emit
    // the field explicitly.
    expect(externalTaskInputContent(seed({ call_id: null }))).toBe("<codex_delegation>continue</codex_delegation>");
  });

  test("a seed carrying an empty-string call_id is admitted identically", () => {
    expect(externalTaskInputContent(seed({ call_id: "" }))).toBe("<codex_delegation>continue</codex_delegation>");
    expect(externalTaskInputContent(seed({ call_id: "   " }))).toBe("<codex_delegation>continue</codex_delegation>");
  });

  test("the absent-field form still works (no regression on a73bb160f)", () => {
    expect(externalTaskInputContent(seed({}))).toBe("<codex_delegation>continue</codex_delegation>");
  });

  test("a REAL call_id is still a paired tool result, never task input", () => {
    // The pairing key is what separates a tool result from a seed. Admitting a paired
    // result as user text would silently drop a real tool round-trip.
    expect(externalTaskInputContent(seed({ call_id: "call_1" }))).toBeUndefined();
  });

  test("a non-string, non-null call_id stays rejected", () => {
    // A numeric id is malformed input, not the absent-pairing seed shape; it keeps the
    // #3259 rejection so a wrong-typed key cannot reach a translating adapter.
    expect(externalTaskInputContent(seed({ call_id: 42 }))).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: {} }))).toBeUndefined();
  });

  test("every other #3735 validation still holds with an unusable call_id", () => {
    // The relaxation is ONLY about the pairing key. Envelope completeness, blank output,
    // and opaque ciphertext keep their existing rejections.
    expect(externalTaskInputContent({ type: "function_call_output", call_id: null, output: "x" })).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: null, namespace: "" }))).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: null, output: "   " }))).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: null, output: [] }))).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: null, output: [{ type: "input_image", image_url: 42 }] }))).toBeUndefined();
  });
});
