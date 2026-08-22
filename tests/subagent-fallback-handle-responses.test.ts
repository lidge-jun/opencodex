/**
 * handleResponses integration coverage for PR #391 merge blockers:
 * pre-fallback account preview (no probe lease), final-route normalization,
 * native effort clamp on final route, pool account preview for native fallback,
 * encrypted native-only fallback, native passthrough terminal finalization.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import {
  clearAccountQuota,
  updateAccountQuota,
} from "../src/codex/quota";
import {
  canAcquireCodexQuotaScopeProbeLease,
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexQuotaHealthSnapshot,
  getCodexUpstreamHealth,
  previewCodexAccountForRequest,
  recordCodexUpstreamOutcome,
  releaseCodexQuotaScopeProbeLease,
  resolveCodexAccountForThreadDetailed,
  tryAcquireCodexQuotaScopeProbeLease,
} from "../src/codex/routing";
import {
  DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS,
  isModelHealthBlocked,
  resetSubagentModelFallbackStateForTests,
  setSubagentQuotaPrimeForTests,
} from "../src/codex/subagent-model-fallback";
import { resolveCodexAuthContext, type CodexAuthContext } from "../src/codex/auth-context";
import { resolveCodexModelEntitlements } from "../src/codex/model-entitlements";
import {
  acquireUpstreamHostAdmission,
  clearUpstreamHostHealth,
  getUpstreamHostHealth,
  recordUpstreamHostFailure,
  releaseUpstreamHostAdmission,
  upstreamHostHealthKey,
} from "../src/codex/upstream-host-health";
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
  clearUpstreamHostHealth();
  clearAccountQuota();
  resetSubagentModelFallbackStateForTests();
  resetAgentTaskRecoveryState();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearUpstreamHostHealth();
  clearAccountQuota();
  resetSubagentModelFallbackStateForTests();
  resetAgentTaskRecoveryState();
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

function mockUpstream(capture: {
  urls: string[];
  bodies: string[];
  auths: Array<string | null>;
}): void {
  globalThis.fetch = (async (input, init) => {
    capture.urls.push(String(input));
    capture.bodies.push(typeof init?.body === "string" ? init.body : "");
    const headers = new Headers(init?.headers);
    capture.auths.push(headers.get("authorization"));
    return Response.json({
      id: "resp_test",
      object: "response",
      status: "completed",
      model: "gpt-5.6-sol",
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

describe("subagent fallback without primary auth cooldown failure", () => {
  test("fallback-chain resolution failure releases the preview selection admission", async () => {
    writeFileSync(join(testDir, "agents"), "not a directory", "utf8");
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
    const cfg = poolNativePlusRoutedConfig({
      subagentModelFallback: ["xai/grok-4.5"],
    });

    await expect(postSpawn(
      cfg,
      { model: "gpt-5.6-sol", input: readableAgentInput(), stream: false },
      { turnAdmissionLease },
    )).rejects.toThrow();

    expect(selectionStarts).toBe(1);
    expect(selectionReleases).toBe(1);
  });

  test("open ChatGPT circuit skips gated entitlement discovery for a healthy routed primary", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    const cfg = poolNativePlusRoutedConfig({
      upstreamHostCircuitThreshold: 1,
      subagentModelFallback: ["gpt-daybreak-blue-latest"],
    });
    const hostKey = upstreamHostHealthKey("openai", "https://chatgpt.com");
    const admission = acquireUpstreamHostAdmission(hostKey, 1, now);
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted" || !admission.lease) {
      throw new Error("expected ChatGPT host circuit admission lease");
    }
    recordUpstreamHostFailure(hostKey, {
      code: "ECONNREFUSED",
      now,
      threshold: 1,
      lease: admission.lease,
    });

    let entitlementCalls = 0;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);
    const response = await postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: readableAgentInput(), stream: false },
      {
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          throw new Error("must not bypass ChatGPT host admission");
        },
      },
    );

    expect(response.status).toBe(200);
    expect(entitlementCalls).toBe(0);
    expect(capture.urls).toHaveLength(1);
    expect(capture.urls[0]).toContain("api.x.ai");
    expect(capture.urls.some(url => url.includes("chatgpt.com"))).toBe(false);
  });

  test("healthy routed primary does not discover entitlements for a later gated fallback", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    const cfg = poolNativePlusRoutedConfig({
      subagentModelFallback: ["gpt-daybreak-blue-latest"],
    });
    setSubagentQuotaPrimeForTests(async () => {});

    let entitlementCalls = 0;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);
    const response = await postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: readableAgentInput(), stream: false },
      {
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          throw new Error("healthy routed primary must finish selection before gated discovery");
        },
      },
    );

    expect(response.status).toBe(200);
    expect(entitlementCalls).toBe(0);
    expect(capture.urls).toHaveLength(1);
    expect(capture.urls[0]).toContain("api.x.ai");
    expect(capture.urls.some(url => url.includes("chatgpt.com"))).toBe(false);
  });

  test("unavailable routed primary discovers entitlements only after reaching gated fallback", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg = poolNativePlusRoutedConfig({
      autoSwitchThreshold: 0,
      subagentModelFallback: ["gpt-daybreak-blue-latest"],
    });
    setSubagentQuotaPrimeForTests(async () => {});
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg, undefined, now);
    const entitlementSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-daybreak-blue-latest"])],
      ]),
      confirmedAccountIds: new Set(["pool-a"]),
      credentialIdentities: new Map<string, string>(),
    };

    let entitlementCalls = 0;
    let finalAuth: CodexAuthContext | undefined;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);
    const response = await postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: readableAgentInput(), stream: false },
      {
        onCodexAuthContextResolved: (ctx) => { finalAuth = ctx; },
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          return entitlementSnapshot;
        },
      },
    );

    expect(response.status).toBe(200);
    // One lazy selection lookup plus final-auth revalidation.
    expect(entitlementCalls).toBe(2);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(capture.urls.some(url => url.includes("chatgpt.com/backend-api/codex"))).toBe(true);
    expect(capture.urls.some(url => url.includes("api.x.ai"))).toBe(false);
    expect(capture.bodies.some(body => body.includes('"model":"gpt-5.6-sol"'))).toBe(true);
  });

  test("entitlement discovery restarts selection from a newly healthy routed primary", async () => {
    const now = 1_800_000_000_000;
    let currentNow = now;
    Date.now = () => currentNow;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg = poolNativePlusRoutedConfig({
      autoSwitchThreshold: 0,
      subagentModelFallback: ["gpt-daybreak-blue-latest"],
    });
    setSubagentQuotaPrimeForTests(async () => {});
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg, undefined, now, 1_000);
    const entitlementSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-daybreak-blue-latest"])],
      ]),
      confirmedAccountIds: new Set(["pool-a"]),
      credentialIdentities: new Map<string, string>(),
    };
    let entitlementCalls = 0;
    let resolveDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => { resolveDiscoveryStarted = resolve; });
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const responsePromise = postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: readableAgentInput(), stream: false },
      {
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          resolveDiscoveryStarted();
          await discoveryGate;
          return entitlementSnapshot;
        },
      },
    );
    await discoveryStarted;
    currentNow = now + 1_001;
    releaseDiscovery();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(entitlementCalls).toBe(1);
    expect(capture.urls).toHaveLength(1);
    expect(capture.urls[0]).toContain("api.x.ai");
    expect(capture.urls.some(url => url.includes("chatgpt.com"))).toBe(false);
  });

  test("circuit opening during credential work fences every gated roster fetch", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    const cfg = poolNativePlusRoutedConfig({
      upstreamHostCircuitThreshold: 1,
      subagentModelFallback: ["gpt-daybreak-blue-latest", "xai/grok-3"],
    });
    setSubagentQuotaPrimeForTests(async () => {});
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg, undefined, now);
    const hostKey = upstreamHostHealthKey("openai", "https://chatgpt.com");
    let rosterFetches = 0;
    let circuitOpened = false;
    let releaseRoster!: () => void;
    const rosterGate = new Promise<void>((resolve) => { releaseRoster = resolve; });
    const entitlementCredential = {
      accountId: "pool-a",
      accessToken: "pool-a-token",
      chatgptAccountId: "pool_acc",
      credentialIdentity: "test:pool-a",
    };
    const deferredRosterFetcher = (async () => {
      rosterFetches += 1;
      await rosterGate;
      return Response.json({ models: [] });
    }) as typeof fetch;
    // Another request already owns a discovery flight before this request's
    // credential work opens the circuit.
    const staleFlight = resolveCodexModelEntitlements(cfg, {
      credentials: [entitlementCredential],
      fetcher: deferredRosterFetcher,
      now,
    });
    expect(rosterFetches).toBe(1);
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const responsePromise = postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: readableAgentInput(), stream: false },
      {
        resolveCodexModelEntitlements: async (config, resolveOptions) => {
          const admission = acquireUpstreamHostAdmission(hostKey, 1, now);
          expect(admission.kind).toBe("admitted");
          if (admission.kind !== "admitted" || !admission.lease) {
            throw new Error("expected ChatGPT host circuit admission lease");
          }
          recordUpstreamHostFailure(hostKey, {
            code: "ECONNREFUSED",
            now,
            threshold: 1,
            lease: admission.lease,
          });
          circuitOpened = true;
          return resolveCodexModelEntitlements(config, {
            ...resolveOptions,
            credentials: [entitlementCredential],
            fetcher: deferredRosterFetcher,
          });
        },
      },
    );
    const completedBeforeStaleFlight = await Promise.race([
      responsePromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    releaseRoster();
    const [response] = await Promise.all([responsePromise, staleFlight]);

    expect(response.status).toBe(200);
    expect(completedBeforeStaleFlight).toBe(true);
    expect(circuitOpened).toBe(true);
    expect(rosterFetches).toBe(1);
    expect(capture.urls).toHaveLength(1);
    expect(capture.urls[0]).toContain("api.x.ai");
    expect(capture.urls.some(url => url.includes("chatgpt.com"))).toBe(false);
  });

  test("probe-due gated primary keeps half-open ownership from a same-model fixed fallback", async () => {
    const now = 1_800_000_000_000;
    let currentNow = now;
    Date.now = () => currentNow;
    installPoolCredential("pool-a", "pool_acc", now);
    installPoolCredential("pool-b", "pool_b_acc", now);
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      upstreamHostCircuitThreshold: 1,
      codexAccountNamespaces: { team: "pool-b" },
      subagentModelFallback: ["team/gpt-daybreak-blue-latest", "xai/grok-4.5"],
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc" },
        { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_b_acc" },
      ],
    });
    const hostKey = upstreamHostHealthKey("openai", "https://chatgpt.com");
    const admission = acquireUpstreamHostAdmission(hostKey, 1, now);
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted" || !admission.lease) {
      throw new Error("expected ChatGPT host circuit admission lease");
    }
    recordUpstreamHostFailure(hostKey, {
      code: "ECONNREFUSED",
      now,
      threshold: 1,
      lease: admission.lease,
    });
    const cooldownUntil = getUpstreamHostHealth(hostKey)?.cooldownUntil;
    expect(cooldownUntil).toBeNumber();
    currentNow = (cooldownUntil ?? now) + 1;
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-daybreak-blue-latest", "429", cfg, "pool-a", now);

    const entitlementSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-daybreak-blue-latest"])],
        ["pool-b", new Set(["gpt-daybreak-blue-latest"])],
      ]),
      confirmedAccountIds: new Set(["pool-a", "pool-b"]),
      credentialIdentities: new Map<string, string>(),
    };
    let entitlementCalls = 0;
    let finalAuth: CodexAuthContext | undefined;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);
    const response = await postSpawn(
      cfg,
      { model: "gpt-daybreak-blue-latest", input: readableAgentInput(), stream: false },
      {
        onCodexAuthContextResolved: (ctx) => { finalAuth = ctx; },
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          return entitlementSnapshot;
        },
      },
    );

    expect(response.status).toBe(200);
    // One call belongs to final auth after half-open host admission. The former
    // speculative pre-admission discovery would make this two.
    expect(entitlementCalls).toBe(1);
    expect(capture.urls.length).toBeGreaterThan(0);
    expect(capture.urls.some(url => url.includes("chatgpt.com/backend-api/codex/responses"))).toBe(true);
    expect(capture.urls.some(url => url.includes("/backend-api/codex/models"))).toBe(false);
    expect(capture.urls.some(url => url.includes("api.x.ai"))).toBe(false);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(getUpstreamHostHealth(hostKey)).toBeNull();
  });

  test("occupied half-open probe lets a concurrent gated primary use a healthy routed fallback", async () => {
    const now = 1_800_000_000_000;
    let currentNow = now;
    Date.now = () => currentNow;
    const cfg = poolNativePlusRoutedConfig({
      upstreamHostCircuitThreshold: 1,
      subagentModelFallback: ["xai/grok-4.5"],
    });
    const hostKey = upstreamHostHealthKey("openai", "https://chatgpt.com");
    const openingAdmission = acquireUpstreamHostAdmission(hostKey, 1, now);
    expect(openingAdmission.kind).toBe("admitted");
    if (openingAdmission.kind !== "admitted" || !openingAdmission.lease) {
      throw new Error("expected ChatGPT host circuit admission lease");
    }
    recordUpstreamHostFailure(hostKey, {
      code: "ECONNREFUSED",
      now,
      threshold: 1,
      lease: openingAdmission.lease,
    });
    const cooldownUntil = getUpstreamHostHealth(hostKey)?.cooldownUntil;
    expect(cooldownUntil).toBeNumber();
    currentNow = (cooldownUntil ?? now) + 1;
    const probeOwner = acquireUpstreamHostAdmission(hostKey, 1, currentNow);
    expect(probeOwner.kind).toBe("admitted");
    if (probeOwner.kind !== "admitted" || !probeOwner.lease) {
      throw new Error("expected half-open probe owner");
    }
    expect(probeOwner.lease.halfOpen).toBe(true);

    let entitlementCalls = 0;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);
    const response = await postSpawn(
      cfg,
      { model: "gpt-daybreak-blue-latest", input: readableAgentInput(), stream: false },
      {
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          throw new Error("entitlement discovery must remain fenced");
        },
      },
    );

    expect(response.status).toBe(200);
    expect(entitlementCalls).toBe(0);
    expect(capture.urls).toHaveLength(1);
    expect(capture.urls[0]).toContain("api.x.ai");
    expect(capture.urls.some(url => url.includes("chatgpt.com"))).toBe(false);
    expect(acquireUpstreamHostAdmission(hostKey, 1, currentNow)).toEqual({
      kind: "blocked",
      retryAfterSeconds: 1,
    });
    expect(releaseUpstreamHostAdmission(probeOwner.lease, currentNow)).toBe(true);
  });

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
      model: "side/gpt-5.6-sol",
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
    expect(new Set(models)).toEqual(new Set(["gpt-5.6-sol"]));
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
      { model: "gpt-5.6-sol", input: readableAgentInput(), stream: false },
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
      model: "gpt-5.6-sol",
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
    noteSubagentModelFailure("gpt-5.6-sol", "429", cfg, "pool-a");

    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    Date.now = () => probeAt;

    let finalAuth: CodexAuthContext | undefined;
    const authPublications: Array<CodexAuthContext | undefined> = [];
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "gpt-5.6-sol", input: readableAgentInput(), stream: false },
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

  test("concurrent probe-due spawns reserve once and advance the loser to routed fallback", async () => {
    const now = 1_800_000_000_000;
    let currentNow = now;
    Date.now = () => currentNow;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg = poolNativePlusRoutedConfig({
      autoSwitchThreshold: 0,
      subagentModelFallback: ["gpt-daybreak-blue-latest", "xai/grok-3"],
    });
    setSubagentQuotaPrimeForTests(async () => {});
    updateAccountQuota("pool-a", 10, undefined, 20);
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
      modelId: "gpt-daybreak-blue-latest",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg, undefined, now, 60 * 60_000);
    currentNow = now + CODEX_QUOTA_PROBE_INTERVAL_MS + 1;

    const entitlementSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-daybreak-blue-latest"])],
      ]),
      confirmedAccountIds: new Set(["pool-a"]),
      credentialIdentities: new Map<string, string>(),
    };
    let lazySelectionsStarted = 0;
    let releaseLazySelections!: () => void;
    const lazySelectionGate = new Promise<void>((resolve) => { releaseLazySelections = resolve; });
    let resolveBothLazySelectionsStarted!: () => void;
    const bothLazySelectionsStarted = new Promise<void>((resolve) => {
      resolveBothLazySelectionsStarted = resolve;
    });
    const resolverCalls = [0, 0];
    let probeOccupiedBeforeFinalAuth = false;
    const entitlementResolver = (requestIndex: number) => async () => {
      resolverCalls[requestIndex] += 1;
      if (resolverCalls[requestIndex] === 1) {
        lazySelectionsStarted += 1;
        if (lazySelectionsStarted === 2) {
          resolveBothLazySelectionsStarted();
          releaseLazySelections();
        }
        await lazySelectionGate;
      } else if (resolverCalls[requestIndex] === 2) {
        probeOccupiedBeforeFinalAuth = !canAcquireCodexQuotaScopeProbeLease(
          "pool-a",
          "shared",
          currentNow,
        );
      }
      return entitlementSnapshot;
    };

    const authPublications: Array<CodexAuthContext | undefined> = [];
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);
    const requests = [0, 1].map((requestIndex) => postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: readableAgentInput(), stream: false },
      {
        onCodexAuthContextResolved: (ctx) => authPublications.push(ctx),
        resolveCodexModelEntitlements: entitlementResolver(requestIndex),
      },
      { model: "", provider: "" },
      {
        "session-id": `probe-race-session-${requestIndex}`,
        "thread-id": `probe-race-thread-${requestIndex}`,
      },
    ));
    await bothLazySelectionsStarted;
    const responses = await Promise.all(requests);

    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(resolverCalls.reduce((sum, calls) => sum + calls, 0)).toBe(3);
    expect(capture.urls.filter(url => url.includes("chatgpt.com/backend-api/codex"))).toHaveLength(1);
    expect(capture.urls.filter(url => url.includes("api.x.ai"))).toHaveLength(1);
    const nativeAuth = authPublications.filter(
      (ctx): ctx is CodexAuthContext => ctx !== undefined,
    );
    expect(nativeAuth).toHaveLength(1);
    expect(nativeAuth[0]).toMatchObject({
      kind: "pool",
      accountId: "pool-a",
      probeQuotaScope: "shared",
    });
    expect(probeOccupiedBeforeFinalAuth).toBe(true);
    expect((nativeAuth[0] as { probeLeaseId?: string }).probeLeaseId).toBeTruthy();
    expect(authPublications.filter(ctx => ctx === undefined)).toHaveLength(1);
    expect(getCodexQuotaHealthSnapshot("pool-a", "shared", currentNow)).toBeNull();
  });

  test("pre-auth continuation refusal releases a reserved scoped probe", async () => {
    const now = 1_800_000_000_000;
    let currentNow = now;
    Date.now = () => currentNow;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg = poolNativePlusRoutedConfig({
      autoSwitchThreshold: 0,
      subagentModelFallback: ["xai/grok-4.5"],
    });
    setSubagentQuotaPrimeForTests(async () => {});
    updateAccountQuota("pool-a", 10, undefined, 20);
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
      modelId: "gpt-5.6-sol",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });
    currentNow = now + CODEX_QUOTA_PROBE_INTERVAL_MS + 1;

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    }) as typeof fetch;
    const response = await postSpawn(cfg, {
      model: "gpt-5.6-sol",
      input: readableAgentInput(),
      previous_response_id: "resp_missing",
      stream: false,
    });

    expect(response.status).toBe(400);
    expect(fetchCalls).toBe(0);
    expect(getCodexQuotaHealthSnapshot("pool-a", "shared", currentNow)).toMatchObject({
      quotaScope: "shared",
    });
    currentNow += CODEX_QUOTA_PROBE_INTERVAL_MS + 1;
    const reacquiredLease = tryAcquireCodexQuotaScopeProbeLease(
      "pool-a",
      "shared",
      currentNow,
    );
    expect(reacquiredLease).toBeTruthy();
    if (reacquiredLease) {
      releaseCodexQuotaScopeProbeLease("pool-a", "shared", reacquiredLease, currentNow);
    }
  });

  test("newer scoped cooldown fences and releases a stale pre-auth reservation", async () => {
    const now = 1_800_000_000_000;
    let currentNow = now;
    Date.now = () => currentNow;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg = poolNativePlusRoutedConfig({
      autoSwitchThreshold: 0,
      subagentModelFallback: ["gpt-daybreak-blue-latest", "xai/grok-3"],
    });
    setSubagentQuotaPrimeForTests(async () => {});
    updateAccountQuota("pool-a", 10, undefined, 20);
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
      modelId: "gpt-daybreak-blue-latest",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg, undefined, now, 60 * 60_000);
    currentNow = now + CODEX_QUOTA_PROBE_INTERVAL_MS + 1;

    const entitlementSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-daybreak-blue-latest"])],
      ]),
      confirmedAccountIds: new Set(["pool-a"]),
      credentialIdentities: new Map<string, string>(),
    };
    let entitlementCalls = 0;
    let sawReservedProbe = false;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    }) as typeof fetch;
    const response = await postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: readableAgentInput(), stream: false },
      {
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          if (entitlementCalls === 2) {
            sawReservedProbe = !canAcquireCodexQuotaScopeProbeLease(
              "pool-a",
              "shared",
              currentNow,
            );
            recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
              modelId: "gpt-daybreak-blue-latest",
              now: currentNow,
              resetAt: Math.floor((currentNow + 60 * 60_000) / 1_000),
            });
          }
          return entitlementSnapshot;
        },
      },
    );

    expect(response.status).toBe(429);
    expect(entitlementCalls).toBe(2);
    expect(sawReservedProbe).toBe(true);
    expect(fetchCalls).toBe(0);
    expect(getCodexQuotaHealthSnapshot("pool-a", "shared", currentNow)).toMatchObject({
      cooldownSource: "reset-derived",
      quotaScope: "shared",
    });
    currentNow += CODEX_QUOTA_PROBE_INTERVAL_MS + 1;
    const reacquiredLease = tryAcquireCodexQuotaScopeProbeLease(
      "pool-a",
      "shared",
      currentNow,
    );
    expect(reacquiredLease).toBeTruthy();
    if (reacquiredLease) {
      releaseCodexQuotaScopeProbeLease("pool-a", "shared", reacquiredLease, currentNow);
    }
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
    mockUpstream(capture);

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
    noteSubagentModelFailure("gpt-5.6-sol", "rate limit exceeded", cfg);

    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(cfg, {
      model: "gpt-5.6-sol",
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
    mockUpstream(capture);

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
    noteSubagentModelFailure("gpt-5.6-sol", "rate limit exceeded", cfg);

    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(cfg, {
      model: "gpt-5.6-sol",
      input: readableAgentInput(),
      stream: false,
    });

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("api.x.ai"))).toBe(true);
  });
});

describe("native fallback account preview", () => {
  test("Desktop fallback affinity drives the subagent preview and final native account", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
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

  test("fallback previews the pool account separately for each candidate quota scope", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
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

    recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
      modelId: "gpt-5.3-codex-spark",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.3-codex-spark", "429", cfg, "pool-a", now);
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
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-b" });
    expect(capture.urls.some((url) => url.includes("chatgpt.com/backend-api/codex"))).toBe(true);
    expect(capture.auths.some((auth) => auth?.includes("pool-b_token"))).toBe(true);
    expect(capture.bodies.some((body) => body.includes('"model":"gpt-5.3-codex-spark"'))).toBe(true);
  });

  test("account-gated fallback previews and authenticates an entitled pool account", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      subagentModelFallback: ["gpt-daybreak-blue-latest", "xai/grok-4.5"],
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
    });
    const desktopHeaders = {
      "session-id": "candidate-entitlement-session-private",
      "thread-id": "candidate-entitlement-thread-private",
    };
    const bound = await resolveCodexAuthContext(new Headers(desktopHeaders), cfg, "pool", {
      modelId: "gpt-5.6-sol",
    });
    expect(bound).toMatchObject({ kind: "pool", accountId: "pool-a" });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.6-sol", "429", cfg, "pool-a", now);
    const entitlementSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-5.6-sol"])],
        ["pool-b", new Set(["gpt-5.6-sol", "gpt-daybreak-blue-latest"])],
      ]),
      confirmedAccountIds: new Set(["pool-a", "pool-b"]),
      credentialIdentities: new Map<string, string>(),
    };
    let entitlementCalls = 0;

    let finalAuth: CodexAuthContext | undefined;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "gpt-5.6-sol", input: readableAgentInput(), stream: false },
      {
        onCodexAuthContextResolved: (ctx) => { finalAuth = ctx; },
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          return entitlementSnapshot;
        },
      },
      { model: "", provider: "" },
      desktopHeaders,
    );

    expect(response.status).toBe(200);
    expect(entitlementCalls).toBe(2);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-b" });
    expect(capture.urls.some((url) => url.includes("chatgpt.com/backend-api/codex"))).toBe(true);
    expect(capture.auths.some((auth) => auth?.includes("pool-b_token"))).toBe(true);
    expect(capture.urls.some((url) => url.includes("api.x.ai"))).toBe(false);
  });

  test("account-qualified primary previews an entitled pool account for a gated fallback", async () => {
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
        ["pool-a", new Set(["gpt-5.6-sol"])],
        ["pool-b", new Set(["gpt-5.6-sol", "gpt-daybreak-blue-latest"])],
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
          return entitlementSnapshot;
        },
      },
      logCtx,
    );

    expect(response.status).toBe(200);
    expect(entitlementCalls).toBe(2);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-b" });
    expect((logCtx as unknown as Record<string, unknown>).subagentModelFallbackTo)
      .toBe("gpt-daybreak-blue-latest");
    expect(capture.bodies.filter(body => body.length > 0)).toHaveLength(1);
    expect(capture.auths[0]).toContain("pool-b_token");
    expect(capture.auths.some((auth) => auth?.includes("pool-b_token"))).toBe(true);
  });

  test("account-qualified primary reroutes when fallback drops its selector from the same model", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      codexAccountNamespaces: { team: "pool-a" },
      subagentModelFallback: ["gpt-5.6-sol", "xai/grok-4.5"],
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
    let finalAuth: CodexAuthContext | undefined;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "team/gpt-5.6-sol", input: readableAgentInput(), stream: false },
      { onCodexAuthContextResolved: (ctx) => { finalAuth = ctx; } },
      logCtx,
    );

    expect(response.status).toBe(200);
    expect((logCtx as unknown as Record<string, unknown>).subagentModelFallbackFrom)
      .toBe("team/gpt-5.6-sol");
    expect((logCtx as unknown as Record<string, unknown>).subagentModelFallbackTo)
      .toBe("gpt-5.6-sol");
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-b" });
    const responseAuths = capture.auths.filter((_auth, index) => capture.bodies[index]?.length > 0);
    expect(responseAuths).toHaveLength(1);
    expect(responseAuths[0]).toContain("pool-b_token");
    expect(capture.urls.some((url) => url.includes("api.x.ai"))).toBe(false);
  });

  test("account-qualified primary skips an unentitled fixed gated fallback", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      codexAccountNamespaces: { team: "pool-a", restricted: "pool-b" },
      subagentModelFallback: ["restricted/gpt-daybreak-blue-latest", "xai/grok-4.5"],
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
        ["pool-a", new Set(["gpt-5.6-sol", "gpt-daybreak-blue-latest"])],
        ["pool-b", new Set(["gpt-5.6-sol"])],
      ]),
      confirmedAccountIds: new Set(["pool-a", "pool-b"]),
      credentialIdentities: new Map<string, string>(),
    };
    let entitlementCalls = 0;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "team/gpt-5.6-sol", input: readableAgentInput(), stream: false },
      {
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          return entitlementSnapshot;
        },
      },
      logCtx,
    );

    expect(response.status).toBe(200);
    expect(entitlementCalls).toBe(1);
    expect((logCtx as unknown as Record<string, unknown>).subagentModelFallbackTo).toBe("xai/grok-4.5");
    expect(capture.urls).toHaveLength(1);
    expect(capture.urls.some((url) => url.includes("api.x.ai"))).toBe(true);
    expect(capture.urls.some((url) => url.includes("chatgpt.com/backend-api/codex"))).toBe(false);
    expect(capture.bodies.some((body) => body.includes("gpt-daybreak-blue-latest"))).toBe(false);
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
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-b" });
    expect(capture.auths[0]).toContain("pool-b_token");
  });

  test("recovery second pass re-previews the account for the newly available candidate scope", async () => {
    const now = 1_800_000_000_000;
    let currentNow = now;
    Date.now = () => currentNow;
    installPoolCredential("pool-a", "pool_acc_a", now);
    installPoolCredential("pool-b", "pool_acc_b", now);
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      agentTaskRecovery: { enabled: true },
      subagentModelFallback: ["gpt-5.3-codex-spark", "gpt-daybreak-blue-latest"],
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

    recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
      modelId: "gpt-5.3-codex-spark",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.3-codex-spark", "429", cfg, "pool-b", now);
    noteSubagentModelFailure("xai/grok-4.5", "429", cfg, undefined, now, 10 * 60_000);
    const entitlementSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-5.6-sol"])],
        ["pool-b", new Set(["gpt-5.6-sol"])],
      ]),
      confirmedAccountIds: new Set(["pool-a", "pool-b"]),
      credentialIdentities: new Map<string, string>(),
    };
    let entitlementCalls = 0;

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
      const url = String(input);
      const raw = typeof init?.body === "string" ? init.body : "";
      fetchedUrls.push(url);
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
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          return entitlementSnapshot;
        },
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
    expect(selectionStarts).toBe(3);
    expect(selectionReleases).toBe(3);
    // The ciphertext pass reaches the gated boundary once. Recovery selects
    // the now-available ungated Spark candidate before that boundary.
    expect(entitlementCalls).toBe(1);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-b" });
    expect(bodyRequests[1]?.auth).toContain("pool-b_token");
  });

  test("uses healthier pool account B when active A is above threshold", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc_a", now);
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
    mockUpstream(capture);

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

describe("encrypted child native-only fallback", () => {
  test("selects ungated native candidate before gated discovery for encrypted input", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      autoSwitchThreshold: 0,
      subagentModelFallback: ["gpt-5.6-terra", "gpt-daybreak-blue-latest"],
    });
    setSubagentQuotaPrimeForTests(async () => {});
    let entitlementCalls = 0;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "xai/grok-4.5", input: encryptedAgentInput(), stream: false },
      {
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          throw new Error("ungated native candidate must win before gated discovery");
        },
      },
    );

    expect(response.status).toBe(200);
    expect(entitlementCalls).toBe(0);
    expect(capture.urls.some(url => url.includes("api.x.ai"))).toBe(false);
    const bodyRequests = capture.bodies.map((body, index) => ({
      body,
      url: capture.urls[index],
    })).filter(({ body }) => body.length > 0);
    expect(bodyRequests).toHaveLength(1);
    expect(bodyRequests[0]?.url).toContain("chatgpt.com/backend-api/codex");
    expect(bodyRequests[0]?.body).toContain('"model":"gpt-5.6-terra"');
    expect(bodyRequests[0]?.body).toContain(FERNET_TASK);
  });

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
        { model: "gpt-5.6-sol", input: readableAgentInput(), stream: true },
        {
          onNativePassthroughTerminal: (status) => terminals.push(status),
        },
      );
      const responseText = await response.text();
      // Allow inspection consumer microtasks to settle.
      await Bun.sleep(20);
      return {
        terminals,
        healthBlocked: isModelHealthBlocked("gpt-5.6-sol", cfg, "pool-a"),
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
      { model: "gpt-5.6-sol", input: readableAgentInput(), stream: true },
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
