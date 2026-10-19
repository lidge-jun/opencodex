import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMainHardLockFallbackOverride } from "../../src/server/responses/main-hard-lock-routing";
import { mainHardLockFallbackCallerCheck } from "../../src/server/responses/core-auth";
import type { HandleResponsesOptions } from "../../src/server/responses/core-options";
import { resolveMainAccountHardLockFallback } from "../../src/codex/main-account-hard-lock";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaCredential, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
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
  return { providers: { deepseek: { adapter: "openai-responses", authMode: "key", baseUrl: "https://deepseek.example.test/v1" } }, codexAccounts: [], ...overrides } as OcxConfig;
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

describe("Direct hard-lock fallback caller identity", () => {
  const mainAccountId = "fallback-account-a";
  function tokenFor(accountId: string): string {
    return `header.${Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    })).toString("base64url")}.signature`;
  }
  const mainToken = tokenFor(mainAccountId);
  const otherToken = tokenFor("fallback-account-b");
  function directConfig(): OcxConfig {
    return config({
      defaultProvider: "openai",
      autoSwitchThreshold: 0,
      providers: {
        openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
          baseUrl: "https://chatgpt.com/backend-api/codex" },
        rescue: { adapter: "openai-responses", authMode: "key", apiKey: "fixture-fallback-key",
          baseUrl: "https://fallback.example/v1" },
      },
      codexMainAccountHardLockFallback: { model: "rescue/rescue-model" },
    } as Partial<OcxConfig>);
  }
  async function dispatch(callerToken: string, accountId: string, source?: "bearer" | "dedicated" | "x-api-key") {
    const seen: Array<{ url: string; auth: string | null; model: string }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), model: body.model });
      return Response.json({ id: "resp_caller_fixture", status: "completed", model: body.model,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${callerToken}`, "chatgpt-account-id": accountId },
      body: JSON.stringify({ model: "gpt-5.3", stream: false, input: "hello" }),
    }), directConfig(), { model: "", provider: "" }, source ? {
      admission: { kind: "configured", keyId: "fixture-admission", source },
    } : {});
    expect(response.status).toBe(200);
    await response.text();
    expect(seen).toHaveLength(1);
    return seen[0]!;
  }
  beforeEach(() => {
    observeMainQuotaCredential(mainToken, mainAccountId);
    observe({ weeklyPercent: 100 });
  });
  test("another caller stays native while the observed main is blocked", async () => {
    expect(await dispatch(otherToken, "fallback-account-b")).toEqual({
      url: "https://chatgpt.com/backend-api/codex/responses", auth: `Bearer ${otherToken}`, model: "gpt-5.3",
    });
  });
  test("the same workspace with an unobserved bearer stays native", async () => {
    const unobservedToken = mainToken.replace(".signature", ".other-signature");
    const seen = await dispatch(unobservedToken, mainAccountId);
    expect(seen.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(seen.auth).toBe(`Bearer ${unobservedToken}`);
  });
  test("a caller matching observed main uses the configured fallback", async () => {
    expect(await dispatch(mainToken, mainAccountId)).toEqual({
      url: "https://fallback.example/v1/responses", auth: "Bearer fixture-fallback-key", model: "rescue-model",
    });
  });
  test("proxy bearer admission preserves stored-main fallback without matching the proxy secret", async () => {
    const seen = await dispatch("fixture-proxy-secret", "", "bearer");
    expect(seen.url).toBe("https://fallback.example/v1/responses");
    expect(seen.auth).toBe("Bearer fixture-fallback-key");
  });
  for (const source of ["dedicated", "x-api-key"] as const) {
    test(`${source} admission preserves the separate caller's native credential`, async () => {
      const seen = await dispatch(otherToken, "fallback-account-b", source);
      expect(seen.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(seen.auth).toBe(`Bearer ${otherToken}`);
    });
  }
  test("an unblocked matching main stays native", async () => {
    observe({ weeklyPercent: 10 });
    const seen = await dispatch(mainToken, mainAccountId);
    expect(seen.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(seen.auth).toBe(`Bearer ${mainToken}`);
  });
  test("a disabled original route keeps its normal 404 with fallback configured and hard lock off", async () => {
    const cfg = directConfig();
    cfg.providers.openai!.disabled = true;
    cfg.codexMainAccountHardLock = false;
    let sends = 0;
    globalThis.fetch = (async () => { sends++; throw new Error("disabled route must not send"); }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${mainToken}`,
        "chatgpt-account-id": mainAccountId },
      body: JSON.stringify({ model: "gpt-5.3", stream: false, input: "hello" }),
    }), cfg, { model: "", provider: "" });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(sends).toBe(0);
  });
});

describe("applyMainHardLockFallbackOverride", async () => {
  test("a blocked lock with no eligible account rewrites the model and the effort", async () => {
    observe({ weeklyPercent: 98 });
    const body: Record<string, unknown> = { model: "gpt-5.3", reasoning: { effort: "high" } };
    expect(await applyMainHardLockFallbackOverride(body, config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>)))
      .toEqual({ sourceModel: "gpt-5.3", targetModel: "deepseek/deepseek-chat" });
    expect(body.model).toBe("deepseek/deepseek-chat");
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  test("each blocking window governs on its own", async () => {
    const cfg = config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>);
    observe({ shortPercent: 90 });
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).not.toBeNull();
    observe({ shortPercent: 0 });
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).toBeNull();
    observe({ weeklyPercent: 98 });
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).not.toBeNull();
    observe({ weeklyPercent: 0 });
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).toBeNull();
  });

  test("a monthly-only account governs on monthly; supplementary monthly data never blocks", async () => {
    const cfg = config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>);
    // No short or weekly evidence at all: monthly is the account's only window.
    observe({ monthlyPercent: 99 });
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).not.toBeNull();
    observe({ monthlyPercent: 50 });
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).toBeNull();
    // Supplementary monthly data on a 5h/weekly account never becomes a lock.
    observe({ shortPercent: 10, weeklyPercent: 10, monthlyPercent: 99 });
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).toBeNull();
  });

  test("release is the same observation that admits: dropping below the threshold stops the rewrite", async () => {
    const cfg = config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>);
    observe({ weeklyPercent: 99 });
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).not.toBeNull();
    observe({ weeklyPercent: 97.99 });
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).toBeNull();
  });

  test("unknown usage, the opt-out, and a missing section all keep the refusal behavior", async () => {
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>))).toBeNull();
    observe({ weeklyPercent: 100 });
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, config({ codexMainAccountHardLock: false, codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>))).toBeNull();
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, config())).toBeNull();
  });

  test("an eligible pool account keeps the request on Codex", async () => {
    observe({ weeklyPercent: 100 });
    const cfg = withPoolAccount(config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>));
    const body: Record<string, unknown> = { model: "gpt-5.3" };
    expect(await applyMainHardLockFallbackOverride(body, cfg)).toBeNull();
    expect(body.model).toBe("gpt-5.3");
  });

  test("a pool account in shared reset-derived cooldown or unused under Direct mode does not suppress the fallback", async () => {
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
    expect(await applyMainHardLockFallbackOverride(cooledBody, cfg, now))
      .toEqual({ sourceModel: "gpt-5.3", targetModel: "deepseek/deepseek-chat" });
    expect(cooledBody.model).toBe("deepseek/deepseek-chat");

    deleteAllScopedHealth("pool-a");
    const directCfg = withPoolAccount(config({
      providers: {
        deepseek: { adapter: "openai-responses", authMode: "key", baseUrl: "https://deepseek.example.test/v1" },
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
    // Direct fails closed without the caller ownership proof supplied by request preparation.
    expect(await applyMainHardLockFallbackOverride(directBody, directCfg, now)).toBeNull();
    expect(directBody.model).toBe("gpt-5.3");
    expect(await applyMainHardLockFallbackOverride(directBody, directCfg, now, async () => () => true))
      .toEqual({ sourceModel: "gpt-5.3", targetModel: "deepseek/deepseek-chat" });
  });

+  test.each(["none", "identity", "bearer"] as const)("Direct ownership is rechecked after the async caller check (change: %s)", async change => {
    observeMainQuotaCredential("fixture-caller-a", "fallback-account-a");
    observe({ weeklyPercent: 100 });
    const cfg = config({
      providers: {
        deepseek: { adapter: "openai-responses", authMode: "key", baseUrl: "https://deepseek.example.test/v1" },
        openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
      codexMainAccountHardLockFallback: FALLBACK,
    } as Partial<OcxConfig>);
    const req = new Request("http://127.0.0.1/v1/responses", { method: "POST",
      headers: { authorization: "Bearer fixture-caller-a", "chatgpt-account-id": "fallback-account-a" } });
    const body = { model: "gpt-5.3", reasoning: { effort: "high" } };
    const pending = applyMainHardLockFallbackOverride(body, cfg, undefined,
      mainHardLockFallbackCallerCheck(req, cfg, {} as HandleResponsesOptions));
    // The replacement is blocked too, so only the ownership recheck can refuse the reroute.
    queueMicrotask(() => {
      if (change === "identity") {
        observeMainQuotaIdentity("fallback-account-b");
        observeMainQuotaCredential("fixture-caller-b", "fallback-account-b");
        setAccountQuotaFromParsed("__main__", { weeklyPercent: 100 }, undefined, captureMainQuotaWriter("fallback-account-b")!);
      } else if (change === "bearer") observeMainQuotaCredential("fixture-caller-a-rotated", "fallback-account-a");
    });
    const result = await pending;
    if (change === "none") {
      expect(result).toEqual({ sourceModel: "gpt-5.3", targetModel: "deepseek/deepseek-chat" });
      return;
    }
    expect(result).toBeNull();
    expect(body).toEqual({ model: "gpt-5.3", reasoning: { effort: "high" } });
  });

  test("only bare Codex-native selectors qualify", async () => {
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
      expect(await applyMainHardLockFallbackOverride(body, cfg)).toBeNull();
      expect(body.model).toBe(model);
    }
  });

  test("a Codex-native fallback target never applies: the refusal is the honest answer", async () => {
    observe({ weeklyPercent: 100 });
    for (const target of ["gpt-5.4", "openai/gpt-5.4"]) {
      const body: Record<string, unknown> = { model: "gpt-5.3" };
      expect(await applyMainHardLockFallbackOverride(body, config({ codexMainAccountHardLockFallback: { model: target } } as Partial<OcxConfig>))).toBeNull();
      expect(body.model).toBe("gpt-5.3");
    }
  });

  test("a fallback without an effort leaves the request's own reasoning untouched", async () => {
    observe({ weeklyPercent: 100 });
    const cfg = config({ codexMainAccountHardLockFallback: { model: "deepseek/deepseek-chat" } } as Partial<OcxConfig>);
    const body: Record<string, unknown> = { model: "gpt-5.3", reasoning: { effort: "high" } };
    expect(await applyMainHardLockFallbackOverride(body, cfg)).toEqual({ sourceModel: "gpt-5.3", targetModel: "deepseek/deepseek-chat" });
    expect(body.model).toBe("deepseek/deepseek-chat");
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  test("a body without a usable model selector is never touched", async () => {
    observe({ weeklyPercent: 100 });
    const cfg = config({ codexMainAccountHardLockFallback: FALLBACK } as Partial<OcxConfig>);
    expect(await applyMainHardLockFallbackOverride(null, cfg)).toBeNull();
    expect(await applyMainHardLockFallbackOverride([], cfg)).toBeNull();
    expect(await applyMainHardLockFallbackOverride({ model: "" }, cfg)).toBeNull();
    expect(await applyMainHardLockFallbackOverride({ model: 42 }, cfg)).toBeNull();
  });

  test("unavailable chosen targets keep the blocked source and reasoning intact", async () => {
    observe({ weeklyPercent: 100 });
    const gateway = { adapter: "openai-responses", authMode: "key", baseUrl: "https://gateway.example.test/v1" } as const;
    for (const target of ["private/secret-model", "former/secret-model", "combo/removed", "policy/removed", "retired-account/gpt-5.3"]) {
      for (const providers of [{ gateway }, {}]) {
        const cfg = config({ providers, defaultProvider: "gateway", codexMainAccountHardLockFallback: { model: target, reasoningEffort: "low" } } as Partial<OcxConfig>);
        const body = { model: "gpt-5.3", reasoning: { effort: "high" } };
        expect(await applyMainHardLockFallbackOverride(body, cfg)).toBeNull();
        expect(body).toEqual({ model: "gpt-5.3", reasoning: { effort: "high" } });
      }
    }
    const cfg = config({ providers: { gateway, private: { ...gateway, disabled: true } }, defaultProvider: "gateway", codexMainAccountHardLockFallback: { model: "private/secret-model" } } as Partial<OcxConfig>);
    expect(await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg)).toBeNull();
  });

  test("target admission is rechecked after provider removal, re-addition and alias changes", async () => {
    observe({ weeklyPercent: 100 });
    const provider = { adapter: "openai-responses", authMode: "key", baseUrl: "https://chosen.example.test/v1", alias: "chosen" } as const;
    const cfg = config({ providers: { private: provider }, defaultProvider: "private", codexMainAccountHardLockFallback: { model: "chosen/secret-model" } } as Partial<OcxConfig>);
    const apply = () => applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg);
    expect(await apply()).not.toBeNull();
    delete cfg.providers.private;
    expect(await apply()).toBeNull();
    cfg.providers.private = provider;
    expect(await apply()).not.toBeNull();
    cfg.providers.private = { ...provider, alias: "renamed" };
    expect(await apply()).toBeNull();
    cfg.codexMainAccountHardLockFallback = { model: "private/secret-model" };
    expect(await apply()).not.toBeNull();
  });

  test("bare fallback and explicitly declared slash model ids stay valid", async () => {
    observe({ weeklyPercent: 100 });
    const provider = { adapter: "openai-responses", authMode: "key", baseUrl: "https://chosen.example.test/v1", models: ["vendor/native-model"] } as const;
    for (const model of ["bare-model", "vendor/native-model", "private/vendor/native-model"]) {
      const cfg = config({ providers: { private: { ...provider, models: [...provider.models] } }, defaultProvider: "private", codexMainAccountHardLockFallback: { model } } as Partial<OcxConfig>);
      expect((await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg))?.targetModel).toBe(model);
    }
  });

  test("configured combo aliases, policy profiles and account namespaces keep their admission", async () => {
    observe({ weeklyPercent: 100 });
    const cfg = config({
      providers: { private: { adapter: "openai-responses", authMode: "key", baseUrl: "https://chosen.example.test/v1" },
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" } },
      combos: { rescue: { alias: "chosen-combo", targets: [{ provider: "private", model: "secret-model" }] } },
      routingProfiles: { rescue: { alias: "chosen-policy", candidates: [{ provider: "private", model: "secret-model" }], require: { tools: true } } },
      codexAccountNamespaces: { pinned: "pool-a" },
    } as Partial<OcxConfig>);
    for (const model of ["combo/rescue", "chosen-combo", "policy/rescue", "chosen-policy", "pinned/gpt-5.3"]) {
      cfg.codexMainAccountHardLockFallback = { model };
      expect((await applyMainHardLockFallbackOverride({ model: "gpt-5.3" }, cfg))?.targetModel).toBe(model);
    }
  });

  test("a stale qualified fallback never sends to the enabled default provider", async () => {
    observeMainQuotaCredential("fixture-caller", "fallback-account-a");
    observe({ weeklyPercent: 100 });
    const cfg = config({
      providers: {
        openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct", baseUrl: "https://chatgpt.com/backend-api/codex" },
        gateway: { adapter: "openai-responses", authMode: "key", apiKey: "fixture-key", baseUrl: "https://gateway.example.test/v1" },
      },
      defaultProvider: "gateway",
      codexMainAccountHardLockFallback: { model: "private/secret-model" },
    } as Partial<OcxConfig>);
    let sends = 0;
    const sentUrls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      sends += 1;
      sentUrls.push(String(input));
      return Response.json({ id: "resp_fixture", status: "completed", output: [] });
    }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture-caller", "chatgpt-account-id": "fallback-account-a" },
      body: JSON.stringify({ model: "gpt-5.3", stream: false, input: "fixture" }),
    }), cfg, { model: "", provider: "" });
    await response.text();
    expect(sentUrls).toEqual([]);
    expect(sends).toBe(0);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test("handleResponses strips caller credentials, preserves requestedModel on combo fallback, and yields to shadow/compaction turns", async () => {
    observe({ weeklyPercent: 100 });
    // This caller is the observed main credential that actually owes the hard lock.
    observeMainQuotaCredential("caller-chatgpt-token", "fallback-account-a");
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
      "chatgpt-account-id": "fallback-account-a",
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
