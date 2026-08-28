/**
 * handleResponses integration coverage for PR #391 merge blockers:
 * pre-fallback account preview (no probe lease), final-route normalization,
 * native effort clamp on final route, pool account preview for native fallback,
 * encrypted native-only fallback, native passthrough terminal finalization.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import {
  clearAccountQuota,
  updateAccountQuota,
} from "../src/codex/quota";
import {
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  previewCodexAccountForRequest,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThreadDetailed,
} from "../src/codex/routing";
import {
  DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS,
  isModelHealthBlocked,
  resetSubagentModelFallbackStateForTests,
  setSubagentQuotaPrimeForTests,
} from "../src/codex/subagent-model-fallback";
import { resetCodexModelEntitlementCacheForTests } from "../src/codex/model-entitlements";
import { getMainAccountPlan, setMainAccountPlan } from "../src/codex/main-account";
import { resolveCodexAuthContext, type CodexAuthContext } from "../src/codex/auth-context";
import { handleResponses } from "../src/server/responses";
import { resetAgentTaskRecoveryState } from "../src/server/responses/agent-task-recovery";
import { isEagerRelaySseResponse } from "../src/server/relay";
import type { ActiveTurnLease } from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";
import type { RequestLogContext } from "../src/server/request-log";
import type { ResponsesTerminalStatus } from "../src/bridge";
import {
  codexHeaders,
  encryptedInput as recoverableEncryptedInput,
  recoverySse,
} from "./helpers/agent-task-recovery";

setDefaultTimeout(30_000);

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let testDir: string;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-subagent-hr-"));
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  resetAgentTaskRecoveryState();
  resetSubagentModelFallbackStateForTests();
  setMainAccountPlan(null);
  // Gated-native negative rosters are cached process-wide for 15s; a real-network
  // miss in one test must not fail-closed the next test's entitlement lookups.
  resetCodexModelEntitlementCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  resetAgentTaskRecoveryState();
  resetSubagentModelFallbackStateForTests();
  setMainAccountPlan(null);
  rmSync(testDir, { recursive: true, force: true });
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function fernetFixture(ciphertextBytes = 16): string {
  const raw = Buffer.alloc(57 + ciphertextBytes, 0x5a);
  raw[0] = 0x80;
  raw.writeBigUInt64BE(1_720_000_000n, 1);
  const unpadded = raw.toString("base64url");
  return `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
}

const FERNET_TASK = fernetFixture();
const GPT56_NATIVE_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;

function chatgptPlanJwt(plan: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ chatgpt_plan_type: plan })).toString("base64url");
  return `${header}.${body}.sig`;
}

function encryptedAgentInput(): unknown[] {
  return [{
    type: "agent_message",
    author: "/root",
    recipient: "/root/worker",
    content: [{ type: "encrypted_content", encrypted_content: FERNET_TASK }],
  }];
}

function readableAgentInput(): unknown[] {
  return [{
    type: "agent_message",
    author: "/root",
    recipient: "/root/worker",
    content: [{ type: "input_text", text: "do the work" }],
  }];
}

function spawnHeaders(extra: HeadersInit = {}): Headers {
  return new Headers({
    "content-type": "application/json",
    "x-openai-subagent": "collab_spawn",
    authorization: "Bearer caller-codex-token",
    ...Object.fromEntries(new Headers(extra)),
  });
}

function poolNativePlusRoutedConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    activeCodexAccountId: "pool-a",
    autoSwitchThreshold: 80,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
      "openai-apikey": {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        apiKey: "sk-test",
      },
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "xai-test",
      },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool_acc" },
    ],
    ...overrides,
  } as OcxConfig;
}

function installPoolCredential(accountId: string, chatgptAccountId: string, now: number): void {
  saveCodexAccountCredential(accountId, {
    accessToken: `${accountId}_token`,
    refreshToken: `${accountId}_refresh`,
    expiresAt: now + 24 * 60 * 60_000,
    chatgptAccountId,
  });
}

function isCodexModelsFetch(input: unknown): boolean {
  try {
    const url = new URL(String(input));
    return url.hostname === "chatgpt.com" && url.pathname.endsWith("/models");
  } catch {
    return false;
  }
}

function codexRosterResponse(slugs: readonly string[]): Response {
  return Response.json({
    models: slugs.map(slug => ({
      slug, supported_in_api: true, visibility: "list",
    })),
  });
}

function codexRosterKey(headers: Headers): string {
  return headers.get("chatgpt-account-id") ?? headers.get("authorization") ?? "";
}

function installCodexRosterMock(rostersByCredential: Readonly<Record<string, readonly string[]>>): void {
  globalThis.fetch = (async (input, init) => {
    if (isCodexModelsFetch(input)) {
      const credential = codexRosterKey(new Headers(init?.headers));
      return codexRosterResponse(rostersByCredential[credential] ?? []);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

function mockUpstream(capture: {
  urls: string[];
  bodies: string[];
  auths: Array<string | null>;
}, rostersByCredential: Readonly<Record<string, readonly string[]>> = {}): void {
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    if (isCodexModelsFetch(input)) {
      const credential = codexRosterKey(headers);
      return codexRosterResponse(rostersByCredential[credential] ?? []);
    }
    const body = typeof init?.body === "string" ? init.body : "";
    capture.urls.push(String(input));
    capture.bodies.push(body);
    capture.auths.push(headers.get("authorization"));
    return Response.json({
      id: "resp_test",
      object: "response",
      status: "completed",
      model: (JSON.parse(body) as { model?: string }).model,
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;
}

function mockSseUpstream(sseBody: string, capture?: { urls: string[] }): void {
  globalThis.fetch = (async (input) => {
    capture?.urls.push(String(input));
    return new Response(sseBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

async function postSpawn(
  config: OcxConfig,
  body: Record<string, unknown>,
  options: Parameters<typeof handleResponses>[3] = {},
  logCtx: RequestLogContext = { model: "", provider: "" },
  headers: HeadersInit = {},
): Promise<Response> {
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: spawnHeaders(headers),
      body: JSON.stringify(body),
    }),
    config,
    logCtx,
    options,
  );
}

async function postDirectCodex(
  config: OcxConfig,
  body: Record<string, unknown>,
  options: Parameters<typeof handleResponses>[3] = {},
): Promise<Response> {
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer caller-codex-token",
      },
      body: JSON.stringify(body),
    }),
    config,
    { model: "", provider: "" },
    options,
  );
}

function unsupportedCodexModelResponse(model: string): Response {
  return new Response(JSON.stringify({
    detail: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
  }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function entitlementSnapshot(grants: Readonly<Record<string, readonly string[]>>) {
  return {
    modelsByAccount: new Map(
      Object.entries(grants).map(([accountId, models]) => [accountId, new Set(models)]),
    ),
    confirmedAccountIds: new Set(Object.keys(grants)),
    credentialIdentities: new Map<string, string>(),
  };
}

describe("subagent fallback without primary auth cooldown failure", () => {
  test("exact account child bypasses quota priming and fallback on an empty 503", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc", now);
    installPoolCredential("pool-b", "pool_b_acc", now);
    const cfg = poolNativePlusRoutedConfig({
      codexAccountNamespaces: { side: "pool-a" },
      subagentModelFallback: ["xai/grok-4.5"],
    });
    cfg.codexAccounts?.push({
      id: "pool-b",
      email: "pool-b@example.test",
      isMain: false,
      chatgptAccountId: "pool_b_acc",
    });
    cfg.activeCodexAccountId = "pool-b";
    updateAccountQuota("pool-b", 95, undefined, 20);

    let quotaPrimes = 0;
    setSubagentQuotaPrimeForTests(async () => { quotaPrimes += 1; });
    const urls: string[] = [];
    const accounts: Array<string | null> = [];
    const models: string[] = [];
    globalThis.fetch = (async (input, init) => {
      urls.push(String(input));
      const headers = new Headers(init?.headers);
      accounts.push(headers.get("chatgpt-account-id"));
      models.push(JSON.parse(String(init?.body))?.model ?? "missing");
      return new Response(null, { status: 503, headers: { "retry-after": "0" } });
    }) as typeof fetch;

    const response = await postSpawn(cfg, {
      model: "side/gpt-5.5",
      input: readableAgentInput(),
      stream: false,
    });

    expect(response.status).toBe(503);
    const error = await response.json() as { error?: { message?: string } };
    expect(error.error?.message?.trim().length).toBeGreaterThan(0);
    expect(error.error?.message?.toLowerCase()).not.toBe("unknown error");
    expect(quotaPrimes).toBe(0);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every(url => url.includes("chatgpt.com/backend-api/codex"))).toBe(true);
    expect(new Set(accounts)).toEqual(new Set(["pool_acc"]));
    expect(new Set(models)).toEqual(new Set(["gpt-5.5"]));
  });

  test("cooled primary with no probe lease selects healthy routed fallback", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg = poolNativePlusRoutedConfig({
      subagentModelFallback: ["xai/grok-4.5"],
    });
    updateAccountQuota("pool-a", 95, undefined, 20);
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, { resetAt, now });

    const authPublications: Array<CodexAuthContext | undefined> = [];
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "gpt-5.5", input: readableAgentInput(), stream: false },
      { onCodexAuthContextResolved: (ctx) => authPublications.push(ctx) },
    );

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("api.x.ai"))).toBe(true);
    expect(response.status).not.toBe(429);
    expect(getCodexUpstreamHealth("pool-a")?.probeLeaseId).toBeUndefined();
    // No auth is resolved before final route; routed final publishes undefined.
    expect(authPublications).toEqual([undefined]);
  });

  test("cooled primary with no usable fallback still returns cooldown 429", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg = poolNativePlusRoutedConfig({
      subagentModelFallback: ["gpt-5.5"],
    });
    updateAccountQuota("pool-a", 95, undefined, 20);
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, { resetAt, now });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    }) as typeof fetch;

    const response = await postSpawn(cfg, {
      model: "gpt-5.5",
      input: readableAgentInput(),
      stream: false,
    });

    expect(response.status).toBe(429);
    expect(fetchCalls).toBe(0);
    expect(getCodexUpstreamHealth("pool-a")?.probeLeaseId).toBeUndefined();
  });

  test("same-provider native fallback at probe window authenticates only for final route", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg = poolNativePlusRoutedConfig({
      subagentModelFallback: ["gpt-5.5"],
    });
    // Health-block the primary so fallback selects another native model; keep
    // account below auto-switch threshold so the probe path is exercised.
    updateAccountQuota("pool-a", 20, undefined, 20);
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, { resetAt, now });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.5", "429", cfg, "pool-a");

    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    Date.now = () => probeAt;

    let finalAuth: CodexAuthContext | undefined;
    const authPublications: Array<CodexAuthContext | undefined> = [];
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "gpt-5.5", input: readableAgentInput(), stream: false },
      {
        onCodexAuthContextResolved: (ctx) => {
          authPublications.push(ctx);
          finalAuth = ctx;
        },
      },
    );

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("chatgpt.com/backend-api/codex"))).toBe(true);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect((finalAuth as { probeLeaseId?: string }).probeLeaseId).toBeTruthy();
    expect(authPublications).toHaveLength(1);
    expect(response.status).not.toBe(429);
  });

  test("final-route direct auth failure does not acquire a pool probe lease", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg: OcxConfig = {
      port: 0,
      defaultProvider: "xai",
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 80,
      subagentModelFallback: ["gpt-5.5"],
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool_acc" },
      ],
    };
    updateAccountQuota("pool-a", 95, undefined, 20);
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, { resetAt, now });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg);

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    }) as typeof fetch;

    // Omit authorization so the canonical Direct final route fails before dispatch.
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openai-subagent": "collab_spawn",
        },
        body: JSON.stringify({
          model: "xai/grok-4.5",
          input: readableAgentInput(),
          stream: false,
        }),
      }),
      cfg,
      { model: "", provider: "" },
    );

    expect(response.status).toBe(401);
    expect(fetchCalls).toBe(0);
    expect(getCodexUpstreamHealth("pool-a")?.probeLeaseId).toBeUndefined();
  });
});

describe("subagent fallback final-route normalization", () => {
  test("falls back to gpt-5.6-sol-pro and rewrites wire model + reasoning.mode", async () => {
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: undefined,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          apiKey: "sk-test",
        },
      },
      subagentModelFallback: ["openai-apikey/gpt-5.6-sol-pro"],
      fastMode: true,
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.6-sol", "429", cfg);

    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await postSpawn(
      cfg,
      {
        model: "gpt-5.6-sol",
        input: readableAgentInput(),
        stream: false,
        reasoning: { effort: "high" },
        service_tier: "default",
      },
      {},
      logCtx,
    );

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("api.openai.com"))).toBe(true);
    const body = JSON.parse(capture.bodies[0]!) as {
      model?: string;
      reasoning?: { effort?: string; mode?: string };
      service_tier?: string;
    };
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.reasoning?.mode).toBe("pro");
    expect(body.service_tier).toBe("priority");
    expect(logCtx.provider).toContain("openai-apikey");
    expect(logCtx.model).toBe("gpt-5.6-sol-pro");
    expect(logCtx.resolvedModel).toBe("gpt-5.6-sol");
    expect(logCtx.providerAdapter).toBe("openai-responses");
  });

  test("routed primary falling back to native gpt-5.5 clamps max effort to xhigh", async () => {
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      subagentModelFallback: ["gpt-5.5"],
      activeCodexAccountId: undefined,
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg);
    noteSubagentModelFailure("grok-4.5", "429", cfg);

    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);
    const logCtx: RequestLogContext = { model: "", provider: "", requestedModel: "xai/grok-4.5" };

    const response = await postSpawn(
      cfg,
      {
        model: "xai/grok-4.5",
        input: readableAgentInput(),
        stream: false,
        reasoning: { effort: "max" },
      },
      {},
      logCtx,
    );

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("chatgpt.com/backend-api/codex"))).toBe(true);
    const body = JSON.parse(capture.bodies[0]!) as {
      model?: string;
      reasoning?: { effort?: string };
    };
    expect(body.model).toBe("gpt-5.5");
    expect(body.reasoning?.effort).toBe("xhigh");
  });

  test("routed primary falling back to native gpt-5.6 keeps real max effort", async () => {
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      subagentModelFallback: ["gpt-5.6-terra"],
      activeCodexAccountId: undefined,
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg);
    noteSubagentModelFailure("grok-4.5", "429", cfg);

    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture, { "Bearer caller-codex-token": ["gpt-5.6-terra"] });

    const response = await postSpawn(cfg, {
      model: "xai/grok-4.5",
      input: readableAgentInput(),
      stream: false,
      reasoning: { effort: "max" },
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(capture.bodies[0]!) as { reasoning?: { effort?: string } };
    expect(body.reasoning?.effort).toBe("max");
  });

  test("native primary falling back to routed does not receive a native clamp", async () => {
    const cfg = poolNativePlusRoutedConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
      },
      subagentModelFallback: ["xai/grok-4.5"],
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.5", "rate limit exceeded", cfg);

    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(cfg, {
      model: "gpt-5.5",
      input: readableAgentInput(),
      stream: false,
      reasoning: { effort: "max" },
    });

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("api.x.ai"))).toBe(true);
    const body = JSON.parse(capture.bodies[0]!) as { reasoning?: { effort?: string } };
    // Routed adapters own effort mapping; the native clamp must not rewrite to xhigh.
    expect(body.reasoning?.effort).not.toBe("xhigh");
  });

  test("routed primary falls back to native and preserves encrypted task passthrough", async () => {
    resetSubagentModelFallbackStateForTests();
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      subagentModelFallback: ["gpt-5.6-terra"],
      activeCodexAccountId: undefined,
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });

    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture, { "Bearer caller-codex-token": ["gpt-5.6-terra"] });

    const response = await postSpawn(cfg, {
      model: "xai/grok-4.5",
      input: encryptedAgentInput(),
      stream: false,
    });

    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`expected 200, got ${response.status}: ${body}`);
    }
    expect(capture.urls.some((url) => url.includes("chatgpt.com/backend-api/codex"))).toBe(true);
    expect(capture.bodies[0]).toContain(FERNET_TASK);
  });

  test("native primary falls back to routed for readable child tasks", async () => {
    const cfg = poolNativePlusRoutedConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
      },
      subagentModelFallback: ["xai/grok-4.5"],
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.5", "rate limit exceeded", cfg);

    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(cfg, {
      model: "gpt-5.5",
      input: readableAgentInput(),
      stream: false,
    });

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("api.x.ai"))).toBe(true);
  });
});

describe("native fallback account preview", () => {
  test("fallback preview and final auth use their own entitlement snapshots", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      codexAccountNamespaces: { team: "pool-a" },
      subagentModelFallback: ["gpt-daybreak-blue-latest", "xai/grok-4.5"],
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("team/gpt-5.6-sol", "429", cfg, "pool-a", now);
    // Make a stale account choice observable at the fallback boundary: preview must
    // apply the first snapshot and move to pool-b before checking model health.
    noteSubagentModelFailure("gpt-daybreak-blue-latest", "429", cfg, "pool-a", now);
    const previewSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-5.6-sol"])],
        ["pool-b", new Set(["gpt-5.6-sol", "gpt-daybreak-blue-latest"])],
      ]),
      confirmedAccountIds: new Set(["pool-a", "pool-b"]),
      credentialIdentities: new Map<string, string>(),
    };
    const finalSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-5.6-sol", "gpt-daybreak-blue-latest"])],
        ["pool-b", new Set(["gpt-5.6-sol"])],
      ]),
      confirmedAccountIds: new Set(["pool-a", "pool-b"]),
      credentialIdentities: new Map<string, string>(),
    };
    let entitlementCalls = 0;
    let finalAuth: CodexAuthContext | undefined;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "team/gpt-5.6-sol", input: readableAgentInput(), stream: false },
      {
        onCodexAuthContextResolved: (ctx) => { finalAuth = ctx; },
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          return entitlementCalls === 1 ? previewSnapshot : finalSnapshot;
        },
      },
      logCtx,
    );

    expect(response.status).toBe(200);
    expect(entitlementCalls).toBe(2);
    // Final auth is authoritative and sees the second snapshot, not the preview snapshot.
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect((logCtx as unknown as Record<string, unknown>).subagentModelFallbackTo)
      .toBe("gpt-daybreak-blue-latest");
    expect(capture.auths[0]).toContain("pool-a_token");
  });

  test("pending preview entitlement errors release admission after preserving the original path", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      codexAccountNamespaces: { team: "pool-a" },
      subagentModelFallback: ["gpt-daybreak-blue-latest"],
    });
    let beginCount = 0;
    let releaseCount = 0;
    let resolverCalls = 0;
    let rejectDiscovery!: (reason: Error) => void;
    const discovery = new Promise<never>((_resolve, reject) => { rejectDiscovery = reject; });
    let signalResolverEntered!: () => void;
    const resolverEntered = new Promise<void>((resolve) => { signalResolverEntered = resolve; });
    const turnAdmissionLease = {
      release() {},
      beginCodexAccountSelection() {
        beginCount += 1;
        return {
          mainProfileDraining: false,
          claimMainProfile: () => true,
          release: () => { releaseCount += 1; },
        };
      },
    } satisfies Pick<ActiveTurnLease, "release" | "beginCodexAccountSelection">;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    }) as typeof fetch;

    const pending = postSpawn(
      cfg,
      { model: "team/gpt-5.6-sol", input: readableAgentInput(), stream: false },
      {
        turnAdmissionLease,
        resolveCodexModelEntitlements: async () => {
          resolverCalls += 1;
          signalResolverEntered();
          return discovery;
        },
      },
    );
    await resolverEntered;

    expect(resolverCalls).toBe(1);
    expect(beginCount).toBe(1);
    expect(releaseCount).toBe(0);
    expect(fetchCalls).toBe(0);

    rejectDiscovery(new TypeError("preview entitlement programmer sentinel"));
    await expect(pending).rejects.toThrow("preview entitlement programmer sentinel");
    expect(releaseCount).toBe(1);
    expect(fetchCalls).toBe(0);
  });

  test("final-auth entitlement errors release both selection admissions on their original path", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      codexAccountNamespaces: { team: "pool-a" },
      subagentModelFallback: ["gpt-daybreak-blue-latest"],
    });
    const entitlementSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-5.6-sol", "gpt-daybreak-blue-latest"])],
      ]),
      confirmedAccountIds: new Set(["pool-a"]),
      credentialIdentities: new Map<string, string>(),
    };
    let beginCount = 0;
    let releaseCount = 0;
    const turnAdmissionLease = {
      release() {},
      beginCodexAccountSelection() {
        beginCount += 1;
        return {
          mainProfileDraining: false,
          claimMainProfile: () => true,
          release: () => { releaseCount += 1; },
        };
      },
    } satisfies Pick<ActiveTurnLease, "release" | "beginCodexAccountSelection">;
    let entitlementCalls = 0;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    }) as typeof fetch;

    await expect(postSpawn(
      cfg,
      { model: "team/gpt-5.6-sol", input: readableAgentInput(), stream: false },
      {
        turnAdmissionLease,
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          if (entitlementCalls === 1) return entitlementSnapshot;
          throw new TypeError("final-auth entitlement programmer sentinel");
        },
      },
    )).rejects.toThrow("final-auth entitlement programmer sentinel");

    expect(entitlementCalls).toBe(2);
    expect(beginCount).toBe(2);
    expect(releaseCount).toBe(2);
    expect(fetchCalls).toBe(0);
  });

  test("programmer errors from entitlement discovery retain their original path", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      codexAccountNamespaces: { team: "pool-a" },
      subagentModelFallback: ["gpt-daybreak-blue-latest"],
    });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    }) as typeof fetch;

    await expect(postSpawn(
      cfg,
      { model: "team/gpt-5.6-sol", input: readableAgentInput(), stream: false },
      {
        resolveCodexModelEntitlements: async () => {
          throw new TypeError("programmer sentinel");
        },
      },
    )).rejects.toThrow("programmer sentinel");
    expect(fetchCalls).toBe(0);
  });

  test("unentitled fixed gated primary falls through to a routed fallback", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      codexAccountNamespaces: { restricted: "pool-b" },
      subagentModelFallback: ["xai/grok-4.5"],
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
    });
    const entitlementSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-5.6-sol", "gpt-daybreak-blue-latest"])],
        ["pool-b", new Set(["gpt-5.6-sol"])],
      ]),
      confirmedAccountIds: new Set(["pool-a", "pool-b"]),
      credentialIdentities: new Map<string, string>(),
    };
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "restricted/gpt-daybreak-blue-latest", input: readableAgentInput(), stream: false },
      { resolveCodexModelEntitlements: async () => entitlementSnapshot },
      logCtx,
    );

    expect(response.status).toBe(200);
    expect((logCtx as unknown as Record<string, unknown>).subagentModelFallbackTo).toBe("xai/grok-4.5");
    expect(capture.urls).toHaveLength(1);
    expect(capture.urls[0]).toContain("api.x.ai");
    expect(capture.bodies[0]).not.toContain("gpt-daybreak-blue-latest");
  });

  test("account-qualified fallback excludes native main entitlement reads during profile drain", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      codexAccountNamespaces: { team: "pool-a" },
      subagentModelFallback: ["gpt-daybreak-blue-latest", "xai/grok-4.5"],
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
    });
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
      fixedAccount: true,
      modelId: "gpt-5.6-sol",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });
    const entitlementSnapshot = {
      modelsByAccount: new Map([
        ["__main__", new Set(["gpt-daybreak-blue-latest"])],
        ["pool-b", new Set(["gpt-daybreak-blue-latest"])],
      ]),
      confirmedAccountIds: new Set(["__main__", "pool-b"]),
      credentialIdentities: new Map<string, string>(),
    };
    const mainExclusions: boolean[] = [];
    let selectionReleases = 0;
    let claimCalls = 0;
    const turnAdmissionLease = {
      release() {},
      beginCodexAccountSelection() {
        return {
          mainProfileDraining: true,
          claimMainProfile: () => { claimCalls += 1; return false; },
          release: () => { selectionReleases += 1; },
        };
      },
    } satisfies Pick<ActiveTurnLease, "release" | "beginCodexAccountSelection">;
    let finalAuth: CodexAuthContext | undefined;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "team/gpt-5.6-sol", input: readableAgentInput(), stream: false },
      {
        turnAdmissionLease,
        onCodexAuthContextResolved: (ctx) => { finalAuth = ctx; },
        resolveCodexModelEntitlements: async (_config, resolveOptions) => {
          mainExclusions.push(resolveOptions?.excludeAccountIds?.has("__main__") === true);
          return entitlementSnapshot;
        },
      },
    );

    expect(response.status).toBe(200);
    expect(mainExclusions).toEqual([true, true]);
    expect(selectionReleases).toBe(2);
    expect(claimCalls).toBe(0);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-b" });
    expect(capture.auths[0]).toContain("pool-b_token");
  });

  test("temporary drain keeps an unread main-only gated candidate ahead of routed fallback", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      codexAccountNamespaces: { team: "pool-a" },
      subagentModelFallback: ["gpt-daybreak-blue-latest", "xai/grok-4.5"],
    });
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
      fixedAccount: true,
      modelId: "gpt-5.6-sol",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });
    const entitlementSnapshot = {
      modelsByAccount: new Map<string, Set<string>>(),
      confirmedAccountIds: new Set<string>(),
      credentialIdentities: new Map<string, string>(),
    };
    const mainExclusions: boolean[] = [];
    let selectionReleases = 0;
    let claimCalls = 0;
    const turnAdmissionLease = {
      release() {},
      beginCodexAccountSelection() {
        return {
          mainProfileDraining: true,
          claimMainProfile: () => { claimCalls += 1; return false; },
          release: () => { selectionReleases += 1; },
        };
      },
    } satisfies Pick<ActiveTurnLease, "release" | "beginCodexAccountSelection">;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    }) as typeof fetch;

    const response = await postSpawn(
      cfg,
      { model: "team/gpt-5.6-sol", input: readableAgentInput(), stream: false },
      {
        turnAdmissionLease,
        resolveCodexModelEntitlements: async (_config, resolveOptions) => {
          mainExclusions.push(resolveOptions?.excludeAccountIds?.has("__main__") === true);
          return entitlementSnapshot;
        },
      },
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("OpenCodex local native-main profile maintenance is active");
    expect(mainExclusions).toEqual([true, true]);
    expect(selectionReleases).toBe(2);
    expect(claimCalls).toBe(1);
    expect(fetchCalls).toBe(0);
    // If preview or pin retirement tried to score synthetic main, getMainAccountPlan
    // would have consumed the missing auth.json attempt and cached `undefined`.
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      tokens: { access_token: chatgptPlanJwt("pro"), account_id: "main-account" },
    }));
    expect(getMainAccountPlan()).toBe("pro");
  });

  test("temporary drain keeps ordinary native-main fallback read-free until the final claim", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      activeCodexAccountId: "__main__",
      subagentModelFallback: ["gpt-5.5"],
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg);
    noteSubagentModelFailure("grok-4.5", "429", cfg);
    let selectionReleases = 0;
    let claimCalls = 0;
    const turnAdmissionLease = {
      release() {},
      beginCodexAccountSelection() {
        return {
          mainProfileDraining: true,
          claimMainProfile: () => { claimCalls += 1; return false; },
          release: () => { selectionReleases += 1; },
        };
      },
    } satisfies Pick<ActiveTurnLease, "release" | "beginCodexAccountSelection">;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    }) as typeof fetch;

    const response = await postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: readableAgentInput(), stream: false },
      { turnAdmissionLease },
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("OpenCodex local native-main profile maintenance is active");
    expect(selectionReleases).toBe(2);
    expect(claimCalls).toBe(1);
    expect(fetchCalls).toBe(0);
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      tokens: { access_token: chatgptPlanJwt("pro"), account_id: "main-account" },
    }));
    expect(getMainAccountPlan()).toBe("pro");
  });

  test("Desktop fallback affinity drives the subagent preview and final native account", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    // Sol/Terra/Luna are account-gated; grant them only to the accounts this
    // preview test configured instead of giving every discovery caller a roster.
    installCodexRosterMock({
      pool_acc_a: GPT56_NATIVE_MODELS,
      pool_acc_b: GPT56_NATIVE_MODELS,
    });
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      subagentModelFallback: ["gpt-5.6-terra"],
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
    });
    const desktopHeaders = {
      "session-id": "desktop-session-private",
      "thread-id": "desktop-thread-private",
    };
    const bound = await resolveCodexAuthContext(new Headers(desktopHeaders), cfg, "pool", {
      modelId: "gpt-5.6-sol",
    });
    expect(bound).toMatchObject({ kind: "pool", accountId: "pool-a" });
    if (bound.kind !== "pool") throw new Error("expected pool context");
    cfg.activeCodexAccountId = "pool-b";
    // The binding above was made under codexQuotaScopeForModel("gpt-5.6-sol") === "shared".
    // The preview inside handleResponses must derive the SAME scope from the route model —
    // an undefined scope reads the "legacy" slot and would miss the binding entirely.
    expect(previewCodexAccountForRequest(bound.affinityKey ?? null, cfg, now, "shared")).toBe("pool-a");
    // With no binding in the legacy slot the preview falls through to rotation/active selection,
    // so it returns a DIFFERENT account than the affinity-bound one — that divergence is exactly
    // what the route-model scope derivation inside handleResponses prevents.
    expect(previewCodexAccountForRequest(bound.affinityKey ?? null, cfg, now, undefined)).not.toBe("pool-a");

    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg);
    noteSubagentModelFailure("grok-4.5", "429", cfg);

    let finalAuth: CodexAuthContext | undefined;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: readableAgentInput(), stream: false },
      { onCodexAuthContextResolved: (ctx) => { finalAuth = ctx; } },
      { model: "", provider: "" },
      desktopHeaders,
    );

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("chatgpt.com/backend-api/codex"))).toBe(true);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(capture.auths.some((auth) => auth?.includes("pool-a_token"))).toBe(true);
  });

  test("subagent preview reads the route-model quota scope, not the legacy slot", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    installCodexRosterMock({
      pool_acc_a: GPT56_NATIVE_MODELS,
      pool_acc_b: GPT56_NATIVE_MODELS,
    });
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      subagentModelFallback: ["gpt-5.6-terra"],
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
    });
    const desktopHeaders = {
      "session-id": "scope-session-private",
      "thread-id": "scope-thread-private",
    };
    const bound = await resolveCodexAuthContext(new Headers(desktopHeaders), cfg, "pool", {
      modelId: "gpt-5.6-sol",
    });
    expect(bound).toMatchObject({ kind: "pool", accountId: "pool-a" });
    cfg.activeCodexAccountId = "pool-b";
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg);
    noteSubagentModelFailure("grok-4.5", "429", cfg);

    let finalAuth: CodexAuthContext | undefined;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: readableAgentInput(), stream: false },
      { onCodexAuthContextResolved: (ctx) => { finalAuth = ctx; } },
      { model: "", provider: "" },
      desktopHeaders,
    );

    // The preview inside handleResponses derives its quota scope from the route model, so the
    // affinity binding made under "shared" is found and the fallback authenticates pool-a —
    // the same account that bound the thread — even though the active account is now pool-b.
    expect(response.status).toBe(200);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-a" });
  });

  test("fallback previews the Pool account separately for each candidate quota scope", async () => {
    const cooldownAt = 1_800_000_000_000;
    const now = cooldownAt + CODEX_QUOTA_PROBE_INTERVAL_MS + 1;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    // This case binds on gpt-5.6-sol, which is account-gated: without a roster the
    // entitlement snapshot fails closed and no account is eligible (#2550).
    installCodexRosterMock({
      pool_acc_a: GPT56_NATIVE_MODELS,
      pool_acc_b: GPT56_NATIVE_MODELS,
    });
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      subagentModelFallback: ["gpt-5.3-codex-spark", "xai/grok-4.5"],
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
    });
    const desktopHeaders = {
      "session-id": "candidate-scope-session-private",
      "thread-id": "candidate-scope-thread-private",
    };
    const bound = await resolveCodexAuthContext(new Headers(desktopHeaders), cfg, "pool", {
      modelId: "gpt-5.6-sol",
    });
    expect(bound).toMatchObject({ kind: "pool", accountId: "pool-a" });
    if (bound.kind !== "pool") throw new Error("expected pool context");
    cfg.activeCodexAccountId = "pool-b";

    recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
      modelId: "gpt-5.3-codex-spark",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });
    recordCodexUpstreamOutcome(cfg, "pool-b", 429, {
      modelId: "gpt-5.3-codex-spark",
      now: cooldownAt,
      resetAt: Math.floor((cooldownAt + 60 * 60_000) / 1_000),
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.6-sol", "429", cfg, "pool-a", now);

    expect(previewCodexAccountForRequest(bound.affinityKey ?? null, cfg, now, "shared")).toBe("pool-a");
    expect(previewCodexAccountForRequest(bound.affinityKey ?? null, cfg, now, "spark")).toBe("pool-b");

    let finalAuth: CodexAuthContext | undefined;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "gpt-5.6-sol", input: readableAgentInput(), stream: false },
      { onCodexAuthContextResolved: (ctx) => { finalAuth = ctx; } },
      { model: "", provider: "" },
      desktopHeaders,
    );

    expect(response.status).toBe(200);
    expect(finalAuth).toMatchObject({
      kind: "pool",
      accountId: "pool-b",
      probeQuotaScope: "spark",
    });
    expect((finalAuth as { probeLeaseId?: string }).probeLeaseId).toBeTruthy();
    expect(capture.urls.some((url) => url.includes("chatgpt.com/backend-api/codex"))).toBe(true);
    expect(capture.auths.some((auth) => auth?.includes("pool-b_token"))).toBe(true);
    expect(capture.bodies.some((body) => body.includes('"model":"gpt-5.3-codex-spark"'))).toBe(true);
  });

  test("recovery re-previews the Pool account for the candidate quota scope", async () => {
    const now = 1_800_000_000_000;
    let currentNow = now;
    Date.now = () => currentNow;
    installPoolCredential("pool-a", "pool_acc_a", now);
    // Same account-gated binding as above: grant the roster to both pool accounts.
    installCodexRosterMock({
      pool_acc_a: GPT56_NATIVE_MODELS,
      pool_acc_b: GPT56_NATIVE_MODELS,
    });
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      agentTaskRecovery: { enabled: true },
      subagentModelFallback: ["gpt-5.3-codex-spark"],
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
    });
    const requestHeaders = codexHeaders("caller-account", {
      "session-id": "recovery-candidate-scope-session-private",
      "thread-id": "recovery-candidate-scope-thread-private",
    });
    const bound = await resolveCodexAuthContext(requestHeaders, cfg, "pool", {
      modelId: "gpt-5.6-sol",
    });
    expect(bound).toMatchObject({ kind: "pool", accountId: "pool-a" });
    if (bound.kind !== "pool") throw new Error("expected pool context");
    cfg.activeCodexAccountId = "pool-b";

    recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
      modelId: "gpt-5.3-codex-spark",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.3-codex-spark", "429", cfg, "pool-b", now);
    noteSubagentModelFailure(
      "gpt-5.3-codex-spark",
      "429",
      cfg,
      "pool-a",
      now,
      10 * DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS,
    );
    noteSubagentModelFailure(
      "xai/grok-4.5",
      "429",
      cfg,
      undefined,
      now,
      10 * DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS,
    );
    noteSubagentModelFailure(
      "grok-4.5",
      "429",
      cfg,
      undefined,
      now,
      10 * DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS,
    );

    expect(previewCodexAccountForRequest(bound.affinityKey ?? null, cfg, now, "shared")).toBe("pool-a");
    expect(previewCodexAccountForRequest(bound.affinityKey ?? null, cfg, now, "spark")).toBe("pool-b");

    let selectionStarts = 0;
    let selectionReleases = 0;
    const turnAdmissionLease = {
      release() {},
      beginCodexAccountSelection() {
        selectionStarts += 1;
        return {
          mainProfileDraining: false,
          claimMainProfile: () => false,
          release: () => { selectionReleases += 1; },
        };
      },
    } satisfies Pick<ActiveTurnLease, "release" | "beginCodexAccountSelection">;
    let finalAuth: CodexAuthContext | undefined;
    const fetchedUrls: string[] = [];
    const forwardedBodies: string[] = [];
    const forwardedAuths: Array<string | null> = [];
    globalThis.fetch = (async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      fetchedUrls.push(String(input));
      forwardedBodies.push(raw);
      forwardedAuths.push(new Headers(init?.headers).get("authorization"));
      if (raw.includes("capture_assignment")) {
        currentNow = now + DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS + 1;
        return new Response(recoverySse("Use the recovered candidate-scope assignment."), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "resp_recovered_candidate_scope",
        object: "response",
        status: "completed",
        model: "gpt-5.3-codex-spark",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const response = await postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: recoverableEncryptedInput(), stream: false },
      {
        turnAdmissionLease,
        onCodexAuthContextResolved: (ctx) => { finalAuth = ctx; },
      },
      { model: "", provider: "" },
      requestHeaders,
    );

    expect(response.status).toBe(200);
    const bodyRequests = forwardedBodies.map((body, index) => ({
      body,
      url: fetchedUrls[index],
      auth: forwardedAuths[index],
    })).filter(({ body }) => body.length > 0);
    expect(bodyRequests).toHaveLength(2);
    expect(bodyRequests[0]?.body).toContain("capture_assignment");
    expect(bodyRequests[1]?.body).toContain("Use the recovered candidate-scope assignment.");
    expect(bodyRequests[1]?.body).toContain('"model":"gpt-5.3-codex-spark"');
    expect(selectionStarts).toBe(3);
    expect(selectionReleases).toBe(3);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-b" });
    expect(bodyRequests[1]?.auth).toContain("pool-b_token");
  });

  /**
   * Recovery must carry the ENTITLEMENT filter too, not only the quota scope (#2509).
   *
   * The end-to-end case above grants the roster to both pool accounts, so it can only prove the
   * SCOPE is re-previewed per candidate. The recovery path re-previewed the scope but passed no
   * eligible-account set, so it could select an account with no entitlement to the recovered
   * model and fail closed at final auth — the same stale-selection class as the quota scope, one
   * layer over.
   *
   * Asserted structurally on the source, like the route-inventory contract: driving it end to end
   * needs a recovered encrypted assignment AND an account-gated candidate whose entitlement
   * differs per account, and the resulting fixture proved more fragile than the thing it checks.
   * What this does catch is the regression that actually threatens the fix — one of the two
   * preview sites silently losing the eligibility argument again.
   */
  test("both fallback preview sites pass the model-eligible account set (#2509)", async () => {
    const source = await Bun.file(
      fileURLToPath(new URL("../src/server/responses/core.ts", import.meta.url)),
    ).text();

    const previews = source.match(/subagentFallbackAccountPreview = \([^)]*\)/g) ?? [];
    // Two assignment sites: the primary selection path and the encrypted-recovery path.
    expect(previews).toHaveLength(2);
    // Neither may drop the third parameter — that is exactly how recovery lost it.
    for (const preview of previews) {
      expect(preview).toContain("modelEligibleAccountIds");
    }

    // And both must actually forward it into the preview call, not merely accept it.
    const forwarded = source.match(
      /\{ \.\.\.(previewSelectionOptions|recoverySelectionOptions), modelEligibleAccountIds \},\s*modelId,\s*\)/g,
    ) ?? [];
    expect(forwarded).toHaveLength(2);
  });

  test("uses healthier pool account B when active A is above threshold", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    installCodexRosterMock({
      pool_acc_a: GPT56_NATIVE_MODELS,
      pool_acc_b: GPT56_NATIVE_MODELS,
    });
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      activeCodexAccountId: "pool-a",
      subagentModelFallback: ["gpt-5.6-terra"],
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
    });
    updateAccountQuota("pool-a", 95, undefined, 20);
    updateAccountQuota("pool-b", 10, undefined, 20);
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg);
    noteSubagentModelFailure("grok-4.5", "429", cfg);

    const activeBefore = cfg.activeCodexAccountId;
    expect(previewCodexAccountForRequest(null, cfg, now)).toBe("pool-b");
    expect(cfg.activeCodexAccountId).toBe(activeBefore);
    expect(getCodexUpstreamHealth("pool-a")?.probeLeaseId).toBeUndefined();
    expect(getCodexUpstreamHealth("pool-b")?.probeLeaseId).toBeUndefined();

    let finalAuth: CodexAuthContext | undefined;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture, {
      pool_acc_a: GPT56_NATIVE_MODELS,
      pool_acc_b: GPT56_NATIVE_MODELS,
    });

    const response = await postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: readableAgentInput(), stream: false },
      { onCodexAuthContextResolved: (ctx) => { finalAuth = ctx; } },
    );

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("chatgpt.com/backend-api/codex"))).toBe(true);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-b" });
    expect(capture.auths.some((auth) => auth?.includes("pool-b_token"))).toBe(true);
  });

  test("skips native fallback when every pool account is exhausted", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    installCodexRosterMock({
      pool_acc_a: GPT56_NATIVE_MODELS,
      pool_acc_b: GPT56_NATIVE_MODELS,
    });
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      activeCodexAccountId: "pool-a",
      subagentModelFallback: ["gpt-5.6-terra", "xai/grok-3"],
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
    });
    updateAccountQuota("pool-a", 95, undefined, 20);
    updateAccountQuota("pool-b", 90, undefined, 20);
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg);
    noteSubagentModelFailure("grok-4.5", "429", cfg);

    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(cfg, {
      model: "xai/grok-4.5",
      input: readableAgentInput(),
      stream: false,
    });

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("api.x.ai"))).toBe(true);
    expect(capture.urls.some((url) => url.includes("chatgpt.com"))).toBe(false);
  });

  test("preview selection does not mutate affinity or acquire probe leases", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    installCodexRosterMock({
      pool_acc_a: GPT56_NATIVE_MODELS,
      pool_acc_b: GPT56_NATIVE_MODELS,
    });
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
    });
    updateAccountQuota("pool-a", 95, undefined, 20);
    updateAccountQuota("pool-b", 10, undefined, 20);

    // Bind affinity to pool-a via normal resolution once.
    const bound = resolveCodexAccountForThreadDetailed("thread-1", cfg, now);
    expect(bound).toMatchObject({ status: "selected", accountId: "pool-b" });
    const activeAfterBind = cfg.activeCodexAccountId;

    const previewed = previewCodexAccountForRequest("thread-1", cfg, now);
    expect(previewed).toBe("pool-b");
    expect(cfg.activeCodexAccountId).toBe(activeAfterBind);
    expect(getCodexUpstreamHealth("pool-a")?.probeLeaseId).toBeUndefined();
    expect(getCodexUpstreamHealth("pool-b")?.probeLeaseId).toBeUndefined();
  });
});

