import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { OcxConfig, OcxComboStrategy } from "../../src/types";
import { handleResponses } from "../../src/server/responses";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { admissionMayUseMeteredComboTargets } from "../../src/server/admission-model-scope";
import { resolveApiAuth, type DataPlaneAdmission } from "../../src/server/auth-cors";
import { clearComboTargetCooldowns, coolComboTarget } from "../../src/combos/failover";
import { clearComboSelectionState, tryPickComboModel } from "../../src/combos/resolve";
import { comboDestinationQuotaExhausted } from "../../src/router";
import { linkAdvisorPlanConfig } from "../../src/server/responses/advisor-plan-slot";
import { noteSubagentModelFailure, resetSubagentModelFallbackStateForTests } from "../../src/codex/subagent-model-fallback";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import { tryReserveCodexWebSocket } from "../../src/codex/websocket-registry";
import { buildResponsesWsData, type WsData } from "../../src/server/ws-bridge";
import { clearCachedProviderQuotas, setCachedProviderQuotaForTests } from "../../src/providers/quota-routing-cache";
import type { ProviderQuota } from "../../src/providers/quota-types";
import { capRequestExecutionBudgetSends, CODEX_TEXT_GUARDED_BUDGET_POLICY, createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { chatSuccess } from "../helpers/combo-failover-upstream";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { saveConfig } from "../../src/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import * as requestPacing from "../../src/providers/request-pacing";
import * as coreAuth from "../../src/server/responses/core-auth";
import * as requestPrepare from "../../src/server/responses/request-prepare";

const issued = { id: "issued", name: "issued", key: "ocx_data_" + "a".repeat(40), createdAt: "2026-10-15T00:00:00Z" };
const keyed: DataPlaneAdmission = { kind: "configured", keyId: issued.id, source: "bearer" };
const local: DataPlaneAdmission = { kind: "loopback", source: "loopback" };
const originalRandom = Math.random;
let sent: string[];
let release: () => void;
let releaseHeldPacing: (() => void) | undefined;
const originalHome = process.env.OPENCODEX_HOME;
let home: string;
// A home per test, so a case that persists its config leaves nothing for the next one.
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-loopback-consent-")); process.env.OPENCODEX_HOME = home; sent = []; release = acquireOwnedSpendHome(); clearComboSelectionState(); clearComboTargetCooldowns(); clearKeyCooldowns(); });
afterEach(() => {
  releaseHeldPacing?.();
  releaseHeldPacing = undefined;
  mock.restore();
  Math.random = originalRandom;
  // The lease surfaces a release failure; the home is restored and removed either way.
  try {
    release();
  } finally {
    clearComboSelectionState(); clearComboTargetCooldowns(); clearCachedProviderQuotas(); clearKeyCooldowns(); resetSubagentModelFallbackStateForTests();
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(home);
  }
});
function config(flag?: boolean, strategy: OcxComboStrategy = "failover"): OcxConfig {
  const provider = (name: string) => ({ adapter: "openai-chat" as const, baseUrl: `https://${name}.test/v1`, apiKey: "fixture", models: ["m"],
    fetch: (async () => { sent.push(name); return Response.json({ error: { message: "fixture refusal", type: "invalid_request_error" } }, { status: 400 }); }) as typeof fetch });
  return { port: 16389, defaultProvider: "paid", providers: { paid: provider("paid"), subscription: provider("subscription"), primary: provider("primary") },
    apiKeys: [issued], combos: { chain: { strategy, ...(flag === undefined ? {} : { allowMeteredTargets: flag }), targets: [{ provider: "paid", model: "m", metered: true }] } } };
}
const spoof = { "x-ocx-allow-metered-targets": "true", "x-opencodex-allow-metered-combo-targets": "true", "allowMeteredTargets": "true" };
function request(wire: string, model = "combo/chain", headers: Record<string, string> = {}) {
  const body = wire === "chat" || wire === "messages"
    ? { model, stream: false, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }
    : { model, input: "hi", stream: false };
  return new Request(`http://localhost:16389/v1/${wire}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
async function post(wire: string, cfg: OcxConfig, admission: DataPlaneAdmission, headers = {}) {
  const req = request(wire, "combo/chain", headers);
  const ctx = { model: "", provider: "" };
  const ids = { requestId: "consent-test", start: Date.now(), admission };
  const response = wire === "chat" ? await handleChatCompletions(req, cfg, ctx, ids)
    : wire === "messages" ? await handleClaudeMessages(req, cfg, ctx, ids)
    : wire === "compact" ? await handleResponsesCompact(req, cfg, ctx, undefined, admission)
    : await handleResponses(req, cfg, ctx, { admission });
  await response.text();
  return response.status;
}

test("quota-only failover returns a transient rate limit without sending to a metered target", async () => {
  const cfg = config(true);
  cfg.combos!.chain = {
    ...cfg.combos!.chain!, quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
  };
  cfg.providers.subscription!.fetch = (async () => {
    sent.push("subscription");
    return Response.json({ error: { code: "rate_limit_exceeded", message: "Usage limit reached. Try again shortly." } },
      { status: 429, headers: { "Retry-After": "2" } });
  }) as typeof fetch;
  expect(await post("responses", cfg, local)).toBe(429);
  expect(sent).toEqual(["subscription"]);
});

test("quota-only failover never treats a preexisting transient cooldown as exhausted quota", async () => {
  const cfg = config(true);
  cfg.combos!.chain = {
    ...cfg.combos!.chain!, quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
  };
  coolComboTarget("chain", { provider: "subscription", model: "m" }, { status: 429, code: "rate_limit_exceeded" });
  expect(await post("responses", cfg, local)).toBe(503);
  expect(sent).toEqual([]);
});

for (const wire of ["responses", "messages"]) {
  test(`${wire}: quota-only failover advances on a quota refusal and remembers it across requests`, async () => {
    const cfg = config(true);
    cfg.combos!.chain = {
      ...cfg.combos!.chain!, quotaOnlyFallback: true,
      targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
    };
    cfg.providers.subscription!.fetch = (async () => {
      sent.push("subscription");
      return Response.json({ error: { code: "insufficient_quota", message: "Quota exhausted" } },
        { status: 429, headers: { "Retry-After": "30" } });
    }) as typeof fetch;
    expect(await post(wire, cfg, local)).toBe(400);
    expect(await post(wire, cfg, local)).toBe(400);
    expect(sent).toEqual(["subscription", "paid", "paid"]);
  });
}

test("replacing a provider credential rechecks its quota before any paid fallback", async () => {
  const cfg = config(true);
  cfg.combos!.chain = {
    ...cfg.combos!.chain!, quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
  };
  cfg.providers.subscription!.fetch = (async (_input, init) => {
    const active = new Headers(init?.headers).get("authorization");
    if (active === "Bearer fixture-replacement") {
      sent.push("replacement");
      return Response.json({ error: { message: "New credential was used", type: "invalid_request_error" } }, { status: 400 });
    }
    sent.push("subscription");
    return Response.json({ error: { code: "insufficient_quota", message: "Quota exhausted" } },
      { status: 429, headers: { "Retry-After": "30" } });
  }) as typeof fetch;
  expect(await post("responses", cfg, local)).toBe(400);
  const updated = { ...cfg, providers: { ...cfg.providers,
    subscription: { ...cfg.providers.subscription!, apiKey: "fixture-replacement" },
  } };
  expect(await post("responses", updated, local)).toBe(400);
  expect(sent).toEqual(["subscription", "paid", "replacement"]);
});

test("quota-only Codex pool fallback waits until every usable account has exhaustion evidence", async () => {
  const cfg = config(true);
  cfg.providers.openai = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" };
  cfg.providers.paid!.fetch = (async () => { sent.push("paid"); return chatSuccess("fallback", "m"); }) as typeof fetch;
  cfg.combos!.chain = { strategy: "failover", quotaOnlyFallback: true, allowMeteredTargets: true,
    targets: [{ provider: "openai", model: "gpt-5.6-luna" }, { provider: "paid", model: "m" }] };
  const accounts = ["strict-pool-a", "strict-pool-b"];
  cfg.codexAccounts = accounts.map((id, index) => ({ id, email: `${id}@example.test`, isMain: false, logLabel: `pstrict${index}` }));
  cfg.codexPool = { poolOnly: true };
  cfg.activeCodexAccountId = accounts[0];
  for (const id of accounts) saveCodexAccountCredential(id, {
    accessToken: "fixture-access", refreshToken: "fixture-refresh",
    expiresAt: Date.now() + 300_000, chatgptAccountId: `workspace-${id}`,
  });
  try {
    const reset = Math.floor((Date.now() + 600_000) / 1000);
    setAccountQuotaFromParsed(accounts[0]!, { weeklyPercent: 100, weeklyResetAt: reset });
    recordCodexUpstreamOutcome(cfg, accounts[1]!, 429, { retryAfter: "30" });
    expect(await post("responses", cfg, local)).toBe(401);
    expect(sent).toEqual([]);
    setAccountQuotaFromParsed(accounts[1]!, { weeklyPercent: 100, weeklyResetAt: reset });
    expect(await post("responses", cfg, local)).toBe(200);
    expect(sent).toEqual(["paid"]);
  } finally {
    for (const id of accounts) clearAccountQuota(id);
    clearCodexUpstreamHealth();
  }
});

test("quota-only failover honors the same-model constraint even across providers", async () => {
  const cfg = config(true);
  cfg.providers.paid!.models = ["different"];
  cfg.combos!.chain = {
    ...cfg.combos!.chain!, quotaOnlyFallback: true, preserveFallbackModel: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "different", metered: true }],
  };
  cfg.providers.subscription!.fetch = (async () => {
    sent.push("subscription");
    return Response.json({ error: { code: "insufficient_quota", message: "Quota exhausted" } }, { status: 429 });
  }) as typeof fetch;
  expect(await post("responses", cfg, local)).toBe(409);
  expect(await post("responses", cfg, local)).toBe(409);
  expect(sent).toEqual(["subscription"]);
});

for (const redirected of [false, true]) {
  test(`quota-only failover requires consent for a known paid API${redirected ? " reached by redirect" : ""}`, async () => {
    const cfg = config(false);
    cfg.providers["openai-apikey"] = { ...cfg.providers.paid!, baseUrl: "https://api.openai.com/v1" };
    if (redirected) {
      Object.assign(cfg.providers.primary!, { authMode: "local", baseUrl: "http://127.0.0.1:19012/v1", allowPrivateNetwork: true });
      cfg.blockedModelRedirects = { "primary/m": "openai-apikey/m" };
    }
    cfg.combos!.chain = {
      ...cfg.combos!.chain!, quotaOnlyFallback: true,
      targets: [{ provider: redirected ? "primary" : "openai-apikey", model: "m", metered: false }],
    };
    const response = await handleResponses(request("responses"), cfg, { provider: "", model: "" }, { admission: local });
    expect(await response.json()).toMatchObject({ error: { code: "combo_metered_consent_required" } });
    expect(response.status).toBe(403);
    expect(sent).toEqual([]);
    cfg.combos!.chain!.allowMeteredTargets = true;
    expect(await post("responses", cfg, keyed)).toBe(403);
    expect(sent).toEqual([]);
    cfg.apiKeys![0] = { ...issued, allowMeteredComboTargets: true };
    expect(await post("responses", cfg, keyed)).toBe(400);
    expect(await post("responses", cfg, local)).toBe(400);
    expect(sent).toEqual(["paid", "paid"]);
  });
}

test("quota-only failover stops before an unmarked custom API key without consent", async () => {
  const cfg = config(false);
  Object.assign(cfg.providers.subscription!, { authMode: "local", baseUrl: "http://127.0.0.1:19012/v1", allowPrivateNetwork: true });
  cfg.providers.subscription!.fetch = (async () => {
    sent.push("subscription");
    return Response.json({ error: { code: "insufficient_quota", message: "Quota exhausted" } }, { status: 429 });
  }) as typeof fetch;
  cfg.combos!.chain = {
    strategy: "failover", quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: false }],
  };
  expect(await post("responses", cfg, local)).toBe(403);
  expect(sent).toEqual(["subscription"]);
  cfg.combos!.chain!.allowMeteredTargets = true;
  expect(await post("responses", cfg, local)).toBe(400);
  expect(sent).toEqual(["subscription", "subscription", "paid"]);
});

test("quota-only failover respects authentication, quota uncertainty and missing consent", async () => {
  const cfg = config(false);
  Object.assign(cfg.providers.subscription!, { authMode: "local", baseUrl: "http://127.0.0.1:19012/v1", allowPrivateNetwork: true });
  cfg.combos!.chain = {
    ...cfg.combos!.chain!, quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }, { provider: "primary", model: "m" }],
  };
  for (const [status, code, message] of [
    [401, "invalid_api_key", "Unauthorized"],
    [429, "rate_limit_error", "Slow down"],
    [429, "insufficient_quota", "Quota exhausted"],
  ] as const) {
    cfg.providers.subscription!.fetch = (async () => {
      sent.push("subscription");
      return Response.json({ error: { code, message } }, { status });
    }) as typeof fetch;
    expect(await post("responses", cfg, local)).toBe(code === "insufficient_quota" ? 403 : status);
  }
  expect(sent).toEqual(["subscription", "subscription", "subscription"]);
});

test("quota-only failover can skip fresh exhausted quota before sending but retries stale quota", async () => {
  const cfg = config(true);
  cfg.combos!.chain = {
    ...cfg.combos!.chain!, quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
  };
  setCachedProviderQuotaForTests("subscription", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
  expect(await post("responses", cfg, local)).toBe(400);
  setCachedProviderQuotaForTests("subscription", { updatedAt: Date.now() - 3_600_000, weeklyPercent: 100 } as ProviderQuota);
  expect(await post("responses", cfg, local)).toBe(400);
  expect(sent).toEqual(["paid", "subscription"]);
});

test("quota-only selection reads the quota of a redirected destination", async () => {
  const cfg = config(true);
  cfg.blockedModelRedirects = { "subscription/m": "primary/m" };
  cfg.combos!.chain = {
    ...cfg.combos!.chain!, quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
  };
  cfg.providers.primary!.fetch = (async () => { sent.push("primary"); return chatSuccess("redirected", "m"); }) as typeof fetch;
  setCachedProviderQuotaForTests("subscription", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
  expect(await post("responses", cfg, local)).toBe(200);
  setCachedProviderQuotaForTests("primary", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
  expect(await post("responses", cfg, local)).toBe(400);
  expect(sent).toEqual(["primary", "paid"]);
});

test("a router-collapsed quota-only Combo reads the quota of a redirected destination", async () => {
  const cfg = config(true);
  cfg.defaultProvider = "primary";
  cfg.providers.mirror = { ...cfg.providers.subscription!, baseUrl: "https://mirror.test/v1",
    fetch: (async () => { sent.push("mirror"); return chatSuccess("mirrored", "m"); }) as typeof fetch };
  cfg.blockedModelRedirects = { "subscription/m": "mirror/m" };
  cfg.combos!.chain = {
    ...cfg.combos!.chain!, alias: "chain-model", quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
  };
  cfg.subagentModelFallback = ["chain-model"];
  setCachedProviderQuotaForTests("subscription", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
  noteSubagentModelFailure("primary/m", "429", cfg);
  const response = await handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }),
    cfg, { model: "", provider: "" }, { admission: local });
  await response.text();
  expect(sent).toEqual(["mirror"]);
});

test("a router-collapsed quota-only Combo skips a Codex pool whose usable accounts are all spent", async () => {
  const cfg = config(true);
  cfg.defaultProvider = "primary";
  cfg.providers.openai = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" };
  cfg.providers.subscription!.fetch = (async () => { sent.push("subscription"); return chatSuccess("fallback", "m"); }) as typeof fetch;
  cfg.combos!.chain = { strategy: "failover", alias: "chain-model", quotaOnlyFallback: true, allowMeteredTargets: true,
    targets: [{ provider: "openai", model: "gpt-5.6-luna" }, { provider: "subscription", model: "m" }] };
  cfg.subagentModelFallback = ["chain-model"];
  const accounts = ["collapsed-pool-a", "collapsed-pool-b"];
  cfg.codexAccounts = accounts.map((id, index) => ({ id, email: `${id}@example.test`, isMain: false, logLabel: `pcollapsed${index}` }));
  cfg.codexPool = { poolOnly: true };
  cfg.activeCodexAccountId = accounts[0];
  for (const id of accounts) saveCodexAccountCredential(id, {
    accessToken: "fixture-access", refreshToken: "fixture-refresh",
    expiresAt: Date.now() + 300_000, chatgptAccountId: `workspace-${id}`,
  });
  try {
    const reset = Math.floor((Date.now() + 600_000) / 1000);
    for (const id of accounts) setAccountQuotaFromParsed(id, { weeklyPercent: 100, weeklyResetAt: reset });
    noteSubagentModelFailure("primary/m", "429", cfg);
    const response = await handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }),
      cfg, { model: "", provider: "" }, { admission: local });
    await response.text();
    expect(sent).toEqual(["subscription"]);
  } finally {
    for (const id of accounts) clearAccountQuota(id);
    clearCodexUpstreamHealth();
  }
});

for (const [fallbackModel, allowed] of [["other", false], ["m", true]] as const) {
  test(`a router-collapsed quota-only Combo keeps the model lock (${fallbackModel})`, async () => {
    const cfg = config(true);
    cfg.defaultProvider = "primary";
    cfg.providers.paid!.models = ["m", "other"];
    cfg.providers.paid!.fetch = (async () => { sent.push("paid"); return chatSuccess("paid", fallbackModel); }) as typeof fetch;
    cfg.combos!.chain = {
      ...cfg.combos!.chain!, alias: "chain-model", quotaOnlyFallback: true, preserveFallbackModel: true,
      targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: fallbackModel, metered: true }],
    };
    cfg.subagentModelFallback = ["chain-model"];
    setCachedProviderQuotaForTests("subscription", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
    noteSubagentModelFailure("primary/m", "429", cfg);
    const response = await handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }),
      cfg, { model: "", provider: "" }, { admission: local });
    const body = await response.text();
    if (allowed) {
      expect(sent).toEqual(["paid"]);
    } else {
      expect(response.status).toBe(409);
      expect(body).toContain("combo_model_change_refused");
      expect(sent).toEqual([]);
    }
  });
}

const sameProviderResolutions = {
  "a bare model redirect": (cfg: OcxConfig) => { cfg.blockedModelRedirects = { retired: "m" }; },
  "a model alias": (cfg: OcxConfig) => { cfg.providers.subscription!.modelAliases = { m: "retired" }; },
};
for (const [resolution, configure] of Object.entries(sameProviderResolutions)) {
  for (const code of ["insufficient_quota", "usage_limit_reached"]) {
    test(`quota-only failover remembers ${code} on a target resolved through ${resolution}`, async () => {
      const cfg = config(true);
      configure(cfg);
      cfg.combos!.chain = {
        ...cfg.combos!.chain!, quotaOnlyFallback: true,
        targets: [{ provider: "subscription", model: "retired" }, { provider: "paid", model: "m", metered: true }],
      };
      const sentModels: string[] = [];
      cfg.providers.subscription!.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        sent.push("subscription");
        sentModels.push((JSON.parse(String(init?.body)) as { model: string }).model);
        return Response.json({ error: { code, message: "Quota exhausted" } }, { status: 429, headers: { "Retry-After": "30" } });
      }) as typeof fetch;
      expect(await post("responses", cfg, local)).toBe(400);
      expect(await post("responses", cfg, local)).toBe(400);
      expect(sentModels).toEqual(["m"]);
      expect(sent).toEqual(["subscription", "paid", "paid"]);
    });
  }
}

test("a router-collapsed Combo rechecks paid consent on the live config before it sends", async () => {
  const live = config(false);
  live.defaultProvider = "primary";
  live.combos!.chain = {
    ...live.combos!.chain!, alias: "chain-model", quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
  };
  live.subagentModelFallback = ["chain-model"];
  const view = linkAdvisorPlanConfig(live, { ...live, combos: { chain: { ...live.combos!.chain!, allowMeteredTargets: true } } });
  setCachedProviderQuotaForTests("subscription", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
  noteSubagentModelFailure("primary/m", "429", view);
  const response = await handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }),
    view, { model: "", provider: "" }, { admission: local });
  expect(await response.json()).toMatchObject({ error: { code: "combo_metered_consent_required" } });
  expect(sent).toEqual([]);
});

test("a router-collapsed Combo rechecks the key's live model scope before it sends", async () => {
  const live = config(true);
  live.defaultProvider = "primary";
  live.combos!.chain = {
    ...live.combos!.chain!, alias: "chain-model", quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
  };
  live.subagentModelFallback = ["chain-model"];
  live.apiKeys = [{ ...issued, allowMeteredComboTargets: true, allowedProviders: ["primary", "subscription"] }];
  const view = linkAdvisorPlanConfig(live, { ...live, apiKeys: [{ ...issued, allowMeteredComboTargets: true }] });
  setCachedProviderQuotaForTests("subscription", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
  noteSubagentModelFailure("primary/m", "429", view);
  const response = await handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }),
    view, { model: "", provider: "" }, { admission: keyed });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { type: "model_not_allowed_for_key" } });
  expect(sent).toEqual([]);
});

test("a quota-only Combo with no usable target names its redirected destination's spent quota", () => {
  const cfg = config(true);
  cfg.providers.mirror = { ...cfg.providers.subscription!, baseUrl: "https://mirror.test/v1" };
  cfg.blockedModelRedirects = { "subscription/m": "mirror/m" };
  cfg.combos!.chain = {
    ...cfg.combos!.chain!, quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
  };
  setCachedProviderQuotaForTests("mirror", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
  setCachedProviderQuotaForTests("paid", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
  expect(() => tryPickComboModel(cfg, "combo/chain", true, (target, now) => comboDestinationQuotaExhausted(cfg, target, now)))
    .toThrow(/target 1 \([^)]*\): quota exhausted/);
});

for (const exhaustedPrimary of [false, true]) {
  test(`a router-collapsed quota-only Combo answers the consent refusal when a paid target stops it${exhaustedPrimary ? " after an exhausted primary" : ""}`, async () => {
    const cfg = config(false);
    cfg.defaultProvider = "primary";
    cfg.combos!.chain = {
      ...cfg.combos!.chain!, alias: "chain-model", quotaOnlyFallback: true,
      targets: exhaustedPrimary
        ? [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }]
        : [{ provider: "paid", model: "m" }],
    };
    cfg.subagentModelFallback = ["chain-model"];
    if (exhaustedPrimary) setCachedProviderQuotaForTests("subscription", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
    noteSubagentModelFailure("primary/m", "429", cfg);
    const response = await handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }),
      cfg, { model: "", provider: "" }, { admission: local });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "combo_metered_consent_required" } });
    expect(sent).toEqual([]);
  });
}

test("quota-only failover remembers exhaustion on a target with a one-entry key pool", async () => {
  const cfg = config(true);
  cfg.providers.subscription!.apiKeyPool = [{ id: "only", key: "fixture" }];
  cfg.combos!.chain = {
    ...cfg.combos!.chain!, quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
  };
  cfg.providers.subscription!.fetch = (async () => {
    sent.push("subscription");
    return Response.json({ error: { code: "insufficient_quota", message: "Quota exhausted" } }, { status: 429, headers: { "Retry-After": "30" } });
  }) as typeof fetch;
  expect(await post("responses", cfg, local)).toBe(400);
  expect(await post("responses", cfg, local)).toBe(400);
  expect(sent).toEqual(["subscription", "paid", "paid"]);
});

const routeEdits = {
  "send path": (cfg: OcxConfig) => { cfg.providers.subscription!.chatCompletionsPath = "/v2/chat/completions"; },
  "redirected model's adapter": (cfg: OcxConfig) => { cfg.providers.subscription!.modelAdapters = { m: "openai-responses" }; },
  "Vertex project": (cfg: OcxConfig) => { cfg.providers.subscription!.project = "project-b"; },
  "Vertex location": (cfg: OcxConfig) => { cfg.providers.subscription!.location = "europe-west4"; },
};
for (const [edit, apply] of Object.entries(routeEdits)) {
  test(`quota-only failover retries a remembered exhausted target once its ${edit} changes`, async () => {
    const cfg = config(true);
    cfg.blockedModelRedirects = { retired: "m" };
    cfg.combos!.chain = {
      ...cfg.combos!.chain!, quotaOnlyFallback: true,
      targets: [{ provider: "subscription", model: "retired" }, { provider: "paid", model: "m", metered: true }],
    };
    cfg.providers.subscription!.fetch = (async () => {
      sent.push("subscription");
      return Response.json({ error: { code: "insufficient_quota", message: "Quota exhausted" } }, { status: 429, headers: { "Retry-After": "30" } });
    }) as typeof fetch;
    expect(await post("responses", cfg, local)).toBe(400);
    expect(await post("responses", cfg, local)).toBe(400);
    apply(cfg);
    expect(await post("responses", cfg, local)).toBe(400);
    expect(sent).toEqual(["subscription", "paid", "paid", "subscription", "paid"]);
  });
}

for (const [status, code] of [[400, "insufficient_quota"], [422, "usage_limit_exceeded"], [503, "usage_limit_exceeded"]] as const) {
  test(`quota-only failover advances on a structured exhaustion code with HTTP ${status}`, async () => {
    const cfg = config(true);
    cfg.combos!.chain = {
      ...cfg.combos!.chain!, quotaOnlyFallback: true,
      targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
    };
    cfg.providers.subscription!.fetch = (async () => {
      sent.push("subscription");
      return Response.json({ error: { code, message: "Account quota exhausted" } }, { status });
    }) as typeof fetch;
    expect(await post("responses", cfg, local)).toBe(400);
    expect(sent.at(-1)).toBe("paid");
  });
}

test("quota-only failover stops on validation prose that only mentions quota", async () => {
  const cfg = config(true);
  cfg.combos!.chain = {
    ...cfg.combos!.chain!, quotaOnlyFallback: true,
    targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
  };
  cfg.providers.subscription!.fetch = (async () => {
    sent.push("subscription");
    return Response.json({ error: { message: "You exceeded your current quota", type: "invalid_request_error" } }, { status: 400 });
  }) as typeof fetch;
  expect(await post("responses", cfg, local)).toBe(400);
  expect(sent).toEqual(["subscription"]);
});

for (const restraint of ["send budget", "cancellation", "scoped provider policy"] as const) {
  test(`quota-only failover cannot bypass ${restraint}`, async () => {
    const cfg = config(true);
    cfg.combos!.chain = {
      ...cfg.combos!.chain!, quotaOnlyFallback: true,
      targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
    };
    if (restraint === "scoped provider policy") cfg.fallback = { routes: { "combo/chain": { provider: false } } };
    const abort = new AbortController();
    cfg.providers.subscription!.fetch = (async () => {
      sent.push("subscription");
      if (restraint === "cancellation") abort.abort();
      return Response.json({ error: { code: "insufficient_quota", message: "Quota exhausted" } }, { status: 429 });
    }) as typeof fetch;
    const response = await handleResponses(request("responses"), cfg, { provider: "", model: "" }, {
      admission: local, abortSignal: abort.signal,
      ...(restraint === "send budget" ? {
        sendBudget: capRequestExecutionBudgetSends(createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY), 1),
      } : {}),
    });
    expect(response.status).toBe(restraint === "cancellation" ? 499 : 429);
    await response.text();
    expect(sent).toEqual(["subscription"]);
  });
}

for (const wire of ["responses", "chat", "messages", "compact"]) {
  test(`${wire}: local operator opt-in permits metered targets, default and spoofed consent deny`, async () => {
    expect(await post(wire, config(), local, spoof)).toBe(503);
    expect(sent).toEqual([]);
    expect(await post(wire, config(false), local)).toBe(503);
    expect(sent).toEqual([]);
    await post(wire, config(true), local);
    expect(sent).toEqual(["paid"]);
  });
  test(`${wire}: public listener ignores combo opt-in, including secondary loopback; opted-in key still works`, async () => {
    const cfg = { ...config(true), hostname: "0.0.0.0" };
    for (const admission of [local, keyed, { kind: "environment", source: "bearer" } as const]) {
      expect(await post(wire, cfg, admission, spoof)).toBe(503);
      expect(sent).toEqual([]);
    }
    cfg.apiKeys![0] = { ...issued, allowMeteredComboTargets: true };
    await post(wire, cfg, keyed);
    expect(sent).toEqual(["paid"]);
  });
}
test("consent uses the auth listener predicate and never overrides a configured or environment admission", () => {
  for (const hostname of [undefined, "127.0.0.1", "localhost.", "::1", "[::1]", "0.0.0.0", "::", "192.0.2.1"]) {
    const cfg = { ...config(true), hostname };
    const auth = resolveApiAuth(request("responses"), cfg);
    expect(admissionMayUseMeteredComboTargets(cfg, local, cfg.combos!.chain)).toBe(auth?.kind === "loopback");
    expect(admissionMayUseMeteredComboTargets(cfg, undefined, cfg.combos!.chain)).toBe(auth?.kind === "loopback");
    expect(admissionMayUseMeteredComboTargets(cfg, keyed, cfg.combos!.chain)).toBe(false);
    expect(admissionMayUseMeteredComboTargets(cfg, { kind: "environment", source: "bearer" }, cfg.combos!.chain)).toBe(false);
    cfg.apiKeys![0] = { ...issued, allowMeteredComboTargets: true };
    expect(admissionMayUseMeteredComboTargets(cfg, keyed, cfg.combos!.chain)).toBe(true);
    expect(admissionMayUseMeteredComboTargets(cfg, { ...keyed, keyId: "missing" }, cfg.combos!.chain)).toBe(false);
  }
});
for (const strategy of ["failover", "round-robin", "random", "least-used", "reset-window", "jev"] as const) {
  test(`${strategy}: the loop's first pick honors local consent`, async () => {
    await post("responses", config(true, strategy), local);
    expect(sent).toEqual(["paid"]);
  });
}
for (const strategy of ["failover", "round-robin", "random"] as const) {
  test(`${strategy}: collapsed subagent fallback honors operator consent and prefers usable unmetered targets`, async () => {
    const cfg = config(true, strategy);
    cfg.defaultProvider = "primary";
    cfg.combos!.chain!.alias = "chain-model";
    cfg.subagentModelFallback = ["chain-model"];
    const postFallback = (admission = local) => {
      resetSubagentModelFallbackStateForTests();
      noteSubagentModelFailure("primary/m", "429", cfg);
      return handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }), cfg, { model: "", provider: "" }, { admission });
    };
    await (await postFallback()).text();
    expect(sent).toEqual(["paid"]);
    sent.length = 0;
    cfg.combos!.chain!.allowMeteredTargets = false;
    expect((await postFallback()).status).toBe(503);
    expect(sent).toEqual([]);
    // Force the paid first choice in random too; it must be re-picked rather than refused.
    if (strategy === "random") Math.random = () => 0;
    cfg.combos!.chain!.targets = [{ provider: "paid", model: "m", metered: true, weight: 10000 }, { provider: "subscription", model: "m", weight: 1 }];
    for (let i = 0; i < 8; i++) {
      clearComboSelectionState();
      await (await postFallback()).text();
    }
    expect(sent).toEqual(Array(8).fill("subscription"));
    sent.length = 0;
    cfg.apiKeys![0] = { ...issued, allowedProviders: ["paid"] };
    expect((await postFallback(keyed)).status).toBe(403);
    expect(sent).toEqual([]);
    coolComboTarget("chain", { provider: "subscription", model: "m" }, { cooldownMs: 600000 });
    expect((await postFallback()).status).toBe(503);
  });
}

