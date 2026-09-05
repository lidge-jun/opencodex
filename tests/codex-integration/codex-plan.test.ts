import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { reconcileFreshPoolAccountPlans, type FreshPoolPlanUpdate } from "../../src/codex/auth-api";
import { getMainAccountPlan, setMainAccountPlan } from "../../src/codex/main-account";
import { extractChatgptPlanType } from "../../src/codex/plan";
import {
  reconcileCodexPlansFromTokens,
  resetJwtPlanNotesForTests,
} from "../../src/codex/plan-from-token";
import { resetPreservedDiskOnlyProvidersForTests } from "../../src/usage/user-cost-overlays";
import {
  armClaudeCodeBaseline,
  loadConfig,
  readConfigDivergenceStatus,
  saveConfig,
  setResidentConfigSha256ForTests,
} from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-plan-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function chatgptPlanJwt(plan: string, accountId = "acct"): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    chatgpt_account_id: accountId,
    chatgpt_plan_type: plan,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: plan },
  })).toString("base64url");
  return `${header}.${body}.sig`;
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_CODEX_HOME, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_CODEX_HOME;
  setResidentConfigSha256ForTests(null);
  resetPreservedDiskOnlyProvidersForTests();
  setMainAccountPlan(null);
  resetJwtPlanNotesForTests();
});

afterEach(() => {
  setMainAccountPlan(null);
  resetJwtPlanNotesForTests();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

describe("extractChatgptPlanType", () => {
  test("reads the namespaced chatgpt_plan_type claim", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
    })).toString("base64url");
    expect(extractChatgptPlanType(undefined, `${header}.${body}.sig`)).toBe("pro");
  });

  test("reads a top-level chatgpt_plan_type claim", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ chatgpt_plan_type: "plus" })).toString("base64url");
    expect(extractChatgptPlanType(`${header}.${body}.sig`)).toBe("plus");
  });

  test("ignores non-JWT access tokens", () => {
    expect(extractChatgptPlanType(undefined, "access-pool-1")).toBeUndefined();
  });
});

describe("reconcileCodexPlansFromTokens", () => {
  test("persists a stale stored free plan from the live access-token JWT (#1989)", () => {
    const config: OcxConfig = {
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [{ id: "pool-jwt-plan", email: "pool@example.test", plan: "free", isMain: false }],
    };
    saveConfig(config);
    saveCodexAccountCredential("pool-jwt-plan", {
      accessToken: chatgptPlanJwt("pro", "acct-pool-jwt-plan"),
      refreshToken: "refresh-pool-jwt-plan",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-jwt-plan",
    });

    reconcileCodexPlansFromTokens(config);

    expect(config.codexAccounts?.[0]?.plan).toBe("pro");
    expect(loadConfig().codexAccounts?.[0]?.plan).toBe("pro");
  });

  test("re-anchors the resident divergence identity after adopting a JWT plan write", () => {
    const config: OcxConfig = {
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [{ id: "pool-jwt-plan", email: "pool@example.test", plan: "free", isMain: false }],
    };
    saveConfig(config);
    saveCodexAccountCredential("pool-jwt-plan", {
      accessToken: chatgptPlanJwt("pro", "acct-pool-jwt-plan"),
      refreshToken: "refresh-pool-jwt-plan",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-jwt-plan",
    });

    // The server armed its resident identity at admission and reuses the same
    // long-lived object for runtime reconciliation.
    const armed = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(armed);
    expect(readConfigDivergenceStatus().diverged).toBe(false);

    reconcileCodexPlansFromTokens(armed);

    expect(armed.codexAccounts?.[0]?.plan).toBe("pro");
    const status = readConfigDivergenceStatus();
    // The plan write was adopted into the served snapshot, so the identity must
    // follow it instead of reporting a persistent false-positive divergence.
    expect(status.diverged).toBe(false);
    expect(status.residentVersion).toBe(status.diskVersion);
  });

  test("a no-op JWT plan write keeps the resident identity in sync on noncanonical bytes", () => {
    const config: OcxConfig = {
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [{
        id: "pool-jwt-noop", email: "noop@example.test", plan: "pro",
        planSource: "jwt", planCredentialGeneration: 1, isMain: false,
      }],
    };
    saveCodexAccountCredential("pool-jwt-noop", {
      accessToken: chatgptPlanJwt("pro", "acct-pool-jwt-noop"),
      refreshToken: "refresh-pool-jwt-noop",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-jwt-noop",
    });
    // Noncanonical raw bytes: pretty-printed with a trailing newline. A re-anchor
    // to the normalized projection would fabricate a divergence for a no-op write.
    writeFileSync(join(TEST_DIR, "config.json"), JSON.stringify(config, null, 2) + "\n");
    const armed = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(armed);
    expect(readConfigDivergenceStatus().diverged).toBe(false);

    reconcileCodexPlansFromTokens(armed);

    const status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(false);
    expect(status.residentVersion).toBe(status.diskVersion);
  });

  test("leaves a non-JWT pool credential's stored plan alone", () => {
    const config: OcxConfig = {
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [{ id: "pool-plain", email: "plain@example.test", plan: "free", isMain: false }],
    };
    saveConfig(config);
    saveCodexAccountCredential("pool-plain", {
      accessToken: "access-pool-plain",
      refreshToken: "refresh-pool-plain",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-plain",
    });

    reconcileCodexPlansFromTokens(config);

    expect(config.codexAccounts?.[0]?.plan).toBe("free");
    expect(loadConfig().codexAccounts?.[0]?.plan).toBe("free");
  });
});

