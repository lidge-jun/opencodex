import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import {
  DEVIN_CLI_CREDENTIALS_ENV,
  devinCliCredentialsPath,
  devinCliSignedIn,
  readDevinCliCredentialFile,
  readDevinCliCredentialOutcome,
  type DevinCliLoginDeps,
} from "../../src/oauth/devin/cli-import";
import { loginDevin, refreshDevinToken, resolveDevinApiServer } from "../../src/oauth/devin";
import { saveCredential } from "../../src/oauth/store";
import type { OAuthController } from "../../src/oauth/types";

/**
 * The measured shape of a signed-in CLI's credentials.toml. Quoted values, flat
 * keys, LF. Fixtures use the real form on purpose: an unquoted matcher passes an
 * unquoted fixture and then fails on the live file.
 */
const REAL_FILE = [
  'windsurf_api_key = "devin-session-token$eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uX2lkIjoid2luZHN1cmYtc2Vzc2lvbi1hYmMifQ.sig"',
  'api_server_url = "https://server.codeium.com"',
  'devin_webapp_host = "https://app.devin.ai"',
  'devin_api_url = "https://api.devin.ai"',
  "",
].join("\n");

const KEY = 'devin-session-token$eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uX2lkIjoid2luZHN1cmYtc2Vzc2lvbi1hYmMifQ.sig';

function depsFor(contents: string | undefined, env: NodeJS.ProcessEnv = {}) {
  return {
    env: { HOME: "/home/u", XDG_DATA_HOME: "/home/u/.local/share", ...env },
    platform: "linux" as NodeJS.Platform,
    exists: () => contents !== undefined,
    read: () => contents ?? "",
  };
}

/**
 * A controller that records whether the browser flow was entered. The merged
 * login's two paths are distinguished by one observable: the Auth0 flow calls
 * `onAuth` with a sign-in URL before anything else, and the CLI import never
 * touches it. `onManualCodeInput` returns "" so the browser branch stops at
 * its own "nothing pasted" error rather than reaching the network.
 */
function recordingController() {
  const auths: Array<{ url: string; instructions?: string }> = [];
  const progress: string[] = [];
  const ctrl: OAuthController = {
    onAuth: (info) => { auths.push(info); },
    onProgress: (m) => { progress.push(m); },
    onManualCodeInput: () => Promise.resolve(""),
  };
  return { ctrl, auths, progress };
}