async function websocket(cfg: OcxConfig, admission: DataPlaneAdmission) {
  const handler = createWebsocketHandler({ config: cfg, deps: {} } as Parameters<typeof createWebsocketHandler>[0]);
  const server = Bun.serve<WsData>({ hostname: "127.0.0.1", port: 0, websocket: handler,
    fetch(req, server) { return server.upgrade(req, { data: buildResponsesWsData(new Headers(spoof), admission, tryReserveCodexWebSocket() ?? undefined) }) ? undefined : new Response("upgrade failed", { status: 400 }); },
  });
  const ws = new WebSocket(String(server.url).replace("http:", "ws:"));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("websocket consent deadline")), 4000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "response.create", model: "combo/chain", input: "hi" }));
      ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket failed")); };
      ws.onmessage = () => { clearTimeout(timer); resolve(); };
    });
  } finally { ws.close(); await server.stop(true); }
}
test("WebSocket frames retain local or keyed consent and reject spoofed consent", async () => {
  await websocket(config(), local);
  expect(sent).toEqual([]);
  await websocket(config(true), local);
  expect(sent).toEqual(["paid"]);
  sent.length = 0;
  const cfg = { ...config(true), hostname: "0.0.0.0" };
  await websocket(cfg, local);
  await websocket(cfg, keyed);
  expect(sent).toEqual([]);
  cfg.apiKeys![0] = { ...issued, allowMeteredComboTargets: true };
  await websocket(cfg, keyed);
  expect(sent).toEqual(["paid"]);
});

