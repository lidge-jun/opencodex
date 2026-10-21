import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherRoutedModels as gatherRoutedModelsDirect } from "../../../src/codex/catalog";
import { clearModelCache } from "../../../src/codex/model-cache";
import { preferKiroModelSupport, preferredInitialAccount } from "../../../src/oauth/generic-account-failover";
import {
  ANTIGRAVITY_ACCOUNT_ROSTER_TTL_MS,
  antigravityAccountRosterModelIds,
  antigravityAccountSupportsModel,
  clearAntigravityAccountRosters,
  recordAntigravityAccountRoster,
} from "../../../src/providers/antigravity-account-roster";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_MODEL_EFFORTS,
  parseAntigravityAvailableModels,
  resolveAntigravityEffortWireModel,
} from "../../../src/providers/antigravity-models";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { withStubbedProviderFetch } from "../../helpers/catalog-provider-fetch";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

// Measured 2026-10-14 on live CCA: Antigravity gates Claude per account. One account lists only
// claude-sonnet-4-6 / claude-opus-4-6-thinking (every claude-*-5-5-* id answers 404), others list
// only the 5.5 suffix families. These payloads mirror those two roster shapes.
const PROVIDER = "google-antigravity";
const row = (maxTokens: number) => ({ maxTokens, supportsImages: true, supportsThinking: true });
const ROSTER_46 = {
  models: {
    "gemini-3.8-flash-low": row(1_048_576), "gemini-3.8-flash-medium": row(1_048_576), "gemini-3.8-flash-high": row(1_048_576),
    "claude-sonnet-4-6": row(250_000), "claude-opus-4-6-thinking": row(250_000),
  },
  agentModelSorts: [{ groups: [{ modelIds: [
    "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "claude-sonnet-4-6", "claude-opus-4-6-thinking",
  ] }] }],
};
const tiers = (base: string) => ["low", "medium", "high"].map(tier => `${base}-${tier}`);
const ROSTER_55 = {
  models: Object.fromEntries([
    ...tiers("gemini-3.8-flash").map(id => [id, row(1_048_576)]),
    ...tiers("gemini-4-argon").map(id => [id, row(1_048_576)]),
    ...tiers("claude-opus-5-5").map(id => [id, row(1_000_000)]),
    ...tiers("claude-sonnet-5-5").map(id => [id, row(1_000_000)]),
  ]),
  agentModelSorts: [{ groups: [{ modelIds: [
    ...tiers("gemini-3.8-flash"), ...tiers("gemini-4-argon"), ...tiers("claude-opus-5-5"), ...tiers("claude-sonnet-5-5"),
  ] }] }],
};

const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
const homes: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  clearAntigravityAccountRosters();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  for (const home of homes.splice(0)) removeTreeWithRetry(home);
});

function homeWithAccounts(accountIds: string[], activeAccountId: string): string {
  const home = mkdtempSync(join(tmpdir(), "ocx-agy-roster-"));
  homes.push(home);
  process.env.OPENCODEX_HOME = home;
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    [PROVIDER]: {
      activeAccountId,
      accounts: accountIds.map(id => ({
        id,
        credential: { access: `access-${id}`, refresh: `refresh-${id}`, expires: Date.now() + 3_600_000, projectId: "project-id" },
      })),
    },
  }));
  return home;
}

function provider(extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "google",
    authMode: "oauth",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    googleMode: "cloud-code-assist",
    project: "configured-project",
    liveModels: true,
    // The static lineup, as the registry seeds it.
    models: [...ANTIGRAVITY_MODELS],
    modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS,
    ...extra,
  } as OcxProviderConfig;
}

async function discoveredIds(payload: unknown, accountId: string): Promise<string[]> {
  homeWithAccounts([accountId], accountId);
  globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
  const models = await gatherRoutedModels({ providers: { [PROVIDER]: provider() } } as unknown as OcxConfig);
  return models.filter(model => model.provider === PROVIDER).map(model => model.id).sort();
}