describe("devin-cli credentials path", () => {
  test("uses the data dir the CLI actually prints, not the config dir", () => {
    expect(devinCliCredentialsPath({ XDG_DATA_HOME: "/d" }, "linux")).toBe("/d/devin/credentials.toml");
  });

  test("Windows uses APPDATA", () => {
    expect(devinCliCredentialsPath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32"))
      .toBe("C:\\Users\\u\\AppData\\Roaming\\devin\\credentials.toml");
  });

  test("the override must be absolute", () => {
    // A relative override would resolve against whatever directory the proxy
    // happens to run in, which is not a location a user can mean.
    const abs = devinCliCredentialsPath({ [DEVIN_CLI_CREDENTIALS_ENV]: "/tmp/creds.toml", XDG_DATA_HOME: "/d" }, "linux");
    expect(abs).toBe("/tmp/creds.toml");
    const rel = devinCliCredentialsPath({ [DEVIN_CLI_CREDENTIALS_ENV]: "creds.toml", XDG_DATA_HOME: "/d" }, "linux");
    expect(rel).toBe("/d/devin/credentials.toml");
  });
});

describe("devin-cli credential file", () => {
  test("reads the two keys it needs and ignores the session-product ones", () => {
    const file = readDevinCliCredentialFile(depsFor(REAL_FILE));
    expect(file).toEqual({ apiKey: KEY, apiServerUrl: "https://server.codeium.com" });
  });

  test("absent file is undefined, not a throw", () => {
    expect(readDevinCliCredentialFile(depsFor(undefined))).toBeUndefined();
    expect(devinCliSignedIn(depsFor(undefined))).toBe(false);
  });

  test("either key missing is a refusal, not a half credential", () => {
    expect(readDevinCliCredentialFile(depsFor('api_server_url = "https://server.codeium.com"\n'))).toBeUndefined();
    expect(readDevinCliCredentialFile(depsFor(`windsurf_api_key = "${KEY}"\n`))).toBeUndefined();
  });

  test("an unquoted value is refused rather than guessed at", () => {
    // The measured file quotes every value. Accepting an unquoted form would be
    // inventing a parser for a shape the vendor does not write.
    expect(readDevinCliCredentialFile(depsFor("windsurf_api_key = abc\napi_server_url = def\n"))).toBeUndefined();
  });
});

describe("devin merged login is import-first", () => {
  // loginDevin reads the real credential path (no injected deps), so these
  // fixtures go through OPENCODEX_DEVIN_CLI_CREDENTIALS — the same absolute-path
  // override the resolver honours — pointed at files under a temp dir.
  const tmp = mkdtempSync(join(tmpdir(), "ocx-devin-login-"));
  const credentialFile = join(tmp, "credentials.toml");
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[DEVIN_CLI_CREDENTIALS_ENV];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[DEVIN_CLI_CREDENTIALS_ENV];
    else process.env[DEVIN_CLI_CREDENTIALS_ENV] = savedEnv;
    rmSync(credentialFile, { force: true });
  });

  const pointAt = (path: string) => { process.env[DEVIN_CLI_CREDENTIALS_ENV] = path; };

  test("a signed-in CLI session imports without a browser", async () => {
    writeFileSync(credentialFile, REAL_FILE);
    pointAt(credentialFile);
    const { ctrl, auths } = recordingController();
    const cred = await loginDevin(ctrl);
    expect(cred.access).toBe(KEY);
    // Durable-key pattern: refresh carries the key too, or detectOAuthWarning
    // reports stale_credentials from the moment of login.
    expect(cred.refresh).toBe(KEY);
    expect(cred.expires).toBe(Number.MAX_SAFE_INTEGER);
    expect(cred.source).toBe("local-cli");
    expect(cred.apiBaseUrl).toBe("https://server.codeium.com");
    // onAuth is never called: the CLI already completed PKCE, so there is
    // nothing left for a browser to authorize.
    expect(auths).toEqual([]);
  });

  test("an off-allowlist api_server_url never becomes the request origin", async () => {
    writeFileSync(credentialFile, REAL_FILE.replace("https://server.codeium.com", "https://evil.example.com"));
    pointAt(credentialFile);
    const cred = await loginDevin(recordingController().ctrl);
    expect(cred.apiBaseUrl).toBe("https://server.codeium.com");
    expect(cred.apiBaseUrl).not.toContain("evil");
  });

  test("a missing credential file falls back to the browser flow", async () => {
    // CLI-absent users have no other sign-in path; a pure rename of the old
    // devin-cli import would leave them unable to log in at all. The empty
    // paste ends the flow at its own error, which is what proves onAuth ran
    // without the test ever reaching RegisterUser.
    pointAt(join(tmp, "does-not-exist.toml"));
    const { ctrl, auths } = recordingController();
    const err = await loginDevin(ctrl).catch((e: Error) => e);
    expect(auths).toHaveLength(1);
    expect(auths[0]!.url).toContain("windsurf");
    expect((err as Error).message).toContain("No auth token pasted");
  });

  test("an unreadable credential file throws instead of opening a browser", async () => {
    // The file exists but cannot be read: a browser login would succeed and
    // leave the broken file in place, hiding the real fault. A directory at
    // the credential path makes readFileSync throw without chmod games, which
    // is the same "unreadable" outcome an EACCES produces.
    pointAt(tmp);
    const { ctrl, auths } = recordingController();
    await expect(loginDevin(ctrl)).rejects.toThrow(/could not read it/);
    expect(auths).toEqual([]);
  });

  test("an incomplete credential file throws instead of opening a browser", async () => {
    // A half-written file is a broken credential, not an absent one: falling
    // back to the browser would mint a second session while the CLI's own
    // file stays corrupt.
    writeFileSync(credentialFile, 'api_server_url = "https://server.codeium.com"\n');
    pointAt(credentialFile);
    const { ctrl, auths } = recordingController();
    await expect(loginDevin(ctrl)).rejects.toThrow(/session key|devin auth login/);
    expect(auths).toEqual([]);
  });

  test("forceLogin skips the import and goes to the browser", async () => {
    // The management route sets forceLogin on addAccount/reauth, and an
    // operator forcing a login means "a different account than the CLI's" —
    // importing the same CLI session again would silently ignore that.
    writeFileSync(credentialFile, REAL_FILE);
    pointAt(credentialFile);
    const { ctrl, auths } = recordingController();
    const err = await loginDevin(ctrl, { forceLogin: true }).catch((e: Error) => e);
    expect(auths).toHaveLength(1);
    expect((err as Error).message).toContain("No auth token pasted");
  });

  test("no thrown message repeats the imported key", async () => {
    // redactSecretString does not recognise a bare JWT or a devin-session-token,
    // and login errors reach terminal output, so nothing parsed may be thrown.
    writeFileSync(credentialFile, `windsurf_api_key = "${KEY}"\n`);
    pointAt(credentialFile);
    const err = await loginDevin(recordingController().ctrl).catch((e: unknown) => e);
    expect(String(err)).not.toContain("devin-session-token");
  });

  test("refresh is terminal", async () => {
    // Cognition exposes no refresh endpoint and the key is durable; throwing
    // invalid_grant lets the request path mark the account needsReauth instead
    // of extending a revoked key forever.
    await expect(refreshDevinToken("x")).rejects.toThrow(/invalid_grant/);
  });
});

