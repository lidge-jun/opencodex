import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount, setAccountPaused } from "../../src/oauth/store";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import * as retry from "../../src/lib/upstream-retry";
import * as webSearch from "../../src/web-search";
import * as adapterResolve from "../../src/server/adapter-resolve";
import * as pacing from "../../src/providers/request-pacing";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";

const DAILY_API_BASE = "https://daily-cloudcode-pa.googleapis.com";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;
let releaseSpendHome: (() => void) | undefined;
let sleepSpy: ReturnType<typeof spyOn> | undefined;

const takeSpendHome = (): void => {
  releaseSpendHome ??= acquireOwnedSpendHome();
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-google-429-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-google-429-"));
  process.env.OPENCODEX_HOME = testDir;
  takeSpendHome();
  clearGenericFailoverHealth();
  sleepSpy = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
});

afterEach(() => {
  sleepSpy?.mockRestore();
  sleepSpy = undefined;
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearGenericFailoverHealth();
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

function antigravityConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": {
        adapter: "google",
        baseUrl: DAILY_API_BASE,
        authMode: "oauth",
        googleMode: "cloud-code-assist",
        project: "initial-project-id",
        models: ["gemini-3.8-flash"],
      },
    },
  } as OcxConfig;
}

function jsonSuccessBody(text: string): Record<string, unknown> {
  return {
    response: {
      candidates: [{
        content: {
          role: "model",
          parts: [{ text }],
        },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 3,
        totalTokenCount: 8,
      },
    },
  };
}

function sseSuccessBody(text: string): string {
  return `data: ${JSON.stringify(jsonSuccessBody(text))}\n\n`;
}

function createResponsesRequest(bodyOverrides: Record<string, unknown> = {}): Request {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "google-antigravity/gemini-3.8-flash",
      input: "hello",
      stream: false,
      ...bodyOverrides,
    }),
  });
}

async function seedAntigravityAccounts(count: number): Promise<Array<{ id: string; auth: string; project: string }>> {
  for (let i = 1; i <= count; i++) {
    await saveCredential("google-antigravity", {
      access: `token-${i}`,
      refresh: `refresh-${i}`,
      expires: Date.now() + 3_600_000,
      accountId: `account-${i}`,
      projectId: `project-${i}`,
    });
  }
  const accounts = getAccountSet("google-antigravity")!.accounts;
  await setActiveAccount("google-antigravity", accounts[0]!.id);
  return accounts.map((a, idx) => ({
    id: a.id,
    auth: `Bearer token-${idx + 1}`,
    project: `project-${idx + 1}`,
  }));
}

function installAntigravityFetchMock(
  handler: (info: { auth: string; project: string; sendIndex: number }) => Response | Promise<Response>,
): void {
  let sendIndex = 0;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const parsedUrl = new URL(url);

    if (parsedUrl.origin === DAILY_API_BASE
      && ["/v1internal:streamGenerateContent", "/v1internal:generateContent"].includes(parsedUrl.pathname)) {
      sendIndex += 1;
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      let project = "";
      if (typeof init?.body === "string") {
        try {
          const parsed = JSON.parse(init.body) as { project?: string };
          project = parsed.project ?? "";
        } catch { /* ignore */ }
      }
      return handler({ auth, project, sendIndex });
    }

    if (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost") return originalFetch(input, init);
    throw new Error(`Unexpected external request: ${url}`);
  }) as typeof fetch;
}

const structuredRefusal = JSON.stringify({ error: {
  status: "PERMISSION_DENIED", message: "validate", details: [{ reason: "VALIDATION_REQUIRED" }],
} });

function webSearchConfig(): OcxConfig {
  const cfg = antigravityConfig();
  cfg.webSearchSidecar = { backend: "exa", exaApiKey: "synthetic-exa-key" };
  saveConfig(cfg);
  return cfg;
}

function budget(sends: number) {
  return createRequestExecutionBudget({
    maxTotalModelSends: sends, baseSendAllowance: sends, finalRecoveryAllowance: 0,
    maxAlternateTargetSends: 0, maxTargetTransitions: 0,
  });
}

const request = () => createResponsesRequest({ tools: [{ type: "web_search" }] });
const route = { model: "gemini-3.8-flash", provider: "google-antigravity" };
const durableHealth = () => getAccountSet("google-antigravity")!.accounts.map(row => ({
  id: row.id, needsReauth: row.needsReauth, needsReauthReason: row.needsReauthReason,
}));