/**
 * Holds the second send of `provider` at its pacing wait until `release` runs, so a test changes the config
 * while that send is known to wait. `entered` resolves once the send is held there.
 */
function secondPacingWait(provider: string): { entered: Promise<void>; release: () => void } {
  const wait = requestPacing.waitForProviderRequestSlot;
  let calls = 0;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  releaseHeldPacing = release;
  const entered = new Promise<void>(resolve => {
    spyOn(requestPacing, "waitForProviderRequestSlot").mockImplementation(async (...args) => {
      if (args[0] === provider && ++calls === 2) {
        resolve();
        await released;
      }
      return wait(...args);
    });
  });
  return { entered, release };
}

/** Resolves once the held pacing wait is reached, and fails when the pending request settles first. */
async function pacingStarted(paced: { entered: Promise<void> }, waiting: Promise<Response>): Promise<void> {
  const first = await Promise.race([paced.entered.then(() => undefined), waiting]);
  if (first) throw new Error(`request settled before pacing: ${first.status}`);
}

const rateLimited = { message: "Rate limit reached for requests per minute" };
for (const [label, firstKeyError, advances] of [
  ["every key proves spent quota", { code: "insufficient_quota", message: "Quota exhausted" }, true],
  ["one key is only rate-limited", rateLimited, false],
] as const) {
  test(`quota-only failover leaves a key pool only when ${label}`, async () => {
    const cfg = config(true);
    cfg.providers.subscription!.apiKey = "key-one";
    cfg.providers.subscription!.apiKeyPool = [{ id: "one", key: "key-one" }, { id: "two", key: "key-two" }];
    cfg.combos!.chain = {
      ...cfg.combos!.chain!, quotaOnlyFallback: true,
      targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }],
    };
    cfg.providers.subscription!.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const keyLabels: Record<string, string> = { "Bearer key-one": "one", "Bearer key-two": "two" };
      const key = keyLabels[new Headers(init?.headers).get("authorization") ?? ""] ?? "unexpected";
      sent.push(key);
      if (key === "unexpected") {
        return Response.json({ error: { message: "unexpected credential", type: "invalid_request_error" } }, { status: 400 });
      }
      const error = key === "one" ? firstKeyError : { code: "insufficient_quota", message: "Quota exhausted" };
      return Response.json({ error }, { status: 429 });
    }) as typeof fetch;
    // Key rotation commits the next key to the persisted row, so the pool has to exist on disk.
    saveConfig(cfg);
    await post("responses", cfg, local);
    expect(sent).toEqual(advances ? ["one", "two", "paid"] : ["one", "two"]);
  });
}