describe("devin tenant selection is provider-scoped", () => {
  // resolveDevinApiServer reads auth.json through getCredential. Isolate the
  // home so these cases cannot pick up a live Devin login, and so seeding a
  // slot cannot write the operator's real store.
  const tmp = mkdtempSync(join(tmpdir(), "ocx-devin-tenant-"));
  let savedHome: string | undefined;

  const EU_HOST = "https://eu.windsurf.com/_route/api_server";
  const FEDSTART_HOST = "https://windsurf.fedstart.com/_route/api_server";
  const US_HOST = "https://server.codeium.com";

  async function seedSlot(provider: string, apiBaseUrl: string) {
    await saveCredential(provider, {
      access: KEY,
      refresh: KEY,
      expires: Number.MAX_SAFE_INTEGER,
      source: "local-cli",
      apiBaseUrl,
    });
  }

  beforeEach(() => {
    savedHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = tmp;
    rmSync(join(tmp, "auth.json"), { force: true });
  });

  afterEach(() => {
    rmSync(join(tmp, "auth.json"), { force: true });
    if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = savedHome;
  });

  test("the default still reads the devin slot", () => {
    // Every existing one-argument caller must keep its behaviour.
    expect(resolveDevinApiServer("https://server.codeium.com")).toBe("https://server.codeium.com");
    expect(resolveDevinApiServer(undefined)).toBe("https://server.codeium.com");
  });

  test("the deprecated devin-cli id normalizes onto the devin slot", () => {
    // A config saved before the merge migration can still name "devin-cli";
    // both ids share one credential slot after the merge, so the alias must
    // read the same place rather than an orphaned slot.
    expect(resolveDevinApiServer(undefined, "devin-cli")).toBe("https://server.codeium.com");
  });

  test("an unmigrated EU tenant on the alias slot is used after the config row is rewritten", async () => {
    // The config rewriter can land providers["devin"] while rekeyProviderCredentials
    // has not yet moved the auth slot. Asking for "devin" must still find the
    // tenant host sitting on "devin-cli"; otherwise the key is sent to the US
    // default and Cognition answers permission_denied.
    await seedSlot("devin-cli", EU_HOST);
    expect(resolveDevinApiServer(undefined, "devin", KEY)).toBe(EU_HOST);
  });

  test("the signed-in alias tenant wins over a configured baseUrl", async () => {
    // RegisterUser recorded the tenant on the credential. A leftover US
    // baseUrl on the rewritten config row must not override that account.
    await seedSlot("devin-cli", EU_HOST);
    expect(resolveDevinApiServer(US_HOST, "devin", KEY)).toBe(EU_HOST);
  });

  test("the literal slot wins when both alias ids hold a tenant", async () => {
    // An unmigrated "devin-cli" row must keep reading its own slot even if a
    // "devin" credential already exists; swapping them would send each key
    // to the other account's host.
    await seedSlot("devin", EU_HOST);
    await seedSlot("devin-cli", FEDSTART_HOST);
    expect(resolveDevinApiServer(undefined, "devin", KEY)).toBe(EU_HOST);
    expect(resolveDevinApiServer(undefined, "devin-cli", KEY)).toBe(FEDSTART_HOST);
  });

  test("a credential that exists but has no usable tenant does not borrow the alias tenant", async () => {
    // rekeyProviderCredentials refuses when both slots are occupied, so this
    // pair can be two different accounts. If the alias host were consulted
    // whenever the literal host is merely unusable — rather than when the
    // literal slot is empty — this account's key would go to the other
    // account's FedStart tenant.
    await seedSlot("devin", "https://api.githubcopilot.com");
    await seedSlot("devin-cli", FEDSTART_HOST);
    expect(resolveDevinApiServer(undefined, "devin", KEY)).toBe(US_HOST);
    expect(resolveDevinApiServer(EU_HOST, "devin", KEY)).toBe(EU_HOST);
  });

  test("an alias slot with a non-Devin apiBaseUrl is not trusted", async () => {
    // The store allowlists Copilot and Devin together, so a Copilot origin is
    // the host that survives persist and still fails validateDevinApiBaseUrl.
    // Without that check on the alias candidate, the merge window would send
    // a Devin key to GitHub.
    // The request key must match the seeded credential, or the lookup stops
    // before the host reaches the validator and this case proves nothing.
    await seedSlot("devin-cli", "https://api.githubcopilot.com");
    expect(resolveDevinApiServer(EU_HOST, "devin", KEY)).toBe(EU_HOST);
    expect(resolveDevinApiServer(undefined, "devin", KEY)).toBe(US_HOST);
  });

  test("a literal tenant is not lent to a key that credential does not own", async () => {
    // A provider-configured key or a forwarded bearer is resolved outside the
    // credential store. Taking the active slot's host for it would send that
    // key to another account's EU tenant.
    const STAGING_HOST = "https://server-staging.codeium.com";
    await seedSlot("devin", EU_HOST);
    expect(resolveDevinApiServer(STAGING_HOST, "devin", "configured-provider-key")).toBe(STAGING_HOST);
    expect(resolveDevinApiServer(undefined, "devin", "configured-provider-key")).toBe(US_HOST);
    expect(resolveDevinApiServer(undefined, "devin", KEY)).toBe(EU_HOST);
  });

  test("an alias credential that owns the key is used when the literal slot owns another", async () => {
    // Both slots are occupied because the rekey refused an occupied
    // destination. Ownership, not slot order, decides which tenant the
    // transmitted key belongs to.
    const ALIAS_KEY = "devin-session-token$alias-account.payload.sig";
    await seedSlot("devin", EU_HOST);
    await saveCredential("devin-cli", {
      access: ALIAS_KEY, refresh: ALIAS_KEY, expires: Number.MAX_SAFE_INTEGER,
      source: "local-cli", apiBaseUrl: FEDSTART_HOST,
    });
    expect(resolveDevinApiServer(undefined, "devin", ALIAS_KEY)).toBe(FEDSTART_HOST);
    expect(resolveDevinApiServer(undefined, "devin", KEY)).toBe(EU_HOST);
  });

  test("a key neither occupied slot owns gets neither stored tenant", async () => {
    const STAGING_HOST = "https://server-staging.codeium.com";
    await seedSlot("devin", EU_HOST);
    await seedSlot("devin-cli", FEDSTART_HOST);
    expect(resolveDevinApiServer(STAGING_HOST, "devin", "unowned-key")).toBe(STAGING_HOST);
    expect(resolveDevinApiServer(STAGING_HOST, "devin-cli", "unowned-key")).toBe(STAGING_HOST);
  });

  test("without a transmitted key no stored tenant is trusted", async () => {
    await seedSlot("devin", EU_HOST);
    await seedSlot("devin-cli", FEDSTART_HOST);
    expect(resolveDevinApiServer(undefined, "devin")).toBe(US_HOST);
    expect(resolveDevinApiServer(undefined, "devin", "")).toBe(US_HOST);
    expect(resolveDevinApiServer("https://server-staging.codeium.com", "devin")).toBe("https://server-staging.codeium.com");
  });

  test("a non-active account's key keeps that account's own tenant", async () => {
    // Several Devin accounts can share one provider id and the request path can
    // admit any of them, so the owner is found by key, not by active selection.
    const EU_KEY = "devin-session-token$eu-account.payload.sig";
    const FEDSTART_KEY = "devin-session-token$fedstart-account.payload.sig";
    await saveCredential("devin", {
      access: EU_KEY, refresh: EU_KEY, expires: Number.MAX_SAFE_INTEGER,
      source: "oauth", accountId: "eu-account", apiBaseUrl: EU_HOST,
    });
    await saveCredential("devin", {
      access: FEDSTART_KEY, refresh: FEDSTART_KEY, expires: Number.MAX_SAFE_INTEGER,
      source: "oauth", accountId: "fedstart-account", apiBaseUrl: FEDSTART_HOST,
    });
    expect(resolveDevinApiServer(undefined, "devin", EU_KEY)).toBe(EU_HOST);
    expect(resolveDevinApiServer(undefined, "devin", FEDSTART_KEY)).toBe(FEDSTART_HOST);
  });
});