describe("Antigravity web-search structured validation rotation (#6666)", () => {
  test("structured A to B uses B's token/project in exactly two sends and leaves durable health unchanged", async () => {
    const accounts = await seedAntigravityAccounts(2);
    const cfg = webSearchConfig();
    const before = durableHealth();
    const sends: Array<{ auth: string; project: string }> = [];
    installAntigravityFetchMock(({ auth, project, sendIndex }) => {
      sends.push({ auth, project });
      return sendIndex === 1 ? new Response(structuredRefusal, { status: 403 })
        : new Response(sseSuccessBody("sibling answered"), { headers: { "content-type": "text/event-stream" } });
    });
    const sendBudget = budget(2);
    const response = await handleResponses(request(), cfg, route, { sendBudget });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("sibling answered");
    expect(sends).toEqual(accounts.map(({ auth, project }) => ({ auth, project })));
    expect(sendBudget.used).toBe(2);
    expect(durableHealth()).toEqual(before);
  });

  test("repeated structured refusals stop after one sibling", async () => {
    const accounts = await seedAntigravityAccounts(3);
    const cfg = webSearchConfig();
    const before = durableHealth();
    const sends: Array<{ auth: string; project: string }> = [];
    installAntigravityFetchMock(({ auth, project }) => {
      sends.push({ auth, project });
      return new Response(structuredRefusal, { status: 403 });
    });
    const sendBudget = budget(3);
    const response = await handleResponses(request(), cfg, route, { sendBudget });
    expect(response.status).toBe(403);
    await response.text();
    expect(sends).toEqual(accounts.slice(0, 2).map(({ auth, project }) => ({ auth, project })));
    expect(sendBudget.used).toBe(2);
    expect(durableHealth()).toEqual(before);
  });

  test.each([
    ["sentence only", JSON.stringify({ error: { message: "Verify your account to continue." } })],
    ["legacy sentence only", JSON.stringify({ error: { message: "Please verify your account to continue using Antigravity." } })],
    ["unrelated", JSON.stringify({ error: { message: "Feature unavailable", details: [{ reason: "OTHER" }] } })],
    ["spoofed message", JSON.stringify({ error: { message: "Antigravity account validation required (VALIDATION_REQUIRED): validate" } })],
    ["spoofed top level", JSON.stringify({ reason: "VALIDATION_REQUIRED", error: { message: "validate" } })],
    ["spoofed nested reason", JSON.stringify({ error: { details: [{ metadata: { reason: "VALIDATION_REQUIRED" } }] } })],
    ["non-array details", JSON.stringify({ error: { details: { reason: "VALIDATION_REQUIRED" } } })],
    ["malformed", structuredRefusal.slice(0, -1)],
    ["oversized complete JSON", JSON.stringify({ error: { details: [{ reason: "VALIDATION_REQUIRED" }] }, padding: "x".repeat(4096) })],
    ["oversized trailing whitespace", structuredRefusal + " ".repeat(4096)],
  ])("%s never rotates", async (_name, body) => {
    const accounts = await seedAntigravityAccounts(2);
    const cfg = webSearchConfig();
    const before = durableHealth();
    const sends: Array<{ auth: string; project: string }> = [];
    installAntigravityFetchMock(({ auth, project }) => {
      sends.push({ auth, project });
      return new Response(body, { status: 403 });
    });
    const response = await handleResponses(request(), cfg, route);
    expect(response.status).toBe(403);
    await response.text();
    expect(sends).toEqual([{ auth: accounts[0]!.auth, project: accounts[0]!.project }]);
    expect(durableHealth()).toEqual(before);
  });

  test("a spent physical-send budget preserves the refusal and durable health", async () => {
    await seedAntigravityAccounts(2);
    const cfg = webSearchConfig();
    const before = durableHealth();
    let sends = 0;
    installAntigravityFetchMock(() => { sends++; return new Response(structuredRefusal, { status: 403 }); });
    const sendBudget = budget(1);
    const response = await handleResponses(request(), cfg, route, { sendBudget });
    expect(response.status).toBe(403);
    await response.text();
    expect(sends).toBe(1);
    expect(sendBudget.used).toBe(1);
    expect(durableHealth()).toEqual(before);
  });

  test("cancellation prevents a sibling send and durable health changes", async () => {
    await seedAntigravityAccounts(2);
    const cfg = webSearchConfig();
    const before = durableHealth();
    const abort = new AbortController();
    let sends = 0;
    installAntigravityFetchMock(() => {
      sends++; abort.abort(); return new Response(structuredRefusal, { status: 403 });
    });
    const response = await handleResponses(request(), cfg, route, { abortSignal: abort.signal });
    await response.text();
    expect(sends).toBe(1);
    expect(durableHealth()).toEqual(before);
  });

  test("a pool absent before dispatch cannot activate after the first refusal", async () => {
    await seedAntigravityAccounts(1);
    const cfg = webSearchConfig();
    let sends = 0;
    installAntigravityFetchMock(async () => {
      sends++;
      await saveCredential("google-antigravity", {
        access: "late-token", refresh: "late-refresh", expires: Date.now() + 3_600_000,
        accountId: "late-account", projectId: "late-project",
      }, { addAccount: true });
      clearGenericFailoverHealth();
      return new Response(structuredRefusal, { status: 403 });
    });
    const response = await handleResponses(request(), cfg, route);
    expect(response.status).toBe(403);
    await response.text();
    expect(sends).toBe(1);
    expect(durableHealth().every(row => !row.needsReauth)).toBe(true);
  });

  test.each(["unavailable", "projectless"])("an %s sibling preserves the refusal and releases its unused permit", async kind => {
    const accounts = await seedAntigravityAccounts(kind === "projectless" ? 1 : 2);
    if (kind === "projectless") {
      await saveCredential("google-antigravity", {
        access: "projectless-token", refresh: "projectless-refresh", expires: Date.now() + 3_600_000,
        accountId: "projectless-account",
      }, { addAccount: true });
      await setActiveAccount("google-antigravity", accounts[0]!.id);
    }
    const cfg = webSearchConfig();
    const before = durableHealth();
    let sends = 0;
    installAntigravityFetchMock(async () => {
      sends++;
      if (kind === "unavailable") await setAccountPaused("google-antigravity", accounts[1]!.id, true);
      return new Response(structuredRefusal, { status: 403 });
    });
    const sendBudget = budget(2);
    const response = await handleResponses(request(), cfg, route, { sendBudget });
    expect(response.status).toBe(403);
    await response.text();
    expect(sends).toBe(1);
    expect(sendBudget.used).toBe(1);
    expect(sendBudget.remainingBaseSends(2)).toBe(1);
    expect(durableHealth()).toEqual(before);
  });
});

