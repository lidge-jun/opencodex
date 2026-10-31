import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushConfigDirHardening } from "../../src/config/paths";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { codexAccountUnusableReason } from "../../src/codex/account-usability";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import type { CodexAuthAccountDto } from "../../src/codex/auth-api/account-list";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { clearMainAccountInfoCache } from "../../src/codex/main-account-cache";
import { setMainAccountPlan } from "../../src/codex/main-account";
import { clearAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { runPassiveRead } from "../../src/lib/passive-read";
import type { OcxConfig } from "../../src/types";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";

/**
 * Security proof for the slot identity fields on the account-list API: `slotId`, `slotKind`
 * and the opaque `upstreamAccountKey` must carry no upstream account ID, user ID, token, or the
 * local admin secret that keys the join. Every sentinel below is distinctive so a substring
 * search over the serialized response is a meaningful check.
 */
const ACCOUNT = "acct-sentinel-0f3a9d";
const USER = "user-sentinel-8c1d42";
const EMAIL = "slot-proof@example.test";
const POOL_ID = "slot-proof-pool";
const NATIVE_REFRESH = "native-refresh-sentinel-5b7e";
const POOL_REFRESH = "pool-refresh-sentinel-2e9c";
const ADMIN_TOKEN = `ocx_admin_${"Q7".repeat(21)}Z`;
const ROTATED_ADMIN_TOKEN = `ocx_admin_${"R4".repeat(21)}Y`;
const KEY_FORMAT = /^uai1_[0-9a-f]{64}$/;

let home: string;
let saved: Record<"CODEX_HOME" | "OPENCODEX_HOME" | "OPENCODEX_ADMIN_AUTH_TOKEN", string | undefined>;
let originalFetch: typeof fetch;
let config: OcxConfig;

function jwt(options: { account?: string; user?: string; label: string }): string {
  return `header.${Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...(options.account ? { chatgpt_account_id: options.account } : {}),
    "https://api.openai.com/auth": { chatgpt_plan_type: "plus", ...(options.user ? { chatgpt_user_id: options.user } : {}) },
    "https://api.openai.com/profile": { email: EMAIL },
    jti: options.label,
  })).toString("base64url")}.sig-${options.label}`;
}

function writeAdminToken(token: string): void {
  writeFileSync(join(process.env.OPENCODEX_HOME!, "admin-api-token"), `${token}\n`);
}

function writeNative(tokens: Record<string, string>): void {
  writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens }));
  reconcileMainCodexAccountRuntimeState();
}

function savePool(accessToken: string): void {
  saveCodexAccountCredential(POOL_ID, { accessToken, refreshToken: POOL_REFRESH,
    chatgptAccountId: ACCOUNT, expiresAt: Date.now() + 3_600_000 });
}

async function listOverHttp(): Promise<{ body: string; accounts: CodexAuthAccountDto[] }> {
  const url = new URL("http://localhost/api/codex-auth/accounts");
  const response = await runPassiveRead(() => handleCodexAuthAPI(new Request(url), url, config));
  expect(response?.status).toBe(200);
  const body = await response!.text();
  return { body, accounts: (JSON.parse(body) as { accounts: CodexAuthAccountDto[] }).accounts };
}

function resetRuntime(): void {
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  resetMainCodexAccountIdentityTrackingForTests();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-slot-identity-"));
  saved = { CODEX_HOME: process.env.CODEX_HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME,
    OPENCODEX_ADMIN_AUTH_TOKEN: process.env.OPENCODEX_ADMIN_AUTH_TOKEN };
  process.env.CODEX_HOME = join(home, "codex");
  process.env.OPENCODEX_HOME = join(home, "ocx");
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  mkdirSync(process.env.OPENCODEX_HOME, { recursive: true });
  originalFetch = globalThis.fetch;
  // A passive read must not probe upstream; any request here is a test failure.
  globalThis.fetch = (async () => { throw new Error("unexpected network request"); }) as unknown as typeof fetch;
  config = { port: 10100, providers: {}, defaultProvider: "openai", codexMainAccountHardLock: false,
    codexAccounts: [{ id: POOL_ID, email: EMAIL, plan: "plus", isMain: false }] };
  resetRuntime();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetRuntime();
  await drainAndRemoveFixtureRoots({
    roots: [{ path: home }],
    restoreEnvironment: () => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  }, {
    // The tracked flight belongs to the nested config directory, not its fixture root.
    settleConfigFlights: () => flushConfigDirHardening(join(home, "ocx")),
  });
});