for (const collapsed of [false, true]) {
  test(`a ${collapsed ? "router-collapsed " : ""}quota-only paid send rechecks consent after it waited for pacing`, async () => {
    const cfg = config(true);
    cfg.defaultProvider = "primary";
    cfg.combos!.chain = { ...cfg.combos!.chain!, alias: "chain-model", quotaOnlyFallback: true, targets: [{ provider: "paid", model: "m" }] };
    cfg.subagentModelFallback = ["chain-model"];
    cfg.providers.paid!.requestPacing = { enabled: true, minIntervalMs: 1_500 };
    const send = () => collapsed
      ? handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }), cfg, { model: "", provider: "" }, { admission: local })
      : handleResponses(request("responses"), cfg, { model: "", provider: "" }, { admission: local });
    if (collapsed) noteSubagentModelFailure("primary/m", "429", cfg);
    const pacedSend = secondPacingWait("paid");
    await (await send()).text();
    const waiting = send();
    await pacingStarted(pacedSend, waiting);
    cfg.combos!.chain!.allowMeteredTargets = false;
    pacedSend.release();
    const refused = await waiting;
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "combo_metered_consent_required" } });
    expect(sent).toEqual(["paid"]);
  });
}

for (const collapsed of [false, true]) {
  test(`a ${collapsed ? "router-collapsed " : ""}quota-only paid send rechecks the key's live model scope after it waited for pacing`, async () => {
    const cfg = config(true);
    cfg.defaultProvider = "primary";
    cfg.combos!.chain = { ...cfg.combos!.chain!, alias: "chain-model", quotaOnlyFallback: true, targets: [{ provider: "paid", model: "m" }] };
    cfg.subagentModelFallback = ["chain-model"];
    cfg.apiKeys = [{ ...issued, allowMeteredComboTargets: true }];
    cfg.providers.paid!.requestPacing = { enabled: true, minIntervalMs: 1_500 };
    const send = () => collapsed
      ? handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }), cfg, { model: "", provider: "" }, { admission: keyed })
      : handleResponses(request("responses"), cfg, { model: "", provider: "" }, { admission: keyed });
    if (collapsed) noteSubagentModelFailure("primary/m", "429", cfg);
    const pacedSend = secondPacingWait("paid");
    await (await send()).text();
    const waiting = send();
    await pacingStarted(pacedSend, waiting);
    cfg.apiKeys = [{ ...issued, allowMeteredComboTargets: true, allowedProviders: ["primary"] }];
    pacedSend.release();
    const refused = await waiting;
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { type: "model_not_allowed_for_key" } });
    expect(sent).toEqual(["paid"]);
  });
}

