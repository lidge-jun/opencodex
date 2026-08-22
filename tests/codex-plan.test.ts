import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { getMainAccountPlan, setMainAccountPlan } from "../src/codex/main-account";
import { extractChatgptPlanType } from "../src/codex/plan";
import {
  reconcileCodexPlansFromTokens,
  resetJwtPlanNotesForTests,
} from "../src/codex/plan-from-token";
import { loadConfig, saveConfig } from "../src/config";
import type { OcxConfig } from "../src/types";

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
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_CODEX_HOME, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_CODEX_HOME;
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
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
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

