import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLoginStatus, getValidAccessTokenForAccount, OAUTH_PROVIDERS, refreshGenericAccountWithLock } from "../../src/oauth";
import { credentialGeneration, getAccountSet, saveAccountCredential, saveCredential, setAccountPaused } from "../../src/oauth/store";
import type { OAuthCredentials } from "../../src/oauth/types";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { collectOAuthHealthEntriesForCli, projectStoredOAuthAccountHealth } from "../../src/oauth/health";
import { collectOAuthDoctorChecks } from "../../src/cli/doctor";

const envKeys = ["OPENCODEX_HOME", "HOME", "USERPROFILE", "LOCALAPPDATA", "KIROCLI_DB_PATH", "KIRO_CLI_DB_FILE", "KIROCLI_TOKEN_KEY", "KIRO_ACCESS_TOKEN", "KIRO_CREDS_FILE", "KIRO_CREDENTIALS_FILE", "KIRO_REGION", "KIRO_PROFILE_ARN"] as const;
const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/test";
const rejection = { error: "invalid_request", error_description: "Invalid request", location: null, reason: null };
let savedEnv: Record<string, string | undefined>;
let home: string;
let originalFetch: typeof fetch;
let stored: OAuthCredentials;
let accountId: string;

beforeEach(async () => {
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  home = mkdtempSync(join(tmpdir(), "kiro-attention-"));
  for (const key of envKeys) delete process.env[key];
  process.env.OPENCODEX_HOME = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LOCALAPPDATA = home;
  process.env.KIROCLI_DB_PATH = join(home, "cli.sqlite3");
  originalFetch = globalThis.fetch;
  stored = { access: "test-access", refresh: "test-refresh", expires: Date.now() - 60_000, accountId: profileArn,
    kiro: { profileArn, ssoRegion: "us-east-1", clientId: "test-client", clientSecret: "test-secret", authType: "aws_sso_oidc" } };
  await saveCredential("kiro", stored);
  accountId = getAccountSet("kiro")!.activeAccountId;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await flushConfigDirHardeningForTests();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  removeTreeWithRetry(home);
});

function rejectRefresh(status = 400, payload: unknown = rejection): void {
  globalThis.fetch = (async () => Response.json(payload, { status })) as typeof fetch;
}
function refresh(): Promise<string> {
  return refreshGenericAccountWithLock("kiro", accountId, OAUTH_PROVIDERS.kiro, stored);
}
function seedCli(identity = profileArn, registered = true): void {
  const db = new Database(process.env.KIROCLI_DB_PATH!);
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO auth_kv VALUES (?, ?)", ["kirocli:odic:token", JSON.stringify({
    access_token: "test-cli-access", refresh_token: "test-cli-refresh", profile_arn: identity, region: "us-east-1", expires_at: "2099-01-01T00:00:00Z",
  })]);
  if (registered) db.run("INSERT INTO auth_kv VALUES (?, ?)", ["kirocli:odic:device-registration", JSON.stringify({ clientId: "cli-client", clientSecret: "cli-secret", region: "us-east-1" })]);
  db.close();
}
function assertAttention(): void {
  expect(getLoginStatus("kiro").loggedIn).toBe(false);
  expect(getLoginStatus("kiro").accounts?.[0]?.needsReauth).toBe(true);
  expect(getLoginStatus("kiro").accounts?.[0]?.needsReauthReason).toBeUndefined();
  // Status attention must never quarantine the credential from internal refresh.
  expect(getAccountSet("kiro")!.accounts[0]!.needsReauth).toBeUndefined();
}