test("web-search preserves structured refusal once the roster's failover limit is spent", async () => {
  const accounts = await seedAntigravityAccounts(5);
  const cfg = webSearchConfig();
  const sends: string[] = [];
  installAntigravityFetchMock(async ({ auth, sendIndex }) => {
    sends.push(auth);
    if (sendIndex <= 4) return Response.json({ error: {
      status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric",
    } }, { status: 429 });
    // A new eligible sibling exists, but it cannot enlarge the captured failover ceiling.
    await saveCredential("google-antigravity", {
      access: "late-token", refresh: "late-refresh", expires: Date.now() + 3_600_000,
      accountId: "late-account", projectId: "late-project",
    }, { addAccount: true });
    return new Response(structuredRefusal, { status: 403 });
  });
  const sendBudget = budget(10);
  const response = await handleResponses(request(), cfg, route, { sendBudget });
  expect(response.status).toBe(403);
  await response.text();
  expect(sends).toEqual(accounts.map(row => row.auth));
  expect(sendBudget.used).toBe(5);
  expect(durableHealth().every(row => !row.needsReauth)).toBe(true);
});

test.each(["non-replayable", "committed output", "non-Google adapter"])(
  "sidecar callback rejects %s before reserving or rotating",
  async gate => {
    await seedAntigravityAccounts(2);
    const cfg = webSearchConfig();
    const before = durableHealth();
    const sendBudget = budget(2);
    const loopSpy = spyOn(webSearch, "runWithWebSearch").mockImplementation(async deps => {
      const refusal = new Response(structuredRefusal, { status: 403 });
      if (gate === "non-replayable") retry.markResponseNonReplayable(refusal);
      if (gate === "committed output") deps.onFirstOutput?.();
      const name = deps.adapter.name;
      if (gate === "non-Google adapter") deps.adapter.name = "mock-other";
      try {
        expect(await deps.on429?.(null, refusal.headers, deps.parsed, refusal)).toBeNull();
        expect(sendBudget.used).toBe(0);
        expect(sendBudget.remainingBaseSends(2)).toBe(2);
        return refusal;
      } finally { deps.adapter.name = name; }
    });
    try {
      const response = await handleResponses(request(), cfg, route, { sendBudget });
      expect(response.status).toBe(403);
      await response.text();
      expect(durableHealth()).toEqual(before);
    } finally { loopSpy.mockRestore(); }
  },
);

