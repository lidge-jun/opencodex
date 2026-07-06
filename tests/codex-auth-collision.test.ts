import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { checkAccountIdCollision } from "../src/codex/auth-api";
import { saveConfig } from "../src/config";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-auth-collision-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_CODEX_HOME, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_CODEX_HOME;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

function seedAccount(id: string, email: string, chatgptAccountId: string, plan?: string): OcxConfig {
  const config: OcxConfig = {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccounts: [{ id, email, plan, isMain: false }],
  };
  saveConfig(config);
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId,
  });
  return config;
}

describe("codex auth account collision", () => {
  test("allows different team members that share a ChatGPT account id", async () => {
    seedAccount("team-member-a", "member-a@example.test", "shared-team-account");

    expect(checkAccountIdCollision("shared-team-account", "member-b@example.test")).toEqual({
      collision: false,
    });
  });

  test("allows the same email and account id because personal and business subscriptions can coexist", async () => {
    seedAccount("team-member-a", "member-a@example.test", "shared-team-account");

    expect(checkAccountIdCollision("shared-team-account", "MEMBER-A@example.test", "business")).toEqual({
      collision: false,
    });
  });

  test("rejects the same personal account within the personal bucket", async () => {
    seedAccount("team-member-a", "member-a@example.test", "shared-team-account");

    const result = checkAccountIdCollision("shared-team-account", "MEMBER-A@example.test");
    expect(result.collision).toBe(true);
    if (result.collision) {
      expect(result.reason).toContain("Account is already in the pool");
    }
  });

  test("rejects the same workspace account within the workspace bucket", async () => {
    seedAccount("workspace-a", "member-a@example.test", "shared-team-account", "team");

    const result = checkAccountIdCollision("shared-team-account", "MEMBER-A@example.test", "business");
    expect(result.collision).toBe(true);
    if (result.collision) {
      expect(result.reason).toContain("Account is already in the pool");
    }
  });

  test("allows pool registration matching the main Codex login account id", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "not-a-jwt",
        account_id: "main-chatgpt-account",
      },
    }));
    saveConfig({
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [],
    } as OcxConfig);

    const result = checkAccountIdCollision("main-chatgpt-account", "main@example.test", "business");
    expect(result).toEqual({ collision: false });
  });
});
