import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, OcxConfig, OcxParsedRequest } from "../../src/types";
import type { ProviderAdapter } from "../../src/adapters/base";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { isAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearAccountNeedsReauth, clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexUpstreamHealth, CODEX_QUOTA_PROBE_INTERVAL_MS, recordCodexUpstreamOutcome, tryAcquireCodexQuotaProbeLease } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar } from "../../src/providers/openai-sidecar";
import * as sidecarModule from "../../src/providers/openai-sidecar";
import { describeImage } from "../../src/vision/describe";
import { describeImagesInPlace, resetVisionDescriptionCache } from "../../src/vision";
import { runWebSearch } from "../../src/web-search/executor";
import { runWithWebSearch } from "../../src/web-search/loop";
import { runTurnWebSearchLoop } from "../../src/web-search/run-turn-loop";
import { createPassthroughWebSearchBridgeExecutor } from "../../src/web-search/passthrough-bridge";
import { handleSearch } from "../../src/server/search";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const accountId = "sidecar-credit-fixture";
const originalFetch = globalThis.fetch;
const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;

function config(): OcxConfig {
  return {
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } },
    port: 10100, hostname: "127.0.0.1", codexMainAccountHardLock: false,
    codexAccounts: [{ id: accountId, email: "fixture@example.test", isMain: false, plan: "pro" }],
    creditCodexAccountIds: [accountId], activeCodexAccountId: accountId,
    autoSwitchThreshold: 0, upstreamFailoverThreshold: 3,
  } as OcxConfig;
}

function quota(percent: number): void {
  updateAccountQuota(accountId, percent, Date.now() + 3_600_000);
  setAccountQuotaFromParsed(accountId, { credits: { hasCredits: true, balance: 42, observedAt: Date.now() } });
}

async function resolve(config: OcxConfig) {
  const sidecar = await resolveFirstUsableOpenAiSidecar(listOpenAiForwardSidecarCandidates(config), new Headers(), config,
    { exactAccount: { accountId, modelId: "gpt-5.5" } });
  if (!sidecar || sidecar.authContext.kind !== "pool") throw new Error("expected stored sidecar fixture");
  return sidecar;
}

