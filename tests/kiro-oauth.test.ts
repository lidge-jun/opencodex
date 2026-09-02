import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAUTH_PROVIDERS, runLogin } from "../src/oauth";
import { inspectKiroCliSqlite, kiroCliInstallGuidance, loginKiro, readKiroCliSqlite, refreshKiroToken, resolveKiroApiRegion, resolveKiroProfileArn, resolveKiroRegion, settleKiroLoginTransaction } from "../src/oauth/kiro";
import { removeTreeWithRetry } from "./helpers/remove-tree";

// Windows CI cold runners take 5-7s for the real SQLite create/inspect cycles here
// (same flake class as 810fa115); the default 5s harness timeout is too tight.
setDefaultTimeout(30_000);

const origHome = process.env.HOME;
const origLocalAppData = process.env.LOCALAPPDATA;
const origUserProfile = process.env.USERPROFILE;
const origEnvTok = process.env.KIRO_ACCESS_TOKEN;
const origArn = process.env.KIRO_PROFILE_ARN;
const origRegion = process.env.KIRO_REGION;
const origApiRegion = process.env.KIRO_API_REGION;
const origCredsFile = process.env.KIRO_CREDS_FILE;
const origCredentialsFile = process.env.KIRO_CREDENTIALS_FILE;
const origCliDbFile = process.env.KIRO_CLI_DB_FILE;
const origCliDbPath = process.env.KIROCLI_DB_PATH;
const origCliTokenKey = process.env.KIROCLI_TOKEN_KEY;
const origFetch = globalThis.fetch;
const warnSpies: Array<ReturnType<typeof spyOn>> = [];
let tmp: string;