describe("account-gated retry entitlement boundary", () => {
  const model = "gpt-daybreak-blue-latest";

  function retryConfig(secondAccount = false): OcxConfig {
    // Keep account selection local to this boundary test. Without known quota, auth performs a
    // WHAM prime whose fetch is unrelated to the credential-bearing send count asserted below.
    updateAccountQuota("pool-a", 10, undefined, 20);
    if (secondAccount) updateAccountQuota("pool-b", 10, undefined, 20);
    return poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        ...(secondAccount
          ? [{ id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" }]
          : []),
      ],
    });
  }

  test("temporary main drain fences every retry-stage entitlement refresh", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    const cfg = retryConfig();
    let selectionReleases = 0;
    const turnAdmissionLease = {
      release() {},
      beginCodexAccountSelection() {
        return {
          mainProfileDraining: true,
          claimMainProfile: () => false,
          release: () => { selectionReleases += 1; },
        };
      },
    } satisfies Pick<ActiveTurnLease, "release" | "beginCodexAccountSelection">;
    const mainExclusions: boolean[] = [];
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls <= 2) return unsupportedCodexModelResponse(model);
      return Response.json({
        id: "resp_retry_fenced",
        object: "response",
        status: "completed",
        model,
        output: [],
      });
    }) as typeof fetch;

    const response = await postDirectCodex(
      cfg,
      { model, input: "hello", stream: false },
      {
        turnAdmissionLease,
        resolveCodexModelEntitlements: async (_config, resolveOptions) => {
          mainExclusions.push(resolveOptions?.excludeAccountIds?.has("__main__") === true);
          return entitlementSnapshot({ "pool-a": [model] });
        },
      },
    );

    expect(response.status).toBe(200);
    expect(fetchCalls).toBe(3);
    expect(mainExclusions).toEqual([true, true, true]);
    expect(selectionReleases).toBe(3);
  });

  test("a first-refresh programmer error cancels the 400 and releases its quota probe", async () => {
    const cooldownAt = 1_800_000_000_000;
    const probeAt = cooldownAt + CODEX_QUOTA_PROBE_INTERVAL_MS;
    Date.now = () => probeAt;
    installPoolCredential("pool-a", "pool_acc_a", probeAt);
    const cfg = retryConfig();
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
      fixedAccount: true,
      modelId: model,
      now: cooldownAt,
      resetAt: Math.floor((cooldownAt + 4 * 24 * 60 * 60_000) / 1_000),
    });
    let entitlementCalls = 0;
    let firstAuth: CodexAuthContext | undefined;
    const upstreamResponses: Response[] = [];
    globalThis.fetch = (async () => {
      const response = unsupportedCodexModelResponse(model);
      upstreamResponses.push(response);
      return response;
    }) as typeof fetch;

    await expect(postDirectCodex(
      cfg,
      { model, input: "hello", stream: false },
      {
        onCodexAuthContextResolved: (ctx) => { firstAuth ??= ctx; },
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          if (entitlementCalls === 1) return entitlementSnapshot({ "pool-a": [model] });
          throw new TypeError("first-refresh programmer sentinel");
        },
      },
    )).rejects.toThrow("first-refresh programmer sentinel");

    const firstProbeLeaseId = (firstAuth as { probeLeaseId?: string } | undefined)?.probeLeaseId;
    expect(firstProbeLeaseId).toBeTruthy();
    expect(upstreamResponses).toHaveLength(1);
    expect(upstreamResponses[0]?.bodyUsed).toBe(true);

    Date.now = () => probeAt + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const nextProbe = await resolveCodexAuthContext(new Headers(), cfg, "pool", {
      modelId: model,
      resolveCodexModelEntitlements: async () => entitlementSnapshot({ "pool-a": [model] }),
    });
    expect((nextProbe as { probeLeaseId?: string }).probeLeaseId).toBeTruthy();
    expect((nextProbe as { probeLeaseId?: string }).probeLeaseId).not.toBe(firstProbeLeaseId);
  });

  test("an alternate-selection programmer error cancels the 400 and releases its quota probe", async () => {
    const cooldownAt = 1_800_000_000_000;
    const probeAt = cooldownAt + CODEX_QUOTA_PROBE_INTERVAL_MS;
    Date.now = () => probeAt;
    installPoolCredential("pool-a", "pool_acc_a", probeAt);
    installPoolCredential("pool-b", "pool_acc_b", probeAt);
    const cfg = retryConfig(true);
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
      fixedAccount: true,
      modelId: model,
      now: cooldownAt,
      resetAt: Math.floor((cooldownAt + 4 * 24 * 60 * 60_000) / 1_000),
    });
    let entitlementCalls = 0;
    let firstAuth: CodexAuthContext | undefined;
    const upstreamResponses: Response[] = [];
    globalThis.fetch = (async () => {
      const response = unsupportedCodexModelResponse(model);
      upstreamResponses.push(response);
      return response;
    }) as typeof fetch;

    await expect(postDirectCodex(
      cfg,
      { model, input: "hello", stream: false },
      {
        onCodexAuthContextResolved: (ctx) => { firstAuth ??= ctx; },
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          if (entitlementCalls === 1) {
            return entitlementSnapshot({
              "pool-a": [model],
              "pool-b": ["gpt-5.6-sol"],
            });
          }
          if (entitlementCalls === 2) {
            return entitlementSnapshot({
              "pool-a": ["gpt-5.6-sol"],
              "pool-b": [model],
            });
          }
          throw new TypeError("alternate programmer sentinel");
        },
      },
    )).rejects.toThrow("alternate programmer sentinel");

    const firstProbeLeaseId = (firstAuth as { probeLeaseId?: string } | undefined)?.probeLeaseId;
    expect(firstProbeLeaseId).toBeTruthy();
    expect(upstreamResponses).toHaveLength(1);
    expect(upstreamResponses[0]?.bodyUsed).toBe(true);

    Date.now = () => probeAt + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const nextProbe = await resolveCodexAuthContext(new Headers(), cfg, "pool", {
      modelId: model,
      resolveCodexModelEntitlements: async () => entitlementSnapshot({
        "pool-a": [model],
        "pool-b": ["gpt-5.6-sol"],
      }),
    });
    expect((nextProbe as { probeLeaseId?: string }).probeLeaseId).toBeTruthy();
    expect((nextProbe as { probeLeaseId?: string }).probeLeaseId).not.toBe(firstProbeLeaseId);
  });

  test("a programmer error between same-account retries keeps its original error path", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    const cfg = retryConfig();
    let entitlementCalls = 0;
    let fetchCalls = 0;
    const upstreamResponses: Response[] = [];
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      const response = unsupportedCodexModelResponse(model);
      upstreamResponses.push(response);
      return response;
    }) as typeof fetch;

    await expect(postDirectCodex(
      cfg,
      { model, input: "hello", stream: false },
      {
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          if (entitlementCalls <= 2) return entitlementSnapshot({ "pool-a": [model] });
          throw new TypeError("retry programmer sentinel");
        },
      },
    )).rejects.toThrow("retry programmer sentinel");
    expect(entitlementCalls).toBe(3);
    expect(fetchCalls).toBe(2);
    expect(upstreamResponses.every(response => response.bodyUsed)).toBe(true);
  });
});