function sse(): Response {
  return new Response('data: {"type":"response.output_text.delta","delta":"fixture answer"}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-sidecar-credit-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  setIcaclsRunnerForTests(() => aclOk);
  setAsyncIcaclsRunnerForTests(async () => aclOk);
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState();
  clearAccountNeedsReauth(accountId);
  resetVisionDescriptionCache();
  saveCodexAccountCredential(accountId, {
    accessToken: "access-token-value-sidecar-credit", refreshToken: "fixture-sidecar-refresh",
    expiresAt: Date.now() + 3_600_000, chatgptAccountId: "fixture-sidecar-workspace",
  });
  globalThis.fetch = Object.assign(async () => { throw new Error("unexpected fixture fetch"); }, { preconnect() {} }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState();
  clearAccountNeedsReauth(accountId);
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

describe("resolved sidecar credit policy at physical dispatch", () => {
  for (const helper of ["vision", "search"] as const) {
    test(`${helper} policy refusal stays local during caller abort`, async () => {
      const cfg = config(); quota(100);
      const sidecar = await resolve(cfg);
      cfg.creditCodexAccountIds = [];
      const controller = new AbortController();
      const recorded: unknown[] = [];
      let sends = 0;
      globalThis.fetch = Object.assign(async () => { sends++; return sse(); }, { preconnect() {} }) as typeof fetch;
      const settings = { model: "gpt-5.5", reasoning: "low" as const, timeoutMs: 5_000 };
      const pending = helper === "vision"
        ? describeImage("data:image/png;base64,iVBORw0KGgo=", "high", "inspect", sidecar.provider,
          sidecar.headers, settings, controller.signal, value => recorded.push(value), sidecar.beforeDispatch)
        : runWebSearch("fixture query", { type: "web_search" }, sidecar.provider,
          sidecar.headers, settings, controller.signal, value => recorded.push(value), sidecar.beforeDispatch);
      controller.abort(new Error("fixture caller cancellation"));
      await pending;
      expect(sends).toBe(0);
      expect(recorded).toEqual([]);
      expect(isAccountNeedsReauth(accountId)).toBe(false);
    });

    test.each(["quota", "consent", "allowed"])(`${helper} rechecks after resolution: %s`, async change => {
      const cfg = config();
      quota(change === "quota" ? 99 : 100);
      const sidecar = await resolve(cfg);
      if (change === "quota") { cfg.creditCodexAccountIds = []; quota(100); }
      if (change === "consent") cfg.creditCodexAccountIds = [];
      let sends = 0;
      const recorded: unknown[] = [];
      globalThis.fetch = Object.assign(async () => { sends++; return sse(); }, { preconnect() {} }) as typeof fetch;
      const settings = { model: "gpt-5.5", reasoning: "low" as const, timeoutMs: 5_000 };
      const beforeDispatch = sidecar.beforeDispatch;
      const outcome = helper === "vision"
        ? await describeImage("data:image/png;base64,iVBORw0KGgo=", "high", "inspect", sidecar.provider,
          sidecar.headers, settings, undefined, value => recorded.push(value), beforeDispatch)
        : await runWebSearch("fixture query", { type: "web_search" }, sidecar.provider,
          sidecar.headers, settings, undefined, value => recorded.push(value), beforeDispatch);
      expect(sends).toBe(change === "allowed" ? 1 : 0);
      if (change === "allowed") { expect(outcome.error).toBeUndefined(); expect(recorded).toEqual([200]); }
      else { expect(outcome.error).toContain("spending credits is off"); expect(recorded).toEqual([]); }
      expect(isAccountNeedsReauth(accountId)).toBe(false);
      expect(getCodexUpstreamHealth(accountId)).toBeNull();
    });
  }

  for (const helper of ["vision", "search"] as const) {
    test(`${helper} reset retry rechecks consent without reporting a connection failure`, async () => {
      const cfg = config(); quota(100);
      const sidecar = await resolve(cfg);
      let sends = 0;
      const recorded: unknown[] = [];
      globalThis.fetch = Object.assign(async () => {
        sends++;
        if (sends === 1) {
          cfg.creditCodexAccountIds = [];
          throw Object.assign(new Error("The socket connection was closed unexpectedly"), { code: "ECONNRESET" });
        }
        return sse();
      }, { preconnect() {} }) as typeof fetch;
      const settings = { model: "gpt-5.5", reasoning: "low" as const, timeoutMs: 5_000 };
      const outcome = helper === "vision"
        ? await describeImage("data:image/png;base64,iVBORw0KGgo=", "high", "inspect", sidecar.provider,
          sidecar.headers, settings, undefined, value => recorded.push(value), sidecar.beforeDispatch)
        : await runWebSearch("fixture query", { type: "web_search" }, sidecar.provider,
          sidecar.headers, settings, undefined, value => recorded.push(value), sidecar.beforeDispatch);
      expect(sends).toBe(1);
      expect(outcome.error).toContain("spending credits is off");
      expect(recorded).toEqual([]);
      expect(isAccountNeedsReauth(accountId)).toBe(false);
    });
  }

  test("search refuses the 429 replay after consent changes", async () => {
    const cfg = config(); quota(100);
    const sidecar = await resolve(cfg);
    let sends = 0;
    const recorded: unknown[] = [];
    globalThis.fetch = Object.assign(async () => {
      sends++;
      cfg.creditCodexAccountIds = [];
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0.01" } });
    }, { preconnect() {} }) as typeof fetch;
    const outcome = await runWebSearch("fixture query", { type: "web_search" }, sidecar.provider, sidecar.headers,
      { model: "gpt-5.5", reasoning: "low", timeoutMs: 5_000 }, undefined,
      value => recorded.push(value), sidecar.beforeDispatch);
    expect(sends).toBe(1);
    expect(outcome.error).toContain("spending credits is off");
    expect(recorded).toEqual([]);
  });

  test("production vision and passthrough search wiring retain the resolver guard", async () => {
    const cfg = config(); quota(100);
    const sidecar = await resolve(cfg);
    cfg.creditCodexAccountIds = [];
    let sends = 0;
    globalThis.fetch = Object.assign(async () => { sends++; return sse(); }, { preconnect() {} }) as typeof fetch;
    const parsed = { modelId: "fixture", stream: false, options: {}, context: { messages: [
      { role: "user" as const, content: [{ type: "image" as const, imageUrl: "data:image/png;base64,iVBORw0KGgo=" }] },
    ] } };
    await describeImagesInPlace(parsed, { backend: "openai", forwardSidecar: sidecar,
      settings: { model: "gpt-5.5", reasoning: "low", timeoutMs: 5_000 }, maxDescriptionsPerTurn: 1 }, sidecar.headers);
    expect(JSON.stringify(parsed.context.messages)).toContain("spending credits is off");
    const execute = createPassthroughWebSearchBridgeExecutor({ backend: "openai", maxSearches: 1, timeoutMs: 5_000 },
      { auth: { openAiSidecar: sidecar } });
    expect((await execute(["fixture query"])).error).toContain("spending credits is off");
    expect(sends).toBe(0);
    expect(getCodexUpstreamHealth(accountId)).toBeNull();
  });

  test("a late search relay hold returns reset-bound 429 without sending or quarantining", async () => {
    const cfg = config(); quota(100);
    const resolveOriginal = sidecarModule.resolveFirstUsableOpenAiSidecar;
    const resolver = spyOn(sidecarModule, "resolveFirstUsableOpenAiSidecar").mockImplementation(async (...args) => {
      const result = await resolveOriginal(...args);
      cfg.creditCodexAccountIds = [];
      return result;
    });
    let sends = 0;
    globalThis.fetch = Object.assign(async () => { sends++; return Response.json({ output: "fixture" }); }, { preconnect() {} }) as typeof fetch;
    try {
      const response = await handleSearch(new Request("http://localhost/v1/alpha/search", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "fixture" }),
      }), cfg, { model: "", provider: "" });
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await response.text()).toContain("spending credits is off");
      expect(sends).toBe(0);
      expect(isAccountNeedsReauth(accountId)).toBe(false);
      expect(getCodexUpstreamHealth(accountId)).toBeNull();
    } finally { resolver.mockRestore(); }
  });

  test("caller-owned Direct auth is not governed by a stored account credit hold", async () => {
    const cfg = config(); cfg.providers.openai!.codexAccountMode = "direct";
    cfg.creditCodexAccountIds = []; quota(100);
    const token = fakeChatGptJwt({ chatgpt_account_id: "caller-workspace" });
    const sidecar = await resolveFirstUsableOpenAiSidecar(listOpenAiForwardSidecarCandidates(cfg),
      new Headers({ authorization: `Bearer ${token}`, "chatgpt-account-id": "caller-workspace" }), cfg);
    expect(sidecar?.authContext.kind).toBe("main");
    expect(sidecar?.beforeDispatch).toBeUndefined();
    let sends = 0;
    globalThis.fetch = Object.assign(async () => { sends++; return sse(); }, { preconnect() {} }) as typeof fetch;
    const outcome = await runWebSearch("fixture query", { type: "web_search" }, sidecar!.provider, sidecar!.headers,
      { model: "gpt-5.5", reasoning: "low", timeoutMs: 5_000 }, undefined, undefined, sidecar!.beforeDispatch);
    expect(outcome.error).toBeUndefined();
    expect(sends).toBe(1);
  });

  test("a dispatch refusal returns an unused quota probe lease", async () => {
    const cfg = config(); quota(99);
    const sidecar = await resolve(cfg);
    const recordedAt = Date.now() - CODEX_QUOTA_PROBE_INTERVAL_MS - 1_000;
    recordCodexUpstreamOutcome(cfg, accountId, 429, {
      resetAt: Math.floor((recordedAt + 86_400_000) / 1_000), now: recordedAt, fixedAccount: true,
    });
    const lease = tryAcquireCodexQuotaProbeLease(accountId);
    expect(lease).toBeTruthy();
    sidecar.authContext.probeLeaseId = lease!;
    quota(100); cfg.creditCodexAccountIds = [];
    const outcome = await runWebSearch("fixture query", { type: "web_search" }, sidecar.provider, sidecar.headers,
      { model: "gpt-5.5", reasoning: "low", timeoutMs: 5_000 }, undefined, undefined, sidecar.beforeDispatch);
    expect(outcome.error).toContain("spending credits is off");
    expect(tryAcquireCodexQuotaProbeLease(accountId, Date.now() + CODEX_QUOTA_PROBE_INTERVAL_MS)).toBeTruthy();
  });

  for (const transport of ["fetch", "runTurn"] as const) {
    test.each(["blocked", "allowed"])(`${transport} search loop carries live policy: %s`, async policyState => {
      const allowed = policyState === "allowed";
      const cfg = config(); quota(100);
      const sidecar = await resolve(cfg);
      if (!allowed) cfg.creditCodexAccountIds = [];
      let searches = 0;
      globalThis.fetch = Object.assign(async input => {
        if (String(input).startsWith(sidecar.provider.baseUrl)) { searches++; return sse(); }
        if (String(input) === "https://routed.example.test/completions") return Response.json({});
        throw new Error("unexpected fixture destination");
      }, { preconnect() {} }) as typeof fetch;
      const parsed: OcxParsedRequest = { modelId: "fixture", stream: true, options: {},
        context: { messages: [{ role: "user", content: "search fixture" }], tools: [] } };
      const settings = { model: "gpt-5.5", reasoning: "low", timeoutMs: 5_000 };
      const searchEvents: AdapterEvent[] = [
        { type: "tool_call_start", id: "fixture-search", name: "web_search" },
        { type: "tool_call_delta", arguments: '{"query":"fixture query"}' },
        { type: "tool_call_end" }, { type: "done" },
      ];
      const answerEvents: AdapterEvent[] = [{ type: "text_delta", text: "fixture answer" }, { type: "done" }];
      async function* stream(events: AdapterEvent[]) { yield* events; }
      const releaseSpendHome = acquireOwnedSpendHome();
      try {
        if (transport === "runTurn") {
          const output: AdapterEvent[] = [];
          for await (const event of runTurnWebSearchLoop(stream(searchEvents), {
            parsed, forwardProvider: sidecar.provider, forwardHeaders: sidecar.headers,
            plan: { backend: "openai", forwardSidecar: sidecar, hostedTool: { type: "web_search" },
              settings, maxSearches: 1, routedModelStallTimeoutMs: 5_000, stallTimeoutSec: 5, streamRoutedModelOutput: false },
            dispatch: () => stream(answerEvents),
          })) output.push(event);
          expect(output.some(event => event.type === "web_search_call_end")).toBe(true);
        } else {
          let iteration = 0;
          const adapter: ProviderAdapter = { name: "sidecar-credit-fixture",
            buildRequest: () => ({ url: "https://routed.example.test/completions", method: "POST", headers: {}, body: "{}" }),
            parseStream: () => stream(iteration++ === 0 ? searchEvents : answerEvents),
          };
          const response = await runWithWebSearch({ parsed, adapter,
            incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
            forwardProvider: sidecar.provider, selectedForwardHeaders: sidecar.headers,
            hostedTool: { type: "web_search" }, settings, maxSearches: 1,
            beforeSidecarDispatch: sidecar.beforeDispatch,
          });
          expect(await response.text()).toContain("response.completed");
        }
        expect(searches).toBe(allowed ? 1 : 0);
        expect(isAccountNeedsReauth(accountId)).toBe(false);
      } finally { releaseSpendHome(); }
    });
  }
});
