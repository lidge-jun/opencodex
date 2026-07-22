import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectKiroCliSqlite, loginKiro, readKiroCliSqlite, refreshKiroToken, resolveKiroApiRegion, resolveKiroProfileArn, resolveKiroRegion } from "../src/oauth/kiro";

// Windows CI cold runners take 5-7s for the real SQLite create/inspect cycles here
// (same flake class as 810fa115); the default 5s harness timeout is too tight.
setDefaultTimeout(30_000);

const origHome = process.env.HOME;
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
  rmSync(tmp, { recursive: true, force: true });
});

function seedKiroCliDb(
  token: { access_token: string; refresh_token?: string; expires_at?: string; profile_arn?: string; region?: string },
  opts: { registration?: Record<string, unknown>; stateArn?: string } = {},
) {
  const dir = join(tmp, "Library", "Application Support", "kiro-cli");
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
  const dir = join(tmp, "Library", "Application Support", "kiro-cli");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.sqlite3"));
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", ["kirocli:social:token", value]);
  db.close();
}

function seedCustomTokenDb(path: string, rows: Array<[string, Record<string, unknown>]>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  for (const [key, value] of rows) db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", [key, JSON.stringify(value)]);
  db.close();
}

describe("kiro oauth — import-first", () => {
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
    const cred = await loginKiro({});
    expect(cred.access).toBe("aoa-xyz");
    expect(cred.refresh).toBe("rt-2");
    expect(cred.source).toBe("local-cli");
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
  });

  test("inspectKiroCliSqlite reports safe diagnostics without token values", () => {
    seedKiroCliDb({ access_token: "aoa-diagnostic-secret", refresh_token: "rt-diagnostic-secret" });

    const result = inspectKiroCliSqlite();
    const rendered = JSON.stringify(result.diagnostics);

    expect(result.token?.access).toBe("aoa-diagnostic-secret");
    expect(result.diagnostics).toContainEqual({ location: "kiro-cli-data", status: "token_found" });
    expect(rendered).not.toContain("aoa-diagnostic-secret");
    expect(rendered).not.toContain("rt-diagnostic-secret");
    expect(rendered).not.toContain(tmp);
  });

  test("inspectKiroCliSqlite distinguishes schema mismatch from no token", () => {
    const dir = join(tmp, "Library", "Application Support", "kiro-cli");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "data.sqlite3"));
    db.run("CREATE TABLE other_table (key TEXT PRIMARY KEY, value TEXT)");
    db.close();

    const result = inspectKiroCliSqlite();

    expect(result.token).toBeNull();
    expect(result.diagnostics).toContainEqual({ location: "kiro-cli-data", status: "schema_mismatch" });
    expect(result.diagnostics).toContainEqual({ location: "kiro-sso-cache", status: "missing" });
  });

  test("inspectKiroCliSqlite distinguishes token_missing and invalid_json", () => {
    seedKiroCliRawValue(JSON.stringify({ refresh_token: "rt-without-access" }));

    const missing = inspectKiroCliSqlite();

    expect(missing.token).toBeNull();
    expect(missing.diagnostics).toContainEqual({ location: "kiro-cli-data", status: "token_missing" });

    rmSync(join(tmp, "Library"), { recursive: true, force: true });
    seedKiroCliRawValue("{not json");

    const invalid = inspectKiroCliSqlite();

    expect(invalid.token).toBeNull();
    expect(invalid.diagnostics).toContainEqual({ location: "kiro-cli-data", status: "invalid_json" });
  });

  test("inspectKiroCliSqlite distinguishes unreadable database path", () => {
    const dir = join(tmp, "Library", "Application Support", "kiro-cli");
    mkdirSync(join(dir, "data.sqlite3"), { recursive: true });

    const result = inspectKiroCliSqlite();

    expect(result.token).toBeNull();
    expect(result.diagnostics).toContainEqual({ location: "kiro-cli-data", status: "unreadable" });
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
    expect(result.diagnostics).toContainEqual({ location: "kiro-cli-data", status: "registration_found" });
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