describe("Antigravity exposure follows each account's own discovery", () => {
  test("a Claude 4.6 account exposes 4.6 and hides the static 5.5 and Argon rows", async () => {
    const ids = await discoveredIds(ROSTER_46, "acct-46");
    expect(ids).toEqual(["claude-opus-4-6-thinking", "claude-sonnet-4-6", "gemini-3.8-flash"]);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46", "claude-sonnet-4-6")).toBe(true);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46", "claude-opus-5-5")).toBe(false);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46", "gemini-4-argon")).toBe(false);
  });

  test("a Claude 5.5 account exposes the full 3.8 / 4 / 5.5 / 5.5 lineup and no 4.6 row", async () => {
    const ids = await discoveredIds(ROSTER_55, "acct-55");
    expect(ids).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "gemini-3.8-flash", "gemini-4-argon"]);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-55", "claude-opus-5-5")).toBe(true);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-55", "claude-opus-5-5-high")).toBe(true);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-55", "claude-sonnet-4-6")).toBe(false);
    expect(antigravityAccountRosterModelIds(PROVIDER, "acct-55")).toEqual(expect.arrayContaining(["claude-opus-5-5", "gemini-4-argon"]));
  });
});

describe("Claude 4.6 and 5.5 both map", () => {
  test("4.6 rides thinkingLevel on its single wire id", () => {
    expect(ANTIGRAVITY_MODEL_EFFORTS["claude-sonnet-4-6"]).toEqual(["low", "medium", "high", "max"]);
    expect(resolveAntigravityEffortWireModel("claude-sonnet-4-6", "high"))
      .toEqual({ wireModelId: "claude-sonnet-4-6", thinkingLevel: "high" });
    // CCA's ThinkingLevel enum tops out at high.
    expect(resolveAntigravityEffortWireModel("claude-opus-4-6-thinking", "max"))
      .toEqual({ wireModelId: "claude-opus-4-6-thinking", thinkingLevel: "high" });
  });

  test("5.5 rides its per-tier suffix wire ids, statically and from discovery", () => {
    for (const base of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      for (const effort of ["low", "medium", "high"] as const) {
        expect(resolveAntigravityEffortWireModel(base, effort)).toEqual({ wireModelId: `${base}-${effort}` });
      }
    }
    const rows = parseAntigravityAvailableModels(ROSTER_55)!;
    expect(rows.find(model => model.id === "claude-opus-5-5")?.effortWireModelIds).toEqual({
      low: "claude-opus-5-5-low", medium: "claude-opus-5-5-medium", high: "claude-opus-5-5-high",
    });
  });
});

describe("account selection prefers an account whose roster lists the model", () => {
  function recordBoth(): void {
    recordAntigravityAccountRoster(PROVIDER, "acct-46", parseAntigravityAvailableModels(ROSTER_46)!);
    recordAntigravityAccountRoster(PROVIDER, "acct-55", parseAntigravityAvailableModels(ROSTER_55)!);
  }

  test("ranking keeps listing accounts, skips known non-listing ones, and keeps unknown ones", () => {
    homeWithAccounts(["acct-46", "acct-55", "acct-new"], "acct-46");
    recordBoth();
    expect(preferKiroModelSupport(PROVIDER, ["acct-46", "acct-55"], "claude-opus-5-5")).toEqual(["acct-55"]);
    expect(preferKiroModelSupport(PROVIDER, ["acct-46", "acct-55"], "claude-sonnet-4-6")).toEqual(["acct-46"]);
    // No roster yet means unknown, never "unsupported".
    expect(preferKiroModelSupport(PROVIDER, ["acct-46", "acct-new"], "claude-opus-5-5")).toEqual(["acct-new"]);
    // Nobody lists it: fall back to every eligible account rather than refusing.
    expect(preferKiroModelSupport(PROVIDER, ["acct-46"], "claude-opus-5-5")).toEqual(["acct-46"]);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-new", "claude-opus-5-5")).toBeUndefined();
  });

  test("a stale roster is unknown", () => {
    homeWithAccounts(["acct-46"], "acct-46");
    recordAntigravityAccountRoster(PROVIDER, "acct-46", parseAntigravityAvailableModels(ROSTER_46)!,
      Date.now() - ANTIGRAVITY_ACCOUNT_ROSTER_TTL_MS - 1);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46", "claude-opus-5-5")).toBeUndefined();
  });

  test("with proactive failover on, a 5.5 request leaves a 4.6-only active account", () => {
    homeWithAccounts(["acct-46", "acct-55"], "acct-46");
    recordBoth();
    const config = { providers: { [PROVIDER]: provider({ oauthAccountFailover: { enabled: true } }) } } as unknown as OcxConfig;
    expect(preferredInitialAccount(config, PROVIDER, Date.now(), "claude-opus-5-5")).toBe("acct-55");
  });
});
