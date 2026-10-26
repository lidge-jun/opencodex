import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAUTH_PROVIDERS, OAuthReauthIdentityMismatchError, publicOAuthAuthenticationErrorMessage, runLogin } from "../../../src/oauth";
import { loginKiro, refreshKiroToken, type KiroCliRunner } from "../../../src/oauth/kiro";
import { KiroUserIdentityUnavailableError } from "../../../src/oauth/kiro-account-identity";
import { readKiroCliSqliteCredential } from "../../../src/oauth/kiro-credentials";
import { getAccountCredential, getAccountSet, saveCredential } from "../../../src/oauth/store";
import type { OAuthController, OAuthCredentials } from "../../../src/oauth/types";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

// Issue #6641: users of one Kiro organization (IAM Identity Center) profile share its profile
// ARN, so account identity must also carry the user that same-session whoami reports.
// Real SQLite create/inspect cycles are slow on cold Windows runners (see kiro-oauth.test.ts).
setDefaultTimeout(30_000);

const ENV_KEYS = [
  "HOME", "LOCALAPPDATA", "USERPROFILE", "OPENCODEX_HOME",
  "KIRO_ACCESS_TOKEN", "KIRO_REFRESH_TOKEN", "KIRO_PROFILE_ARN", "KIRO_REGION", "KIRO_API_REGION",
  "KIRO_CREDS_FILE", "KIRO_CREDENTIALS_FILE", "KIRO_CLI_DB_FILE", "KIROCLI_DB_PATH", "KIROCLI_TOKEN_KEY",
] as const;
const originalEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
const originalLogin = OAUTH_PROVIDERS.kiro.login;
const originalFetch = globalThis.fetch;
let tmp: string;

const ORG_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/ORGSHARED";

/**
 * Pinned \`kiro-cli whoami --format json\` shapes. Only \`email\` and the profile ARN fields are read
 * by OCX. \`accountType\`/\`region\`/\`startUrl\` and a null Builder ID email follow the Kiro CLI
 * command reference as summarized from public docs; no live CLI output was captured for them.
 */
const WHOAMI = {
  alice: { accountType: "IamIdentityCenter", email: "Alice@Org.Test", region: "us-east-1", startUrl: "https://org.awsapps.com/start" },
  bob: { accountType: "IamIdentityCenter", email: "bob@org.test", region: "us-east-1", startUrl: "https://org.awsapps.com/start" },
  noUser: { accountType: "IamIdentityCenter", region: "us-east-1", startUrl: "https://org.awsapps.com/start" },
  builderId: { accountType: "BuilderId", email: null },
  personal: { accountType: "Social", email: "me@personal.test" },
} as const;
type WhoamiFixture = keyof typeof WHOAMI;

function config(): OcxConfig {
  return { port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} };
}

function kiroCliDbPath(): string {
  if (process.platform === "win32") return join(tmp, "AppData", "Local", "Kiro-Cli", "data.sqlite3");
  if (process.platform === "darwin") return join(tmp, "Library", "Application Support", "kiro-cli", "data.sqlite3");
  return join(tmp, ".local", "share", "kiro-cli", "data.sqlite3");
}

function removeKiroCliDb(): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(kiroCliDbPath() + suffix, { force: true });
}

/** One kiro-cli session: token row plus the organization profile the CLI selected. */
function seedSession(access: string, refresh: string, profileArn: string | null = ORG_ARN): void {
  removeKiroCliDb();
  mkdirSync(join(kiroCliDbPath(), ".."), { recursive: true });
  const db = new Database(kiroCliDbPath());
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", [
    "kirocli:social:token", JSON.stringify({ access_token: access, refresh_token: refresh }),
  ]);
  if (profileArn) {
    db.run("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO state (key, value) VALUES (?, ?)", ["api.codewhisperer.profile", JSON.stringify({ arn: profileArn })]);
  }
  db.close();
}

