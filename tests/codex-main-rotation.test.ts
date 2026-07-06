import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearThreadAccountMap,
  clearCodexUpstreamHealth,
  formatCodexProviderForLog,
  isCodexAccountInCooldown,
  pickLowestUsageCodexAccount,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import {
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
} from "../src/codex/auth-context";
import { isCodexAccountUsable } from "../src/codex/account-usability";
import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "../src/codex/main-account";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import {
  clearAccountNeedsReauth,
  clearAccountQuota,
  markAccountNeedsReauth,
  updateAccountQuota,
} from "../src/codex/auth-api";
import type { OcxConfig } from "../src/types";

const STORE_DIR = join(import.meta.dir, ".tmp-main-rotation-store");
const CODEX_DIR = join(import.meta.dir, ".tmp-main-rotation-codex");
let prevOpencodexHome: string | undefined;
let prevCodexHome: string | undefined;

function writeMainAuth(): void {
  mkdirSync(CODEX_DIR, { recursive: true });
  writeFileSync(
    join(CODEX_DIR, "auth.json"),
    JSON.stringify({ tokens: { access_token: "main_access", account_id: "main_acct" } }),
  );
}

function saveCred(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [
      { id: "a", email: "a@test", isMain: false },
      { id: "b", email: "b@test", isMain: false },
    ],
    activeCodexAccountId: "a",
    autoSwitchThreshold: 80,
    upstreamFailoverThreshold: 3,
    ...overrides,
  } as OcxConfig;
}

describe("main account rotation (Option A)", () => {
  beforeEach(() => {
    prevOpencodexHome = process.env.OPENCODEX_HOME;
    prevCodexHome = process.env.CODEX_HOME;
    for (const d of [STORE_DIR, CODEX_DIR]) if (existsSync(d)) rmSync(d, { recursive: true });
    mkdirSync(STORE_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = STORE_DIR;
    process.env.CODEX_HOME = CODEX_DIR;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    setMainAccountPlan(null);
    for (const id of ["a", "b", MAIN_CODEX_ACCOUNT_ID]) clearAccountNeedsReauth(id);
    saveCred("a");
    saveCred("b");
    writeMainAuth();
  });

  afterEach(() => {
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    setMainAccountPlan(null);
    for (const id of ["a", "b", MAIN_CODEX_ACCOUNT_ID]) clearAccountNeedsReauth(id);
    for (const d of [STORE_DIR, CODEX_DIR]) if (existsSync(d)) rmSync(d, { recursive: true });
    if (prevOpencodexHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prevOpencodexHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
  });

  test("main account is usable when ~/.codex/auth.json token is present", () => {
    expect(isCodexAccountUsable(makeConfig(), MAIN_CODEX_ACCOUNT_ID)).toBe(true);
  });

  test("main account is not usable when auth.json is absent", () => {
    rmSync(join(CODEX_DIR, "auth.json"));
    expect(isCodexAccountUsable(makeConfig(), MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });

  test("main account is not usable when flagged needs-reauth", () => {
    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    expect(isCodexAccountUsable(makeConfig(), MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });

  test("quota auto-switch can move from a hot pool account onto the main account", () => {
    const config = makeConfig();
    updateAccountQuota("a", 90, 0);
    updateAccountQuota("b", 50, 0);
    updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 5, 0);
    expect(resolveCodexAccountForThread("thread-1", config)).toBe(MAIN_CODEX_ACCOUNT_ID);
  });

  test("pickLowestUsageCodexAccount includes main and respects excludeId", () => {
    const config = makeConfig();
    updateAccountQuota("a", 90, 0);
    updateAccountQuota("b", 50, 0);
    updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 5, 0);
    expect(pickLowestUsageCodexAccount(config)).toBe(MAIN_CODEX_ACCOUNT_ID);
    // Excluding main falls back to the lowest-usage pool account.
    expect(pickLowestUsageCodexAccount(config, MAIN_CODEX_ACCOUNT_ID)).toBe("b");
  });

  test("main is excluded from rotation candidates when its token is missing", () => {
    rmSync(join(CODEX_DIR, "auth.json"));
    const config = makeConfig();
    updateAccountQuota("a", 90, 0);
    updateAccountQuota("b", 50, 0);
    expect(pickLowestUsageCodexAccount(config)).toBe("b");
  });

  test("active __main__ resolves to an injected main-pool auth context", async () => {
    const config = makeConfig({ activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID, autoSwitchThreshold: 0, codexAccounts: [] });
    const ctx = await resolveCodexAuthContext(new Headers(), config);
    expect(ctx).toEqual({
      kind: "main-pool",
      accountId: MAIN_CODEX_ACCOUNT_ID,
      accessToken: "main_access",
      chatgptAccountId: "main_acct",
    });
    expect(isCodexAuthContextUsable(ctx, config)).toBe(true);
    const headers = headersForCodexAuthContext(new Headers(), ctx);
    expect(headers.get("authorization")).toBe("Bearer main_access");
    expect(headers.get("chatgpt-account-id")).toBe("main_acct");
  });

  test("active __main__ falls back to passthrough when the token vanishes", async () => {
    const config = makeConfig({ activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID, autoSwitchThreshold: 0, codexAccounts: [] });
    rmSync(join(CODEX_DIR, "auth.json"));
    const ctx = await resolveCodexAuthContext(new Headers(), config);
    expect(ctx).toEqual({ kind: "main", accountId: null });
  });

  test("provider log label unifies the main account with the passthrough provider", () => {
    const config = makeConfig();
    // main-pool (MAIN_CODEX_ACCOUNT_ID) and the main passthrough (null) are the same physical
    // account, so both log under the base provider name and aggregate into one usage row.
    expect(formatCodexProviderForLog("chatgpt", MAIN_CODEX_ACCOUNT_ID, config)).toBe("chatgpt");
    expect(formatCodexProviderForLog("chatgpt", null, config)).toBe("chatgpt");
  });

  test("failure failover can move from a failing pool account onto the main account", () => {
    const config = makeConfig({ autoSwitchThreshold: 0, upstreamFailoverThreshold: 3 });
    const now = 1_800_000_000_000;
    updateAccountQuota("b", 50, 0);
    updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 5, 0);
    for (let i = 0; i < 3; i++) recordCodexUpstreamOutcome(config, "a", 500, { now });
    expect(resolveCodexAccountForThread("failover-thread", config, now)).toBe(MAIN_CODEX_ACCOUNT_ID);
  });

  test("cooldown removes the main account from rotation candidates", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 90, 0);
    updateAccountQuota("b", 50, 0);
    updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 5, 0);
    expect(pickLowestUsageCodexAccount(config, undefined, now)).toBe(MAIN_CODEX_ACCOUNT_ID);
    recordCodexUpstreamOutcome(config, MAIN_CODEX_ACCOUNT_ID, 429, { retryAfter: "60", now });
    expect(isCodexAccountInCooldown(MAIN_CODEX_ACCOUNT_ID, now)).toBe(true);
    expect(pickLowestUsageCodexAccount(config, undefined, now)).toBe("b");
  });
});