test("a Combo child rechecks the key's live scope against the model it sends after a pacing wait", async () => {
  const cfg = config(true);
  cfg.providers["openai-apikey"] = {
    adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key", apiKey: "fixture-key",
    models: ["gpt-5.6-sol-pro", "gpt-5.6-sol"], requestPacing: { enabled: true, minIntervalMs: 1_500 },
    fetch: (async () => {
      sent.push("openai-apikey");
      return Response.json({ error: { message: "fixture refusal", type: "invalid_request_error" } }, { status: 400 });
    }) as typeof fetch,
  };
  cfg.combos!.chain = { ...cfg.combos!.chain!, quotaOnlyFallback: true, targets: [{ provider: "openai-apikey", model: "gpt-5.6-sol-pro" }] };
  cfg.apiKeys = [{ ...issued, allowMeteredComboTargets: true }];
  const send = () => handleResponses(request("responses"), cfg, { model: "", provider: "" }, { admission: keyed });
  const pacedSend = secondPacingWait("openai-apikey");
  await (await send()).text();
  const waiting = send();
  await pacingStarted(pacedSend, waiting);
  // The public virtual model stays allowed, but the wire model it sends does not.
  cfg.apiKeys = [{ ...issued, allowMeteredComboTargets: true, allowedModels: ["openai-apikey/gpt-5.6-sol-pro"] }];
  pacedSend.release();
  const refused = await waiting;
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: { type: "model_not_allowed_for_key" } });
  expect(sent).toEqual(["openai-apikey"]);
});

