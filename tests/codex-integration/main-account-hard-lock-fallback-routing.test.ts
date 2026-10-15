import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMainHardLockFallbackOverride } from "../../src/server/responses/main-hard-lock-routing";
import { resolveMainAccountHardLockFallback } from "../../src/codex/main-account-hard-lock";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { clearAccountQuota, setAccountQuotaFromParsed, type StoredAccountQuota } from "../../src/codex/quota";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { NATIVE_RESERVE_MODEL } from "../../src/codex/catalog/native-models";
import { deleteAllScopedHealth, setScopedHealth } from "../../src/codex/routing/health-store";
import { handleResponses } from "../../src/server/responses";
import { clearComboRecallForTests, recallComboForLane, rememberComboForLane } from "../../src/server/responses/combo-session-recall";
import { sessionLaneIdFromRequest } from "../../src/server/request-log-conversation";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const now = Date.UTC(2026, 8, 5);
const FALLBACK = { model: "deepseek/deepseek-chat", reasoningEffort: "low" };
const originalFetch = globalThis.fetch;
let home: string;
let previousHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-main-lock-fallback-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
  clearAccountQuota();
  clearMainAccountInfoCache();
  deleteAllScopedHealth("pool-a");
  clearComboRecallForTests();
  observeMainQuotaIdentity("fallback-account-a");
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  clearAccountQuota();
  clearMainAccountInfoCache();
  deleteAllScopedHealth("pool-a");
  clearComboRecallForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function observe(quota: Omit<StoredAccountQuota, "updatedAt">): void {
  const writer = captureMainQuotaWriter("fallback-account-a");
  if (!writer) throw new Error("fixture identity was not observed");
  setAccountQuotaFromParsed("__main__", quota, undefined, writer);
}

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { providers: {}, codexAccounts: [], ...overrides } as OcxConfig;
}

function withPoolAccount(target: OcxConfig): OcxConfig {
  saveCodexAccountCredential("pool-a", {
    accessToken: "access-pool-a",
    refreshToken: "refresh-pool-a",
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: "acct-pool-a",
  });
  return { ...target, codexAccounts: [{ id: "pool-a", email: "pool@example.test", isMain: false, plan: "pro" }] } as OcxConfig;
}

describe("main-account hard-lock fallback resolution", () => {
  test("a malformed section disables the reroute instead of half-applying", () => {
    expect(resolveMainAccountHardLockFallback(config())).toBeUndefined();
    expect(resolveMainAccountHardLockFallback({ codexMainAccountHardLockFallback: { model: "  " } } as OcxConfig)).toBeUndefined();
    expect(resolveMainAccountHardLockFallback({ codexMainAccountHardLockFallback: { model: " deepseek/deepseek-chat" } } as OcxConfig)).toBeUndefined();
    expect(resolveMainAccountHardLockFallback({ codexMainAccountHardLockFallback: { model: "a b" } } as OcxConfig)).toBeUndefined();
    expect(resolveMainAccountHardLockFallback({ codexMainAccountHardLockFallback: { model: "deepseek/deepseek-chat", reasoningEffort: "extreme" } } as OcxConfig)).toBeUndefined();
    expect(resolveMainAccountHardLockFallback({ codexMainAccountHardLockFallback: FALLBACK } as OcxConfig)).toEqual(FALLBACK);
    expect(resolveMainAccountHardLockFallback({ codexMainAccountHardLockFallback: { model: "combo/x" } } as OcxConfig))
      .toEqual({ model: "combo/x" });
    // The dashboard row keeps the configured model while its switch is off: enabled false
    // pauses the reroute without forgetting the destination, and a malformed enabled flag
    // is a hand edit the section boundary never accepts.
    expect(resolveMainAccountHardLockFallback({ codexMainAccountHardLockFallback: { ...FALLBACK, enabled: false } } as OcxConfig)).toBeUndefined();
    expect(resolveMainAccountHardLockFallback({ codexMainAccountHardLockFallback: { ...FALLBACK, enabled: true } } as OcxConfig)).toEqual(FALLBACK);
  });
});