function silenceWarn(): ReturnType<typeof spyOn> {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  warnSpies.push(warning);
  return warning;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-oauth-"));
  process.env.HOME = tmp;
  // The native-store resolver is per-platform (issue #710), and on win32 it prefers
  // LOCALAPPDATA/USERPROFILE over HOME — so HOME alone no longer isolates a Windows runner from its
  // real profile. Point both at the temp dir for the duration of each test.
  process.env.LOCALAPPDATA = join(tmp, "AppData", "Local");
  process.env.USERPROFILE = tmp;
  delete process.env.KIRO_ACCESS_TOKEN;
  delete process.env.KIRO_PROFILE_ARN;
  delete process.env.KIRO_REGION;
  delete process.env.KIRO_API_REGION;
  delete process.env.KIRO_CREDS_FILE;
  delete process.env.KIRO_CREDENTIALS_FILE;
  delete process.env.KIRO_CLI_DB_FILE;
  delete process.env.KIROCLI_DB_PATH;
  delete process.env.KIROCLI_TOKEN_KEY;
});
afterEach(() => {
  for (const warning of warnSpies.splice(0)) warning.mockRestore();
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = origLocalAppData;
  if (origUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserProfile;
  if (origEnvTok === undefined) delete process.env.KIRO_ACCESS_TOKEN;
  else process.env.KIRO_ACCESS_TOKEN = origEnvTok;
  if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN;
  else process.env.KIRO_PROFILE_ARN = origArn;
  if (origRegion === undefined) delete process.env.KIRO_REGION;
  else process.env.KIRO_REGION = origRegion;
  if (origApiRegion === undefined) delete process.env.KIRO_API_REGION;
  else process.env.KIRO_API_REGION = origApiRegion;
  if (origCredsFile === undefined) delete process.env.KIRO_CREDS_FILE;
  else process.env.KIRO_CREDS_FILE = origCredsFile;
  if (origCredentialsFile === undefined) delete process.env.KIRO_CREDENTIALS_FILE;
  else process.env.KIRO_CREDENTIALS_FILE = origCredentialsFile;
  if (origCliDbFile === undefined) delete process.env.KIRO_CLI_DB_FILE;
  else process.env.KIRO_CLI_DB_FILE = origCliDbFile;
  if (origCliDbPath === undefined) delete process.env.KIROCLI_DB_PATH;
  else process.env.KIROCLI_DB_PATH = origCliDbPath;
  if (origCliTokenKey === undefined) delete process.env.KIROCLI_TOKEN_KEY;
  else process.env.KIROCLI_TOKEN_KEY = origCliTokenKey;
  globalThis.fetch = origFetch;
  removeTreeWithRetry(tmp);
});

/**
 * The native kiro-cli store is resolved per-platform (issue #710), so fixtures must seed the layout
 * the HOST resolves. Mirrors `resolveKiroCliNativeSessionEntries` in src/oauth/kiro-credentials.ts.
 */
function kiroCliDbDir(): string {
  if (process.platform === "win32") return join(tmp, "AppData", "Local", "Kiro-Cli");
  if (process.platform === "darwin") return join(tmp, "Library", "Application Support", "kiro-cli");
  return join(tmp, ".local", "share", "kiro-cli");
}

// The native-store diagnostic label is per-platform (#710 added the win32/linux variants), so
// these expectations must follow the host the suite runs on. Hardcoding the darwin label made
// every inspectKiroCliSqlite case fail on Linux and Windows CI while passing on macOS (#718).
function kiroCliDbLocation(): "kiro-cli-windows-data" | "kiro-cli-data" | "kiro-cli-linux-data" {
  if (process.platform === "win32") return "kiro-cli-windows-data";
  if (process.platform === "darwin") return "kiro-cli-data";
  return "kiro-cli-linux-data";
}

function seedKiroCliDb(
  token: { access_token: string; refresh_token?: string; expires_at?: string; profile_arn?: string; region?: string },
  opts: { registration?: Record<string, unknown>; stateArn?: string } = {},
) {
  const dir = kiroCliDbDir();
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.sqlite3"));
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", ["kirocli:social:token", JSON.stringify(token)]);
  if (opts.registration) {
    db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", ["kirocli:odic:device-registration", JSON.stringify(opts.registration)]);
  }
  if (opts.stateArn) {
    db.run("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO state (key, value) VALUES (?, ?)", ["api.codewhisperer.profile", JSON.stringify({ arn: opts.stateArn })]);
  }
  db.close();
}

function seedKiroCliRawValue(value: string) {
  const dir = kiroCliDbDir();
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.sqlite3"));
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", ["kirocli:social:token", value]);
  db.close();
}

function removeKiroCliDb(): void {
  const path = kiroCliDbPath();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

function kiroCliDbPath(): string {
  return join(kiroCliDbDir(), "data.sqlite3");
}

function kiroCliRecoveryPath(): string {
  return `${kiroCliDbPath()}.opencodex-recovery`;
}

function rewriteKiroCliRecoveryOwner(ownerPid: number): void {
  const path = kiroCliRecoveryPath();
  const payload = readFileSync(path);
  const firstLineEnd = payload.indexOf(0x0a);
  const ownerLineEnd = payload.indexOf(0x0a, firstLineEnd + 1);
  writeFileSync(path, Buffer.concat([
    payload.subarray(0, firstLineEnd + 1),
    Buffer.from(`${ownerPid}\n`, "utf8"),
    payload.subarray(ownerLineEnd + 1),
  ]), { mode: 0o600 });
}

function seedCustomTokenDb(path: string, rows: Array<[string, Record<string, unknown>]>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  for (const [key, value] of rows) db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", [key, JSON.stringify(value)]);
  db.close();
}

describe("kiro oauth — import-first", () => {
  test("Kiro CLI install guidance uses PowerShell on Windows and keeps the Unix command elsewhere", () => {
    expect(kiroCliInstallGuidance("win32")).toContain("irm 'https://cli.kiro.dev/install.ps1' | iex");
    expect(kiroCliInstallGuidance("win32")).not.toContain("curl -fsSL https://cli.kiro.dev/install | bash");
    expect(kiroCliInstallGuidance("darwin")).toContain("curl -fsSL https://cli.kiro.dev/install | bash");
  });

  test("readKiroCliSqlite imports access+refresh from auth_kv", () => {
    seedKiroCliDb({ access_token: "aoa-abc", refresh_token: "rt-1", expires_at: "2099-01-01T00:00:00Z" });
    const t = readKiroCliSqlite();
    expect(t?.access).toBe("aoa-abc");
    expect(t?.refresh).toBe("rt-1");
    expect(t?.expires).toBe(new Date("2099-01-01T00:00:00Z").getTime());
  });

  test("KIROCLI_DB_PATH selects a nonstandard read-only database without creating missing paths", () => {
    const path = join(tmp, "custom", "credentials.sqlite3");
    seedCustomTokenDb(path, [["kirocli:social:token", { access_token: "aoa-custom", refresh_token: "rt-custom" }]]);
    process.env.KIROCLI_DB_PATH = path;
    expect(readKiroCliSqlite()?.access).toBe("aoa-custom");

    const missing = join(tmp, "missing", "credentials.sqlite3");
    seedKiroCliDb({ access_token: "aoa-default-must-not-win", refresh_token: "rt-default" });
    process.env.KIROCLI_DB_PATH = missing;
    expect(readKiroCliSqlite()).toBeNull();
    expect(existsSync(missing)).toBe(false);
  });

  test("known token rows are preferred deterministically and KIROCLI_TOKEN_KEY overrides them", () => {
    const path = join(tmp, "selection", "credentials.sqlite3");
    seedCustomTokenDb(path, [
      ["kirocli:social:token", { access_token: "aoa-social", refresh_token: "rt-social" }],
      ["kirocli:odic:token", { access_token: "aoa-oidc", refresh_token: "rt-oidc" }],
    ]);
    process.env.KIROCLI_DB_PATH = path;
    expect(readKiroCliSqlite()?.access).toBe("aoa-oidc");
    process.env.KIROCLI_TOKEN_KEY = "kirocli:social:token";
    expect(readKiroCliSqlite()?.access).toBe("aoa-social");
  });

  test("otherwise ambiguous token rows require explicit selection without leaking paths or secrets", () => {
    const path = join(tmp, "ambiguous", "credentials.sqlite3");
    seedCustomTokenDb(path, [
      ["custom:a:token", { access_token: "aoa-secret-a", refresh_token: "rt-a" }],
      ["custom:b:token", { access_token: "aoa-secret-b", refresh_token: "rt-b" }],
    ]);
    process.env.KIROCLI_DB_PATH = path;
    expect(() => readKiroCliSqlite()).toThrow("set KIROCLI_TOKEN_KEY to select one");
    try {
      readKiroCliSqlite();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(tmp);
      expect(message).not.toContain("aoa-secret");
    }
  });

  test("loginKiro returns imported SQLite credentials", async () => {
    seedKiroCliDb({ access_token: "aoa-xyz", refresh_token: "rt-2" });
    const cred = await loginKiro({}, { cliRunner: async () => ({ exitCode: 1, stdout: "" }) });
    expect(cred.access).toBe("aoa-xyz");
    expect(cred.refresh).toBe("rt-2");
    expect(cred.source).toBe("local-cli");
  });

  test("force login switches Kiro CLI identity and imports a distinct account", async () => {
    const calls: string[][] = [];
    const auth: Array<{ url: string; instructions?: string }> = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "login") {
        seedKiroCliDb({
          access_token: "aoa-second",
          refresh_token: "rt-second",
          expires_at: "2099-01-01T00:00:00Z",
          region: "eu-west-1",
        });
      }
      if (args[0] === "whoami") return { exitCode: 0, stdout: JSON.stringify({ email: "Second@Example.com" }) };
      return { exitCode: 0, stdout: "" };
    };

    const cred = await loginKiro({ onAuth: info => auth.push(info) }, { forceLogin: true, cliRunner: runner });

    expect(calls).toEqual([
      ["logout"],
      ["login"],
      ["whoami", "--format", "json"],
    ]);
    expect(auth).toEqual([expect.objectContaining({ url: "", instructions: expect.stringContaining("fresh browser login") })]);
    expect(cred).toMatchObject({
      access: "aoa-second",
      refresh: "rt-second",
      email: "second@example.com",
      source: "local-cli",
      kiro: { ssoRegion: "eu-west-1" },
    });
  });

  test("force login imports only the newly authenticated CLI account, not a configured credential file", async () => {
    const file = join(tmp, "old-account.json");
    writeFileSync(file, JSON.stringify({
      accessToken: "aoa-old-json",
      refreshToken: "rt-old-json",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/old",
    }));
    process.env.KIRO_CREDS_FILE = file;
    const runner = async (args: string[]) => {
      if (args[0] === "login") {
        seedKiroCliDb({
          access_token: "aoa-new-cli",
          refresh_token: "rt-new-cli",
          profile_arn: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/new",
        });
      }
      if (args[0] === "whoami") return { exitCode: 0, stdout: JSON.stringify({ email: "new@example.com" }) };
      return { exitCode: 0, stdout: "" };
    };

    const cred = await loginKiro({}, { forceLogin: true, cliRunner: runner });

    expect(cred.access).toBe("aoa-new-cli");
    expect(cred.refresh).toBe("rt-new-cli");
    expect(cred.accountId).toBe("arn:aws:codewhisperer:eu-west-1:123456789012:profile/new");
    expect(cred.email).toBe("new@example.com");
    expect(cred.source).toBe("local-cli");
  });

  test("force login durably records the prior session before logout and deletes it after successful settlement", async () => {
    seedKiroCliDb({ access_token: "aoa-prior", refresh_token: "rt-prior" });
    let recoveryExistedBeforeLogout = false;
    let recoveryModeBeforeLogout: number | undefined;
    const runner = async (args: string[]) => {
      if (args[0] === "logout") {
        recoveryExistedBeforeLogout = existsSync(kiroCliRecoveryPath());
        recoveryModeBeforeLogout = statSync(kiroCliRecoveryPath()).mode & 0o777;
        removeKiroCliDb();
      }
      if (args[0] === "login") {
        seedKiroCliDb({
          access_token: "aoa-new",
          refresh_token: "rt-new",
          profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/new",
        });
      }
      if (args[0] === "whoami") return { exitCode: 0, stdout: JSON.stringify({ email: "new@example.com" }) };
      return { exitCode: 0, stdout: "" };
    };

    const pending = await loginKiro({}, { forceLogin: true, cliRunner: runner });

    expect(recoveryExistedBeforeLogout).toBe(true);
    if (process.platform !== "win32") expect(recoveryModeBeforeLogout).toBe(0o600);
    expect(existsSync(kiroCliRecoveryPath())).toBe(true);
    settleKiroLoginTransaction(pending, true);
    expect(existsSync(kiroCliRecoveryPath())).toBe(false);
    expect(readKiroCliSqlite()?.access).toBe("aoa-new");
  });

  test("force login refuses to log out when a present CLI session cannot be snapshotted", async () => {
    const dir = kiroCliDbDir();
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "data.sqlite3"));
    db.run("CREATE TABLE other_table (key TEXT PRIMARY KEY, value TEXT)");
    db.close();
    const calls: string[][] = [];

    await expect(loginKiro({}, {
      forceLogin: true,
      cliRunner: async (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stdout: "" };
      },
    })).rejects.toThrow(/could not be backed up/i);

    expect(calls).toEqual([]);
    expect(existsSync(kiroCliRecoveryPath())).toBe(false);
    expect(existsSync(join(dir, "data.sqlite3"))).toBe(true);
  });

  test("force login still proceeds when no CLI session exists at all", async () => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "login") {
        seedKiroCliDb({
          access_token: "aoa-first",
          refresh_token: "rt-first",
          profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/first",
        });
      }
      if (args[0] === "whoami") return { exitCode: 0, stdout: JSON.stringify({ email: "first@example.com" }) };
      return { exitCode: 0, stdout: "" };
    };

    const cred = await loginKiro({}, { forceLogin: true, cliRunner: runner });

    expect(calls[0]).toEqual(["logout"]);
    expect(cred.access).toBe("aoa-first");
    expect(existsSync(kiroCliRecoveryPath())).toBe(false);
  });

  test("next ordinary login restores stale crash recovery before importing SQLite", async () => {
    seedKiroCliDb({ access_token: "aoa-prior", refresh_token: "rt-prior" });
    const firstRunner = async (args: string[]) => {
      if (args[0] === "logout") removeKiroCliDb();
      if (args[0] === "login") {
        seedKiroCliDb({
          access_token: "aoa-abandoned",
          refresh_token: "rt-abandoned",
          profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/abandoned",
        });
      }
      if (args[0] === "whoami") {
        for (const suffix of ["-wal", "-shm", "-journal"]) writeFileSync(`${kiroCliDbPath()}${suffix}`, `abandoned${suffix}`);
        return { exitCode: 0, stdout: JSON.stringify({ email: "abandoned@example.com" }) };
      }
      return { exitCode: 0, stdout: "" };
    };

    const abandoned = await loginKiro({}, { forceLogin: true, cliRunner: firstRunner });
    expect(abandoned.access).toBe("aoa-abandoned");
    expect(existsSync(kiroCliRecoveryPath())).toBe(true);
    const liveTransactionFiles = ["", "-wal", "-shm", "-journal", ".opencodex-recovery"]
      .map(suffix => readFileSync(`${kiroCliDbPath()}${suffix}`));

    let liveOwnerRunnerCalled = false;
    const liveOwnerFailure = await loginKiro({}, {
      cliRunner: async () => {
        liveOwnerRunnerCalled = true;
        return { exitCode: 0, stdout: "" };
      },
    }).catch((error: unknown) => error);
    expect(liveOwnerFailure).toBeInstanceOf(Error);
    expect((liveOwnerFailure as Error).message).toContain("still in progress");
    expect((liveOwnerFailure as Error).message).toContain(`pid ${process.pid}`);
    expect((liveOwnerFailure as Error).message).toContain(kiroCliRecoveryPath());
    expect(liveOwnerRunnerCalled).toBe(false);
    expect(existsSync(kiroCliRecoveryPath())).toBe(true);
    expect(["", "-wal", "-shm", "-journal", ".opencodex-recovery"]
      .map((suffix, index) => readFileSync(`${kiroCliDbPath()}${suffix}`).equals(liveTransactionFiles[index]!)))
      .toEqual([true, true, true, true, true]);

    const exitedOwner = Bun.spawn([process.execPath, "-e", ""]);
    await exitedOwner.exited;
    rewriteKiroCliRecoveryOwner(exitedOwner.pid);

    // This call stands in for a fresh process: it deliberately never settles or otherwise uses
    // the in-memory transaction above. Ordinary import must recover the stale transaction first.
    const calls: string[][] = [];
    const secondRunner = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "whoami") return { exitCode: 0, stdout: JSON.stringify({ email: "prior@example.com" }) };
      throw new Error(`unexpected Kiro CLI command: ${args[0]}`);
    };

    const restored = await loginKiro({}, { cliRunner: secondRunner });

    expect(restored).toMatchObject({ access: "aoa-prior", refresh: "rt-prior", email: "prior@example.com" });
    expect(calls).toEqual([["whoami", "--format", "json"]]);
    expect(["-wal", "-shm", "-journal"].map(suffix => existsSync(`${kiroCliDbPath()}${suffix}`))).toEqual([false, false, false]);
    expect(readKiroCliSqlite()).toMatchObject({ access: "aoa-prior", refresh: "rt-prior" });
    expect(existsSync(kiroCliRecoveryPath())).toBe(false);
  });

  test("whoami supplies a valid profileArn when the SQLite import lacks one (#993)", async () => {
    const arn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCD1234";
    seedKiroCliDb({ access_token: "aoa-builder", refresh_token: "rt-builder" });
    const runner = async (args: string[]) => {
      if (args[0] === "whoami") {
        return { exitCode: 0, stdout: JSON.stringify({ email: "builder@example.com", profileArn: arn }) };
      }
      throw new Error(`unexpected Kiro CLI command: ${args[0]}`);
    };

    const cred = await loginKiro({}, { cliRunner: runner });

    expect(cred).toMatchObject({
      access: "aoa-builder",
      accountId: arn,
      kiro: { profileArn: arn },
    });
  });

  test("a nested profile.arn shape is accepted (#993)", async () => {
    const arn = "arn:aws:codewhisperer:eu-west-1:123456789012:profile/XY-99";
    seedKiroCliDb({ access_token: "aoa-nested", refresh_token: "rt-nested" });
    const nestedRunner = async (args: string[]) => {
      if (args[0] === "whoami") return { exitCode: 0, stdout: JSON.stringify({ profile: { arn } }) };
      throw new Error("unexpected");
    };
    const nested = await loginKiro({}, { cliRunner: nestedRunner });
    expect(nested.accountId).toBe(arn);
  });

  test("a malformed whoami ARN is ignored without breaking the login (#993)", async () => {
    seedKiroCliDb({ access_token: "aoa-bad", refresh_token: "rt-bad" });
    const badRunner = async (args: string[]) => {
      if (args[0] === "whoami") {
        return { exitCode: 0, stdout: JSON.stringify({ profileArn: "not-an-arn", email: "bad@example.com" }) };
      }
      throw new Error("unexpected");
    };
    const bad = await loginKiro({}, { cliRunner: badRunner });
    // Malformed ARN: login still succeeds for ungated models, but no ARN is borrowed.
    expect(bad.accountId).toBeUndefined();
    expect(bad.kiro?.profileArn).toBeUndefined();
  });

  test("an imported SQLite profileArn stays authoritative over whoami (#993)", async () => {
    const sqliteArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/SQLITE";
    const whoamiArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/WHOAMI";
    seedKiroCliDb({ access_token: "aoa-both", refresh_token: "rt-both", profile_arn: sqliteArn });
    const runner = async (args: string[]) => {
      if (args[0] === "whoami") return { exitCode: 0, stdout: JSON.stringify({ profileArn: whoamiArn }) };
      throw new Error("unexpected");
    };
    const cred = await loginKiro({}, { cliRunner: runner });
    expect(cred.accountId).toBe(sqliteArn);
  });

  test("a session switch between the SQLite read and whoami discards whoami's ARN (#993)", async () => {
    const arnB = "arn:aws:codewhisperer:us-east-1:123456789012:profile/OTHER-ACCOUNT";
    seedKiroCliDb({ access_token: "aoa-accountA", refresh_token: "rt-accountA" });
    const runner = async (args: string[]) => {
      if (args[0] === "whoami") {
        // Another process switches the active CLI session mid-flight.
        removeKiroCliDb();
        seedKiroCliDb({ access_token: "aoa-accountB", refresh_token: "rt-accountB" });
        return { exitCode: 0, stdout: JSON.stringify({ email: "b@example.com", profileArn: arnB }) };
      }
      throw new Error("unexpected");
    };
    const cred = await loginKiro({}, { cliRunner: runner });
    // Account A's token must never carry account B's ARN.
    expect(cred.accountId).toBeUndefined();
    expect(cred.kiro?.profileArn).toBeUndefined();
  });

  test("the discarded whoami identity takes the email with it, not just the ARN (#993)", async () => {
    // Review finding: asserting only that the ARN is absent also passes against
    // pre-fix code, which ignored whoami's ARN entirely. The email is the part
    // that pre-fix code WOULD have kept, so it is the assertion that actually
    // proves the mismatch path clears the whole identity.
    const arnB = "arn:aws:codewhisperer:us-east-1:123456789012:profile/OTHER-ACCOUNT";
    seedKiroCliDb({ access_token: "aoa-accountA", refresh_token: "rt-accountA" });
    const runner = async (args: string[]) => {
      if (args[0] === "whoami") {
        removeKiroCliDb();
        seedKiroCliDb({ access_token: "aoa-accountB", refresh_token: "rt-accountB" });
        return { exitCode: 0, stdout: JSON.stringify({ email: "b@example.com", profileArn: arnB }) };
      }
      throw new Error("unexpected");
    };
    const cred = await loginKiro({}, { cliRunner: runner });
    expect(cred.email).toBeUndefined();
    expect(cred.kiro?.profileArn).toBeUndefined();
  });

  test("with no refresh token the access token is the revalidation key (#993)", async () => {
    // The implementation falls back to the access token when refresh is absent.
    // Without this case that branch is unexercised in either direction.
    const arn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/BUILDER";
    seedKiroCliDb({ access_token: "aoa-only" });
    const runner = async (args: string[]) => {
      if (args[0] === "whoami") {
        return { exitCode: 0, stdout: JSON.stringify({ email: "a@example.com", profileArn: arn }) };
      }
      throw new Error("unexpected");
    };
    const cred = await loginKiro({}, { cliRunner: runner });
    expect(cred.kiro?.profileArn).toBe(arn);
  });

  test("an access-token-only session that changes under whoami is rejected (#993)", async () => {
    const arnB = "arn:aws:codewhisperer:us-east-1:123456789012:profile/OTHER-ACCOUNT";
    seedKiroCliDb({ access_token: "aoa-accountA" });
    const runner = async (args: string[]) => {
      if (args[0] === "whoami") {
        removeKiroCliDb();
        seedKiroCliDb({ access_token: "aoa-accountB" });
        return { exitCode: 0, stdout: JSON.stringify({ email: "b@example.com", profileArn: arnB }) };
      }
      throw new Error("unexpected");
    };
    const cred = await loginKiro({}, { cliRunner: runner });
    expect(cred.kiro?.profileArn).toBeUndefined();
    expect(cred.email).toBeUndefined();
  });

  test("invalid recovery data names the file the operator must remove", async () => {
    seedKiroCliDb({ access_token: "aoa-prior", refresh_token: "rt-prior" });
    writeFileSync(kiroCliRecoveryPath(), "not a recovery database", { mode: 0o600 });
    let runnerCalled = false;

    const failure = await loginKiro({}, {
      cliRunner: async () => {
        runnerCalled = true;
        return { exitCode: 0, stdout: "" };
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("recovery data is invalid");
    expect((failure as Error).message).toContain(kiroCliRecoveryPath());
    expect((failure as Error).message).toContain("Remove this file to continue");
    expect(runnerCalled).toBe(false);
    expect(readKiroCliSqlite()).toMatchObject({ access: "aoa-prior", refresh: "rt-prior" });
    expect(existsSync(kiroCliRecoveryPath())).toBe(true);
  });

  test("force login cancellation during browser login restores the prior Kiro CLI session", async () => {
    seedKiroCliDb({ access_token: "aoa-prior", refresh_token: "rt-prior" });
    const controller = new AbortController();
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "logout") {
        removeKiroCliDb();
      }
      if (args[0] === "login") {
        controller.abort();
      }
      return { exitCode: 0, stdout: "" };
    };

    await expect(loginKiro({ signal: controller.signal }, { forceLogin: true, cliRunner: runner })).rejects.toThrow(/cancelled/i);
    expect(calls).toEqual([["logout"], ["login"]]);
    expect(readKiroCliSqlite()).toMatchObject({ access: "aoa-prior", refresh: "rt-prior" });
    expect(existsSync(kiroCliRecoveryPath())).toBe(false);
  });

  test("force login callback failure restores the prior Kiro CLI session", async () => {
    seedKiroCliDb({ access_token: "aoa-prior", refresh_token: "rt-prior" });
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "logout") removeKiroCliDb();
      return { exitCode: args[0] === "login" ? 1 : 0, stdout: "" };
    };

    await expect(loginKiro({}, { forceLogin: true, cliRunner: runner })).rejects.toThrow(/did not complete successfully/i);

    expect(calls).toEqual([["logout"], ["login"]]);
    expect(readKiroCliSqlite()).toMatchObject({ access: "aoa-prior", refresh: "rt-prior" });
    expect(existsSync(kiroCliRecoveryPath())).toBe(false);
  });

  test("credential persistence failure restores the prior Kiro CLI session", async () => {
    seedKiroCliDb({ access_token: "aoa-prior", refresh_token: "rt-prior" });
    const runner = async (args: string[]) => {
      if (args[0] === "logout") removeKiroCliDb();
      if (args[0] === "login") {
        seedKiroCliDb({
          access_token: "aoa-new",
          refresh_token: "rt-new",
          profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/new",
        });
      }
      if (args[0] === "whoami") return { exitCode: 0, stdout: JSON.stringify({ email: "new@example.com" }) };
      return { exitCode: 0, stdout: "" };
    };
    const pending = await loginKiro({}, { forceLogin: true, cliRunner: runner });
    expect(readKiroCliSqlite()?.access).toBe("aoa-new");

    const originalLogin = OAUTH_PROVIDERS.kiro.login;
    OAUTH_PROVIDERS.kiro.login = async () => pending;
    try {
      await expect(runLogin("kiro", {}, { forceLogin: true }, {
        saveCredential: async () => { throw new Error("simulated credential persistence failure"); },
      })).rejects.toThrow("simulated credential persistence failure");
    } finally {
      OAUTH_PROVIDERS.kiro.login = originalLogin;
    }

    expect(readKiroCliSqlite()).toMatchObject({ access: "aoa-prior", refresh: "rt-prior" });
    expect(existsSync(kiroCliRecoveryPath())).toBe(false);
  });

  test("loginKiro imports JSON credentials and resolver metadata", async () => {
    const file = join(tmp, "kiro-creds.json");
    writeFileSync(file, JSON.stringify({
      accessToken: "aoa-json",
      refreshToken: "rt-json",
      expiresAt: "2099-01-01T00:00:00Z",
      profileArn: "arn:aws:codewhisperer:ap-northeast-1:123456789012:profile/demo",
      region: "us-west-2",
      apiRegion: "eu-central-1",
    }));
    process.env.KIRO_CREDS_FILE = file;

    const cred = await loginKiro({});

    expect(cred.access).toBe("aoa-json");
    expect(cred.refresh).toBe("rt-json");
    expect(cred.source).toBe("credential-file");
    expect(cred.accountId).toBe("arn:aws:codewhisperer:ap-northeast-1:123456789012:profile/demo");
    expect(cred.kiro).toMatchObject({
      profileArn: "arn:aws:codewhisperer:ap-northeast-1:123456789012:profile/demo",
      ssoRegion: "us-west-2",
      apiRegion: "eu-central-1",
    });
    expect(resolveKiroProfileArn()).toBe("arn:aws:codewhisperer:ap-northeast-1:123456789012:profile/demo");
    expect(resolveKiroRegion()).toBe("us-west-2");
    expect(resolveKiroApiRegion()).toBe("eu-central-1");
  });

  test("malformed imported expiry with a refresh token is warned and treated as expired", async () => {
    const warning = silenceWarn();
    const file = join(tmp, "kiro-malformed-refresh-expiry.json");
    writeFileSync(file, JSON.stringify({
      accessToken: "aoa-json",
      refreshToken: "rt-json",
      expiresAt: "not-a-date",
    }));
    process.env.KIRO_CREDS_FILE = file;

    const cred = await loginKiro({});

    expect(cred.refresh).toBe("rt-json");
    expect(cred.expires).toBe(0);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(warning.mock.calls[0]?.[0])).toContain("credential expiry is present but unparseable");
  });

  test("malformed imported expiry without a refresh token is warned and receives the default TTL", async () => {
    const warning = silenceWarn();
    const file = join(tmp, "kiro-malformed-access-only-expiry.json");
    writeFileSync(file, JSON.stringify({ accessToken: "aoa-json", expiresAt: "not-a-date" }));
    process.env.KIRO_CREDS_FILE = file;
    const before = Date.now();

    const cred = await loginKiro({});

    expect(cred.refresh).toBe("");
    expect(cred.expires).toBeGreaterThanOrEqual(before + 3600_000);
    expect(cred.expires).toBeLessThanOrEqual(Date.now() + 3600_000);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(warning.mock.calls[0]?.[0])).toContain("no refresh token is available");
  });

  test("missing imported expiry receives the default TTL without warning", async () => {
    const warning = silenceWarn();
    const file = join(tmp, "kiro-missing-expiry.json");
    writeFileSync(file, JSON.stringify({ accessToken: "aoa-json", refreshToken: "rt-json" }));
    process.env.KIRO_CREDS_FILE = file;
    const before = Date.now();

    const cred = await loginKiro({});

    expect(cred.expires).toBeGreaterThanOrEqual(before + 3600_000);
    expect(cred.expires).toBeLessThanOrEqual(Date.now() + 3600_000);
    expect(warning).not.toHaveBeenCalled();
  });

  test("loginKiro falls back to KIRO_ACCESS_TOKEN env when no SQLite token", async () => {
    process.env.KIRO_ACCESS_TOKEN = "aoa-env";
    const cred = await loginKiro({});
    expect(cred.access).toBe("aoa-env");
    expect(cred.source).toBe("environment");
  });

  test("loginKiro uses manual paste (CLI) when no SQLite/env token", async () => {
    const cred = await loginKiro({ onManualCodeInput: async () => "  aoa-pasted  " });
    expect(cred.access).toBe("aoa-pasted");
    expect(cred.source).toBe("manual");
  });

  test("loginKiro throws (not hangs) in GUI with no token and no manual input", async () => {
    await expect(loginKiro({})).rejects.toThrow(/no token found/i);
    await expect(loginKiro({})).rejects.toThrow(/cli\.kiro\.dev\/install/);
  });

  test("loginKiro instructions name the Kiro CLI install prerequisite", async () => {
    let instructions: string | undefined;
    let progress: string | undefined;
    await loginKiro({
      onAuth: ({ instructions: text }) => {
        instructions = text;
      },
      onProgress: message => {
        progress = message;
      },
      onManualCodeInput: async () => "aoa-pasted",
    });
    expect(instructions).toContain("cli.kiro.dev/install");
    expect(instructions).toContain("kiro-cli login");
    expect(progress).toContain("kiro-cli");
  });

  test("inspectKiroCliSqlite reports safe diagnostics without token values", () => {
    seedKiroCliDb({ access_token: "aoa-diagnostic-secret", refresh_token: "rt-diagnostic-secret" });

    const result = inspectKiroCliSqlite();
    const rendered = JSON.stringify(result.diagnostics);

    expect(result.token?.access).toBe("aoa-diagnostic-secret");
    expect(result.diagnostics).toContainEqual({ location: kiroCliDbLocation(), status: "token_found" });
    expect(rendered).not.toContain("aoa-diagnostic-secret");
    expect(rendered).not.toContain("rt-diagnostic-secret");
    expect(rendered).not.toContain(tmp);
  });

  test("inspectKiroCliSqlite distinguishes schema mismatch from no token", () => {
    const dir = kiroCliDbDir();
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "data.sqlite3"));
    db.run("CREATE TABLE other_table (key TEXT PRIMARY KEY, value TEXT)");
    db.close();

    const result = inspectKiroCliSqlite();

    expect(result.token).toBeNull();
    expect(result.diagnostics).toContainEqual({ location: kiroCliDbLocation(), status: "schema_mismatch" });
    expect(result.diagnostics).toContainEqual({ location: "kiro-sso-cache", status: "missing" });
  });

  test("inspectKiroCliSqlite distinguishes token_missing and invalid_json", () => {
    seedKiroCliRawValue(JSON.stringify({ refresh_token: "rt-without-access" }));

    const missing = inspectKiroCliSqlite();

    expect(missing.token).toBeNull();
    expect(missing.diagnostics).toContainEqual({ location: kiroCliDbLocation(), status: "token_missing" });

    // Drop the seeded database before re-seeding. This has to follow the platform: removing only
    // `Library` left the Linux store at `.local/share` in place, so the second seed hit
    // "table auth_kv already exists" and the case failed on ubuntu CI while passing on macOS (#718).
    removeTreeWithRetry(kiroCliDbDir());
    seedKiroCliRawValue("{not json");

    const invalid = inspectKiroCliSqlite();

    expect(invalid.token).toBeNull();
    expect(invalid.diagnostics).toContainEqual({ location: kiroCliDbLocation(), status: "invalid_json" });
  });

  test("inspectKiroCliSqlite distinguishes unreadable database path", () => {
    const dir = kiroCliDbDir();
    mkdirSync(join(dir, "data.sqlite3"), { recursive: true });

    const result = inspectKiroCliSqlite();

    expect(result.token).toBeNull();
    expect(result.diagnostics).toContainEqual({ location: kiroCliDbLocation(), status: "unreadable" });
  });

  test("SQLite import reads device registration and state profile region without leaking diagnostics", () => {
    const arn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/demo";
    seedKiroCliDb(
      { access_token: "aoa-sqlite", refresh_token: "rt-sqlite", region: "ap-southeast-2" },
      { registration: { client_id: "cid-sqlite", client_secret: "secret-sqlite", region: "us-west-2" }, stateArn: arn },
    );

    const result = inspectKiroCliSqlite();
    const rendered = JSON.stringify(result.diagnostics);

    expect(result.token?.access).toBe("aoa-sqlite");
    expect(result.diagnostics).toContainEqual({ location: kiroCliDbLocation(), status: "registration_found" });
    expect(resolveKiroProfileArn()).toBe(arn);
    expect(resolveKiroRegion()).toBe("ap-southeast-2");
    expect(resolveKiroApiRegion()).toBe("eu-central-1");
    expect(rendered).not.toContain("secret-sqlite");
    expect(rendered).not.toContain(arn);
    expect(rendered).not.toContain(tmp);
  });

  test("enterprise clientIdHash JSON credentials load AWS SSO device registration", async () => {
    const file = join(tmp, "kiro-enterprise.json");
    const cacheDir = join(tmp, ".aws", "sso", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "hash123.json"), JSON.stringify({ clientId: "cid-hash", clientSecret: "secret-hash" }));
    writeFileSync(file, JSON.stringify({
      accessToken: "aoa-enterprise",
      refreshToken: "rt-enterprise",
      clientIdHash: "hash123",
      region: "us-east-2",
    }));
    process.env.KIRO_CREDS_FILE = file;
    let captured: { url: string; body: Record<string, unknown> } | undefined;
    globalThis.fetch = (async (input, init) => {
      captured = { url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return new Response(JSON.stringify({ accessToken: "aoa-new", refreshToken: "rt-new", expiresIn: 60 }), { status: 200 });
    }) as typeof fetch;

    const cred = await refreshKiroToken("rt-enterprise");

    expect(cred.access).toBe("aoa-new");
    expect(captured?.url).toBe("https://oidc.us-east-2.amazonaws.com/token");
    expect(captured?.body).toEqual({
      grantType: "refresh_token",
      clientId: "cid-hash",
      clientSecret: "secret-hash",
      refreshToken: "rt-enterprise",
    });
  });

  test("enterprise clientIdHash traversal is ignored outside the AWS SSO cache directory", async () => {
    const file = join(tmp, "kiro-enterprise-traversal.json");
    const cacheDir = join(tmp, ".aws", "sso", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(tmp, ".aws", "sso", "escaped.json"), JSON.stringify({
      clientId: "escaped-client",
      clientSecret: "escaped-secret",
      region: "ap-south-1",
    }));
    writeFileSync(file, JSON.stringify({
      accessToken: "aoa-enterprise",
      refreshToken: "rt-enterprise",
      clientIdHash: "../escaped",
      region: "us-east-2",
    }));
    process.env.KIRO_CREDS_FILE = file;
    let capturedUrl = "";
    globalThis.fetch = (async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ accessToken: "aoa-new", refreshToken: "rt-new", expiresIn: 60 }), { status: 200 });
    }) as typeof fetch;

    const cred = await refreshKiroToken("rt-enterprise");

    expect(cred.access).toBe("aoa-new");
    expect(capturedUrl).toBe("https://prod.us-east-2.auth.desktop.kiro.dev/refreshToken");
  });

  test("refreshKiroToken uses AWS SSO OIDC JSON payload when client credentials exist", async () => {
    const file = join(tmp, "kiro-oidc.json");
    writeFileSync(file, JSON.stringify({
      accessToken: "aoa-old",
      refreshToken: "rt-old",
      region: "ap-southeast-1",
      clientId: "cid",
      clientSecret: "secret",
    }));
    process.env.KIRO_CREDS_FILE = file;
    let captured: { url: string; contentType?: string; body: Record<string, unknown> } | undefined;
    globalThis.fetch = (async (input, init) => {
      captured = {
        url: String(input),
        contentType: (init?.headers as Record<string, string>)?.["Content-Type"],
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(JSON.stringify({ accessToken: "aoa-oidc", refreshToken: "rt-oidc", expiresIn: 60 }), { status: 200 });
    }) as typeof fetch;

    const cred = await refreshKiroToken("rt-old");

    expect(cred.access).toBe("aoa-oidc");
    expect(captured?.url).toBe("https://oidc.ap-southeast-1.amazonaws.com/token");
    expect(captured?.contentType).toBe("application/json");
    expect(captured?.body).toEqual({
      grantType: "refresh_token",
      clientId: "cid",
      clientSecret: "secret",
      refreshToken: "rt-old",
    });
  });

  test("refreshKiroToken uses stored account metadata instead of another local Kiro session", async () => {
    const file = join(tmp, "other-local-account.json");
    writeFileSync(file, JSON.stringify({
      accessToken: "aoa-other",
      refreshToken: "rt-other",
      region: "ap-southeast-1",
      clientId: "other-client",
      clientSecret: "other-secret",
    }));
    process.env.KIRO_CREDS_FILE = file;
    let captured: { url: string; body: Record<string, unknown> } | undefined;
    globalThis.fetch = (async (input, init) => {
      captured = { url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return new Response(JSON.stringify({ accessToken: "aoa-stored-new", expiresIn: 60 }), { status: 200 });
    }) as typeof fetch;

    await refreshKiroToken("rt-stored", undefined, {
      access: "aoa-stored",
      refresh: "rt-stored",
      expires: 0,
      accountId: "profile-stored",
      kiro: {
        profileArn: "profile-stored",
        ssoRegion: "eu-west-1",
        clientId: "stored-client",
        clientSecret: "stored-secret",
      },
    });

    expect(captured?.url).toBe("https://oidc.eu-west-1.amazonaws.com/token");
    expect(captured?.body).toMatchObject({
      clientId: "stored-client",
      clientSecret: "stored-secret",
      refreshToken: "rt-stored",
    });
  });

  test("legacy stored credential without kiro metadata does not borrow the local CLI region", async () => {
    // A legacy OCX account predates account-scoped metadata. The local CLI is signed into a
    // different account in another region; refresh must not route through that region.
    seedKiroCliDb({
      access_token: "aoa-other-cli",
      refresh_token: "rt-other-cli",
      region: "ap-southeast-1",
      profile_arn: "arn:aws:codewhisperer:ap-southeast-1:123456789012:profile/other",
    });
    let captured: string | undefined;
    globalThis.fetch = (async (input) => {
      captured = String(input);
      return new Response(JSON.stringify({ accessToken: "aoa-legacy-new", expiresIn: 60 }), { status: 200 });
    }) as typeof fetch;

    const cred = await refreshKiroToken("rt-legacy", undefined, {
      access: "aoa-legacy",
      refresh: "rt-legacy",
      expires: 0,
    });

    expect(captured).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken");
    expect(captured).not.toContain("ap-southeast-1");
    expect(cred.access).toBe("aoa-legacy-new");
  });

  test("legacy stored credential ignores KIRO_REGION set for a different local account", async () => {
    process.env.KIRO_REGION = "eu-central-1";
    let captured: string | undefined;
    globalThis.fetch = (async (input) => {
      captured = String(input);
      return new Response(JSON.stringify({ accessToken: "aoa-scoped-new", expiresIn: 60 }), { status: 200 });
    }) as typeof fetch;

    await refreshKiroToken("rt-legacy", undefined, {
      access: "aoa-legacy",
      refresh: "rt-legacy",
      expires: 0,
    });

    expect(captured).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken");

    // A truly accountless refresh keeps the documented env fallback.
    await refreshKiroToken("rt-accountless");
    expect(captured).toBe("https://prod.eu-central-1.auth.desktop.kiro.dev/refreshToken");
  });

  test("stored refresh metadata does not inspect an unrelated ambiguous local CLI store", async () => {
    const path = join(tmp, "ambiguous-refresh", "credentials.sqlite3");
    seedCustomTokenDb(path, [
      ["custom:a:token", { access_token: "aoa-a", refresh_token: "rt-a" }],
      ["custom:b:token", { access_token: "aoa-b", refresh_token: "rt-b" }],
    ]);
    process.env.KIROCLI_DB_PATH = path;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accessToken: "aoa-stored-new", expiresIn: 60 }), { status: 200 })) as typeof fetch;

    await expect(refreshKiroToken("rt-stored", undefined, {
      access: "aoa-stored",
      refresh: "rt-stored",
      expires: 0,
      kiro: {
        ssoRegion: "eu-west-1",
        clientId: "stored-client",
        clientSecret: "stored-secret",
      },
    })).resolves.toMatchObject({ access: "aoa-stored-new", refresh: "rt-stored" });
  });

  test("refreshKiroToken retries a rotated local refresh only for the same profile", async () => {
    const profileArn = "arn:aws:codewhisperer:eu-west-1:123456789012:profile/same";
    seedKiroCliDb({
      access_token: "aoa-local-new",
      refresh_token: "rt-local-new",
      profile_arn: profileArn,
      region: "eu-west-1",
    });
    const refreshRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      refreshRequests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (refreshRequests.length === 1) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(JSON.stringify({ accessToken: "aoa-recovered", expiresIn: 60 }), { status: 200 });
    }) as typeof fetch;

    const fresh = await refreshKiroToken("rt-stored-old", undefined, {
      access: "aoa-stored-old",
      refresh: "rt-stored-old",
      expires: 0,
      accountId: profileArn,
      source: "local-cli",
      kiro: {
        profileArn,
        ssoRegion: "eu-west-1",
        clientId: "stale-client",
        clientSecret: "stale-secret",
      },
    });

    expect(refreshRequests).toEqual([
      {
        url: "https://oidc.eu-west-1.amazonaws.com/token",
        body: {
          grantType: "refresh_token",
          clientId: "stale-client",
          clientSecret: "stale-secret",
          refreshToken: "rt-stored-old",
        },
      },
      {
        url: "https://prod.eu-west-1.auth.desktop.kiro.dev/refreshToken",
        body: { refreshToken: "rt-local-new" },
      },
    ]);
    expect(fresh).toMatchObject({ access: "aoa-recovered", refresh: "rt-local-new", kiro: { profileArn } });
    expect(fresh.kiro?.clientId).toBeUndefined();
    expect(fresh.kiro?.clientSecret).toBeUndefined();
  });

  test("refreshKiroToken never retries a rotated local refresh from another profile", async () => {
    seedKiroCliDb({
      access_token: "aoa-other",
      refresh_token: "rt-other-new",
      profile_arn: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/other",
      region: "eu-west-1",
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as typeof fetch;

    await expect(refreshKiroToken("rt-stored-old", undefined, {
      access: "aoa-stored-old",
      refresh: "rt-stored-old",
      expires: 0,
      accountId: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/stored",
      source: "local-cli",
      kiro: {
        profileArn: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/stored",
        ssoRegion: "eu-west-1",
      },
    })).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

  test("refreshKiroToken rejects conflicting stored profile identities before local recovery", async () => {
    const localProfile = "arn:aws:codewhisperer:eu-west-1:123456789012:profile/local";
    seedKiroCliDb({
      access_token: "aoa-local",
      refresh_token: "rt-local-new",
      profile_arn: localProfile,
      region: "eu-west-1",
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as typeof fetch;

    await expect(refreshKiroToken("rt-stored-old", undefined, {
      access: "aoa-stored-old",
      refresh: "rt-stored-old",
      expires: 0,
      accountId: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/different",
      source: "local-cli",
      kiro: { profileArn: localProfile, ssoRegion: "eu-west-1" },
    })).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

  test("refreshKiroToken composes caller cancellation with its request timeout", async () => {
    const controller = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout");
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ accessToken: "aoa-new", expiresIn: 60 }), { status: 200 });
    }) as typeof fetch;

    try {
      await refreshKiroToken("rt-old", controller.signal, {
        access: "aoa-old",
        refresh: "rt-old",
        expires: 0,
        kiro: { ssoRegion: "us-east-1" },
      });
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(requestSignal).not.toBe(controller.signal);
      expect(requestSignal?.aborted).toBe(false);
      controller.abort();
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  test("refreshKiroToken maps the desktop refresh response to credentials", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accessToken: "aoa-new", refreshToken: "rt-new", expiresIn: 1000 }), {
        status: 200,
      })) as typeof fetch;
    const before = Date.now();
    const cred = await refreshKiroToken("rt-old");
    expect(cred.access).toBe("aoa-new");
    expect(cred.refresh).toBe("rt-new");
    expect(cred.expires).toBeGreaterThanOrEqual(before + 1000 * 1000 - 50);
  });

  test("refreshKiroToken keeps old refresh token when server omits it", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accessToken: "aoa-new2", expiresIn: 60 }), { status: 200 })) as typeof fetch;
    const cred = await refreshKiroToken("rt-keep");
    expect(cred.refresh).toBe("rt-keep");
  });

  test("refreshKiroToken throws without a refresh token", async () => {
    await expect(refreshKiroToken("")).rejects.toThrow(/no refresh token/i);
  });
});