for (const wire of ["responses", "chat"] as const) {
  test(`a Combo child refuses a configured key removed while its send waited for pacing${wire === "chat" ? " on the native Chat path" : ""}`, async () => {
    const cfg = config(true);
    // An unmarked target of an ordinary Combo needs no paid consent, so only the key itself admits the send.
    cfg.combos!.chain = { strategy: "failover", targets: [{ provider: "subscription", model: "m" }] };
    cfg.apiKeys = [issued];
    cfg.providers.subscription!.requestPacing = { enabled: true, minIntervalMs: 1_500 };
    // The Chat variant sends each eligible candidate natively, outside request preparation.
    if (wire === "chat") cfg.protocols = { rollout: { nativeChatCombos: true } };
    const send = () => wire === "chat"
      ? handleChatCompletions(request("chat"), cfg, { model: "", provider: "" }, { requestId: "consent-test", start: Date.now(), admission: keyed })
      : handleResponses(request("responses"), cfg, { model: "", provider: "" }, { admission: keyed });
    const pacedSend = secondPacingWait("subscription");
    await (await send()).text();
    const waiting = send();
    await pacingStarted(pacedSend, waiting);
    cfg.apiKeys = [];
    pacedSend.release();
    const refused = await waiting;
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).toMatch(/model_not_allowed_for_key|not allowed for this API key/);
    expect(sent).toEqual(["subscription"]);
  });
}