describe("encrypted child native-only fallback", () => {
  test("rejects encrypted routed primary when only routed fallbacks exist", async () => {
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      subagentModelFallback: ["xai/grok-3"],
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
      },
    });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    }) as typeof fetch;

    const response = await postSpawn(cfg, {
      model: "xai/grok-4.5",
      input: encryptedAgentInput(),
      stream: false,
    });
    const json = await response.json() as { error?: { code?: string } };
    expect(response.status).toBe(400);
    expect(json.error?.code).toBe("unreadable_encrypted_agent_task");
    expect(fetchCalls).toBe(0);
  });

  test("skips exhausted native candidates before rejecting encrypted routed primary", async () => {
    resetSubagentModelFallbackStateForTests();
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      subagentModelFallback: ["gpt-5.6-terra", "xai/grok-3"],
      activeCodexAccountId: undefined,
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.6-terra", "429", cfg);

    const response = await postSpawn(cfg, {
      model: "xai/grok-4.5",
      input: encryptedAgentInput(),
      stream: false,
    });
    expect(response.status).toBe(400);
  });

  test("non-thread-spawn encrypted routed requests stay rejected without fallback", async () => {
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      subagentModelFallback: ["gpt-5.5"],
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer caller-codex-token",
        },
        body: JSON.stringify({
          model: "xai/grok-4.5",
          input: encryptedAgentInput(),
          stream: false,
        }),
      }),
      cfg,
      { model: "", provider: "" },
    );
    expect(response.status).toBe(400);
  });
});

