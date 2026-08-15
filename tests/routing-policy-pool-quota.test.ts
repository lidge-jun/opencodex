import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearAccountQuota, setAccountQuotaFromParsed } from "../src/codex/quota";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "../src/codex/account-runtime-state";
import { clearCodexUpstreamHealth, recordCodexUpstreamOutcome } from "../src/codex/routing";
import { codexPoolQuotaEvidence, quotaEvidenceForCandidate } from "../src/routing/quota";
import { getDefaultConfig } from "../src/config";
import { routeModel } from "../src/router";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import { closeRequestHistoryIndex } from "../src/routing/history/indexer";

let testHome: string;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-routing-policy-quota-"));
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = testHome;
  process.env.CODEX_HOME = testHome;
  clearAccountNeedsReauth("bound");
});

afterEach(() => {
  clearAccountQuota();
  clearCodexUpstreamHealth();
  closeRequestHistoryIndex();
  clearAccountNeedsReauth("bound");
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(testHome);
});

function saveBoundCredential(): void {
  saveCodexAccountCredential("bound", {
    accessToken: "bound-access",
    refreshToken: "bound-refresh",
    expiresAt: Date.now() + 3_600_000,
    chatgptAccountId: "bound-chatgpt-account",
  });
}

describe("Codex pool quota evidence for routing policies", () => {
  test("uses the best known usable headroom instead of only one active account", () => {
    setAccountQuotaFromParsed("low", { weeklyPercent: 95 });
    setAccountQuotaFromParsed("healthy", { weeklyPercent: 20 });
    expect(codexPoolQuotaEvidence([
      { accountId: "low", plan: "plus" },
      { accountId: "healthy", plan: "plus" },
    ])).toMatchObject({ known: true, exhausted: false, headroom: 0.8, source: "codex-pool" });
  });

  test("the live policy evidence path aggregates the reconciled pool", () => {
    setAccountQuotaFromParsed("active", { weeklyPercent: 96 });
    setAccountQuotaFromParsed("alternate", { weeklyPercent: 25 });
    expect(quotaEvidenceForCandidate({
      provider: "openai",
      model: "gpt-5.6",
      codexAccountId: "active",
      codexAccountPlan: "plus",
    })).toMatchObject({ known: true, exhausted: false, headroom: 0.75, source: "codex-pool" });
  });

  test("an exact custom-model binding scores only its bound account", () => {
    setAccountQuotaFromParsed("bound", { weeklyPercent: 96 });
    setAccountQuotaFromParsed("healthy-alternate", { weeklyPercent: 25 });
    const evidence = quotaEvidenceForCandidate({
      provider: "openai",
      model: "targeted-preview",
      codexAccountId: "bound",
      codexAccountPlan: "plus",
      codexAccountScope: "exact",
    });
    expect(evidence).toMatchObject({ known: true, exhausted: false, source: "codex-pool" });
    expect(evidence.headroom).toBeCloseTo(0.04);
  });

  test("a policy excludes an orphaned exact target and selects a healthy fallback", () => {
    const config = {
      ...getDefaultConfig(),
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward" as const,
        },
      },
      codexAccounts: [],
      customModels: [{
        id: "orphaned-row",
        provider: "openai",
        modelId: "orphaned-preview",
        codexAccountTarget: "deleted-account",
      }],
      routingProfiles: {
        available: {
          candidates: [
            { provider: "openai", model: "orphaned-preview" },
            { provider: "openai", model: "gpt-5.6-sol" },
          ],
          unknownEvidence: {
            capability: "allow" as const,
            health: "allow" as const,
            quota: "allow" as const,
            cost: "allow" as const,
          },
        },
      },
    };

    const route = routeModel(config, "policy/available");
    expect(route.modelId).toBe("gpt-5.6-sol");
    expect(route.routeDecision?.candidates[0]).toMatchObject({
      eligible: false,
      exclusions: [{ code: "account-unavailable" }],
    });
    expect(route.routeDecision?.selected.candidateIndex).toBe(1);
  });

  test("a malformed exact target excludes only its candidate and keeps a healthy fallback", () => {
    const config = {
      ...getDefaultConfig(),
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          authMode: "forward" as const,
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
      },
      customModels: [{
        id: "broken",
        provider: "openai",
        modelId: "broken-target",
        codexAccountTarget: null as unknown as string,
      }],
      routingProfiles: {
        fallback: {
          candidates: [
            { provider: "openai", model: "broken-target" },
            { provider: "openai", model: "gpt-5.6-sol" },
          ],
          unknownEvidence: {
            capability: "allow" as const,
            health: "allow" as const,
            quota: "allow" as const,
            cost: "allow" as const,
          },
        },
      },
    };

    const route = routeModel(config, "policy/fallback");
    expect(route.modelId).toBe("gpt-5.6-sol");
    expect(route.routeDecision?.candidates[0]).toMatchObject({
      eligible: false,
      exclusions: [{ code: "account-unavailable" }],
    });
  });

  test("an ambiguous duplicate target excludes only its candidate and keeps a healthy fallback", () => {
    const config = {
      ...getDefaultConfig(),
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          authMode: "forward" as const,
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
      },
      customModels: [
        {
          id: "ambiguous-unbound",
          provider: "openai",
          modelId: "vendor/model",
        },
        {
          id: "ambiguous-bound",
          provider: "openai",
          modelId: "vendor-model",
          codexAccountTarget: "@main",
        },
      ],
      routingProfiles: {
        fallback: {
          candidates: [
            { provider: "openai", model: "vendor-model" },
            { provider: "openai", model: "gpt-5.6-sol" },
          ],
          unknownEvidence: {
            capability: "allow" as const,
            health: "allow" as const,
            quota: "allow" as const,
            cost: "allow" as const,
          },
        },
      },
    };

    const route = routeModel(config, "policy/fallback");
    expect(route.modelId).toBe("gpt-5.6-sol");
    expect(route.routeDecision?.candidates[0]).toMatchObject({
      eligible: false,
      exclusions: [{ code: "account-unavailable" }],
    });
  });

  test("a policy alias preserves the exact binding of an available custom target", () => {
    saveBoundCredential();
    const config = {
      ...getDefaultConfig(),
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward" as const,
        },
      },
      codexAccounts: [{ id: "bound", email: "bound@example.test", isMain: false }],
      customModels: [{
        id: "bound-row",
        provider: "openai",
        modelId: "bound-preview",
        codexAccountTarget: "bound",
      }],
      routingProfiles: {
        bound: {
          candidates: [{ provider: "openai", model: "bound-preview" }],
          unknownEvidence: {
            capability: "allow" as const,
            health: "allow" as const,
            quota: "allow" as const,
            cost: "allow" as const,
          },
        },
      },
    };

    expect(routeModel(config, "policy/bound")).toMatchObject({
      providerName: "openai",
      modelId: "bound-preview",
      codexAccountId: "bound",
      codexAccountBinding: "custom-model",
    });
  });

  for (const targetState of ["missing-credential", "paused", "needs-reauth"] as const) {
    test(`an exact target in ${targetState} state yields to a healthy policy fallback`, () => {
      if (targetState !== "missing-credential") saveBoundCredential();
      if (targetState === "needs-reauth") markAccountNeedsReauth("bound");
      const config = {
        ...getDefaultConfig(),
        defaultProvider: "openai",
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward" as const,
          },
        },
        codexAccounts: [{ id: "bound", email: "bound@example.test", isMain: false }],
        ...(targetState === "paused" ? { pausedCodexAccountIds: ["bound"] } : {}),
        customModels: [{
          id: "bound-row",
          provider: "openai",
          modelId: "bound-preview",
          codexAccountTarget: "bound",
        }],
        routingProfiles: {
          available: {
            candidates: [
              { provider: "openai", model: "bound-preview" },
              { provider: "openai", model: "gpt-5.6-sol" },
            ],
            unknownEvidence: {
              capability: "allow" as const,
              health: "allow" as const,
              quota: "allow" as const,
              cost: "allow" as const,
            },
          },
        },
      };

      const route = routeModel(config, "policy/available");
      expect(route.modelId).toBe("gpt-5.6-sol");
      expect(route.routeDecision?.candidates[0]).toMatchObject({
        eligible: false,
        exclusions: [{ code: "account-unavailable" }],
      });
      expect(route.routeDecision?.selected.candidateIndex).toBe(1);
    });
  }

  test("a policy excludes a model-scoped cooldown on an exact target", () => {
    saveBoundCredential();
    const now = Date.now();
    const config = {
      ...getDefaultConfig(),
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward" as const,
        },
      },
      codexAccounts: [{ id: "bound", email: "bound@example.test", isMain: false }],
      customModels: [{
        id: "bound-spark-row",
        provider: "openai",
        modelId: "gpt-5.3-codex-spark",
        codexAccountTarget: "bound",
      }],
      routingProfiles: {
        available: {
          candidates: [
            { provider: "openai", model: "gpt-5.3-codex-spark" },
            { provider: "openai", model: "gpt-5.6-sol" },
          ],
          unknownEvidence: {
            capability: "allow" as const,
            health: "allow" as const,
            quota: "allow" as const,
            cost: "allow" as const,
          },
        },
      },
    };
    recordCodexUpstreamOutcome(config, "bound", 429, {
      now,
      resetAt: now + 60_000,
      modelId: "gpt-5.3-codex-spark",
      fixedAccount: true,
    });

    const route = routeModel(config, "policy/available");
    expect(route.modelId).toBe("gpt-5.6-sol");
    expect(route.routeDecision?.candidates[0]).toMatchObject({
      eligible: false,
      exclusions: [{ code: "cooldown" }],
    });
    expect(route.routeDecision?.selected.candidateIndex).toBe(1);
  });

  test("reports exhausted only when every pool account is known exhausted", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 100, weeklyResetAt: Date.now() + 60_000 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 100, weeklyResetAt: Date.now() + 120_000 });
    const evidence = codexPoolQuotaEvidence([
      { accountId: "a", plan: "plus" },
      { accountId: "b", plan: "plus" },
    ]);
    expect(evidence.known).toBe(true);
    expect(evidence.exhausted).toBe(true);
    expect(evidence.headroom).toBe(0);
    expect(evidence.resetAtMs).toBeDefined();
  });

  test("does not call a partially unknown pool exhausted", () => {
    setAccountQuotaFromParsed("known-exhausted", { weeklyPercent: 100 });
    expect(codexPoolQuotaEvidence([
      { accountId: "known-exhausted", plan: "plus" },
      { accountId: "unknown", plan: "plus" },
    ])).toEqual({ known: false });
  });

  test("credits-only cached evidence stays unknown", () => {
    setAccountQuotaFromParsed("known-exhausted", { weeklyPercent: 100 });
    setAccountQuotaFromParsed("credits-only", { resetCredits: 7 });
    expect(codexPoolQuotaEvidence([
      { accountId: "known-exhausted", plan: "plus" },
      { accountId: "credits-only", plan: "plus" },
    ])).toEqual({ known: false });
  });
});
