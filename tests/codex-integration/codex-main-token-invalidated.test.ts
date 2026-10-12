import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAccountNeedsReauth, clearMainAccountInfoCache, handleCodexAuthAPI, isAccountNeedsReauth, markAccountNeedsReauth,
  type CodexAuthAccountDto,
} from "../../src/codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "../../src/codex/main-account";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { isTerminalMainAuthResponse } from "../../src/codex/auth-api/main-account-probe";
import { projectCodexQuotaRefreshOutcome } from "../../src/codex/quota-refresh-outcome";
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

async function mainRow(runtimeConfig = config()): Promise<CodexAuthAccountDto | undefined> {
  const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
  const data = await (await handleCodexAuthAPI(req, new URL(req.url), runtimeConfig))!.json() as { accounts: CodexAuthAccountDto[] };
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


test("quota diagnostics expose only allowlisted terminal codes", () => {
  expect(projectCodexQuotaRefreshOutcome({ status: "http_error", httpStatus: 401,
    code: "token_invalidated", message: "private-upstream-marker" })).toEqual({
    status: "http_error", httpStatus: 401, code: "token_invalidated",
  });
  for (const code of ["private-upstream-marker", "server_error", { code: "token_invalidated" }]) {
    expect(projectCodexQuotaRefreshOutcome({ status: "http_error", httpStatus: 401, code }))
      .toEqual({ status: "http_error", httpStatus: 401 });
  }
});

test("live bare and unknown-code 401s and terminal-looking 5xx stay transient", async () => {
  for (const [status, code] of [[401, undefined], [401, "server_error"], [403, "permission_denied"],
    [503, "token_invalidated"]] as const) {
    expect(await isTerminalMainAuthResponse(Response.json({ error: { code } }, { status }), true)).toBe(false);
  }
  expect(await isTerminalMainAuthResponse(Response.json({ error: { code: "token_invalidated" } }, { status: 401 }), true)).toBe(true);
});


test("a stale main 401 cannot attribute a later credential failure while pool probes settle", async () => {
  saveCodexAccountCredential("delayed-pool", {
    accessToken: "pool-access", refreshToken: "pool-refresh",
    expiresAt: Date.now() + 3_600_000, chatgptAccountId: "pool-account",
  });
  const runtimeConfig = { ...config(), codexAccounts: [{ id: "delayed-pool", email: "pool@example.test", isMain: false }] };
  let started!: () => void;
  const poolStarted = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async (_input, init) => {
    if (new Headers(init?.headers).get("authorization") === "Bearer pool-access") {
      started();
      await gate;
      return Response.json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 10 } } });
    }
    return Response.json({ error: { code: "token_invalidated" } }, { status: 401 });
  }) as typeof fetch;
  const pending = mainRow(runtimeConfig);
  try {
    await Promise.race([poolStarted, pending.then(() => { throw new Error("Pool probe never started"); })]);
    clearMainAccountInfoCache();
    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    release();
    const row = await pending;
    expect(row).toMatchObject({ needsReauth: true, reauthReason: "refresh_failed", plan: null });
    expect(row).not.toHaveProperty("quotaRefresh");
  } finally {
    release();
    await pending;
  }
});


test.each([
  { status: 401, live: true, code: undefined, reason: "refresh_failed" },
  { status: 401, live: true, code: "server_error", reason: "refresh_failed" },
  { status: 401, live: false, code: undefined, reason: "unauthorized" },
  { status: 403, live: true, code: "invalid_workspace_selected", reason: "unauthorized" },
  { status: 403, live: true, code: "permission_denied", reason: "refresh_failed" },
])("reauth attribution follows terminal probe evidence: %j", async ({ status, live, code, reason }) => {
  writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({
    tokens: { access_token: jwtWithExp(Math.floor(Date.now() / 1000) + (live ? 3600 : -60)), account_id: "acct-main" },
  }));
  markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  globalThis.fetch = (async () => Response.json({ error: { code } }, { status })) as typeof fetch;
  const row = await mainRow();
  expect(row).toMatchObject({ needsReauth: true, reauthReason: reason,
    quotaRefresh: { status: "http_error", httpStatus: status } });
  expect(row).not.toHaveProperty("terminalAuthFailure");
});