describe("applyMainHardLockFallbackOverride", () => {
  test("a blocked lock with no eligible account rewrites the model and the effort", () => {
    observe({ weeklyPercent: 98 });
    const body: Record<string, unknown> = { model: "gpt-5.3", reasoning: { effort: "high" } };
    expect(applyMainHardLockFallbackOverride(body, config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>)))
      .toEqual({ sourceModel: "gpt-5.3", targetModel: "deepseek/deepseek-chat" });
    expect(body.model).toBe("deepseek/deepseek-chat");
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  test("each blocking window governs on its own", () => {
    const cfg = config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>);
    observe({ shortPercent: 90 });
    expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).not.toBeNull();
    observe({ shortPercent: 0 });
    expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).toBeNull();
    observe({ weeklyPercent: 98 });
    expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).not.toBeNull();
    observe({ weeklyPercent: 0 });
    expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).toBeNull();
  });

  test("a monthly-only account governs on monthly; supplementary monthly data never blocks", () => {
    const cfg = config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>);
    // No short or weekly evidence at all: monthly is the account's only window.
    observe({ monthlyPercent: 99 });
    expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).not.toBeNull();
    observe({ monthlyPercent: 50 });
    expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).toBeNull();
    // Supplementary monthly data on a 5h/weekly account never becomes a lock.
    observe({ shortPercent: 10, weeklyPercent: 10, monthlyPercent: 99 });
    expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).toBeNull();
  });

  test("release is the same observation that admits: dropping below the threshold stops the rewrite", () => {
    const cfg = config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>);
    observe({ weeklyPercent: 99 });
    expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).not.toBeNull();
    observe({ weeklyPercent: 97.99 });
    expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).toBeNull();
  });

  test("unknown usage, the opt-out, and a missing section all keep the refusal behavior", () => {
    expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>))).toBeNull();
    observe({ weeklyPercent: 100 });
    expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, config({ codexMainAccountHardLock: false, codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>))).toBeNull();
    expect(applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, config())).toBeNull();
  });

  test("an eligible pool account keeps the request on Codex", () => {
    observe({ weeklyPercent: 100 });
    const cfg = withPoolAccount(config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>));
    const body: Record<string, unknown> = { model: "gpt-5.3" };
    expect(applyMainHardLockFallbackOverride(body, cfg)).toBeNull();
    expect(body.model).toBe("gpt-5.3");
  });

  test("a pool account in shared reset-derived cooldown or unused under Direct mode does not suppress the fallback", () => {
    observe({ weeklyPercent: 100 });
    const cfg = withPoolAccount(config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>));
    setScopedHealth("pool-a", "shared", {
      consecutiveFailures: 0,
      lastFailureStatus: 429,
      lastFailureAt: now,
      cooldownUntil: now + 60_000,
      cooldownSince: now,
      cooldownSource: "reset-derived",
      cooldownGeneration: 1,
    });
    const cooledBody: Record<string, unknown> = { model: "gpt-5.3" };
    expect(applyMainHardLockFallbackOverride(cooledBody, cfg, now))
      .toEqual({ sourceModel: "gpt-5.3", targetModel: "deepseek/deepseek-chat" });
    expect(cooledBody.model).toBe("deepseek/deepseek-chat");

    deleteAllScopedHealth("pool-a");
    const directCfg = withPoolAccount(config({
      providers: {
        openai: {
          adapter: "openai-responses",
          authMode: "forward",
          codexAccountMode: "direct",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
      },
      codexMainAccountHardLockFallback: FALLBACK,
    } as Partial<OcxConfig>));
    const directBody: Record<string, unknown> = { model: "gpt-5.3" };
    expect(applyMainHardLockFallbackOverride(directBody, directCfg, now))
      .toEqual({ sourceModel: "gpt-5.3", targetModel: "deepseek/deepseek-chat" });
  });

  test("only bare Codex-native selectors qualify", () => {
    observe({ weeklyPercent: 100 });
    const cfg = config({
      codexMainAccountHardLockFallback: FALLBACK,
      combos: {
        nativeMasquerade: {
          alias: "gpt-5.4",
          nativeAlias: true,
          displayName: "GPT-5.4 Combo",
          targets: [{ provider: "deepseek", model: "deepseek-chat" }],
        },
      },
    } as Partial<OcxConfig>);
    for (const model of ["deepseek/deepseek-chat", "combo/x", "openai-codex/gpt-5.3", NATIVE_RESERVE_MODEL, "gpt-5.4"]) {
      const body: Record<string, unknown> = { model };
      expect(applyMainHardLockFallbackOverride(body, cfg)).toBeNull();
      expect(body.model).toBe(model);
    }
  });

  test("a Codex-native fallback target never applies: the refusal is the honest answer", () => {
    observe({ weeklyPercent: 100 });
    for (const target of ["gpt-5.4", "openai/gpt-5.4"]) {
      const body: Record<string, unknown> = { model: "gpt-5.3" };
      expect(applyMainHardLockFallbackOverride(body, config({ codexMainAccountHardLockFallback: { model: target } } as Partial<OcxConfig>))).toBeNull();
      expect(body.model).toBe("gpt-5.3");
    }
  });

  test("a fallback without an effort leaves the request's own reasoning untouched", () => {
    observe({ weeklyPercent: 100 });
    const cfg = config({ codexMainAccountHardLockFallback: { model: "deepseek/deepseek-chat" } } as Partial<OcxConfig>);
    const body: Record<string, unknown> = { model: "gpt-5.3", reasoning: { effort: "high" } };
    expect(applyMainHardLockFallbackOverride(body, cfg)).toEqual({ sourceModel: "gpt-5.3", targetModel: "deepseek/deepseek-chat" });
    expect(body.model).toBe("deepseek/deepseek-chat");
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  test("a body without a usable model selector is never touched", () => {
    observe({ weeklyPercent: 100 });
    const cfg = config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>);
    expect(applyMainHardLockFallbackOverride(null, cfg)).toBeNull();
    expect(applyMainHardLockFallbackOverride([], cfg)).toBeNull();
    expect(applyMainHardLockFallbackOverride({ model: "" }, cfg)).toBeNull();
    expect(applyMainHardLockFallbackOverride({ model: 42 }, cfg)).toBeNull();
  });

  test("handleResponses strips caller credentials, preserves requestedModel on combo fallback, and yields to shadow/compaction turns", async () => {
    observe({ weeklyPercent: 100 });
    const cfg = config({
      defaultProvider: "gateway",
      providers: {
        openai: {
          adapter: "openai-responses",
          authMode: "forward",
          codexAccountMode: "direct",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
        gateway: {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://gateway.example/v1",
        },
        shadow: {
          adapter: "openai-responses",
          authMode: "key",
          baseUrl: "https://shadow.example/v1",
          apiKey: "shadow-key",
        },
      },
      combos: {
        prior: { targets: [{ provider: "gateway", model: "prior-model" }] },
        rescue: { targets: [{ provider: "gateway", model: "combo-target" }] },
      },
      shadowCallIntercept: {
        enabled: true,
        model: "shadow/helper-model",
        sourceModels: ["gpt-5.6-luna"],
      },
      codexMainAccountHardLockFallback: { model: "combo/rescue", reasoningEffort: "low" },
    } as Partial<OcxConfig>);

    const seen: Array<{ url: string; auth: string | null; accountId: string | null; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const parsedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      seen.push({
        url: String(input),
        auth: headers.get("authorization"),
        accountId: headers.get("chatgpt-account-id"),
        body: parsedBody,
      });
      return Response.json({
        id: "resp_fallback_fixture",
        status: "completed",
        model: String(parsedBody.model ?? "combo-target"),
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      });
    }) as typeof fetch;

    const headers = new Headers({
      "content-type": "application/json",
      "session_id": "lane-hard-lock-fallback",
      "authorization": "Bearer caller-chatgpt-token",
      "chatgpt-account-id": "acct-caller",
    });
    const lane = sessionLaneIdFromRequest(headers);
    rememberComboForLane(lane, "prior", { provider: "gateway", model: "prior-model" }, "prior-model", captureConfigGeneration());

    const comboLog: RequestLogContext = { model: "", provider: "" };
    const comboRes = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-5.3",
        stream: false,
        input: [
          { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAABm0_native_ciphertext" },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        ],
      }),
    }), cfg, comboLog);
    expect(comboRes.status).toBe(200);
    await comboRes.text();
    expect(comboLog.requestedModel).toBe("gpt-5.3");
    expect(seen[0]!.url).toBe("https://gateway.example/v1/responses");
    expect(seen[0]!.body.model).toBe("combo-target");
    expect(seen[0]!.auth).toBeNull();
    expect(seen[0]!.accountId).toBeNull();
    expect(JSON.stringify(seen[0]!.body.input)).not.toContain("gAAAAABm0_native_ciphertext");
    expect(recallComboForLane(cfg, lane, "prior-model")).toBe("prior");

    // Non-combo shadow-intercept target keeps ownership of helper calls even while hard-locked.
    const shadowLog: RequestLogContext = { model: "", provider: "" };
    const shadowRes = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        stream: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Generate a concise title" }] }],
      }),
    }), cfg, shadowLog);
    expect(shadowRes.status).toBe(200);
    await shadowRes.text();
    expect(seen[1]!.url).toBe("https://shadow.example/v1/responses");
    expect(seen[1]!.body.model).toBe("helper-model");
    expect(shadowLog.shadowCallRewrittenFrom).toBe("gpt-5.6-luna");
  });
});
