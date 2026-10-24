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

  async function dispatchFallback(cfg: OcxConfig, random: () => number): Promise<{ response: Response; sent: string[] }> {
    const sent: string[] = [];
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
      }), cfg, { model: "", provider: "" });
      return { response, sent };
    } finally {
      Math.random = originalRandom;
    }
  }

  // The existing pre-admission samples the combo. Let that real check choose the allowed
  // provider hop, then let the dispatch independently choose the same-provider model hop.
  function sampledProviderThenModel(): () => number {
    let samples = 0;
    return () => samples++ === 0 ? 0.999 : 0;
  }

  test("model fallback off: the first same-provider pick is refused at dispatch with no send", async () => {
    observe({ weeklyPercent: 98 });
    const { response, sent } = await dispatchFallback(
      comboDispatchConfig({ provider: true, model: false }), sampledProviderThenModel());
    expect(recentFallbackEvents()).toContainEqual(expect.objectContaining({
      site: "hard-lock", outcome: "taken", kind: "provider", to: "deepseek/deepseek-chat",
    }));
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
      comboDispatchConfig({ provider: true, model: true }), sampledProviderThenModel());
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
    const { response, sent } = await dispatchFallback(
      comboDispatchConfig({ provider: true, model: false }), () => 0.999);
    expect(response.headers.get("x-opencodex-fallback")).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("deepseek");
    expect(response.status).toBe(200);
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

describe("hard-lock fallback with fallback off", () => {
  test("classifying a routing-profile target reads config only: nothing opens under OPENCODEX_HOME", async () => {
    observe({ weeklyPercent: 98 });
    const cfg = {
      ...config({ provider: false }),
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
      expect(refusal.error.fallback).toMatchObject({ kind: "provider", from: "openai/gpt-5.3", to: "deepseek/deepseek-chat" });
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