/**
 * Fake kiro-cli. whoami answers for whichever session the CLI database holds right now, so it
 * behaves like the real CLI across logout/login; \`login\` installs the next queued session.
 */
function fakeCli(
  whoamiByRefresh: Record<string, WhoamiFixture | "fail">,
  nextLogin: Array<{ access: string; refresh: string; profileArn?: string }> = [],
  whoamiTrailer = "",
): { runner: KiroCliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: KiroCliRunner = async args => {
    calls.push(args);
    if (args[0] === "whoami") {
      const fixture = whoamiByRefresh[readKiroCliSqliteCredential()?.refresh ?? ""];
      if (!fixture || fixture === "fail") return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: JSON.stringify(WHOAMI[fixture]) + whoamiTrailer };
    }
    if (args[0] === "logout") {
      removeKiroCliDb();
      return { exitCode: 0, stdout: "" };
    }
    if (args[0] === "login") {
      const session = nextLogin.shift();
      if (!session) return { exitCode: 1, stdout: "" };
      seedSession(session.access, session.refresh, session.profileArn ?? ORG_ARN);
      return { exitCode: 0, stdout: "" };
    }
    return { exitCode: 1, stdout: "" };
  };
  return { runner, calls };
}

/** The dashboard path: runLogin persists through the real store with this fake CLI. */
async function dashboardLogin(runner: KiroCliRunner, addAccount = false): Promise<OAuthCredentials> {
  OAUTH_PROVIDERS.kiro.login = (ctrl, opts) => loginKiro(ctrl, { forceLogin: opts?.forceLogin, cliRunner: runner });
  return await runLogin("kiro", {} as OAuthController, addAccount ? { forceLogin: true } : undefined, {
    loadConfig: config,
    saveConfig: () => {},
  });
}

function rows() {
  return getAccountSet("kiro")?.accounts ?? [];
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-org-user-identity-"));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = tmp;
  process.env.LOCALAPPDATA = join(tmp, "AppData", "Local");
  process.env.USERPROFILE = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "opencodex");
});

afterEach(() => {
  OAUTH_PROVIDERS.kiro.login = originalLogin;
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeTreeWithRetry(tmp);
});