describe("kiro oauth — adapter-time resolvers (profileArn / region)", () => {
  test("account-scoped resolution never borrows another local Kiro identity", () => {
    const file = join(tmp, "local-other-account.json");
    writeFileSync(file, JSON.stringify({
      accessToken: "aoa-other",
      refreshToken: "rt-other",
      profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/other",
      region: "eu-central-1",
    }));
    process.env.KIRO_CREDS_FILE = file;

    expect(resolveKiroProfileArn({})).toBeUndefined();
    expect(resolveKiroRegion({})).toBe("us-east-1");
    expect(resolveKiroApiRegion({})).toBe("us-east-1");
  });

  test("account-scoped resolution is not overridden by another account's environment metadata", () => {
    process.env.KIRO_PROFILE_ARN = "arn:environment-account";
    process.env.KIRO_REGION = "ap-southeast-1";
    process.env.KIRO_API_REGION = "ap-northeast-1";
    const account = {
      profileArn: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/account-b",
      ssoRegion: "eu-west-1",
      apiRegion: "eu-central-1",
    };

    expect(resolveKiroProfileArn(account)).toBe(account.profileArn);
    expect(resolveKiroRegion(account)).toBe("eu-west-1");
    expect(resolveKiroApiRegion(account)).toBe("eu-central-1");
  });

  test("resolveKiroProfileArn: KIRO_PROFILE_ARN env wins over SQLite", () => {
    process.env.KIRO_PROFILE_ARN = "arn:env";
    seedKiroCliDb({ access_token: "aoa", profile_arn: "arn:sqlite" });
    expect(resolveKiroProfileArn()).toBe("arn:env");
  });

  test("resolveKiroProfileArn: reads profile_arn from SQLite when env unset", () => {
    seedKiroCliDb({ access_token: "aoa", profile_arn: "arn:sqlite" });
    expect(resolveKiroProfileArn()).toBe("arn:sqlite");
  });

  test("resolveKiroProfileArn: undefined when no env and no SQLite", () => {
    expect(resolveKiroProfileArn()).toBeUndefined();
  });

  test("resolveKiroRegion: KIRO_REGION override, else us-east-1 default", () => {
    expect(resolveKiroRegion()).toBe("us-east-1");
    process.env.KIRO_REGION = "eu-west-1";
    expect(resolveKiroRegion()).toBe("eu-west-1");
  });

  test("resolveKiroRegion rejects host-injection region values without echoing input", () => {
    for (const value of ["us-east-1/../../evil", "us-east-1@evil.test", "https://evil.test", "../us-east-1"]) {
      process.env.KIRO_REGION = value;
      expect(() => resolveKiroRegion()).toThrow("Kiro: invalid region value.");
      try {
        resolveKiroRegion();
      } catch (err) {
        expect(err instanceof Error ? err.message : String(err)).not.toContain(value);
      }
    }
  });

  test("resolveKiroApiRegion: KIRO_API_REGION overrides imported profile region", () => {
    seedKiroCliDb({
      access_token: "aoa",
      profile_arn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/demo",
    });
    expect(resolveKiroApiRegion()).toBe("eu-central-1");
    process.env.KIRO_API_REGION = "us-east-2";
    expect(resolveKiroApiRegion()).toBe("us-east-2");
  });
});