describe("Kiro AWS SSO refresh attention", () => {
  test("exact refresh rejection projects needsReauth after expiry and persists across restart", async () => {
    const requests: unknown[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json(rejection, { status: 400 });
    }) as typeof fetch;
    await expect(refresh()).rejects.toThrow();
    expect(requests).toEqual([{ url: "https://oidc.us-east-1.amazonaws.com/token", body: {
      grantType: "refresh_token", clientId: "test-client", clientSecret: "test-secret", refreshToken: "test-refresh",
    } }]);
    assertAttention();
    const auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    expect(auth.kiro.accounts[0].refreshAttentionGeneration).toBe(credentialGeneration(stored));
    const restart = Bun.spawnSync([process.execPath, "-e", `import {getLoginStatus} from ${JSON.stringify(join(import.meta.dir, "../../src/oauth/index.ts"))}; console.log(JSON.stringify(getLoginStatus("kiro")));`], { env: process.env });
    expect(restart.exitCode).toBe(0);
    const status = JSON.parse(restart.stdout.toString());
    expect(status.loggedIn).toBe(false);
    expect(status.accounts[0].needsReauth).toBe(true);
  });

  test("still-valid access token stays logged in, then projects attention at expiry", async () => {
    stored = { ...stored, expires: Date.now() + 60_000 };
    await saveAccountCredential("kiro", accountId, stored);
    rejectRefresh();
    await expect(refresh()).rejects.toThrow();
    expect(getLoginStatus("kiro").loggedIn).toBe(true);
    expect(getLoginStatus("kiro").accounts?.[0]?.needsReauth).toBeUndefined();
    const originalNow = Date.now;
    Date.now = () => stored.expires + 1;
    try { assertAttention(); } finally { Date.now = originalNow; }
  });

  test("desktop malformed-request rejection does not set attention or quarantine", async () => {
    stored = { ...stored, kiro: { profileArn, authType: "kiro_desktop" } };
    await saveAccountCredential("kiro", accountId, stored);
    rejectRefresh();
    await expect(refresh()).rejects.toThrow();
    expect(getLoginStatus("kiro").loggedIn).toBe(true);
    expect(getLoginStatus("kiro").accounts?.[0]?.needsReauth).toBeUndefined();
    expect(getAccountSet("kiro")!.accounts[0]!.needsReauth).toBeUndefined();
  });

  for (const [label, status, payload] of [
    ["5xx", 503, rejection], ["different input error", 400, { error: "invalid_client" }],
    ["unallowlisted error text", 400, { error: "invalid_request arbitrary-secret-text" }],
  ] as const) {
    test(`${label} does not flag attention`, async () => {
      rejectRefresh(status, payload);
      await expect(refresh()).rejects.toThrow();
      expect(getLoginStatus("kiro").loggedIn).toBe(true);
      expect(getLoginStatus("kiro").accounts?.[0]?.needsReauth).toBeUndefined();
    });
  }
  test("network failure does not flag attention", async () => {
    globalThis.fetch = (async () => { throw new Error("network unavailable"); }) as typeof fetch;
    await expect(refresh()).rejects.toThrow();
    expect(getLoginStatus("kiro").loggedIn).toBe(true);
  });

  test("matching rotated CLI recovery succeeds before recording attention", async () => {
    seedCli();
    const tokens: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const token = JSON.parse(String(init?.body)).refreshToken;
      tokens.push(token);
      return token === stored.refresh ? Response.json(rejection, { status: 400 })
        : Response.json({ accessToken: "recovered-access", refreshToken: "recovered-refresh", expiresIn: 3600 });
    }) as typeof fetch;
    expect(await refresh()).toBe("recovered-access");
    expect(tokens).toEqual(["test-refresh", "test-cli-refresh"]);
    expect(getLoginStatus("kiro").loggedIn).toBe(true);
    expect(getLoginStatus("kiro").accounts?.[0]?.needsReauth).toBeUndefined();
  });

  test("failed matching CLI recovery records attention only after both attempts", async () => {
    seedCli();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json(rejection, { status: 400 }); }) as typeof fetch;
    await expect(refresh()).rejects.toThrow();
    expect(calls).toBe(2);
    assertAttention();
  });
  test("failed matching desktop CLI recovery preserves the original SSO evidence", async () => {
    seedCli(profileArn, false);
    const urls: string[] = [];
    globalThis.fetch = (async input => { urls.push(String(input)); return Response.json(rejection, { status: 400 }); }) as typeof fetch;
    await expect(refresh()).rejects.toThrow();
    expect(urls).toEqual(["https://oidc.us-east-1.amazonaws.com/token", "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"]);
    assertAttention();
  });
  test("transient matching CLI recovery failure does not flag attention", async () => {
    seedCli();
    let calls = 0;
    globalThis.fetch = (async () => Response.json(rejection, { status: ++calls === 1 ? 400 : 503 })) as typeof fetch;
    await expect(refresh()).rejects.toThrow();
    expect(calls).toBe(2);
    expect(getLoginStatus("kiro").loggedIn).toBe(true);
    expect(getLoginStatus("kiro").accounts?.[0]?.needsReauth).toBeUndefined();
  });
  test("terminal grant rejection retains the existing internal quarantine", async () => {
    rejectRefresh(400, { error: "invalid_grant" });
    await expect(refresh()).rejects.toThrow();
    expect(getAccountSet("kiro")!.accounts[0]!.needsReauth).toBe(true);
    expect(getLoginStatus("kiro").loggedIn).toBe(false);
  });

  test("unrelated CLI account is never adopted", async () => {
    seedCli("arn:aws:codewhisperer:us-east-1:123456789012:profile/other");
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json(rejection, { status: 400 }); }) as typeof fetch;
    await expect(refresh()).rejects.toThrow();
    expect(calls).toBe(1);
    assertAttention();
  });

  test("late rejection cannot mark a replacement credential", async () => {
    let dispatch!: () => void;
    const dispatched = new Promise<void>(resolve => { dispatch = resolve; });
    let reject!: (response: Response) => void;
    globalThis.fetch = (() => { dispatch(); return new Promise<Response>(resolve => { reject = resolve; }); }) as typeof fetch;
    const attempt = refresh();
    await dispatched;
    await saveAccountCredential("kiro", accountId, { ...stored, access: "replacement-access", refresh: "replacement-refresh", expires: Date.now() + 3600_000 });
    reject(Response.json(rejection, { status: 400 }));
    await expect(attempt).rejects.toThrow();
    expect(getLoginStatus("kiro").loggedIn).toBe(true);
    expect(getLoginStatus("kiro").accounts?.[0]?.needsReauth).toBeUndefined();
    expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).kiro.accounts[0].refreshAttentionGeneration).toBeUndefined();
  });

  test("successful subsequent refresh stays eligible and clears durable evidence", async () => {
    rejectRefresh();
    await expect(refresh()).rejects.toThrow();
    assertAttention();
    globalThis.fetch = (async () => Response.json({ accessToken: "recovered-access", refreshToken: "recovered-refresh", expiresIn: 3600 })) as typeof fetch;
    expect(await getValidAccessTokenForAccount("kiro", accountId)).toBe("recovered-access");
    expect(getLoginStatus("kiro").loggedIn).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).kiro.accounts[0].refreshAttentionGeneration).toBeUndefined();
  });
  test("explicit replacement clears evidence even for identical tokens", async () => {
    rejectRefresh();
    await expect(refresh()).rejects.toThrow();
    assertAttention();
    await saveCredential("kiro", stored);
    expect(getLoginStatus("kiro").loggedIn).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).kiro.accounts[0].refreshAttentionGeneration).toBeUndefined();
  });
  test("operator pause committed during refresh is preserved", async () => {
    globalThis.fetch = (async () => {
      await setAccountPaused("kiro", accountId, true);
      return Response.json(rejection, { status: 400 });
    }) as typeof fetch;
    await expect(refresh()).rejects.toThrow();
    expect(getAccountSet("kiro")!.accounts[0]!.paused).toBe(true);
    expect(getLoginStatus("kiro").accounts?.[0]?.needsReauth).toBeUndefined();
  });

  test("canonical health honors the supplied time at the attention expiry boundary", async () => {
    rejectRefresh();
    await expect(refresh()).rejects.toThrow();
    const account = getAccountSet("kiro")!.accounts[0]!;
    expect(projectStoredOAuthAccountHealth("kiro", account, stored.expires - 1, { observeOnly: true }))
      .toEqual({ status: "healthy" });
    expect(projectStoredOAuthAccountHealth("kiro", account, stored.expires, { observeOnly: true }))
      .toEqual({ status: "reauth_required", reason: "refresh_failed" });
    expect(account.needsReauth).toBeUndefined();
  });

  test("canonical health ignores stale attention generations and other providers", async () => {
    rejectRefresh();
    await expect(refresh()).rejects.toThrow();
    const account = getAccountSet("kiro")!.accounts[0]!;
    expect(projectStoredOAuthAccountHealth("kiro", {
      ...account, credential: { ...account.credential, access: "replacement-access" },
    }, stored.expires, { observeOnly: true })).toEqual({ status: "healthy" });
    expect(projectStoredOAuthAccountHealth("xai", account, stored.expires, { observeOnly: true }))
      .toEqual({ status: "healthy" });
  });

  test("collected CLI health and doctor warn at attention expiry without mutating quarantine", async () => {
    rejectRefresh();
    await expect(refresh()).rejects.toThrow();
    const authPath = join(home, "auth.json");
    const before = readFileSync(authPath, "utf8");
    const deps = { findLiveProxyImpl: async () => null };
    const valid = await collectOAuthHealthEntriesForCli(stored.expires - 1, deps);
    expect(valid.entries.find(entry => entry.provider === "kiro")?.health).toEqual({ status: "healthy" });
    const validChecks = await collectOAuthDoctorChecks(stored.expires - 1, deps);
    expect(validChecks.some(check => check.level === "WARN" && check.message.includes("kiro"))).toBe(false);
    const expired = await collectOAuthHealthEntriesForCli(stored.expires, deps);
    expect(expired.entries.find(entry => entry.provider === "kiro")).toEqual({
      provider: "kiro", accountId, health: { status: "reauth_required", reason: "refresh_failed" },
      action: "run `ocx login kiro`",
    });
    const checks = await collectOAuthDoctorChecks(stored.expires, deps);
    const warning = checks.find(check => check.level === "WARN" && check.message.includes("kiro"));
    expect(warning?.message).toContain("requires reauthentication");
    expect(warning?.message).toContain("ocx login kiro");
    expect(warning?.message).not.toContain(accountId);
    for (const secret of ["test-access", "test-refresh", "test-secret", "refreshAttentionGeneration", credentialGeneration(stored)]) {
      expect(JSON.stringify({ expired, checks })).not.toContain(secret);
    }
    expect(readFileSync(authPath, "utf8")).toBe(before);
    expect(getAccountSet("kiro")!.accounts[0]!.needsReauth).toBeUndefined();
  });

  test.each(["status", "accounts"])("management %s API exposes attention without internal evidence or secrets", async endpoint => {
    rejectRefresh();
    await expect(refresh()).rejects.toThrow();
    const request = new ManagementRequest(`http://localhost/api/oauth/${endpoint}?provider=kiro`);
    const config = { port: 0, defaultProvider: "kiro", providers: {} } as OcxConfig;
    const response = await handleManagementAPI(request, new URL(request.url), config);
    expect(response?.status).toBe(200);
    const body = await response!.json();
    if (endpoint === "status") expect(body.loggedIn).toBe(false);
    expect(body.accounts[0].needsReauth).toBe(true);
    if (endpoint === "accounts") {
      expect(body.accounts[0].health).toEqual({ status: "reauth_required", reason: "refresh_failed" });
      expect(body.accounts[0].healthLabel).toBe("Refresh failed");
      expect(body.accounts[0].healthAction).toBe("run `ocx login kiro`");
      expect(body.accounts[0].healthSummary).toContain("reauthentication required");
    }
    for (const value of ["test-access", "test-refresh", "test-secret", "test-client", "refreshAttentionGeneration", credentialGeneration(stored)]) {
      expect(JSON.stringify(body)).not.toContain(value);
    }
  });
});