describe("getMainAccountPlan JWT fallback", () => {
  test("reads chatgpt_plan_type from auth.json when WHAM has not cached a plan (#1989)", () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: {
        access_token: chatgptPlanJwt("pro", "acct-main-jwt"),
        account_id: "acct-main-jwt",
      },
    }));

    expect(getMainAccountPlan()).toBe("pro");
    expect(getMainAccountPlan()).toBe("pro");
  });
});

describe("WHAM-wins plan provenance gate (release-audit fix)", () => {
  test("WHAM plan adoption re-anchors the resident config identity", () => {
    const config: OcxConfig = {
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [{
        id: "pool-wham-reanchor", email: "reanchor@example.test", plan: "pro",
        planSource: "wham", planCredentialGeneration: 1, isMain: false,
      }],
    };
    saveConfig(config);
    const armed = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(armed);
    expect(readConfigDivergenceStatus().diverged).toBe(false);
    saveCodexAccountCredential("pool-wham-reanchor", {
      accessToken: chatgptPlanJwt("plus", "acct-pool-wham-reanchor"),
      refreshToken: "refresh-pool-wham-reanchor",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-wham-reanchor",
    });
    // A WHAM refresh persists plan=plus and adopts it into the long-lived config;
    // without re-anchoring, status would keep claiming a divergence.
    const updates: FreshPoolPlanUpdate[] = [{
      accountId: "pool-wham-reanchor", plan: "plus", credentialGeneration: 1,
    }];
    reconcileFreshPoolAccountPlans(armed, updates);
    expect(armed.codexAccounts?.[0]?.plan).toBe("plus");
    const status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(false);
    expect(status.residentVersion).toBe(status.diskVersion);
  });

  test("a no-op WHAM refresh keeps the resident identity in sync on noncanonical bytes", () => {
    const config: OcxConfig = {
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [{
        id: "pool-wham-noop", email: "noop@example.test", plan: "pro",
        planSource: "wham", planCredentialGeneration: 1, isMain: false,
      }],
    };
    // Noncanonical raw bytes: pretty-printed with a trailing newline. A re-anchor
    // to the normalized projection would fabricate a divergence for a no-op write.
    writeFileSync(join(TEST_DIR, "config.json"), JSON.stringify(config, null, 2) + "\n");
    // beforeEach removed TEST_DIR, so seed the generation-1 credential the WHAM
    // freshness gate requires (matching the committed WHAM fixture setup).
    saveCodexAccountCredential("pool-wham-noop", {
      accessToken: chatgptPlanJwt("pro", "acct-pool-wham-noop"),
      refreshToken: "refresh-pool-wham-noop",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-wham-noop",
    });
    const armed = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(armed);
    expect(readConfigDivergenceStatus().diverged).toBe(false);

    // Plan and provenance already match: the WHAM refresh must stay write-free and
    // must NOT re-anchor the resident digest to the normalized projection.
    const updates: FreshPoolPlanUpdate[] = [{
      accountId: "pool-wham-noop", plan: "pro", credentialGeneration: 1,
    }];
    reconcileFreshPoolAccountPlans(armed, updates);

    const status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(false);
    expect(status.residentVersion).toBe(status.diskVersion);
  });

  test("a same-generation JWT cannot overwrite a WHAM-sourced plan", () => {
    const config: OcxConfig = {
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [{
        id: "pool-wham-fence", email: "fence@example.test", plan: "pro",
        planSource: "wham", planCredentialGeneration: 1, isMain: false,
      }],
    };
    saveConfig(config);
    saveCodexAccountCredential("pool-wham-fence", {
      accessToken: chatgptPlanJwt("plus", "acct-pool-wham-fence"),
      refreshToken: "refresh-pool-wham-fence",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-wham-fence",
    });
    // credential save above starts at generation 1 == fence generation
    reconcileCodexPlansFromTokens(config);
    expect(config.codexAccounts?.[0]?.plan).toBe("pro");
    expect(loadConfig().codexAccounts?.[0]?.plan).toBe("pro");
  });

  test("a newer-generation JWT (token refresh after the WHAM read) may write again", () => {
    const config: OcxConfig = {
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [{
        id: "pool-wham-stale", email: "stale@example.test", plan: "pro",
        planSource: "wham", planCredentialGeneration: 0, isMain: false,
      }],
    };
    saveConfig(config);
    saveCodexAccountCredential("pool-wham-stale", {
      accessToken: chatgptPlanJwt("plus", "acct-pool-wham-stale"),
      refreshToken: "refresh-pool-wham-stale",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-wham-stale",
    });
    // saved credential generation (>=1) is newer than the WHAM fence at 0
    reconcileCodexPlansFromTokens(config);
    expect(config.codexAccounts?.[0]?.plan).toBe("plus");
    const persisted = loadConfig().codexAccounts?.[0];
    expect(persisted?.plan).toBe("plus");
    expect(persisted?.planSource).toBe("jwt");
  });

  test("the gate survives a restart because provenance is persisted, not in-memory", () => {
    const config: OcxConfig = {
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [{
        id: "pool-wham-restart", email: "restart@example.test", plan: "pro",
        planSource: "wham", planCredentialGeneration: 1, isMain: false,
      }],
    };
    saveConfig(config);
    saveCodexAccountCredential("pool-wham-restart", {
      accessToken: chatgptPlanJwt("plus", "acct-pool-wham-restart"),
      refreshToken: "refresh-pool-wham-restart",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-wham-restart",
    });
    resetJwtPlanNotesForTests(); // simulate a fresh process: in-memory notes gone
    const reloaded = loadConfig(); // startup path reads persisted config
    reconcileCodexPlansFromTokens(reloaded);
    expect(loadConfig().codexAccounts?.[0]?.plan).toBe("pro");
  });
});
describe("rotated-JWT plan reconciliation across propagated aliases (#2892 gap 3)", () => {
  test("a plan-changing rotated JWT reconciles the alias, not just the refresh owner", async () => {
    const { getValidCodexToken, readCodexAccountRecord } = await import("../../src/codex/account-store");
    const oldJwt = chatgptPlanJwt("plus");
    const shared = { refreshToken: "plan-grant", expiresAt: 0, chatgptAccountId: "acct" };
    saveCodexAccountCredential("plan-owner", { accessToken: oldJwt, ...shared });
    saveCodexAccountCredential("plan-alias", { accessToken: oldJwt, ...shared });
    // Advance the alias so its generation DIVERGES from the owner's. Without this both land on the
    // same number and an assertion about the per-alias fence would pass even if the code used the
    // owner's generation — a vacuous test. Re-saving the identical credential keeps the record an
    // eligible untouched duplicate while bumping only its generation.
    saveCodexAccountCredential("plan-alias", { accessToken: oldJwt, ...shared });
    saveCodexAccountCredential("plan-alias", { accessToken: oldJwt, ...shared });
    saveConfig({
      ...loadConfig(),
      codexAccounts: [
        { id: "plan-owner", email: "owner@test", plan: "plus" },
        { id: "plan-alias", email: "alias@test", plan: "plus" },
      ],
    } as OcxConfig);

    const rotatedJwt = chatgptPlanJwt("pro");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      access_token: rotatedJwt,
      refresh_token: "plan-grant-rotated",
      expires_in: 3600,
    })) as typeof fetch;
    try {
      await getValidCodexToken("plan-owner");

      // The alias holds the rotated Pro JWT after propagation...
      const alias = readCodexAccountRecord("plan-alias")!;
      expect(alias.credential?.accessToken).toBe(rotatedJwt);

      // ...so its configured plan must be reconciled too. Reconciling only the owner left the alias
      // on "plus" while carrying a Pro credential, and its cached-token fast path never repairs
      // that, so quota scoring stayed wrong until a restart or a WHAM refresh.
      const accounts = loadConfig().codexAccounts ?? [];
      expect(accounts.find(a => a.id === "plan-owner")?.plan).toBe("pro");
      expect(accounts.find(a => a.id === "plan-alias")?.plan).toBe("pro");
      // The alias is fenced at its OWN committed generation, not the owner's.
      expect(accounts.find(a => a.id === "plan-alias")?.planCredentialGeneration).toBe(alias.generation);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
