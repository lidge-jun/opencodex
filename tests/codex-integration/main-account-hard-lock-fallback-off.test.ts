/**
 * OCX-11 at the main-account hard-lock fallback (src/server/responses/main-hard-lock-routing.ts):
 * refused, the reroute leaves the body untouched and the request answers fallback_refused
 * without contacting the configured fallback; allowed, the reroute is unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { applyMainHardLockFallbackOverride } from "../../src/server/responses/main-hard-lock-routing";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { clearAccountQuota, setAccountQuotaFromParsed, type StoredAccountQuota } from "../../src/codex/quota";
import { handleResponses } from "../../src/server/responses";
import { FallbackRefusedError, clearFallbackEventsForTests, recentFallbackEvents } from "../../src/routing/fallback-policy";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { clearComboSelectionState, getCombo, noteComboSuccess, pickComboTarget } from "../../src/combos";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import type { OcxConfig } from "../../src/types";
import type { OcxFallbackConfig } from "../../src/types/fallback";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const FALLBACK = { model: "deepseek/deepseek-chat", reasoningEffort: "low" };
const originalFetch = globalThis.fetch;
let home: TempHome;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  home = createTempHome("ocx-main-lock-fallback-off-");
  releaseSpendHome = acquireOwnedSpendHome();
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearFallbackEventsForTests();
  clearComboSelectionState();
  observeMainQuotaIdentity("fallback-account-a");
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  // Profile evaluation opens this index; release its Windows handle before removing the home.
  closeRequestHistoryIndex();
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearFallbackEventsForTests();
  home.remove();
});

describe("hard-lock first-dispatch policy", () => {
  function comboDispatchConfig(fallback: OcxFallbackConfig): OcxConfig {
    return {
      ...config(fallback),
      providers: {
        ...config().providers,
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
      codexMainAccountHardLockFallback: { model: "combo/random-rescue" },
      combos: { "random-rescue": { strategy: "random", targets: [
        { provider: "openai", model: "gpt-5.4" },
        { provider: "deepseek", model: "deepseek-chat" },
      ] } },
    } as OcxConfig;
  }

  async function dispatchFallback(cfg: OcxConfig, random: () => number) {
    const sent: string[] = [];
    const budget = createRequestExecutionBudget();
    globalThis.fetch = (async (input: string | URL | Request) => {
      sent.push(String(input instanceof Request ? input.url : input));
      return Response.json({ id: "resp_dispatch_fixture", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    }) as typeof fetch;
    const originalRandom = Math.random;
    Math.random = random;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.3", stream: false, input: "hello" }),
      }), cfg, { model: "", provider: "" }, { sendBudget: budget });
      return { response, sent, used: budget.used };
    } finally {
      Math.random = originalRandom;
    }
  }

  test("model fallback off: the first same-provider pick is refused at dispatch with no send", async () => {
    observe({ weeklyPercent: 98 });
    let samples = 0;
    const { response, sent, used } = await dispatchFallback(
      comboDispatchConfig({ provider: true, model: false }), () => { samples++; return 0; });
    expect(samples).toBe(1);
    expect(used).toBe(0);
    expect(recentFallbackEvents()).toHaveLength(1);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-fallback")).toBe("refused");
    expect(sent).toEqual([]);
    expect(recentFallbackEvents().at(-1)).toMatchObject({
      site: "combo", outcome: "refused", kind: "model", trigger: "hard_lock",
      from: "openai/gpt-5.3", to: "openai/gpt-5.4",
    });
  });

  test("model fallback on: the same-provider pick is admitted past the dispatch guard", async () => {
    observe({ weeklyPercent: 98 });
    const { response, sent } = await dispatchFallback(
      comboDispatchConfig({ provider: true, model: true }), () => 0);
    // Taken records guard admission. The separate canonical account lock still refuses this
    // child, and the combo then dispatches its allowed provider fallback to the fetch stub.
    expect(recentFallbackEvents()).toContainEqual(expect.objectContaining({
      site: "combo", outcome: "taken", kind: "model", trigger: "hard_lock",
      from: "openai/gpt-5.3", to: "openai/gpt-5.4",
    }));
    expect(response.headers.get("x-opencodex-fallback")).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("deepseek");
    expect(response.status).toBe(200);
  });

  test("provider fallback on: a cross-provider first pick still dispatches", async () => {
    observe({ weeklyPercent: 98 });
    let samples = 0;
    const { response, sent, used } = await dispatchFallback(
      comboDispatchConfig({ provider: true, model: false }), () => { samples++; return 0.999; });
    expect(samples).toBe(1);
    expect(used).toBe(1);
    expect(recentFallbackEvents()).toMatchObject([{ site: "combo", outcome: "taken", kind: "provider" }]);
    expect(recentFallbackEvents()).toHaveLength(1);
    expect(response.headers.get("x-opencodex-fallback")).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("deepseek");
    expect(response.status).toBe(200);
  });

  test("all-denied preflight refuses once before RNG, send reservation or dispatch", async () => {
    observe({ weeklyPercent: 98 });
    let samples = 0;
    const { response, sent, used } = await dispatchFallback(
      comboDispatchConfig({ provider: false, model: false }), () => { samples++; return 0.999; });
    expect(response.status).toBe(429);
    expect(sent).toEqual([]);
    expect(used).toBe(0);
    expect(samples).toBe(0);
    expect(recentFallbackEvents()).toMatchObject([{ site: "hard-lock", outcome: "refused", kind: "model" }]);
    expect(recentFallbackEvents()).toHaveLength(1);
  });

  test("a forbidden provider pick is not filtered in favor of an allowed model candidate", async () => {
    observe({ weeklyPercent: 98 });
    const { response, sent, used } = await dispatchFallback(
      comboDispatchConfig({ provider: false, model: true }), () => 0.999);
    expect(response.status).toBe(429);
    expect(sent).toEqual([]);
    expect(used).toBe(0);
    expect(recentFallbackEvents()).toMatchObject([{ site: "combo", outcome: "refused", kind: "provider" }]);
    expect(recentFallbackEvents()).toHaveLength(1);
  });

  test("unknown preflight does not authorize an unresolved actual destination", async () => {
    observe({ weeklyPercent: 98 });
    const cfg = comboDispatchConfig({ provider: false, model: false });
    cfg.combos!["random-rescue"]!.targets = [{ provider: "deepseek", model: "deepseek-chat" }];
    cfg.providers.backup = { adapter: "openai-responses", authMode: "key", apiKey: "fixture-unused-key" };
    cfg.blockedModelRedirects = { "deepseek/deepseek-chat": "backup/model-backup", "backup/model-backup": "deepseek/deepseek-chat" };
    let sends = 0;
    globalThis.fetch = (async () => { sends++; throw new Error("Must not send an unresolved destination"); }) as typeof fetch;
    const budget = createRequestExecutionBudget();
    await expect(handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.3", stream: false, input: "hello" }),
    }), cfg, { model: "", provider: "" }, { sendBudget: budget })).rejects.toThrow("redirect cycle");
    expect(sends).toBe(0);
    expect(budget.used).toBe(0);
    expect(recentFallbackEvents()).toEqual([]);
  });
});

function observe(quota: Omit<StoredAccountQuota, "updatedAt">): void {
  const writer = captureMainQuotaWriter("fallback-account-a");
  if (!writer) throw new Error("fixture identity was not observed");
  setAccountQuotaFromParsed("__main__", quota, undefined, writer);
}

function config(fallback?: OcxFallbackConfig): OcxConfig {
  return {
    providers: { deepseek: { adapter: "openai-responses", authMode: "key", apiKey: "fixture-key", baseUrl: "https://deepseek.example.test/v1" } },
    codexAccounts: [],
    codexMainAccountHardLockFallback: FALLBACK,
    ...(fallback ? { fallback } : {}),
  } as OcxConfig;
}

describe("hard-lock selection-free preflight", () => {
  const targets = [{ provider: "openai", model: "gpt-5.4" }, { provider: "deepseek", model: "deepseek-chat" }];
  function declared(kind: "combo" | "policy", fallback: OcxFallbackConfig, alias = false): OcxConfig {
    return { ...config(fallback),
      providers: { ...config().providers, openai: { adapter: "openai-responses", authMode: "forward" } },
      codexMainAccountHardLockFallback: { model: alias ? "rescue-alias" : `${kind}/rescue`, reasoningEffort: "low" },
      ...(kind === "combo" ? { combos: { rescue: { alias: "rescue-alias", strategy: "random", targets } } }
        : { routingProfiles: { rescue: { alias: "rescue-alias", candidates: targets } } }),
    } as OcxConfig;
  }

  for (const kind of ["combo", "policy"] as const) for (const alias of [false, true]) {
    for (const provider of [false, true]) for (const model of [false, true]) {
      test(`${kind} alias=${alias} provider=${provider} model=${model}: only all-denied refuses without selection`, async () => {
        observe({ weeklyPercent: 98 });
        const cfg = declared(kind, { provider, model }, alias);
        const body = { model: "gpt-5.3", reasoning: { effort: "high" }, input: [{ text: "preserve" }] };
        const before = structuredClone(body);
        const files = readdirSync(home.root).sort();
        const random = Math.random; let samples = 0;
        Math.random = () => { samples++; return 0; };
        try {
          if (!provider && !model) {
            await expect(applyMainHardLockFallbackOverride(body, cfg)).rejects.toBeInstanceOf(FallbackRefusedError);
            expect(body).toEqual(before);
            expect(recentFallbackEvents()).toMatchObject([{ outcome: "refused" }]);
            expect(recentFallbackEvents()).toHaveLength(1);
          } else {
            expect(await applyMainHardLockFallbackOverride(body, cfg)).toEqual({ sourceModel: before.model, targetModel: cfg.codexMainAccountHardLockFallback!.model });
            expect(body.reasoning.effort).toBe("low");
            expect(recentFallbackEvents()).toEqual([]);
          }
          expect(samples).toBe(0);
          expect(readdirSync(home.root).sort()).toEqual(files);
        } finally { Math.random = random; }
      });
    }

    test(`${kind} alias=${alias}: an unresolved candidate is not discarded as denied`, async () => {
      observe({ weeklyPercent: 98 });
      const cfg = declared(kind, { provider: false, model: false }, alias);
      const candidates = [{ provider: "deepseek", model: "deepseek-chat" }, { provider: "removed-provider", model: "unknown-model" }];
      if (kind === "combo") cfg.combos!.rescue!.targets = candidates;
      else cfg.routingProfiles!.rescue!.candidates = candidates;
      expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).not.toBeNull();
      expect(recentFallbackEvents()).toEqual([]);
    });

    test(`${kind} alias=${alias}: resolved aliases and redirects determine both kinds`, async () => {
      observe({ weeklyPercent: 98 });
      const cfg = declared(kind, { provider: false, model: true }, alias);
      cfg.providers.openai!.alias = "source-alias";
      const candidates = [{ provider: "source-alias", model: "gpt-5.4" }];
      if (kind === "combo") cfg.combos!.rescue!.targets = candidates;
      else cfg.routingProfiles!.rescue!.candidates = candidates;
      cfg.blockedModelRedirects = { "openai/gpt-5.4": "deepseek/deepseek-chat" };
      await expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).rejects.toBeInstanceOf(FallbackRefusedError);
      expect(recentFallbackEvents()).toMatchObject([{ kind: "provider", to: "deepseek/deepseek-chat" }]);
      clearFallbackEventsForTests();
      cfg.blockedModelRedirects = {};
      expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).not.toBeNull();
      expect(recentFallbackEvents()).toEqual([]);
    });

    test(`${kind} alias=${alias}: exact actual-route precedence and device refusal`, async () => {
      observe({ weeklyPercent: 98 });
      const cfg = declared(kind, { provider: false, model: false, routes: {
        "combo/rescue": { provider: true, model: true },
        "gpt-5.3": { provider: false, model: false },
        "policy/rescue": { provider: true, model: true },
      } }, alias);
      if (kind === "combo") expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).not.toBeNull();
      else await expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).rejects.toBeInstanceOf(FallbackRefusedError);
      clearFallbackEventsForTests();
      cfg.fallback!.devices = { fixture_device: { provider: false, model: false } };
      await expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg, undefined, undefined,
        { kind: "configured", keyId: "fixture_device" })).rejects.toBeInstanceOf(FallbackRefusedError);
      expect(recentFallbackEvents()).toMatchObject([{ scope: "device", scopeKey: "fixture_device" }]);
      expect(recentFallbackEvents()).toHaveLength(1);
    });

    test(`${kind} alias=${alias}: source-provider policy and a no-hop candidate are preserved`, async () => {
      observe({ weeklyPercent: 98 });
      const cfg = declared(kind, { provider: true, model: true, providers: { openai: { provider: false, model: false } } }, alias);
      await expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).rejects.toBeInstanceOf(FallbackRefusedError);
      expect(recentFallbackEvents()).toMatchObject([{ scope: "provider", scopeKey: "openai" }]);
      clearFallbackEventsForTests();
      const candidates = [{ provider: "openai", model: "gpt-5.3" }, ...targets];
      if (kind === "combo") cfg.combos!.rescue!.targets = candidates;
      else cfg.routingProfiles!.rescue!.candidates = candidates;
      expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).not.toBeNull();
      expect(recentFallbackEvents()).toEqual([]);
    });
  }

  for (const strategy of ["random", "round-robin", "least-used"] as const) {
    test(`${strategy}: preflight preserves weighted selection and sticky history`, async () => {
      observe({ weeklyPercent: 98 });
      const cfg = declared("combo", { provider: true, model: true });
      cfg.combos!.rescue!.strategy = strategy;
      cfg.combos!.rescue!.stickyLimit = 2;
      cfg.combos!.rescue!.targets = [{ ...targets[0]!, weight: 3 }, { ...targets[1]!, weight: 1 }];
      const random = Math.random;
      const sequence = async (preflight: boolean) => {
        clearComboSelectionState();
        let samples = 0;
        Math.random = () => [0.1, 0.9, 0.5, 0.8][samples++ % 4]!;
        const picks: string[] = [];
        for (let index = 0; index < 8; index++) {
          if (preflight) await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg);
          const pick = pickComboTarget(cfg, "rescue")!;
          picks.push(`${pick.target.provider}/${pick.target.model}`);
          noteComboSuccess("rescue", getCombo(cfg, "rescue")!, pick.target, pick.writerGeneration);
        }
        return { picks, samples };
      };
      try {
        expect(await sequence(true)).toEqual(await sequence(false));
        expect(recentFallbackEvents()).toEqual([]);
      } finally { Math.random = random; clearComboSelectionState(); }
    });
  }
});

describe("hard-lock fallback with fallback off", () => {
  test("classifying a routing-profile target reads config only: nothing opens under OPENCODEX_HOME", async () => {
    observe({ weeklyPercent: 98 });
    const cfg = {
      ...config({ provider: false, model: false }),
      providers: {
        ...config().providers,
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
      routingProfiles: { rescue: { alias: "chosen-policy", candidates: [{ provider: "openai", model: "gpt-5.4" }, { provider: "deepseek", model: "deepseek-chat" }] } },
    } as OcxConfig;
    for (const model of ["policy/rescue", "chosen-policy"]) {
      cfg.codexMainAccountHardLockFallback = { model };
      // The evaluator would open routing-history.sqlite here, and on Windows its handle blocks
      // the home's removal. The hop is classified from the declared candidates instead.
      const before = readdirSync(home.root).sort();
      let thrown: unknown;
      try {
        await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg);
      } catch (error) {
        thrown = error;
      }
      expect(readdirSync(home.root).sort()).toEqual(before);
      expect(thrown).toBeInstanceOf(FallbackRefusedError);
      const refusal = await (thrown as FallbackRefusedError).response.json() as { error: { fallback: Record<string, string> } };
      expect(refusal.error.fallback).toMatchObject({ kind: "model", from: "openai/gpt-5.3", to: "openai/gpt-5.4" });
    }
  });

  test("provider fallback off: the reroute is refused and the body is untouched", async () => {
    observe({ weeklyPercent: 98 });
    const body: Record<string, unknown> = { model: "gpt-5.3", reasoning: { effort: "high" } };
    let thrown: unknown;
    try {
      await applyMainHardLockFallbackOverride(body, config({ provider: false }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FallbackRefusedError);
    const response = (thrown as FallbackRefusedError).response;
    expect(response.status).toBe(429);
    const refusal = await response.json() as { error: { code: string; fallback: Record<string, string> } };
    expect(refusal.error.code).toBe("fallback_refused");
    expect(refusal.error.fallback).toMatchObject({ kind: "provider", trigger: "hard_lock", from: "openai/gpt-5.3", to: "deepseek/deepseek-chat" });
    expect(body).toEqual({ model: "gpt-5.3", reasoning: { effort: "high" } });
  });

  test("a route override on the source model reopens it; absent policy is unchanged", async () => {
    observe({ weeklyPercent: 98 });
    const routed: Record<string, unknown> = { model: "gpt-5.3" };
    expect(await applyMainHardLockFallbackOverride(routed, config({ provider: false, routes: { "gpt-5.3": { provider: true } } })))
      .toEqual({ sourceModel: "gpt-5.3", targetModel: "deepseek/deepseek-chat" });
    const plain: Record<string, unknown> = { model: "gpt-5.3" };
    expect(await applyMainHardLockFallbackOverride(plain, config())).toEqual({ sourceModel: "gpt-5.3", targetModel: "deepseek/deepseek-chat" });
    expect(recentFallbackEvents().map(event => event.outcome)).toEqual(["taken", "taken"]);
  });

  test("end to end: the request answers fallback_refused and nothing is sent", async () => {
    observe({ weeklyPercent: 98 });
    const sent: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      sent.push(String(input instanceof Request ? input.url : input));
      return Response.json({ error: { message: "must not be called" } }, { status: 500 });
    }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.3", stream: false, input: "hello" }),
    }), config({ provider: false }), { model: "", provider: "" });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-fallback")).toBe("refused");
    expect(sent).toEqual([]);
  });
});