for (const [change, apply] of [
  ["a target marked paid", (cfg: OcxConfig) => { cfg.combos!.chain!.targets[0]!.metered = true; }],
  ["a quota-only rule turned on", (cfg: OcxConfig) => { cfg.combos!.chain!.quotaOnlyFallback = true; }],
] as const) for (const collapsed of [false, true]) {
  test(`a ${collapsed ? "router-collapsed send" : "Combo child"} rechecks ${change} while it waited for pacing`, async () => {
    const cfg = config(false);
    cfg.defaultProvider = "primary";
    // An unmarked paid API target of an ordinary Combo needs consent only once it is marked paid or the
    // quota-only rule applies.
    cfg.combos!.chain = { strategy: "failover", alias: "chain-model", targets: [{ provider: "paid", model: "m" }] };
    cfg.subagentModelFallback = ["chain-model"];
    cfg.providers.paid!.requestPacing = { enabled: true, minIntervalMs: 1_500 };
    const send = () => collapsed
      ? handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }), cfg, { model: "", provider: "" }, { admission: local })
      : handleResponses(request("responses"), cfg, { model: "", provider: "" }, { admission: local });
    if (collapsed) noteSubagentModelFailure("primary/m", "429", cfg);
    const pacedSend = secondPacingWait("paid");
    await (await send()).text();
    const waiting = send();
    await pacingStarted(pacedSend, waiting);
    apply(cfg);
    pacedSend.release();
    const refused = await waiting;
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "combo_metered_consent_required" } });
    expect(sent).toEqual(["paid"]);
  });
}

test("a Combo child refuses a configured key removed while its credentials were being resolved", async () => {
  const cfg = config(true);
  cfg.combos!.chain = { strategy: "failover", targets: [{ provider: "subscription", model: "m" }] };
  cfg.apiKeys = [issued];
  const resolveAuth = coreAuth.resolveResponsesCodexAuth;
  spyOn(coreAuth, "resolveResponsesCodexAuth").mockImplementation(async (...args) => {
    // Removed after the request was admitted, while preparation awaits its credentials.
    cfg.apiKeys = [];
    return resolveAuth(...args);
  });
  const response = await handleResponses(request("responses"), cfg, { model: "", provider: "" }, { admission: keyed });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { type: "model_not_allowed_for_key" } });
  expect(sent).toEqual([]);
});

test("a router-collapsed quota-only send keeps its consent rule when the Combo is deleted during the pacing wait", async () => {
  const cfg = config(true);
  cfg.defaultProvider = "primary";
  // An unmarked paid API target needs consent only under the quota-only rule.
  cfg.combos!.chain = { ...cfg.combos!.chain!, alias: "chain-model", quotaOnlyFallback: true, targets: [{ provider: "paid", model: "m" }] };
  cfg.subagentModelFallback = ["chain-model"];
  cfg.providers.paid!.requestPacing = { enabled: true, minIntervalMs: 1_500 };
  const send = () => handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }),
    cfg, { model: "", provider: "" }, { admission: local });
  noteSubagentModelFailure("primary/m", "429", cfg);
  const pacedSend = secondPacingWait("paid");
  await (await send()).text();
  const waiting = send();
  await pacingStarted(pacedSend, waiting);
  // Deleting the Combo also removes the loopback consent it carried.
  delete cfg.combos!.chain;
  pacedSend.release();
  const refused = await waiting;
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: { code: "combo_metered_consent_required" } });
  expect(sent).toEqual(["paid"]);
});

