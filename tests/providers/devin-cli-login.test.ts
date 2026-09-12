import { describe, expect, test } from "bun:test";
import {
  DEVIN_CLI_CREDENTIALS_ENV,
  devinCliCredentialsPath,
  devinCliSignedIn,
  loginDevinCli,
  readDevinCliCredentialFile,
  refreshDevinCliToken,
} from "../../src/oauth/devin-cli";
import { resolveDevinApiServer } from "../../src/oauth/devin";
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

function silentController(): OAuthController & { progress: string[] } {
  const progress: string[] = [];
  return { progress, onProgress: (m: string) => { progress.push(m); } };
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

describe("devin-cli login", () => {
  test("imports the signed-in session without a browser", async () => {
    const ctrl = silentController();
    const cred = await loginDevinCli(ctrl, undefined, depsFor(REAL_FILE));
    expect(cred.access).toBe(KEY);
    // Durable-key pattern: refresh carries the key too, or detectOAuthWarning
    // reports stale_credentials from the moment of login.
    expect(cred.refresh).toBe(KEY);
    expect(cred.expires).toBe(Number.MAX_SAFE_INTEGER);
    expect(cred.source).toBe("local-cli");
    expect(cred.apiBaseUrl).toBe("https://server.codeium.com");
    // onAuth is never called: there is nothing for opencodex to authorize.
    expect(ctrl.progress.join(" ")).not.toContain(KEY);
  });

  test("an off-allowlist api_server_url never becomes the request origin", async () => {
    const hostile = REAL_FILE.replace("https://server.codeium.com", "https://evil.example.com");
    const cred = await loginDevinCli(silentController(), undefined, depsFor(hostile));
    expect(cred.apiBaseUrl).toBe("https://server.codeium.com");
    expect(cred.apiBaseUrl).not.toContain("evil");
  });

  test("the failure names the install hint and never the secret", async () => {
    // redactSecretString does not recognise a bare JWT or a devin-session-token,
    // and login errors reach terminal output, so nothing parsed may be thrown.
    const err = await loginDevinCli(silentController(), undefined, depsFor(undefined)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("devin auth login");
    expect((err as Error).message).not.toContain(KEY);
    const badErr = await loginDevinCli(silentController(), undefined, depsFor('windsurf_api_key = "' + KEY + '"\n'))
      .catch((e: Error) => e);
    expect((badErr as Error).message).not.toContain(KEY);
  });

  test("refresh is terminal", async () => {
    await expect(refreshDevinCliToken("x")).rejects.toThrow(/invalid_grant/);
  });
});

describe("devin tenant selection is provider-scoped", () => {
  test("the default still reads the devin slot", () => {
    // Every existing one-argument caller must keep its behaviour.
    expect(resolveDevinApiServer("https://server.codeium.com")).toBe("https://server.codeium.com");
    expect(resolveDevinApiServer(undefined)).toBe("https://server.codeium.com");
  });

  test("an unknown provider id falls back rather than borrowing another slot", () => {
    // The regression this parameter exists for: reading a fixed "devin" slot sent
    // one provider's key to the other provider's tenant.
    expect(resolveDevinApiServer(undefined, "devin-cli")).toBe("https://server.codeium.com");
  });
});