describe("Kiro organization users (#6641)", () => {
  test("two users of one organization profile keep separate account slots", async () => {
    seedSession("aoa-alice", "rt-alice");
    const cli = fakeCli({ "rt-alice": "alice", "rt-bob": "bob" }, [{ access: "aoa-bob", refresh: "rt-bob" }]);
    await dashboardLogin(cli.runner);
    await dashboardLogin(cli.runner, true);

    const accounts = rows();
    expect(accounts).toHaveLength(2);
    expect(new Set(accounts.map(account => account.id)).size).toBe(2);
    expect(accounts.map(account => account.credential.accountId)).toEqual([ORG_ARN, ORG_ARN]);
    expect(accounts.map(account => account.credential.email).sort()).toEqual(["alice@org.test", "bob@org.test"]);
    const alice = accounts.find(account => account.credential.email === "alice@org.test")!;
    expect(alice.credential).toMatchObject({ access: "aoa-alice", refresh: "rt-alice", kiro: { profileArn: ORG_ARN } });
    const bob = accounts.find(account => account.credential.email === "bob@org.test")!;
    expect(getAccountSet("kiro")?.activeAccountId).toBe(bob.id);
  });

  // kiro-cli 2.32 prints the selected profile as text after the whoami JSON. Reading the whole
  // stream as JSON lost both users' emails, so the second user's import overwrote the first.
  const PROFILE_TRAILER = `\n\nProfile:\nKiroProfile-us-east-1\n${ORG_ARN}\n\n`;

  test("an import after a CLI user switch keeps both users when whoami appends its Profile block", async () => {
    seedSession("aoa-alice", "rt-alice");
    const cli = fakeCli({ "rt-alice": "alice", "rt-bob": "bob" }, [], PROFILE_TRAILER);
    await dashboardLogin(cli.runner);
    seedSession("aoa-bob", "rt-bob");
    await dashboardLogin(cli.runner);

    const accounts = rows();
    expect(accounts.map(account => account.credential.email).sort()).toEqual(["alice@org.test", "bob@org.test"]);
    expect(accounts.find(account => account.credential.email === "alice@org.test")!.credential)
      .toMatchObject({ access: "aoa-alice", refresh: "rt-alice", accountId: ORG_ARN });
  });

  test("Add account keeps both users when whoami appends its Profile block", async () => {
    seedSession("aoa-alice", "rt-alice");
    const cli = fakeCli({ "rt-alice": "alice", "rt-bob": "bob" }, [{ access: "aoa-bob", refresh: "rt-bob" }], PROFILE_TRAILER);
    await dashboardLogin(cli.runner);
    await dashboardLogin(cli.runner, true);

    expect(rows().map(account => account.credential.email).sort()).toEqual(["alice@org.test", "bob@org.test"]);
    expect(rows().map(account => account.credential.accountId)).toEqual([ORG_ARN, ORG_ARN]);
  });

  test("re-importing the same user updates that user's slot", async () => {
    seedSession("aoa-alice", "rt-alice");
    const cli = fakeCli(
      { "rt-alice": "alice", "rt-alice-2": "alice", "rt-alice-3": "alice" },
      [{ access: "aoa-alice-3", refresh: "rt-alice-3" }],
    );
    await dashboardLogin(cli.runner);
    const slot = rows()[0]!.id;

    seedSession("aoa-alice-2", "rt-alice-2");
    await dashboardLogin(cli.runner);
    await dashboardLogin(cli.runner, true);

    expect(rows()).toHaveLength(1);
    expect(getAccountCredential("kiro", slot)).toMatchObject({
      access: "aoa-alice-3",
      refresh: "rt-alice-3",
      accountId: ORG_ARN,
      email: "alice@org.test",
    });
  });

  test("personal accounts keep their identity rules", async () => {
    seedSession("aoa-me", "rt-me", null);
    const cli = fakeCli({ "rt-me": "personal", "rt-me-2": "personal", "rt-builder": "builderId", "rt-builder-2": "builderId" });
    await dashboardLogin(cli.runner);
    seedSession("aoa-me-2", "rt-me-2", null);
    await dashboardLogin(cli.runner);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.credential).toMatchObject({ access: "aoa-me-2", email: "me@personal.test" });
    expect(rows()[0]!.credential.accountId).toBeUndefined();

    // Builder ID reports no user and no account profile: an ordinary import keeps replacing the
    // active identity-less slot in place, as before this change.
    await saveCredential("kiro", { access: "aoa-x", refresh: "rt-x", expires: Date.now() + 60_000, source: "local-cli" }, { preserveIdentityless: true });
    seedSession("aoa-builder", "rt-builder", null);
    const first = await dashboardLogin(cli.runner);
    expect(first.accountId).toBeUndefined();
    expect(first.email).toBeUndefined();
    seedSession("aoa-builder-2", "rt-builder-2", null);
    await dashboardLogin(cli.runner);
    expect(rows()).toHaveLength(2);
    expect(rows().some(account => account.credential.access === "aoa-builder-2")).toBe(true);
    expect(rows().some(account => account.credential.access === "aoa-builder")).toBe(false);
  });

  test("without a user from whoami a profile with no identified user keeps the legacy ARN identity", async () => {
    seedSession("aoa-a", "rt-a");
    const cli = fakeCli({ "rt-a": "noUser", "rt-b": "fail" });
    await dashboardLogin(cli.runner);
    seedSession("aoa-b", "rt-b");
    await dashboardLogin(cli.runner);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.credential).toMatchObject({ access: "aoa-b", accountId: ORG_ARN });
    expect(rows()[0]!.credential.email).toBeUndefined();
  });

  test("an unidentified login never replaces an identified organization user and restores the CLI", async () => {
    seedSession("aoa-alice", "rt-alice");
    const cli = fakeCli({ "rt-alice": "alice", "rt-unknown": "fail" }, [{ access: "aoa-unknown", refresh: "rt-unknown" }]);
    await dashboardLogin(cli.runner);
    const before = structuredClone(getAccountSet("kiro"));

    const error = await dashboardLogin(cli.runner, true).then(() => undefined, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(KiroUserIdentityUnavailableError);
    const message = publicOAuthAuthenticationErrorMessage(error);
    expect(message).toContain("did not report which user is signed in");
    expect(message).not.toContain("alice");
    expect(getAccountSet("kiro")).toEqual(before);
    // The forced login switched kiro-cli; the refused write rolls the CLI back to Alice's session.
    expect(readKiroCliSqliteCredential()).toMatchObject({ access: "aoa-alice", refresh: "rt-alice" });
    expect(cli.calls.map(args => args[0])).toEqual(["whoami", "logout", "login", "whoami"]);
  });

  test("an unidentified import of the same CLI session refreshes the identified slot and keeps its user", async () => {
    seedSession("aoa-alice", "rt-alice");
    await dashboardLogin(fakeCli({ "rt-alice": "alice" }).runner);
    const slot = rows()[0]!.id;

    seedSession("aoa-alice-new", "rt-alice");
    await dashboardLogin(fakeCli({ "rt-alice": "fail" }).runner);

    expect(rows()).toHaveLength(1);
    expect(getAccountCredential("kiro", slot)).toMatchObject({
      access: "aoa-alice-new",
      accountId: ORG_ARN,
      email: "alice@org.test",
    });
  });

  test("a profile with other rows never lets an unrelated login claim the identity-less active slot", async () => {
    await saveCredential("kiro", {
      access: "aoa-alice", refresh: "rt-alice", expires: Date.now() + 60_000,
      accountId: ORG_ARN, email: "alice@org.test", source: "local-cli", kiro: { profileArn: ORG_ARN },
    });
    await saveCredential("kiro", { access: "aoa-c", refresh: "rt-c", expires: Date.now() + 60_000, source: "local-cli" }, { preserveIdentityless: true });
    const identityless = rows().find(account => account.credential.accountId === undefined)!;
    expect(getAccountSet("kiro")?.activeAccountId).toBe(identityless.id);

    seedSession("aoa-bob", "rt-bob");
    await dashboardLogin(fakeCli({ "rt-bob": "bob" }).runner);

    expect(rows()).toHaveLength(3);
    expect(getAccountCredential("kiro", identityless.id)).toEqual(identityless.credential);
  });

  test("reauth of a row saved without a user refuses a user who already owns another slot", async () => {
    await saveCredential("kiro", {
      access: "aoa-legacy", refresh: "rt-legacy", expires: Date.now() + 60_000,
      accountId: ORG_ARN, source: "local-cli", kiro: { profileArn: ORG_ARN },
    });
    const legacy = rows()[0]!.id;
    await saveCredential("kiro", {
      access: "aoa-bob", refresh: "rt-bob", expires: Date.now() + 60_000,
      accountId: ORG_ARN, email: "bob@org.test", source: "local-cli", kiro: { profileArn: ORG_ARN },
    });
    const reauthWith = async (email: string) => {
      OAUTH_PROVIDERS.kiro.login = async () => ({
        access: "aoa-new", refresh: "rt-new", expires: Date.now() + 60_000, accountId: ORG_ARN,
        email, source: "local-cli", kiro: { profileArn: ORG_ARN },
      });
      return await runLogin("kiro", {} as OAuthController, { reauthAccountId: legacy }, { loadConfig: config, saveConfig: () => {} });
    };

    await expect(reauthWith("bob@org.test")).rejects.toBeInstanceOf(OAuthReauthIdentityMismatchError);
    expect(getAccountCredential("kiro", legacy)).toMatchObject({ access: "aoa-legacy" });
    await reauthWith("alice@org.test");
    expect(getAccountCredential("kiro", legacy)).toMatchObject({ access: "aoa-new", email: "alice@org.test" });
  });

  describe("accounts stored before this change", () => {
    const legacyArnOnly = (refresh: string): OAuthCredentials => ({
      access: "aoa-legacy", refresh, expires: Date.now() + 60_000, accountId: ORG_ARN, source: "local-cli",
      kiro: { profileArn: ORG_ARN },
    });

    test("an ARN-only row gains its user when the same CLI session is re-imported", async () => {
      await saveCredential("kiro", legacyArnOnly("rt-alice"));
      const slot = rows()[0]!.id;
      seedSession("aoa-alice", "rt-alice");
      await dashboardLogin(fakeCli({ "rt-alice": "alice" }).runner);

      expect(rows()).toHaveLength(1);
      expect(getAccountCredential("kiro", slot)).toMatchObject({ access: "aoa-alice", email: "alice@org.test" });
    });

    test("an ARN-only row is kept when another session of the organization is imported", async () => {
      await saveCredential("kiro", legacyArnOnly("rt-legacy"));
      const legacy = rows()[0]!;
      seedSession("aoa-bob", "rt-bob");
      await dashboardLogin(fakeCli({ "rt-bob": "bob" }).runner);

      expect(rows()).toHaveLength(2);
      expect(getAccountCredential("kiro", legacy.id)).toEqual(legacy.credential);
    });

    test("an ARN + email row saved before this change still matches its user", async () => {
      await saveCredential("kiro", { ...legacyArnOnly("rt-old"), email: "alice@org.test" });
      const slot = rows()[0]!.id;
      seedSession("aoa-alice", "rt-alice");
      await dashboardLogin(fakeCli({ "rt-alice": "alice" }).runner);

      expect(rows()).toHaveLength(1);
      expect(getAccountCredential("kiro", slot)).toMatchObject({ access: "aoa-alice", email: "alice@org.test" });
    });

    test("Add account names the current CLI user on an ARN-only row before switching users", async () => {
      await saveCredential("kiro", { ...legacyArnOnly("rt-alice"), plan: "pro" } as OAuthCredentials);
      const legacy = rows()[0]!;
      seedSession("aoa-alice-cli", "rt-alice");
      const cli = fakeCli(
        { "rt-alice": "alice", "rt-bob": "bob", "rt-alice-2": "alice" },
        [{ access: "aoa-bob", refresh: "rt-bob" }],
      );
      await dashboardLogin(cli.runner, true);

      expect(rows()).toHaveLength(2);
      // Only the user is recorded; the stored tokens, plan and routing stay untouched.
      expect(getAccountCredential("kiro", legacy.id)).toEqual({ ...legacy.credential, email: "alice@org.test" });

      // Alice later signs in again with a new session: her slot is found, not duplicated.
      seedSession("aoa-alice-2", "rt-alice-2");
      await dashboardLogin(cli.runner);
      expect(rows()).toHaveLength(2);
      expect(getAccountCredential("kiro", legacy.id)).toMatchObject({ access: "aoa-alice-2", email: "alice@org.test" });
    });
  });

  test("reauth of an organization user rejects another user of the same profile", async () => {
    await saveCredential("kiro", {
      access: "aoa-alice", refresh: "rt-alice", expires: Date.now() + 60_000,
      accountId: ORG_ARN, email: "alice@org.test", source: "local-cli", kiro: { profileArn: ORG_ARN },
    });
    const slot = rows()[0]!.id;
    const reauthWith = async (credential: Partial<OAuthCredentials>) => {
      OAUTH_PROVIDERS.kiro.login = async () => ({
        access: "aoa-new", refresh: "rt-new", expires: Date.now() + 60_000, accountId: ORG_ARN,
        source: "local-cli", kiro: { profileArn: ORG_ARN }, ...credential,
      });
      return await runLogin("kiro", {} as OAuthController, { reauthAccountId: slot }, { loadConfig: config, saveConfig: () => {} });
    };

    await expect(reauthWith({ email: "bob@org.test" })).rejects.toBeInstanceOf(OAuthReauthIdentityMismatchError);
    await expect(reauthWith({})).rejects.toBeInstanceOf(OAuthReauthIdentityMismatchError);
    expect(getAccountCredential("kiro", slot)).toMatchObject({ access: "aoa-alice" });

    await reauthWith({ email: "ALICE@org.test" });
    expect(getAccountCredential("kiro", slot)).toMatchObject({ access: "aoa-new" });
  });

  describe("rotated CLI session recovery", () => {
    const stored: OAuthCredentials = {
      access: "aoa-alice-old", refresh: "rt-alice-old", expires: 0, accountId: ORG_ARN,
      email: "alice@org.test", source: "local-cli",
      kiro: { profileArn: ORG_ARN, ssoRegion: "us-east-1", clientId: "client", clientSecret: "secret" },
    };

    function refreshServer(): string[] {
      const refreshTokens: string[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        refreshTokens.push(String((JSON.parse(String(init?.body)) as { refreshToken: string }).refreshToken));
        if (refreshTokens.length === 1) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        return new Response(JSON.stringify({ accessToken: "aoa-recovered", expiresIn: 60 }), { status: 200 });
      }) as typeof fetch;
      return refreshTokens;
    }

    test("never adopts another organization user's CLI session", async () => {
      seedSession("aoa-bob", "rt-bob");
      const refreshTokens = refreshServer();
      await expect(refreshKiroToken("rt-alice-old", undefined, stored, {
        cliRunner: fakeCli({ "rt-bob": "bob" }).runner,
      })).rejects.toBeInstanceOf(Error);
      expect(refreshTokens).toEqual(["rt-alice-old"]);
    });

    test("never adopts a session whose user whoami cannot name", async () => {
      seedSession("aoa-cli", "rt-cli");
      const refreshTokens = refreshServer();
      await expect(refreshKiroToken("rt-alice-old", undefined, stored, {
        cliRunner: fakeCli({ "rt-cli": "fail" }).runner,
      })).rejects.toBeInstanceOf(Error);
      expect(refreshTokens).toEqual(["rt-alice-old"]);
    });

    test("a row without a user adopts no CLI session while another row shares its profile", async () => {
      const { email: _email, ...unnamed } = stored;
      await saveCredential("kiro", { ...stored, access: "aoa-bob", refresh: "rt-bob", email: "bob@org.test" });
      seedSession("aoa-cli", "rt-cli");
      const refreshTokens = refreshServer();
      await expect(refreshKiroToken("rt-alice-old", undefined, unnamed, {
        cliRunner: fakeCli({ "rt-cli": "bob" }).runner,
      })).rejects.toBeInstanceOf(Error);
      expect(refreshTokens).toEqual(["rt-alice-old"]);
    });

    test("cancellation while whoami runs is reported as cancellation", async () => {
      seedSession("aoa-alice-cli", "rt-alice-cli");
      const refreshTokens = refreshServer();
      const controller = new AbortController();
      const runner: KiroCliRunner = async () => {
        controller.abort(new Error("caller cancelled"));
        throw new Error("Kiro login cancelled.");
      };
      await expect(refreshKiroToken("rt-alice-old", controller.signal, stored, { cliRunner: runner }))
        .rejects.toThrow("caller cancelled");
      expect(refreshTokens).toEqual(["rt-alice-old"]);
    });

    test("still recovers the same user's rotated CLI session", async () => {
      seedSession("aoa-alice-cli", "rt-alice-cli");
      const refreshTokens = refreshServer();
      const fresh = await refreshKiroToken("rt-alice-old", undefined, stored, {
        cliRunner: fakeCli({ "rt-alice-cli": "alice" }).runner,
      });
      expect(refreshTokens).toEqual(["rt-alice-old", "rt-alice-cli"]);
      expect(fresh).toMatchObject({ access: "aoa-recovered", refresh: "rt-alice-cli" });
    });
  });
});

