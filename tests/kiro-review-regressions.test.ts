import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidAccessTokenSnapshot, OAUTH_PROVIDERS, runLogin } from "../src/oauth";
import { loginKiro, refreshKiroToken } from "../src/oauth/kiro";
import {
  inspectKiroCliSessionSnapshot,
  persistKiroCliSessionRecovery,
  readKiroCliSqliteCredential,
  restoreStaleKiroCliSessionRecovery,
} from "../src/oauth/kiro-credentials";
import { getAccountCredential, getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import type { OAuthController, OAuthCredentials } from "../src/oauth/types";
import type { OcxConfig } from "../src/types";

const ENV_KEYS = [
  "HOME",
  // The native kiro-cli store resolves per-platform (issue #710) and win32 prefers these over HOME,
  // so both must be isolated or a Windows runner would read the real user profile.
  "LOCALAPPDATA",
  "USERPROFILE",
  "OPENCODEX_HOME",
  "KIRO_ACCESS_TOKEN",
  "KIRO_REFRESH_TOKEN",
  "KIRO_PROFILE_ARN",
  "KIRO_REGION",
  "KIRO_API_REGION",
  "KIRO_CREDS_FILE",
  "KIRO_CREDENTIALS_FILE",
  "KIRO_CLI_DB_FILE",
  "KIROCLI_DB_PATH",
  "KIROCLI_TOKEN_KEY",
] as const;
const originalEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
let tmp: string;

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {},
  };
}

/**
 * Seeds/reads the layout the HOST resolver picks (issue #710). Mirrors
 * `resolveKiroCliNativeSessionEntries` in src/oauth/kiro-credentials.ts.
 */
function kiroCliDbDir(): string {
  if (process.platform === "win32") return join(tmp, "AppData", "Local", "Kiro-Cli");
  if (process.platform === "darwin") return join(tmp, "Library", "Application Support", "kiro-cli");
  return join(tmp, ".local", "share", "kiro-cli");
}

function kiroCliDbPath(): string {
  return join(kiroCliDbDir(), "data.sqlite3");
}

function kiroCliRecoveryPath(): string {
  return `${kiroCliDbPath()}.opencodex-recovery`;
}

function amazonQDbPath(): string {
  return join(tmp, ".local", "share", "amazon-q", "data.sqlite3");
}