test.each(["construction", "admission", "admission cancellation"])(
  "real web-search sibling %s failure refunds the unused send and preserves error ownership",
  async failure => {
    const accounts = await seedAntigravityAccounts(2);
    const cfg = webSearchConfig();
    const before = durableHealth();
    const sendBudget = budget(2);
    const abort = new AbortController();
    const sends: Array<{ auth: string; project: string }> = [];
    let rejected = 0;
    installAntigravityFetchMock(({ auth, project }) => {
      sends.push({ auth, project });
      return new Response(structuredRefusal, { status: 403 });
    });
    const resolve = adapterResolve.resolveAdapter;
    const wait = pacing.waitForProviderRequestSlot;
    const resolveSpy = spyOn(adapterResolve, "resolveAdapter").mockImplementation((provider, ...args) => {
      const adapter = resolve(provider, ...args);
      if (failure === "construction" && provider.project === accounts[1]!.project) {
        adapter.buildRequest = async () => { rejected++; throw new Error("replacement-build-canary"); };
      }
      return adapter;
    });
    const pacingSpy = spyOn(pacing, "waitForProviderRequestSlot").mockImplementation(async (name, provider, ...args) => {
      if (failure.startsWith("admission") && provider.project === accounts[1]!.project) {
        rejected++;
        if (failure === "admission cancellation") abort.abort();
        throw new Error("replacement-admission-canary");
      }
      return wait(name, provider, ...args);
    });
    try {
      const response = await handleResponses(request(), cfg, route, { sendBudget, abortSignal: abort.signal });
      const body = await response.text();
      expect(rejected).toBeGreaterThan(0);
      expect(response.status).toBe(failure === "admission cancellation" ? 499 : 403);
      if (failure !== "admission cancellation") {
        expect(body).toContain("Antigravity account validation required (VALIDATION_REQUIRED): validate");
      }
      expect(body).not.toContain("canary");
      expect(sends).toEqual([{ auth: accounts[0]!.auth, project: accounts[0]!.project }]);
      expect(sendBudget.used).toBe(1);
      expect(sendBudget.remainingBaseSends(2)).toBe(1);
      expect(durableHealth()).toEqual(before);
    } finally { resolveSpy.mockRestore(); pacingSpy.mockRestore(); }
  },
);

for (const dispatched of [false, true]) test(`Combo Antigravity 403 sibling hop ${dispatched ? "dispatches" : "stops before dispatch"} with exact settlement`, async () => {
  const accounts = await seedAntigravityAccounts(2);
  const cfg = webSearchConfig();
  let charges = 0, refunds = 0, physical = 0, refused = 0;
  const sendBudget = createRequestExecutionBudget({
    maxTotalModelSends: 2, baseSendAllowance: 2, finalRecoveryAllowance: 0,
    maxAlternateTargetSends: 0, maxTargetTransitions: 0,
  }, undefined, { charge: () => { charges++; return true; }, refund: () => { refunds++; } });
  // The stopped child keeps Combo's logical key. The dispatched child pins its
  // physical endpoint to isolate hop ownership from a target-transition replacement.
  const initial = sendBudget.reserveDispatch({
    sendClass: "initial",
    targetKey: dispatched ? `${DAILY_API_BASE}/v1internal:streamGenerateContent?alt=sse` : "google-antigravity/gemini-3.8-flash",
    countedExternally: true,
  });
  if (!initial.allowed) throw new Error("Combo initial booking denied");
  installAntigravityFetchMock(({ auth, project }) => {
    physical++;
    expect({ auth, project }).toEqual({ auth: accounts[physical - 1]!.auth, project: accounts[physical - 1]!.project });
    return physical === 1 ? new Response(structuredRefusal, { status: 403 })
      : new Response(sseSuccessBody("sibling answered"), { headers: { "content-type": "text/event-stream" } });
  });
  const originalResolve = adapterResolve.resolveAdapter;
  const resolveSpy = spyOn(adapterResolve, "resolveAdapter").mockImplementation((provider, ...args) => {
    const adapter = originalResolve(provider, ...args);
    if (!dispatched && provider.project === accounts[1]!.project) {
      adapter.buildRequest = async () => { refused++; throw new Error("synthetic sibling construction refusal"); };
    }
    return adapter;
  });
  try {
    const response = await handleResponses(request(), cfg, route, {
      sendBudget, comboAttempt: true, comboInitialSend: { permit: initial.permit },
    });
    await response.text();
    expect(response.status).toBe(dispatched ? 200 : 403);
    expect(refused).toBe(dispatched ? 0 : 1);
    expect(physical).toBe(dispatched ? 2 : 1);
    expect(charges).toBe(2);
    expect(refunds).toBe(dispatched ? 0 : 1);
    expect(sendBudget.used).toBe(dispatched ? 2 : 1);
  } finally { resolveSpy.mockRestore(); }
});

test("web-search 429 recovery still uses the sibling's identity and charges exactly two physical sends", async () => {
  const accounts = await seedAntigravityAccounts(2);
  const cfg = webSearchConfig();
  const sends: Array<{ auth: string; project: string }> = [];
  installAntigravityFetchMock(({ auth, project, sendIndex }) => {
    sends.push({ auth, project });
    return sendIndex === 1 ? Response.json({ error: {
      status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric",
    } }, { status: 429 }) : new Response(sseSuccessBody("429 sibling answered"), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const sendBudget = budget(2);
  const response = await handleResponses(request(), cfg, route, { sendBudget });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("429 sibling answered");
  expect(sends).toEqual(accounts.map(({ auth, project }) => ({ auth, project })));
  expect(sendBudget.used).toBe(2);
});