describe("native passthrough terminal finalization", () => {
  function failedSse(message: string, type = "rate_limit_error"): string {
    return `event: response.failed\ndata: ${JSON.stringify({
      type: "response.failed",
      response: {
        status: "failed",
        error: { type, message },
      },
    })}\n\n`;
  }

  async function runStreamingSpawn(
    streamMode: "legacy-tee" | "eager-relay",
    sseBody: string,
  ): Promise<{
    terminals: ResponsesTerminalStatus[];
    healthBlocked: boolean;
    responseText: string;
  }> {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg = poolNativePlusRoutedConfig({
      streamMode,
      activeCodexAccountId: "pool-a",
      subagentModelFallback: ["xai/grok-4.5"],
    });
    updateAccountQuota("pool-a", 20, undefined, 20);

    const terminals: ResponsesTerminalStatus[] = [];
    mockSseUpstream(sseBody);

    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    // Force win32 so eager-relay decision path is reachable via streamMode override.
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const response = await postSpawn(
        cfg,
        { model: "gpt-5.5", input: readableAgentInput(), stream: true },
        {
          onNativePassthroughTerminal: (status) => terminals.push(status),
        },
      );
      const responseText = await response.text();
      // Allow inspection consumer microtasks to settle.
      await Bun.sleep(20);
      return {
        terminals,
        healthBlocked: isModelHealthBlocked("gpt-5.5", cfg, "pool-a"),
        responseText,
      };
    } finally {
      if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
    }
  }

  for (const streamMode of ["legacy-tee", "eager-relay"] as const) {
    test(`${streamMode}: 429 failed records health and invokes terminal callback`, async () => {
      const result = await runStreamingSpawn(streamMode, failedSse("rate limited", "rate_limit_error"));
      expect(result.terminals).toEqual(["failed"]);
      expect(result.healthBlocked).toBe(true);
      expect(result.responseText).toContain("response.failed");
    });

    test(`${streamMode}: 402-style insufficient_quota records health and invokes callback`, async () => {
      const result = await runStreamingSpawn(
        streamMode,
        failedSse("insufficient quota", "insufficient_quota"),
      );
      expect(result.terminals).toEqual(["failed"]);
      expect(result.healthBlocked).toBe(true);
    });

    test(`${streamMode}: generic 500 failure invokes terminal callback without health block`, async () => {
      const result = await runStreamingSpawn(
        streamMode,
        failedSse("internal server error", "server_error"),
      );
      expect(result.terminals).toEqual(["failed"]);
      expect(result.healthBlocked).toBe(false);
    });

    test(`${streamMode}: completed terminal fires exactly once`, async () => {
      const sse = `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "r1", status: "completed", output: [] },
      })}\n\n`;
      const result = await runStreamingSpawn(streamMode, sse);
      expect(result.terminals).toEqual(["completed"]);
      expect(result.healthBlocked).toBe(false);
    });
  }
});

describe("darwin explicit eager-relay path selection", () => {
  const completedSse = `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { id: "r1", status: "completed", output: [] },
  })}\n\n`;

  async function runDarwinStreamMode(streamMode: "legacy-tee" | "eager-relay"): Promise<Response> {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc", now);
    mockSseUpstream(completedSse);
    return postSpawn(
      poolNativePlusRoutedConfig({ streamMode, activeCodexAccountId: "pool-a" }),
      { model: "gpt-5.5", input: readableAgentInput(), stream: true },
    );
  }

  test.skipIf(process.platform !== "darwin")(
    "eager-relay + no rewrite marks the direct handleResponses response as eager",
    async () => {
      const response = await runDarwinStreamMode("eager-relay");
      expect(isEagerRelaySseResponse(response)).toBe(true);
      expect(await response.text()).toContain("response.completed");
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "legacy-tee + no rewrite does not carry the eager marker",
    async () => {
      const response = await runDarwinStreamMode("legacy-tee");
      expect(isEagerRelaySseResponse(response)).toBe(false);
      expect(await response.text()).toContain("response.completed");
    },
  );
});