function removeKiroCliDb(): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${kiroCliDbPath()}${suffix}`, { force: true });
  }
}

function seedSqliteTokenDb(
  path: string,
  access: string,
  refresh: string,
  opts: { profileArn?: string; emptyAuthKv?: boolean } = {},
): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  if (!opts.emptyAuthKv) {
    db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", [
      "kirocli:social:token",
      JSON.stringify({ access_token: access, refresh_token: refresh }),
    ]);
  }
  if (opts.profileArn) {
    db.run("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO state (key, value) VALUES (?, ?)", [
      "api.codewhisperer.profile",
      JSON.stringify({ arn: opts.profileArn }),
    ]);
  }
  db.close();
}

function seedKiroCliDb(access: string, refresh: string, opts: { profileArn?: string; emptyAuthKv?: boolean } = {}): void {
  seedSqliteTokenDb(kiroCliDbPath(), access, refresh, opts);
}

function rewriteRecoveryProcessInstance(processInstance: string): void {
  const path = kiroCliRecoveryPath();
  const payload = readFileSync(path);
  const headerEnd = payload.indexOf(0x0a);
  const ownerEnd = payload.indexOf(0x0a, headerEnd + 1);
  const instanceEnd = payload.indexOf(0x0a, ownerEnd + 1);
  if (headerEnd < 0 || ownerEnd < 0 || instanceEnd < 0) throw new Error("unexpected Kiro recovery format");
  expect(Number(payload.subarray(headerEnd + 1, ownerEnd).toString("utf8"))).toBe(process.pid);
  writeFileSync(path, Buffer.concat([
    payload.subarray(0, ownerEnd + 1),
    Buffer.from(`${processInstance}\n`, "utf8"),
    payload.subarray(instanceEnd + 1),
  ]), { mode: 0o600 });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-review-regressions-"));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = tmp;
  process.env.LOCALAPPDATA = join(tmp, "AppData", "Local");
  process.env.USERPROFILE = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "opencodex");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("Kiro review regressions", () => {
  test("environment login keeps explicit request-routing metadata without borrowing local CLI state", async () => {
    process.env.KIRO_ACCESS_TOKEN = "aoa-env";
    process.env.KIRO_REFRESH_TOKEN = "rt-env";
    process.env.KIRO_PROFILE_ARN = "arn:aws:codewhisperer:ap-southeast-2:123456789012:profile/env";
    process.env.KIRO_API_REGION = "eu-west-1";
    process.env.KIRO_REGION = "eu-central-1";

    const credential = await runLogin("kiro", {} as OAuthController, undefined, {
      loadConfig: config,
      saveConfig: () => {},
    });
    const snapshot = await getValidAccessTokenSnapshot("kiro");

    expect(credential).toMatchObject({
      access: "aoa-env",
      refresh: "rt-env",
      source: "environment",
      kiro: {
        profileArn: "arn:aws:codewhisperer:ap-southeast-2:123456789012:profile/env",
        apiRegion: "eu-west-1",
        ssoRegion: "eu-central-1",
      },
    });
    expect(snapshot).toMatchObject({
      accessToken: "aoa-env",
      kiro: {
        profileArn: "arn:aws:codewhisperer:ap-southeast-2:123456789012:profile/env",
        apiRegion: "eu-west-1",
        ssoRegion: "eu-central-1",
      },
    });
  });

  test("environment credentials refresh with KIRO_REGION instead of defaulting to us-east-1", async () => {
    process.env.KIRO_REGION = "eu-central-1";
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      return new Response(JSON.stringify({
        accessToken: "aoa-refreshed",
        refreshToken: "rt-refreshed",
        expiresIn: 3600,
      }), { status: 200 });
    }) as typeof fetch;
    try {
      const fresh = await refreshKiroToken("rt-env", undefined, {
        access: "aoa-expired",
        refresh: "rt-env",
        expires: 0,
        source: "environment",
      });
      expect(fresh.access).toBe("aoa-refreshed");
      expect(seen.some(url => url.includes("prod.eu-central-1.auth.desktop.kiro.dev"))).toBe(true);
      expect(seen.some(url => url.includes("prod.us-east-1.auth.desktop.kiro.dev"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Kiro CLI recovery rolls back auth and config persistence failures", async () => {
    await saveCredential("kiro", {
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() + 60_000,
      accountId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/old",
      email: "old@example.test",
      source: "local-cli",
    });
    const previousActive = getAccountSet("kiro")!.activeAccountId;
    const rawCredential: OAuthCredentials = {
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 60_000,
      accountId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/new",
      email: "new@example.test",
      source: "local-cli",
    };
    const events: string[] = [];
    const originalLogin = OAUTH_PROVIDERS.kiro.login;
    OAUTH_PROVIDERS.kiro.login = async () => rawCredential;
    try {
      await expect(runLogin("kiro", {} as OAuthController, { forceLogin: true }, {
        loadConfig: () => {
          events.push("load-config");
          return config();
        },
        saveConfig: () => {
          events.push("save-config");
          throw new Error("config write failed");
        },
        settleKiroLoginTransaction: (credential, persisted) => {
          expect(credential).toBe(rawCredential);
          events.push(`settle:${persisted}`);
        },
      })).rejects.toThrow("config write failed");
    } finally {
      OAUTH_PROVIDERS.kiro.login = originalLogin;
    }

    expect(events).toEqual([
      "load-config", // namespace preflight before browser/CLI auth
      "load-config", // provider validation before credential persistence
      "load-config", // latest-row upsert after credential persistence
      "save-config",
      "settle:false",
    ]);
    expect(getAccountSet("kiro")?.activeAccountId).toBe(previousActive);
    expect(getAccountSet("kiro")?.accounts).toHaveLength(1);
    expect(getAccountCredential("kiro", previousActive)).toMatchObject({
      access: "old-access",
      accountId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/old",
    });
  });

  test("forced login refuses custom import DB selectors that diverge from the CLI store", async () => {
    seedKiroCliDb("aoa-primary", "rt-primary", {
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/primary",
    });
    const custom = join(tmp, "custom-import.sqlite3");
    seedSqliteTokenDb(custom, "aoa-custom", "rt-custom", {
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/custom",
    });
    process.env.KIROCLI_DB_PATH = custom;
    const calls: string[][] = [];
    await expect(loginKiro({} as OAuthController, {
      forceLogin: true,
      cliRunner: async args => {
        calls.push(args);
        return { exitCode: 0, stdout: "" };
      },
    })).rejects.toThrow(/will not sign it out|KIROCLI_DB_PATH|KIRO_CLI_DB_FILE/);
    expect(calls).toEqual([]);
    expect(readFileSync(kiroCliDbPath()).length).toBeGreaterThan(0);
    expect(inspectKiroCliSessionSnapshot()).toMatchObject({ blocked: true, snapshot: null });
  }, { timeout: 20_000 });

  test("forced login refuses when the primary CLI store exists but only a later fallback is readable", async () => {
    mkdirSync(join(kiroCliDbPath(), ".."), { recursive: true });
    writeFileSync(kiroCliDbPath(), "not-a-sqlite-database", { mode: 0o600 });
    seedSqliteTokenDb(amazonQDbPath(), "aoa-fallback", "rt-fallback", {
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fallback",
    });
    const calls: string[][] = [];
    await expect(loginKiro({} as OAuthController, {
      forceLogin: true,
      cliRunner: async args => {
        calls.push(args);
        return { exitCode: 0, stdout: "" };
      },
    })).rejects.toThrow(/will not sign it out/);
    expect(calls).toEqual([]);
    expect(existsSync(kiroCliDbPath())).toBe(true);
    expect(readFileSync(kiroCliDbPath(), "utf8")).toBe("not-a-sqlite-database");
  });

  test("Add account binds a legacy identity-less Kiro row before switching and keeps it selectable", async () => {
    const legacyArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/legacy";
    const nextArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/next";
    seedKiroCliDb("aoa-legacy", "rt-legacy", { profileArn: legacyArn });
    await saveCredential("kiro", {
      access: "aoa-legacy",
      refresh: "rt-legacy",
      expires: Date.now() + 60_000,
      source: "local-cli",
    });
    const legacySlot = getAccountSet("kiro")!.activeAccountId;

    const credential = await loginKiro({} as OAuthController, {
      forceLogin: true,
      cliRunner: async args => {
        if (args[0] === "whoami") {
          return { exitCode: 0, stdout: JSON.stringify({ email: "legacy@example.test" }) };
        }
        if (args[0] === "logout") {
          removeKiroCliDb();
          return { exitCode: 0, stdout: "" };
        }
        if (args[0] === "login") {
          seedKiroCliDb("aoa-next", "rt-next", { profileArn: nextArn });
          return { exitCode: 0, stdout: "" };
        }
        return { exitCode: 1, stdout: "" };
      },
    });
    await saveCredential("kiro", credential, { preserveIdentityless: true });

    const set = getAccountSet("kiro")!;
    expect(set.accounts.length).toBeGreaterThanOrEqual(2);
    const legacy = getAccountCredential("kiro", legacySlot);
    expect(legacy).toMatchObject({
      accountId: legacyArn,
      refresh: "rt-legacy",
      kiro: { profileArn: legacyArn },
    });
    expect(await setActiveAccount("kiro", legacySlot)).toBe(true);
    expect(getAccountSet("kiro")?.activeAccountId).toBe(legacySlot);
  });

  test("Kiro reauth accepts the same email when the refreshed credential gains a profile ARN", async () => {
    await saveCredential("kiro", {
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() + 60_000,
      email: "same@example.test",
      source: "local-cli",
    });
    const slotId = getAccountSet("kiro")!.activeAccountId;
    const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/same";
    const originalLogin = OAUTH_PROVIDERS.kiro.login;
    OAUTH_PROVIDERS.kiro.login = async () => ({
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 60_000,
      email: "SAME@example.test",
      accountId: profileArn,
      source: "local-cli",
      kiro: { profileArn },
    });
    try {
      await runLogin("kiro", {} as OAuthController, { reauthAccountId: slotId }, {
        loadConfig: config,
        saveConfig: () => {},
      });
    } finally {
      OAUTH_PROVIDERS.kiro.login = originalLogin;
    }

    expect(getAccountSet("kiro")?.accounts).toHaveLength(1);
    expect(getAccountCredential("kiro", slotId)).toMatchObject({
      access: "new-access",
      email: "SAME@example.test",
      accountId: profileArn,
      kiro: { profileArn },
    });
  });

  test("same-PID process restart restores a stale Kiro CLI recovery transaction", () => {
    seedKiroCliDb("aoa-prior", "rt-prior");
    const snapshot = inspectKiroCliSessionSnapshot().snapshot;
    expect(snapshot).not.toBeNull();
    persistKiroCliSessionRecovery(snapshot!);

    removeKiroCliDb();
    seedKiroCliDb("aoa-abandoned", "rt-abandoned");
    rewriteRecoveryProcessInstance("restarted-process-instance");

    expect(restoreStaleKiroCliSessionRecovery()).toBe(true);
    expect(readKiroCliSqliteCredential()).toMatchObject({ access: "aoa-prior", refresh: "rt-prior" });
    expect(existsSync(kiroCliRecoveryPath())).toBe(false);
  });
});
