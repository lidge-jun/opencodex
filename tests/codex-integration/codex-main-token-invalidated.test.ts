import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAccountNeedsReauth, clearMainAccountInfoCache, handleCodexAuthAPI, isAccountNeedsReauth,
  type CodexAuthAccountDto,
} from "../../src/codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "../../src/codex/main-account";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// ChatGPT revokes every session of an account whose plan changes (Pro to Free), and the usage
// endpoint then answers 401 `token_invalidated` while the access token's `exp` is still ahead.

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const env = { home: process.env.OPENCODEX_HOME, codex: process.env.CODEX_HOME };
const previousFetch = globalThis.fetch;
let dir = "";

function jwtWithExp(exp: number): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ exp })}.sig`;
}

const config = (): OcxConfig => ({ port: 10100, providers: {}, defaultProvider: "openai", codexAccounts: [] });

async function mainRow(): Promise<CodexAuthAccountDto | undefined> {
  const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
  const data = await (await handleCodexAuthAPI(req, new URL(req.url), config()))!.json() as { accounts: CodexAuthAccountDto[] };
  return data.accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID);
}

beforeEach(() => {
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  dir = mkdtempSync(join(tmpdir(), "ocx-main-token-invalidated-"));
  const codexHome = join(dir, "codex");
  mkdirSync(codexHome, { recursive: true });
  process.env.OPENCODEX_HOME = dir;
  process.env.CODEX_HOME = codexHome;
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  resetMainCodexAccountIdentityTrackingForTests();
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
    tokens: { access_token: jwtWithExp(Math.floor(Date.now() / 1000) + 3600), account_id: "acct-main" },
  }));
});

afterEach(async () => {
  globalThis.fetch = previousFetch;
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  if (env.home === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = env.home;
  if (env.codex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = env.codex;
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  removeTreeWithRetry(dir);
});

test("a session revoked by a plan change needs sign-in, names the code and keeps the last plan", async () => {
  globalThis.fetch = (async () => Response.json({
    plan_type: "pro",
    rate_limit: { primary_window: { used_percent: 46 } },
  })) as typeof fetch;
  await mainRow();

  globalThis.fetch = (async () => Response.json({
    error: { message: "Your authentication token has been invalidated.", code: "token_invalidated" },
    status: 401,
  }, { status: 401 })) as typeof fetch;

  expect(await mainRow()).toMatchObject({
    needsReauth: true,
    reauthReason: "unauthorized",
    plan: "pro",
    quota: null,
    quotaRefresh: { status: "http_error", httpStatus: 401, code: "token_invalidated" },
  });
  expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
});