for (const collapsed of [false, true]) {
  test(`a ${collapsed ? "router-collapsed send" : "Combo child"} of a quota-only Combo reclassifies its redirected destination from the live provider`, async () => {
    // Consent stays withheld throughout, so only the destination's live class changes the outcome.
    const cfg = config(false);
    cfg.defaultProvider = "primary";
    const loopbackRow = (name: string) => ({ adapter: "openai-chat" as const, authMode: "local" as const, baseUrl: "http://127.0.0.1:9/v1",
      allowPrivateNetwork: true, models: ["m"],
      fetch: (async () => { sent.push(name); return Response.json({ error: { message: "fixture refusal", type: "invalid_request_error" } }, { status: 400 }); }) as typeof fetch });
    cfg.providers.selector = loopbackRow("selector");
    cfg.providers.mirror = { ...loopbackRow("mirror"), requestPacing: { enabled: true, minIntervalMs: 1_500 } };
    cfg.blockedModelRedirects = { "selector/m": "mirror/m" };
    cfg.combos!.chain = { strategy: "failover", alias: "chain-model", quotaOnlyFallback: true,
      targets: [{ provider: "selector", model: "m" }] };
    cfg.subagentModelFallback = ["chain-model"];
    const send = () => collapsed
      ? handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }), cfg, { model: "", provider: "" }, { admission: local })
      : handleResponses(request("responses"), cfg, { model: "", provider: "" }, { admission: local });
    if (collapsed) noteSubagentModelFailure("primary/m", "429", cfg);
    const pacedSend = secondPacingWait("mirror");
    // The explicit loopback local destination sends without paid-call consent.
    await (await send()).text();
    const waiting = send();
    await pacingStarted(pacedSend, waiting);
    // The redirect destination becomes a paid API row while the send waits.
    cfg.providers.mirror = { ...cfg.providers.mirror!, authMode: "key", baseUrl: "https://mirror.example/v1", apiKey: "fixture" };
    pacedSend.release();
    const refused = await waiting;
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "combo_metered_consent_required" } });
    expect(sent).toEqual(["mirror"]);
  });
}

test("a quota-only Combo with no target left names the quota of a redirected destination", async () => {
  const cfg = config(true);
  cfg.combos!.chain = { ...cfg.combos!.chain!, quotaOnlyFallback: true, targets: [{ provider: "subscription", model: "m" }] };
  cfg.blockedModelRedirects = { "subscription/m": "primary/m" };
  setCachedProviderQuotaForTests("primary", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
  const response = await handleResponses(request("responses"), cfg, { model: "", provider: "" }, { admission: local });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "combo_unavailable", combo: { cause: "quota" } } });
  expect(sent).toEqual([]);
});

test("a Combo child that settles on a paid destination the parent never saw needs paid-call consent", async () => {
  const cfg = config(false);
  const loopbackRow = (name: string) => ({ adapter: "openai-chat" as const, authMode: "local" as const, baseUrl: "http://127.0.0.1:9/v1",
    allowPrivateNetwork: true, models: ["m"],
    fetch: (async () => { sent.push(name); return Response.json({ error: { message: "fixture refusal", type: "invalid_request_error" } }, { status: 400 }); }) as typeof fetch });
  cfg.providers.selector = loopbackRow("selector");
  cfg.providers.mirror = loopbackRow("mirror");
  cfg.blockedModelRedirects = { "selector/m": "mirror/m" };
  cfg.combos!.chain = { strategy: "failover", quotaOnlyFallback: true, targets: [{ provider: "selector", model: "m" }] };
  const prepare = requestPrepare.prepareResponsesRequest;
  spyOn(requestPrepare, "prepareResponsesRequest").mockImplementation(async (...args) => {
    if (!args[0].options.comboAttempt) return prepare(...args);
    // The child resolves its route while the redirect points at the paid API, then the redirect is restored.
    cfg.blockedModelRedirects = { "selector/m": "paid/m" };
    try {
      return await prepare(...args);
    } finally {
      cfg.blockedModelRedirects = { "selector/m": "mirror/m" };
    }
  });
  const refused = await handleResponses(request("responses"), cfg, { model: "", provider: "" }, { admission: local });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: { code: "combo_metered_consent_required" } });
  expect(sent).toEqual([]);
});

test("a router-collapsed send keeps the quota-only rule it was selected under when the Combo changes during credential resolution", async () => {
  const cfg = config(true);
  cfg.defaultProvider = "primary";
  cfg.combos!.chain = { ...cfg.combos!.chain!, alias: "chain-model", quotaOnlyFallback: true, targets: [{ provider: "paid", model: "m" }] };
  cfg.subagentModelFallback = ["chain-model"];
  noteSubagentModelFailure("primary/m", "429", cfg);
  const resolveAuth = coreAuth.resolveResponsesCodexAuth;
  spyOn(coreAuth, "resolveResponsesCodexAuth").mockImplementation(async (...args) => {
    // Both changed after the pick was selected, while preparation awaits its credentials.
    cfg.combos!.chain!.quotaOnlyFallback = false;
    cfg.combos!.chain!.allowMeteredTargets = false;
    return resolveAuth(...args);
  });
  const response = await handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }),
    cfg, { model: "", provider: "" }, { admission: local });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "combo_metered_consent_required" } });
  expect(sent).toEqual([]);
});

test("a router-collapsed send keeps the consent its prepared paid destination needs when the live row becomes local", async () => {
  const cfg = config(true);
  cfg.defaultProvider = "primary";
  cfg.combos!.chain = { ...cfg.combos!.chain!, alias: "chain-model", quotaOnlyFallback: true, targets: [{ provider: "paid", model: "m" }] };
  cfg.subagentModelFallback = ["chain-model"];
  cfg.providers.paid!.requestPacing = { enabled: true, minIntervalMs: 1_500 };
  const send = () => handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }),
    cfg, { model: "", provider: "" }, { admission: local });
  noteSubagentModelFailure("primary/m", "429", cfg);
  const pacedSend = secondPacingWait("paid");
  await (await send()).text();
  const waiting = send();
  await pacingStarted(pacedSend, waiting);
  // The live row becomes a local route and the caller loses paid-call consent while the send waits.
  // A transport that keeps the prepared row would still send to the paid API.
  cfg.providers.paid = { ...cfg.providers.paid!, authMode: "local", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true };
  cfg.combos!.chain!.allowMeteredTargets = false;
  pacedSend.release();
  const refused = await waiting;
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: { code: "combo_metered_consent_required" } });
  expect(sent).toEqual(["paid"]);
});