describe("devin-cli credential path and read bounds", () => {
  const okFile = [
    'windsurf_api_key = "devin-session-token$eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig"',
    'api_server_url = "https://server.codeium.com"',
    "",
  ].join("\n");

  test("an empty XDG_DATA_HOME or APPDATA does not become a cwd-relative path", () => {
    // `??` treated "" as set, so join("", "devin", …) resolved against whatever
    // directory the proxy was started in, and a planted file there would import
    // as the operator's own CLI session.
    // The fallback reads the real home directory rather than env.HOME, so the
    // assertion is on shape: anchored at that home directory, and under its data
    // dir. Anchoring is what proves the path is not cwd-relative; asserting a
    // leading "/" instead would only hold when the HOST is POSIX, because
    // `homedir()` returns `C:\\Users\\<name>` on Windows no matter which
    // platform the resolver is asked about.
    for (const empty of ["", "   "]) {
      const resolved = devinCliCredentialsPath({ HOME: "/home/u", XDG_DATA_HOME: empty }, "linux");
      expect(resolved.startsWith(homedir())).toBe(true);
      expect(resolved.endsWith("/.local/share/devin/credentials.toml")).toBe(true);
    }
    const win = devinCliCredentialsPath({ APPDATA: "" }, "win32");
    // The win32 branch joins with win32 separators, so a POSIX host home such as
    // `/Users/runner` comes back as `\\Users\\runner`. Normalize the anchor the
    // same way rather than comparing a host-shaped string against it.
    expect(win.startsWith(win32.join(homedir()))).toBe(true);
    expect(win.endsWith("AppData\\Roaming\\devin\\credentials.toml")).toBe(true);
    expect(win.startsWith("devin")).toBe(false);
  });

  test("a present-but-unreadable file is not reported as a missing sign-in", () => {
    const deps = {
      env: { HOME: "/home/u", XDG_DATA_HOME: "/home/u/.local/share" },
      platform: "linux" as NodeJS.Platform,
      exists: () => true,
      read: () => { throw new Error("EACCES: permission denied"); },
    };
    expect(readDevinCliCredentialOutcome(deps)).toEqual({ kind: "unreadable" });
    // "run devin auth login" would succeed and change nothing, so the two
    // outcomes must not share one outcome kind.
    expect(readDevinCliCredentialOutcome({ ...deps, exists: () => false })).toEqual({ kind: "missing" });
  });

  test("a file past the parse bound is refused rather than scanned", () => {
    const deps = {
      env: { HOME: "/home/u", XDG_DATA_HOME: "/home/u/.local/share" },
      platform: "linux" as NodeJS.Platform,
      exists: () => true,
      read: () => okFile + "#".repeat(64 * 1024),
    };
    expect(readDevinCliCredentialOutcome(deps).kind).toBe("unreadable");
    expect(readDevinCliCredentialFile(deps)).toBeUndefined();
  });

  test("a file with only one of the two keys names the incomplete case", () => {
    const deps = {
      env: { HOME: "/home/u", XDG_DATA_HOME: "/home/u/.local/share" },
      platform: "linux" as NodeJS.Platform,
      exists: () => true,
      read: () => 'api_server_url = "https://server.codeium.com"\n',
    };
    expect(readDevinCliCredentialOutcome(deps).kind).toBe("incomplete");
  });
});