describe("Codex account slot identity metadata", () => {
  test("the account-list response carries no upstream identifiers, tokens, or admin secret", async () => {
    writeAdminToken(ADMIN_TOKEN);
    const nativeAccess = jwt({ account: ACCOUNT, user: USER, label: "native-access" });
    const nativeId = jwt({ account: ACCOUNT, user: USER, label: "native-id" });
    const poolAccess = jwt({ account: ACCOUNT, user: USER, label: "pool-access" });
    writeNative({ access_token: nativeAccess, id_token: nativeId, refresh_token: NATIVE_REFRESH, account_id: ACCOUNT });
    savePool(poolAccess);

    const { body, accounts } = await listOverHttp();
    const main = accounts.find(row => row.id === "__main__")!;
    const pool = accounts.find(row => row.id === POOL_ID)!;
    expect(main).toMatchObject({ slotId: "__main__", slotKind: "native-main" });
    expect(pool).toMatchObject({ slotId: POOL_ID, slotKind: "pool" });
    expect(main.upstreamAccountKey).toMatch(KEY_FORMAT);
    expect(pool.upstreamAccountKey).toBe(main.upstreamAccountKey);

    const secrets = [ACCOUNT, USER, NATIVE_REFRESH, POOL_REFRESH, ADMIN_TOKEN, nativeAccess, nativeId, poolAccess,
      ...[nativeAccess, nativeId, poolAccess].flatMap(token => token.split(".").slice(1))];
    for (const secret of secrets) expect(body).not.toContain(secret);

    // The key is keyed by the local admin secret: rotating it changes every key, so a holder of
    // the identifiers alone cannot compute or confirm one.
    writeAdminToken(ROTATED_ADMIN_TOKEN);
    const rotated = await listOverHttp();
    const rotatedMain = rotated.accounts.find(row => row.id === "__main__")!;
    expect(rotatedMain.upstreamAccountKey).toMatch(KEY_FORMAT);
    expect(rotatedMain.upstreamAccountKey).not.toBe(main.upstreamAccountKey);
    expect(rotated.body).not.toContain(ROTATED_ADMIN_TOKEN);
  });

  test("a native account_id without any token account claim yields no join key", async () => {
    writeAdminToken(ADMIN_TOKEN);
    writeNative({ access_token: jwt({ user: USER, label: "native-unclaimed" }), account_id: ACCOUNT });
    savePool(jwt({ account: ACCOUNT, user: USER, label: "pool-claimed" }));

    const { accounts } = await listOverHttp();
    expect(accounts.find(row => row.id === "__main__")).toMatchObject({ slotId: "__main__", slotKind: "native-main" });
    expect(accounts.find(row => row.id === "__main__")?.upstreamAccountKey).toBeUndefined();
    expect(accounts.find(row => row.id === POOL_ID)?.upstreamAccountKey).toMatch(KEY_FORMAT);
    // The unverified account ID still guards against storing the native login as a Pool duplicate.
    expect(codexAccountUnusableReason(config, POOL_ID)).toBe("duplicate_main");
  });

  test("account and user claims split across native tokens yield no join key", async () => {
    writeAdminToken(ADMIN_TOKEN);
    // A stale or mixed token set: the ID token proves only the account, the access token only the user.
    writeNative({ id_token: jwt({ account: ACCOUNT, label: "native-id-account-only" }),
      access_token: jwt({ user: USER, label: "native-access-user-only" }), account_id: ACCOUNT });
    savePool(jwt({ account: ACCOUNT, user: USER, label: "pool-claimed" }));

    const { accounts } = await listOverHttp();
    expect(accounts.find(row => row.id === "__main__")?.upstreamAccountKey).toBeUndefined();
    expect(accounts.find(row => row.id === POOL_ID)?.upstreamAccountKey).toMatch(KEY_FORMAT);
  });

  test("one native token claiming both account and user still joins the Pool row", async () => {
    writeAdminToken(ADMIN_TOKEN);
    writeNative({ id_token: jwt({ account: ACCOUNT, user: USER, label: "native-id-bound" }),
      access_token: jwt({ user: USER, label: "native-access-user" }), account_id: ACCOUNT });
    savePool(jwt({ account: ACCOUNT, user: USER, label: "pool-claimed" }));

    const { accounts } = await listOverHttp();
    const mainKey = accounts.find(row => row.id === "__main__")?.upstreamAccountKey;
    expect(mainKey).toMatch(KEY_FORMAT);
    expect(accounts.find(row => row.id === POOL_ID)?.upstreamAccountKey).toBe(mainKey);
  });
});
