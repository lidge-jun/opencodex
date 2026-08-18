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
