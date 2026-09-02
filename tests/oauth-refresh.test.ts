import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidAccessToken, getValidAccessTokenForAccount, OAuthLoginRequiredError, OAuthTokenRefreshBusyError, OAuthTokenRefreshStaleError, OAUTH_PROVIDERS, refreshAnthropicAccountWithLock, seedOAuthTokenRefreshFlightsForTests } from "../src/oauth";
import { RefreshIntentIOError, nousRefreshIntentBlocksReplay } from "../src/oauth/nous";
import * as nousModule from "../src/oauth/nous";
import { AnthropicTokenError } from "../src/oauth/anthropic";
import {
  OAuthRefreshIntentIOError,
  credentialGeneration,
  getAccountCredential,
  getAccountSet,
  getAuthRefreshIntentPath,
  getCredential,
  markAccountNeedsReauth,
  markOAuthRefreshIntentCleanupPending,
  readOAuthRefreshIntent,
  saveCredential,
  writeOAuthRefreshIntent,
} from "../src/oauth/store";
import * as storeModule from "../src/oauth/store";
import * as configModule from "../src/config";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const origHome = process.env.HOME;
const origLocalAppData = process.env.LOCALAPPDATA;
const origUserProfile = process.env.USERPROFILE;
const origOcxHome = process.env.OPENCODEX_HOME;
const origRegion = process.env.KIRO_REGION;
const origCliDbFile = process.env.KIRO_CLI_DB_FILE;
const origCliDbPath = process.env.KIROCLI_DB_PATH;
const origCliTokenKey = process.env.KIROCLI_TOKEN_KEY;
const origClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const origFetch = globalThis.fetch;
const origWarn = console.warn;
let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `oauth-refresh-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  // Native kiro-cli store resolves per-platform (issue #710); win32 prefers these over HOME.
  process.env.LOCALAPPDATA = join(tmp, "AppData", "Local");
  process.env.USERPROFILE = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
  process.env.KIRO_REGION = "us-east-1";
  delete process.env.KIRO_CLI_DB_FILE;
  delete process.env.KIROCLI_DB_PATH;
  delete process.env.KIROCLI_TOKEN_KEY;
  process.env.CLAUDE_CONFIG_DIR = join(tmp, ".claude");
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = origLocalAppData;
  if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  if (origCliDbFile === undefined) delete process.env.KIRO_CLI_DB_FILE; else process.env.KIRO_CLI_DB_FILE = origCliDbFile;
  if (origCliDbPath === undefined) delete process.env.KIROCLI_DB_PATH; else process.env.KIROCLI_DB_PATH = origCliDbPath;
  if (origCliTokenKey === undefined) delete process.env.KIROCLI_TOKEN_KEY; else process.env.KIROCLI_TOKEN_KEY = origCliTokenKey;
  if (origClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = origClaudeConfigDir;
  globalThis.fetch = origFetch;
  console.warn = origWarn;
  removeTreeWithRetry(tmp);
});

function seedKiroCliDb(token: {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  profile_arn?: string;
  region?: string;
}) {
  // Host-resolved layout (issue #710): mirrors resolveKiroCliNativeSessionEntries.
  const dir = process.platform === "win32"
    ? join(tmp, "AppData", "Local", "Kiro-Cli")
    : process.platform === "darwin"
      ? join(tmp, "Library", "Application Support", "kiro-cli")
      : join(tmp, ".local", "share", "kiro-cli");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.sqlite3"));
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", ["kirocli:social:token", JSON.stringify(token)]);
  db.close();
}

function seedGrokAuth(token: {
  key: string;
  refresh_token: string;
  expires_at: string;
  user_id?: string;
  email?: string;
}) {
  const dir = join(tmp, ".grok");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "https://auth.x.ai::test": token }));
}

function seedClaudeCredentials(access: string, refresh: string, expires: number) {
  const dir = join(tmp, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: expires },
  }));
}

function xaiRefreshResponses(access = "xai-fresh", refresh = "rt-fresh"): Response[] {
  return [
    new Response(JSON.stringify({
      authorization_endpoint: "https://auth.x.ai/authorize",
      token_endpoint: "https://auth.x.ai/token",
    }), { status: 200 }),
    new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600 }), { status: 200 }),
  ];
}

function mockXaiRefreshFetch(access = "xai-fresh", refresh = "rt-fresh") {
  let discoveryCalls = 0;
  let tokenCalls = 0;
  const tokenBodies: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      tokenCalls++;
      tokenBodies.push(String(init.body));
      return xaiRefreshResponses(access, refresh)[1]!;
    }
    discoveryCalls++;
    return xaiRefreshResponses(access, refresh)[0]!;
  }) as typeof fetch;
  return {
    discoveryCount: () => discoveryCalls,
    tokenCount: () => tokenCalls,
    tokenBodies,
  };
}

function mockRefreshFetch(responses: Array<Response | Error>): { count: () => number } {
  let calls = 0;
  let i = 0;
  globalThis.fetch = (async () => {
    calls++;
    const next = responses[i++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { count: () => calls };
}

describe("oauth refresh hardening", () => {
  test("OAuth token-refresh flight 33 rejects and a stale same-key owner cannot delete replacement", async () => {
    await saveCredential("kiro", { access: "old", refresh: "rt-old", expires: 1, accountId: "flight-owner" });
    const accountId = getAccountSet("kiro")!.activeAccountId;
    const full = seedOAuthTokenRefreshFlightsForTests(Array.from({ length: 32 }, (_, index) => ({ key: `synthetic-${index}` })));
    const fetchBefore = mockRefreshFetch([]);
    try {
      await expect(getValidAccessTokenForAccount("kiro", accountId)).rejects.toBeInstanceOf(OAuthTokenRefreshBusyError);
      expect(fetchBefore.count()).toBe(0);
    } finally {
      for (const promise of full.promises) promise.catch(() => {});
      full.cleanup();
    }

    const stale = seedOAuthTokenRefreshFlightsForTests([{ key: `kiro\0${accountId}`, startedAt: Date.now() - 120_001 }]);
    const refresh = mockRefreshFetch([
      new Response(JSON.stringify({ accessToken: "fresh", refreshToken: "rt-fresh", expiresIn: 3600 }), { status: 200 }),
    ]);
    const replacement = getValidAccessTokenForAccount("kiro", accountId);
    await expect(stale.promises[0]!).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
    await expect(replacement).resolves.toBe("fresh");
    expect(refresh.count()).toBe(1);
    stale.cleanup();
  });
  test("valid stored credential returns without refresh", async () => {
    const mock = mockRefreshFetch([new Response("unexpected", { status: 500 })]);
    await saveCredential("kiro", { access: "aoa-valid", refresh: "rt", expires: Date.now() + 3600_000 });
    await expect(getValidAccessToken("kiro")).resolves.toBe("aoa-valid");
    expect(mock.count()).toBe(0);
  });

  test("concurrent expired Kiro refreshes share one request", async () => {
    const mock = mockRefreshFetch([
      new Response(JSON.stringify({ accessToken: "aoa-fresh", refreshToken: "rt-fresh", expiresIn: 3600 }), { status: 200 }),
    ]);
    await saveCredential("kiro", { access: "aoa-old", refresh: "rt-old", expires: Date.now() - 1 });
    const [a, b] = await Promise.all([getValidAccessToken("kiro"), getValidAccessToken("kiro")]);
    expect(a).toBe("aoa-fresh");
    expect(b).toBe("aoa-fresh");
    expect(mock.count()).toBe(1);
    expect(getCredential("kiro")?.refresh).toBe("rt-fresh");
  });

  test("stored Kiro account refresh does not import a different local CLI session", async () => {
    const mock = mockRefreshFetch([
      new Response(JSON.stringify({ accessToken: "aoa-refreshed", refreshToken: "rt-refreshed", expiresIn: 3600 }), { status: 200 }),
    ]);
    seedKiroCliDb({ access_token: "aoa-sqlite", refresh_token: "rt-sqlite", expires_at: "2099-01-01T00:00:00Z" });
    await saveCredential("kiro", { access: "aoa-old", refresh: "rt-old", expires: Date.now() - 1 });
    await expect(getValidAccessToken("kiro")).resolves.toBe("aoa-refreshed");
    expect(mock.count()).toBe(1);
    expect(getCredential("kiro")?.refresh).toBe("rt-refreshed");
    expect(getCredential("kiro")?.source).not.toBe("local-cli");
  });

  test("account-scoped Kiro OIDC refresh sends stored client registration and preserves metadata", async () => {
    const profileArn = "arn:aws:codewhisperer:eu-west-1:123456789012:profile/account-scoped";
    const urls: string[] = [];
    const bodies: unknown[] = [];
    globalThis.fetch = (async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        accessToken: "aoa-oidc-fresh",
        refreshToken: "rt-oidc-fresh",
        expiresIn: 3600,
      }), { status: 200 });
    }) as typeof fetch;
    await saveCredential("kiro", {
      access: "aoa-oidc-old",
      refresh: "rt-oidc-old",
      expires: Date.now() - 1,
      accountId: profileArn,
      kiro: {
        profileArn,
        apiRegion: "eu-west-1",
        ssoRegion: "eu-west-1",
        clientId: "stored-client",
        clientSecret: "stored-secret",
      },
    });

    await expect(getValidAccessToken("kiro")).resolves.toBe("aoa-oidc-fresh");
    expect(urls).toEqual(["https://oidc.eu-west-1.amazonaws.com/token"]);
    expect(bodies).toEqual([{
      grantType: "refresh_token",
      clientId: "stored-client",
      clientSecret: "stored-secret",
      refreshToken: "rt-oidc-old",
    }]);
    expect(getCredential("kiro")).toMatchObject({
      access: "aoa-oidc-fresh",
      refresh: "rt-oidc-fresh",
      accountId: profileArn,
      kiro: {
        profileArn,
        apiRegion: "eu-west-1",
        ssoRegion: "eu-west-1",
        clientId: "stored-client",
        clientSecret: "stored-secret",
      },
    });
  });

  test("failed Kiro refresh does not overwrite the stored account from local CLI", async () => {
    await saveCredential("kiro", { access: "aoa-old", refresh: "rt-old", expires: Date.now() - 1 });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      seedKiroCliDb({ access_token: "aoa-recovered", refresh_token: "rt-recovered", expires_at: "2099-01-01T00:00:00Z" });
      throw new Error("network down");
    }) as typeof fetch;

    await expect(getValidAccessToken("kiro")).rejects.toThrow("network down");
    expect(calls).toBe(1);
    expect(getCredential("kiro")?.refresh).toBe("rt-old");
    expect(getCredential("kiro")?.access).toBe("aoa-old");
  });

  test("late Kiro refresh cannot overwrite a newer reauthentication", async () => {
    await saveCredential("kiro", {
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1,
      accountId: "kiro-race-account",
      kiro: { profileArn: "old-profile", apiRegion: "us-east-1" },
    });
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const mayFinish = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = (async () => {
      started();
      await mayFinish;
      return new Response(JSON.stringify({ accessToken: "late-access", refreshToken: "late-refresh", expiresIn: 3600 }), { status: 200 });
    }) as typeof fetch;

    const pending = getValidAccessToken("kiro");
    await didStart;
    await saveCredential("kiro", {
      access: "reauth-access",
      refresh: "reauth-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "kiro-race-account",
      kiro: { profileArn: "reauth-profile", apiRegion: "eu-west-1" },
    });
    release();

    await expect(pending).resolves.toBe("reauth-access");
    expect(getCredential("kiro")).toMatchObject({
      access: "reauth-access",
      refresh: "reauth-refresh",
      kiro: { profileArn: "reauth-profile", apiRegion: "eu-west-1" },
    });
  });

  test("terminal Kiro refresh errors mark only the rejected generation for reauthentication", async () => {
    await saveCredential("kiro", {
      access: "expired-access",
      refresh: "revoked-refresh",
      expires: Date.now() - 1,
      accountId: "kiro-revoked-account",
    });
    mockRefreshFetch([
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "do not surface this detail" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ]);

    const error = await getValidAccessToken("kiro").then(
      () => undefined,
      reason => reason,
    );
    expect(error).toBeInstanceOf(OAuthLoginRequiredError);
    expect(String(error)).not.toContain("do not surface this detail");
    expect(getAccountSet("kiro")?.accounts[0]?.needsReauth).toBe(true);
  });

  test("same-profile local rotation persists the recovered desktop generation without stale registration", async () => {
    const profileArn = "arn:aws:codewhisperer:eu-west-1:123456789012:profile/persisted";
    seedKiroCliDb({
      access_token: "aoa-local",
      refresh_token: "rt-local-new",
      expires_at: "2099-01-01T00:00:00Z",
      profile_arn: profileArn,
      region: "eu-west-1",
    });
    await saveCredential("kiro", {
      access: "aoa-stored",
      refresh: "rt-stored-old",
      expires: Date.now() - 1,
      accountId: profileArn,
      source: "local-cli",
      kiro: {
        profileArn,
        ssoRegion: "eu-west-1",
        clientId: "stale-client",
        clientSecret: "stale-secret",
      },
    });
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      if (urls.length === 1) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return new Response(JSON.stringify({ accessToken: "aoa-recovered", expiresIn: 3600 }), { status: 200 });
    }) as typeof fetch;

    const access = await getValidAccessToken("kiro");
    expect(access).toBe("aoa-recovered");
    expect(urls).toEqual([
      "https://oidc.eu-west-1.amazonaws.com/token",
      "https://prod.eu-west-1.auth.desktop.kiro.dev/refreshToken",
    ]);
    expect(getCredential("kiro")).toMatchObject({
      access: "aoa-recovered",
      refresh: "rt-local-new",
      kiro: { profileArn, ssoRegion: "eu-west-1" },
    });
    expect(getCredential("kiro")?.kiro?.clientId).toBeUndefined();
    expect(getCredential("kiro")?.kiro?.clientSecret).toBeUndefined();
  });

  test("refresh preserves existing credential source metadata", async () => {
    mockRefreshFetch([
      new Response(JSON.stringify({ accessToken: "aoa-fresh", refreshToken: "rt-fresh", expiresIn: 3600 }), { status: 200 }),
    ]);
    await saveCredential("kiro", { access: "aoa-old", refresh: "rt-old", expires: Date.now() - 1, source: "manual" });

    await expect(getValidAccessToken("kiro")).resolves.toBe("aoa-fresh");
    expect(getCredential("kiro")?.source).toBe("manual");
  });

  test("newer Grok generation is adopted before xAI refresh with zero endpoint calls", async () => {
    const mock = mockRefreshFetch([new Response("unexpected", { status: 500 })]);
    await saveCredential("xai", {
      access: "xai-old", refresh: "rt-old", expires: Date.now() - 1, accountId: "user-1", source: "local-cli",
    });
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-new", expires_at: new Date(Date.now() + 3600_000).toISOString(), user_id: "user-1",
    });

    await expect(getValidAccessToken("xai")).resolves.toBe("xai-disk");
    expect(mock.count()).toBe(0);
    expect(getCredential("xai")?.refresh).toBe("rt-new");
    expect(getCredential("xai")?.source).toBe("local-cli");
  });

  test("malformed Grok generation is not adopted and falls through to refresh-resolution", async () => {
    await saveCredential("xai", {
      access: "xai-old", refresh: "rt-old", expires: Date.now() - 1, accountId: "user-1", source: "local-cli",
    });
    // Disk auth.json carries an unparseable expires_at; before the NaN guard this
    // generation was adopted as authoritative and never refreshed.
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-disk", expires_at: "not-a-date", user_id: "user-1",
    });
    const mock = mockXaiRefreshFetch();

    await expect(getValidAccessToken("xai")).resolves.toBe("xai-fresh");
    expect(mock.discoveryCount()).toBe(1);
    expect(mock.tokenCount()).toBe(1);
    expect(new URLSearchParams(mock.tokenBodies[0]).get("refresh_token")).toBe("rt-old");
    expect(getCredential("xai")?.source).toBe("oauth");
  });

  test("newer-expiry Grok access token is adopted when refresh generation is unchanged", async () => {
    const mock = mockRefreshFetch([new Response("unexpected", { status: 500 })]);
    await saveCredential("xai", {
      access: "xai-old", refresh: "rt-same", expires: Date.now() - 1, accountId: "user-1", source: "local-cli",
    });
    const diskExpires = Date.now() + 3600_000;
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-same", expires_at: new Date(diskExpires).toISOString(), user_id: "user-1",
    });

    await expect(getValidAccessToken("xai")).resolves.toBe("xai-disk");
    expect(mock.count()).toBe(0);
    expect(getCredential("xai")?.expires).toBe(diskExpires);
  });

  test("stale Grok generation refreshes once and detaches to OpenCodex ownership", async () => {
    await saveCredential("xai", {
      access: "xai-old", refresh: "rt-old", expires: Date.now() - 1, accountId: "user-1", source: "local-cli",
    });
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-old", expires_at: new Date(Date.now() - 2_000).toISOString(), user_id: "user-1",
    });
    const grokPath = join(tmp, ".grok", "auth.json");
    const before = readFileSync(grokPath);
    const mock = mockXaiRefreshFetch();
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      await expect(getValidAccessToken("xai")).resolves.toBe("xai-fresh");
    } finally {
      console.warn = originalWarn;
    }

    expect(mock.discoveryCount()).toBe(1);
    expect(mock.tokenCount()).toBe(1);
    expect(warnings).toEqual([[
      "[oauth:xai] Grok CLI credential was stale; refreshed into OpenCodex ownership. Grok CLI may require login again.",
    ]]);
    expect(getCredential("xai")?.refresh).toBe("rt-fresh");
    expect(getCredential("xai")?.source).toBe("oauth");
    expect(readFileSync(grokPath)).toEqual(before);
  });

  test("stale different Grok generation with earlier expiry is not adopted", async () => {
    const storedExpiry = Date.now() - 1;
    await saveCredential("xai", {
      access: "xai-ours", refresh: "rt-ours", expires: storedExpiry, accountId: "user-1", source: "local-cli",
    });
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-disk", expires_at: new Date(storedExpiry - 10_000).toISOString(), user_id: "user-1",
    });
    const mock = mockXaiRefreshFetch();

    await expect(getValidAccessToken("xai")).resolves.toBe("xai-fresh");
    expect(mock.discoveryCount()).toBe(1);
    expect(mock.tokenCount()).toBe(1);
    expect(new URLSearchParams(mock.tokenBodies[0]).get("refresh_token")).toBe("rt-ours");
    expect(getCredential("xai")?.source).toBe("oauth");
  });

  test("mismatched Grok identity is not adopted into a local-cli account", async () => {
    await saveCredential("xai", {
      access: "xai-ours", refresh: "rt-ours", expires: Date.now() - 1, accountId: "user-1", source: "local-cli",
    });
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-disk", expires_at: new Date(Date.now() + 3600_000).toISOString(), user_id: "user-2",
    });
    const mock = mockXaiRefreshFetch();

    await expect(getValidAccessToken("xai")).resolves.toBe("xai-fresh");
    expect(mock.discoveryCount()).toBe(1);
    expect(mock.tokenCount()).toBe(1);
    expect(new URLSearchParams(mock.tokenBodies[0]).get("refresh_token")).toBe("rt-ours");
    expect(getCredential("xai")?.accountId).toBe("user-1");
    expect(getCredential("xai")?.source).toBe("oauth");
  });

  test("concurrent xAI local-cli refreshes share reconciliation and one detach exchange", async () => {
    await saveCredential("xai", {
      access: "xai-old", refresh: "rt-old", expires: Date.now() - 1, accountId: "user-1", source: "local-cli",
    });
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-old", expires_at: new Date(Date.now() - 2_000).toISOString(), user_id: "user-1",
    });
    const mock = mockXaiRefreshFetch();

    const [a, b] = await Promise.all([getValidAccessToken("xai"), getValidAccessToken("xai")]);
    expect(a).toBe("xai-fresh");
    expect(b).toBe("xai-fresh");
    expect(mock.discoveryCount()).toBe(1);
    expect(mock.tokenCount()).toBe(1);
    expect(getCredential("xai")?.source).toBe("oauth");
  });

  test("Anthropic transient failures do not mark needsReauth", async () => {
    for (const [index, error] of [
      new AnthropicTokenError("server", 503, undefined),
      new AnthropicTokenError("timeout", undefined, undefined),
    ].entries()) {
      await saveCredential("anthropic", { access: `old-${index}`, refresh: `rt-old-${index}`, expires: 1, accountId: `acct-${index}` });
      const id = getAccountSet("anthropic")!.activeAccountId;
      await expect(refreshAnthropicAccountWithLock("anthropic", id, { ...OAUTH_PROVIDERS.anthropic!, refresh: async () => { throw error; } }, getAccountCredential("anthropic", id)!)).rejects.toBe(error);
      expect(getAccountSet("anthropic")!.accounts.find(account => account.id === id)!.needsReauth).toBeUndefined();
    }
  });

  test("Anthropic confirmed invalid_grant marks needsReauth", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    await expect(refreshAnthropicAccountWithLock("anthropic", id, { ...OAUTH_PROVIDERS.anthropic!, refresh: async () => { throw new AnthropicTokenError("bad grant", 400, "invalid_grant"); } }, credential)).rejects.toBeInstanceOf(OAuthLoginRequiredError);
    expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBe(true);
  });

  /**
   * A definitive non-terminal HTTP failure is retryable: the endpoint answered with a failure,
   * so the durable intent must not turn that promised retry into OAuthLoginRequiredError.
   * A timeout or unreadable response is different — the provider may already have rotated the
   * token, so that post-dispatch intent remains as the replay guard.
   */
  test("a definitive transient Anthropic HTTP failure leaves the account refreshable", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const transient = new AnthropicTokenError("server", 503, undefined);
    await expect(refreshAnthropicAccountWithLock("anthropic", id, {
      ...OAUTH_PROVIDERS.anthropic!,
      refresh: async () => { throw transient; },
    }, getAccountCredential("anthropic", id)!)).rejects.toBe(transient);
    expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();

    // Upstream recovers: the retry the caller was promised must actually succeed.
    await expect(refreshAnthropicAccountWithLock("anthropic", id, {
      ...OAUTH_PROVIDERS.anthropic!,
      refresh: async () => ({ access: "fresh", refresh: "rt-fresh", expires: Date.now() + 3_600_000 }),
    }, getAccountCredential("anthropic", id)!)).resolves.toBe("fresh");
    expect(getAccountSet("anthropic")!.accounts.find(account => account.id === id)!.needsReauth).toBeUndefined();
  });

  test("an Anthropic refresh with an uncertain post-dispatch outcome preserves its intent", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    const generation = credentialGeneration(credential);
    const timeout = new AnthropicTokenError("timeout", undefined, undefined);
    let refreshCalls = 0;
    const def = {
      ...OAUTH_PROVIDERS.anthropic!,
      refresh: async () => {
        refreshCalls += 1;
        throw timeout;
      },
    };

    await expect(refreshAnthropicAccountWithLock("anthropic", id, def, credential)).rejects.toBe(timeout);

    const pending = readOAuthRefreshIntent("anthropic", id);
    expect(pending).toMatchObject({ generation });
    expect(pending?.cleanupPending).toBeUndefined();
    expect(getAccountSet("anthropic")!.accounts.find(account => account.id === id)!.needsReauth).toBeUndefined();
    await expect(refreshAnthropicAccountWithLock("anthropic", id, def, credential))
      .rejects.toBeInstanceOf(OAuthLoginRequiredError);
    expect(refreshCalls).toBe(1);
    expect(readOAuthRefreshIntent("anthropic", id)).toEqual(pending);
  });

  test("a pre-dispatch Anthropic abort clears its unconsumed refresh intent", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    const aborted = new Error("aborted before dispatch");
    const controller = new AbortController();
    controller.abort(aborted);
    let calls = 0;

    await expect(refreshAnthropicAccountWithLock("anthropic", id, {
      ...OAUTH_PROVIDERS.anthropic!,
      refresh: async () => { calls += 1; throw new Error("must not run"); },
    }, credential, { signal: controller.signal })).rejects.toBe(aborted);

    expect(calls).toBe(0);
    expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
  });

  test("a failed pre-dispatch cleanup remains safely retryable", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    const controller = new AbortController();
    const aborted = new Error("aborted before dispatch");
    controller.abort(aborted);
    const realClear = storeModule.clearOAuthRefreshIntentIfMatch;
    let clearCalls = 0;
    const clearSpy = spyOn(storeModule, "clearOAuthRefreshIntentIfMatch").mockImplementation((...args) => {
      clearCalls += 1;
      if (clearCalls === 1) throw new Error("intent unlink failed");
      return realClear(...args);
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(refreshAnthropicAccountWithLock("anthropic", id, {
        ...OAUTH_PROVIDERS.anthropic!,
        refresh: async () => { throw new Error("must not dispatch"); },
      }, credential, { signal: controller.signal })).rejects.toBe(aborted);
      expect(readOAuthRefreshIntent("anthropic", id)?.cleanupPending).toBe("pre-dispatch");

      let retryCalls = 0;
      await expect(refreshAnthropicAccountWithLock("anthropic", id, {
        ...OAUTH_PROVIDERS.anthropic!,
        refresh: async () => {
          retryCalls += 1;
          return { access: "fresh", refresh: "rt-fresh", expires: Date.now() + 3_600_000 };
        },
      }, credential)).resolves.toBe("fresh");
      expect(retryCalls).toBe(1);
      expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test("a cleanup-marker persistence failure surfaces a typed error with the provider outcome", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    const transient = new AnthropicTokenError("server", 503, undefined);
    const markerFailure = new configModule.ConfigMutationLockError(
      "Could not acquire config mutation transaction",
      { cause: Object.assign(new Error("intent marker write failed"), { code: "EACCES" }) },
    );
    let markerCalls = 0;
    const markerSpy = spyOn(storeModule, "markOAuthRefreshIntentCleanupPending").mockImplementation(() => {
      markerCalls += 1;
      throw markerFailure;
    });
    try {
      let rejection: unknown;
      try {
        await refreshAnthropicAccountWithLock("anthropic", id, {
          ...OAUTH_PROVIDERS.anthropic!,
          refresh: async () => { throw transient; },
        }, credential);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(OAuthRefreshIntentIOError);
      expect(rejection).toMatchObject({
        operation: "mark-cleanup-pending",
        code: "OAUTH_REFRESH_INTENT_IO",
        cause: markerFailure,
        refreshError: transient,
      });
      expect(markerCalls).toBe(1);
      const pending = readOAuthRefreshIntent("anthropic", id);
      expect(pending?.cleanupPending).toBeUndefined();
      expect(getAccountSet("anthropic")!.accounts.find(account => account.id === id)!.needsReauth).toBeUndefined();
    } finally {
      markerSpy.mockRestore();
    }
  });

  test("transient cleanup-marker lock contention settles a retryable rejection without reauth", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    const transient = new AnthropicTokenError("server", 503, undefined);
    const realMark = storeModule.markOAuthRefreshIntentCleanupPending;
    let markerCalls = 0;
    const markerSpy = spyOn(storeModule, "markOAuthRefreshIntentCleanupPending").mockImplementation((...args) => {
      markerCalls += 1;
      if (markerCalls <= 2) {
        throw new configModule.ConfigMutationLockError(
          "Config mutation already in progress",
          { cause: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }) },
        );
      }
      return realMark(...args);
    });
    try {
      let providerCalls = 0;
      await expect(refreshAnthropicAccountWithLock("anthropic", id, {
        ...OAUTH_PROVIDERS.anthropic!,
        refresh: async () => {
          providerCalls += 1;
          throw transient;
        },
      }, credential)).rejects.toBe(transient);

      expect(providerCalls).toBe(1);
      expect(markerCalls).toBe(3);
      expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
      expect(getAccountSet("anthropic")!.accounts.find(account => account.id === id)!.needsReauth).toBeUndefined();

      await expect(refreshAnthropicAccountWithLock("anthropic", id, {
        ...OAUTH_PROVIDERS.anthropic!,
        refresh: async () => ({
          access: "fresh",
          refresh: "rt-fresh",
          expires: Date.now() + 3_600_000,
        }),
      }, getAccountCredential("anthropic", id)!)).resolves.toBe("fresh");
      expect(getAccountCredential("anthropic", id)?.access).toBe("fresh");
      expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
    } finally {
      markerSpy.mockRestore();
    }
  });

  test("persistent cleanup-marker lock contention stays bounded and preserves the replay guard", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    const generation = credentialGeneration(credential);
    const transient = new AnthropicTokenError("server", 503, undefined);
    let markerCalls = 0;
    let lastBusy: configModule.ConfigMutationLockError | undefined;
    const markerSpy = spyOn(storeModule, "markOAuthRefreshIntentCleanupPending").mockImplementation(() => {
      markerCalls += 1;
      lastBusy = new configModule.ConfigMutationLockError(
        "Config mutation already in progress",
        { cause: Object.assign(new Error("database table is locked"), { code: "SQLITE_LOCKED" }) },
      );
      throw lastBusy;
    });
    try {
      let providerCalls = 0;
      let rejection: unknown;
      try {
        await refreshAnthropicAccountWithLock("anthropic", id, {
          ...OAUTH_PROVIDERS.anthropic!,
          refresh: async () => {
            providerCalls += 1;
            throw transient;
          },
        }, credential);
      } catch (error) {
        rejection = error;
      }

      expect(providerCalls).toBe(1);
      expect(markerCalls).toBe(4);
      expect(rejection).toBeInstanceOf(OAuthRefreshIntentIOError);
      expect(rejection).toMatchObject({
        operation: "mark-cleanup-pending",
        code: "OAUTH_REFRESH_INTENT_IO",
        cause: lastBusy,
        refreshError: transient,
      });
      expect(getAccountCredential("anthropic", id)).toEqual(credential);
      expect(readOAuthRefreshIntent("anthropic", id)).toMatchObject({ generation });
      expect(readOAuthRefreshIntent("anthropic", id)?.cleanupPending).toBeUndefined();
      expect(getAccountSet("anthropic")!.accounts.find(account => account.id === id)!.needsReauth).toBeUndefined();
    } finally {
      markerSpy.mockRestore();
    }
  });

  test("a failed definitive-rejection cleanup is retried before the next Anthropic request", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    const generation = credentialGeneration(credential);
    const transient = new AnthropicTokenError("server", 503, undefined);
    const clearFailure = new Error("intent unlink failed");
    const realClear = storeModule.clearOAuthRefreshIntentIfMatch;
    const events: string[] = [];
    let clearCalls = 0;
    const clearSpy = spyOn(storeModule, "clearOAuthRefreshIntentIfMatch").mockImplementation((...args) => {
      clearCalls += 1;
      if (clearCalls === 1) {
        events.push("clear-fail");
        throw clearFailure;
      }
      events.push(args[2].cleanupPending ? "clear-recovery" : "clear-success");
      return realClear(...args);
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(refreshAnthropicAccountWithLock("anthropic", id, {
        ...OAUTH_PROVIDERS.anthropic!,
        refresh: async () => {
          events.push("provider-503");
          throw transient;
        },
      }, credential)).rejects.toBe(transient);

      expect(readOAuthRefreshIntent("anthropic", id)).toMatchObject({
        generation,
        cleanupPending: "definitive-rejection",
      });
      expect(getAccountSet("anthropic")!.accounts.find(account => account.id === id)!.needsReauth).toBeUndefined();

      let retryCalls = 0;
      await expect(refreshAnthropicAccountWithLock("anthropic", id, {
        ...OAUTH_PROVIDERS.anthropic!,
        refresh: async () => {
          events.push("provider-retry");
          retryCalls += 1;
          return { access: "fresh", refresh: "rt-fresh", expires: Date.now() + 3_600_000 };
        },
      }, getAccountCredential("anthropic", id)!)).resolves.toBe("fresh");
      expect(retryCalls).toBe(1);
      expect(clearCalls).toBe(3);
      expect(events).toEqual([
        "provider-503",
        "clear-fail",
        "clear-recovery",
        "provider-retry",
        "clear-success",
      ]);
      expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test("a persistently blocked cleanup fails operationally without replay or reauth", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    const transient = new AnthropicTokenError("server", 503, undefined);
    const cleanupFailure = new Error("intent unlink failed");
    const clearSpy = spyOn(storeModule, "clearOAuthRefreshIntentIfMatch").mockImplementation(() => {
      throw cleanupFailure;
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(refreshAnthropicAccountWithLock("anthropic", id, {
        ...OAUTH_PROVIDERS.anthropic!,
        refresh: async () => { throw transient; },
      }, credential)).rejects.toBe(transient);
      expect(readOAuthRefreshIntent("anthropic", id)?.cleanupPending).toBe("definitive-rejection");

      let retryCalls = 0;
      let rejection: unknown;
      try {
        await refreshAnthropicAccountWithLock("anthropic", id, {
          ...OAUTH_PROVIDERS.anthropic!,
          refresh: async () => {
            retryCalls += 1;
            return { access: "must-not-run", refresh: "must-not-run", expires: Date.now() + 3_600_000 };
          },
        }, credential);
      } catch (error) {
        rejection = error;
      }

      expect(retryCalls).toBe(0);
      expect(rejection).toBeInstanceOf(OAuthRefreshIntentIOError);
      expect(rejection).toMatchObject({
        operation: "resume-cleanup",
        code: "OAUTH_REFRESH_INTENT_IO",
        cause: cleanupFailure,
      });
      expect(getAccountSet("anthropic")!.accounts.find(account => account.id === id)!.needsReauth).toBeUndefined();
      expect(readOAuthRefreshIntent("anthropic", id)?.cleanupPending).toBe("definitive-rejection");
    } finally {
      warnSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test("Anthropic persistence failure after provider success preserves the replay guard", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    const generation = credentialGeneration(credential);
    const persistenceFailure = new Error("credential persistence failed");
    let refreshCalls = 0;
    const def = {
      ...OAUTH_PROVIDERS.anthropic!,
      refresh: async () => {
        refreshCalls += 1;
        return {
          access: "fresh",
          refresh: "rt-fresh",
          expires: Date.now() + 3_600_000,
        };
      },
    };
    const mergeSpy = spyOn(storeModule, "mergeAccountCredential").mockImplementation(async () => {
      throw persistenceFailure;
    });
    let pendingAfterFailure: ReturnType<typeof readOAuthRefreshIntent>;
    try {
      await expect(refreshAnthropicAccountWithLock("anthropic", id, def, credential))
        .rejects.toBe(persistenceFailure);

      const pending = readOAuthRefreshIntent("anthropic", id);
      pendingAfterFailure = pending;
      expect(pending).toMatchObject({ generation });
      expect(pending?.cleanupPending).toBeUndefined();
      expect(getAccountCredential("anthropic", id)).toEqual(credential);
      expect(getAccountSet("anthropic")!.accounts.find(account => account.id === id)!.needsReauth).toBeUndefined();
    } finally {
      mergeSpy.mockRestore();
    }
    await expect(refreshAnthropicAccountWithLock("anthropic", id, def, credential))
      .rejects.toBeInstanceOf(OAuthLoginRequiredError);
    expect(refreshCalls).toBe(1);
    expect(readOAuthRefreshIntent("anthropic", id)).toEqual(pendingAfterFailure);
  });

  test("post-persist intent cleanup failure does not turn Anthropic refresh success into failure", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    const oldGeneration = credentialGeneration(credential);
    const clearSpy = spyOn(storeModule, "clearOAuthRefreshIntentIfMatch").mockImplementation(() => {
      throw new Error("intent unlink failed");
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(refreshAnthropicAccountWithLock("anthropic", id, {
        ...OAUTH_PROVIDERS.anthropic!,
        refresh: async () => ({
          access: "fresh",
          refresh: "rt-fresh",
          expires: Date.now() + 3_600_000,
        }),
      }, credential)).resolves.toBe("fresh");

      expect(getAccountCredential("anthropic", id)?.access).toBe("fresh");
      expect(readOAuthRefreshIntent("anthropic", id)).toMatchObject({ generation: oldGeneration });
    } finally {
      warnSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test("Anthropic post-dispatch stale flight replacement stays retryable without replay or reauth", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const originalRefresh = OAUTH_PROVIDERS.anthropic!.refresh;
    let started!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    OAUTH_PROVIDERS.anthropic!.refresh = async (_refresh, signal) => {
      calls += 1;
      if (calls === 1) {
        started();
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return { access: "fresh", refresh: "rt-fresh", expires: Date.now() + 3_600_000 };
    };
    const staleOwner = getValidAccessTokenForAccount("anthropic", id);
    await didStart;
    const intent = readOAuthRefreshIntent("anthropic", id);
    expect(intent?.generation).toBe(credentialGeneration(getAccountCredential("anthropic", id)!));
    expect(intent?.flightId).toBeString();
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
    try {
      const replacement = getValidAccessTokenForAccount("anthropic", id);
      const [staleResult, replacementResult] = await Promise.allSettled([staleOwner, replacement]);
      expect(staleResult.status).toBe("rejected");
      expect(staleResult.status === "rejected" && staleResult.reason).toBeInstanceOf(OAuthTokenRefreshStaleError);
      expect(replacementResult.status).toBe("rejected");
      expect(replacementResult.status === "rejected" && replacementResult.reason).toBeInstanceOf(OAuthTokenRefreshStaleError);
      expect(calls).toBe(1);
      expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
      expect(readOAuthRefreshIntent("anthropic", id)).toMatchObject({
        ...intent,
        staleOwner: true,
      });
      await expect(getValidAccessTokenForAccount("anthropic", id)).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
      expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
      expect(calls).toBe(1);
    } finally {
      clock.mockRestore();
      OAUTH_PROVIDERS.anthropic!.refresh = originalRefresh;
    }
  });

  test("Anthropic pre-dispatch stale flight replacement clears its matching durable intent", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const generation = credentialGeneration(getAccountCredential("anthropic", id)!);
    const flightId = "aborted-pre-dispatch-owner";
    writeOAuthRefreshIntent("anthropic", id, generation, Date.now() - 120_001, flightId);
    const stale = seedOAuthTokenRefreshFlightsForTests([{
      key: `anthropic\0${id}`,
      startedAt: Date.now() - 120_001,
      flightId,
      dispatched: false,
    }]);
    const originalRefresh = OAUTH_PROVIDERS.anthropic!.refresh;
    let calls = 0;
    OAUTH_PROVIDERS.anthropic!.refresh = async () => {
      calls += 1;
      return { access: "fresh", refresh: "rt-fresh", expires: Date.now() + 3_600_000 };
    };
    try {
      const replacement = getValidAccessTokenForAccount("anthropic", id);
      await expect(stale.promises[0]!).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
      await expect(replacement).resolves.toBe("fresh");
      expect(calls).toBe(1);
      expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
      expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
    } finally {
      stale.cleanup();
      OAUTH_PROVIDERS.anthropic!.refresh = originalRefresh;
    }
  });

  test("Anthropic stale flight replacement preserves foreign same-generation intents", async () => {
    for (const [index, intentFlightId] of ["foreign-owner", undefined].entries()) {
      await saveCredential("anthropic", {
        access: `old-${index}`,
        refresh: `rt-old-${index}`,
        expires: 1,
        accountId: `acct-${index}`,
      });
      const id = getAccountSet("anthropic")!.activeAccountId;
      const generation = credentialGeneration(getAccountCredential("anthropic", id)!);
      const staleFlightId = `stale-owner-${index}`;
      writeOAuthRefreshIntent("anthropic", id, generation, Date.now() - 120_001, intentFlightId);
      const expectedIntent = readOAuthRefreshIntent("anthropic", id);
      const stale = seedOAuthTokenRefreshFlightsForTests([{
        key: `anthropic\0${id}`,
        startedAt: Date.now() - 120_001,
        flightId: staleFlightId,
        dispatched: false,
      }]);
      try {
        const replacement = getValidAccessTokenForAccount("anthropic", id);
        await expect(stale.promises[0]!).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
        await expect(replacement).rejects.toBeInstanceOf(OAuthLoginRequiredError);
        expect(readOAuthRefreshIntent("anthropic", id)).toEqual(expectedIntent);
        expect(getAccountSet("anthropic")!.accounts.find(account => account.id === id)?.needsReauth).toBe(true);
      } finally {
        stale.cleanup();
      }
    }
  });

  test("legacy OAuth refresh intent without flightId remains valid", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const legacy = {
      version: 1,
      provider: "anthropic",
      accountId: id,
      generation: credentialGeneration(getAccountCredential("anthropic", id)!),
      createdAt: Date.now() - 120_001,
    } as const;
    writeFileSync(getAuthRefreshIntentPath("anthropic", id), `${JSON.stringify(legacy)}\n`);

    expect(readOAuthRefreshIntent("anthropic", id)).toEqual(legacy);
    expect(readOAuthRefreshIntent("anthropic", id)?.uncertain).toBeUndefined();
    let refreshCalls = 0;
    await expect(refreshAnthropicAccountWithLock("anthropic", id, {
      ...OAUTH_PROVIDERS.anthropic!,
      refresh: async () => {
        refreshCalls += 1;
        return { access: "must-not-run", refresh: "must-not-run", expires: Date.now() + 3_600_000 };
      },
    }, getAccountCredential("anthropic", id)!)).rejects.toBeInstanceOf(OAuthLoginRequiredError);
    expect(refreshCalls).toBe(0);
    expect(readOAuthRefreshIntent("anthropic", id)).toEqual(legacy);
  });

  test("cleanup-pending CAS never rewrites a foreign same-generation attempt", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const generation = credentialGeneration(getAccountCredential("anthropic", id)!);
    const intent = writeOAuthRefreshIntent("anthropic", id, generation, Date.now());

    for (const foreign of [
      { ...intent, generation: "foreign-generation" },
      { ...intent, attemptId: "foreign-attempt" },
      { ...intent, flightId: "foreign-flight" },
      { ...intent, createdAt: intent.createdAt + 1 },
    ]) {
      expect(markOAuthRefreshIntentCleanupPending(
        "anthropic",
        id,
        foreign,
        "definitive-rejection",
      )).toBeUndefined();
      expect(storeModule.clearOAuthRefreshIntentIfMatch("anthropic", id, foreign)).toBe(false);
      expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent);
    }
  });

  test("a replaced obsolete intent blocks Anthropic redispatch", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    const obsolete = writeOAuthRefreshIntent("anthropic", id, "0".repeat(64));
    const replacement = { ...obsolete, attemptId: "foreign-attempt" };
    writeFileSync(getAuthRefreshIntentPath("anthropic", id), `${JSON.stringify(replacement)}\n`);
    const clearSpy = spyOn(storeModule, "clearOAuthRefreshIntentIfMatch").mockReturnValue(false);
    let refreshCalls = 0;
    try {
      await expect(refreshAnthropicAccountWithLock("anthropic", id, {
        ...OAUTH_PROVIDERS.anthropic!,
        refresh: async () => {
          refreshCalls += 1;
          return { access: "must-not-run", refresh: "must-not-run", expires: Date.now() + 3_600_000 };
        },
      }, credential)).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
      expect(refreshCalls).toBe(0);
      expect(readOAuthRefreshIntent("anthropic", id)).toEqual(replacement);
    } finally {
      clearSpy.mockRestore();
    }
  });

  test("cleanup-pending marker commit preserves an attempt replaced during comparison", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const path = getAuthRefreshIntentPath("anthropic", id);
    const generation = credentialGeneration(getAccountCredential("anthropic", id)!);
    const original = writeOAuthRefreshIntent("anthropic", id, generation, Date.now(), "original-flight");
    const replacement = {
      ...original,
      attemptId: "replacement-attempt",
      flightId: "replacement-flight",
    };

    expect(markOAuthRefreshIntentCleanupPending(
      "anthropic",
      id,
      original,
      "definitive-rejection",
      { beforeMarkCommit: () => writeFileSync(path, `${JSON.stringify(replacement)}\n`) },
    )).toBeUndefined();
    expect(readOAuthRefreshIntent("anthropic", id)).toEqual(replacement);
  });

  test("exact cleanup preserves an attempt replaced before unlink", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const path = getAuthRefreshIntentPath("anthropic", id);
    const generation = credentialGeneration(getAccountCredential("anthropic", id)!);
    const original = writeOAuthRefreshIntent("anthropic", id, generation, Date.now(), "original-flight");
    const replacement = {
      ...original,
      attemptId: "replacement-attempt",
      flightId: "replacement-flight",
    };

    expect(storeModule.clearOAuthRefreshIntentIfMatch(
      "anthropic",
      id,
      original,
      { beforeClearRecheck: () => writeFileSync(path, `${JSON.stringify(replacement)}\n`) },
    )).toBe(false);
    expect(readOAuthRefreshIntent("anthropic", id)).toEqual(replacement);
  });

  test("an invalid cleanup-pending marker fails closed as uncertain", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const intent = writeOAuthRefreshIntent(
      "anthropic",
      id,
      credentialGeneration(getAccountCredential("anthropic", id)!),
    );
    const { attemptId: _attemptId, ...withoutAttemptId } = intent;
    for (const invalid of [
      { ...intent, cleanupPending: "unsafe-retry" },
      { ...withoutAttemptId, cleanupPending: "definitive-rejection" },
      { ...intent, cleanupPending: "definitive-rejection", uncertain: true },
      { ...intent, cleanupPending: "definitive-rejection", staleOwner: true },
    ]) {
      writeFileSync(getAuthRefreshIntentPath("anthropic", id), `${JSON.stringify(invalid)}\n`);
      expect(readOAuthRefreshIntent("anthropic", id)?.uncertain).toBe(true);
    }
    let refreshCalls = 0;
    await expect(refreshAnthropicAccountWithLock("anthropic", id, {
      ...OAUTH_PROVIDERS.anthropic!,
      refresh: async () => {
        refreshCalls += 1;
        return { access: "must-not-run", refresh: "must-not-run", expires: Date.now() + 3_600_000 };
      },
    }, getAccountCredential("anthropic", id)!)).rejects.toBeInstanceOf(OAuthLoginRequiredError);
    expect(refreshCalls).toBe(0);
  });

  test("Anthropic never replays an outstanding oauth-source generation across re-entry", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-consumed", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    writeOAuthRefreshIntent("anthropic", id, credentialGeneration(credential), Date.now() - 120_001);
    let refreshCalls = 0;

    const attempt = () => refreshAnthropicAccountWithLock("anthropic", id, {
      ...OAUTH_PROVIDERS.anthropic!,
      refresh: async () => { refreshCalls++; throw new Error("must not replay"); },
    }, credential);

    await expect(attempt()).rejects.toBeInstanceOf(OAuthLoginRequiredError);
    await expect(attempt()).rejects.toBeInstanceOf(OAuthLoginRequiredError);

    expect(refreshCalls).toBe(0);
    expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBe(true);
    expect(readOAuthRefreshIntent("anthropic", id)?.generation).toBe(credentialGeneration(credential));
  });

  test("Anthropic treats a corrupt durable intent as outstanding and never refreshes", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-consumed", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    writeFileSync(getAuthRefreshIntentPath("anthropic", id), "not-json");
    let refreshCalls = 0;

    await expect(refreshAnthropicAccountWithLock("anthropic", id, {
      ...OAUTH_PROVIDERS.anthropic!,
      refresh: async () => { refreshCalls++; throw new Error("must not replay"); },
    }, credential)).rejects.toBeInstanceOf(OAuthLoginRequiredError);

    expect(refreshCalls).toBe(0);
    expect(readOAuthRefreshIntent("anthropic", id)?.uncertain).toBe(true);
  });

  test("Anthropic outstanding intent adopts a newer Claude credential without replay", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-consumed", expires: 1, source: "local-cli" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    writeOAuthRefreshIntent("anthropic", id, credentialGeneration(credential));
    seedClaudeCredentials("disk", "rt-new", Date.now() + 3600_000);
    let refreshCalls = 0;

    await expect(refreshAnthropicAccountWithLock("anthropic", id, {
      ...OAUTH_PROVIDERS.anthropic!,
      refresh: async () => { refreshCalls++; throw new Error("must not replay"); },
    }, credential)).resolves.toBe("disk");

    expect(refreshCalls).toBe(0);
    expect(getAccountCredential("anthropic", id)?.refresh).toBe("rt-new");
    expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
  });

  test("Anthropic successful refresh clears its intent and the new generation can refresh", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const calls: string[] = [];
    const def = {
      ...OAUTH_PROVIDERS.anthropic!,
      refresh: async (refresh: string) => {
        calls.push(refresh);
        return calls.length === 1
          ? { access: "fresh-1", refresh: "rt-new-1", expires: 1 }
          : { access: "fresh-2", refresh: "rt-new-2", expires: Date.now() + 3600_000 };
      },
    };

    await expect(refreshAnthropicAccountWithLock("anthropic", id, def, getAccountCredential("anthropic", id)!)).resolves.toBe("fresh-1");
    expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
    await expect(refreshAnthropicAccountWithLock("anthropic", id, def, getAccountCredential("anthropic", id)!)).resolves.toBe("fresh-2");

    expect(calls).toEqual(["rt-old", "rt-new-1"]);
    expect(getAccountCredential("anthropic", id)?.refresh).toBe("rt-new-2");
    expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
  });

  test("Anthropic late terminal failure does not mark a superseding generation", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const credential = getAccountCredential("anthropic", id)!;
    let reject!: () => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const pending = refreshAnthropicAccountWithLock("anthropic", id, {
      ...OAUTH_PROVIDERS.anthropic!,
      refresh: () => new Promise((_, rejectPromise) => { reject = () => rejectPromise(new AnthropicTokenError("late", 400, "invalid_grant")); started(); }),
    }, credential);
    await began;
    await saveCredential("anthropic", { access: "new", refresh: "rt-new", expires: Date.now() + 3600_000, accountId: "acct" });
    reject();
    await expect(pending).rejects.toBeInstanceOf(OAuthLoginRequiredError);
    expect(getCredential("anthropic")?.access).toBe("new");
    expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
  });

  test("Anthropic adopts a newer Claude Code generation without refreshing", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, source: "local-cli" });
    seedClaudeCredentials("disk", "rt-new", Date.now() + 3600_000);
    const mock = mockRefreshFetch([new Response("unexpected", { status: 500 })]);
    await expect(getValidAccessToken("anthropic")).resolves.toBe("disk");
    expect(mock.count()).toBe(0);
    expect(getCredential("anthropic")?.refresh).toBe("rt-new");
  });

  /**
   * The disk credential is committed before the observed intent is cleaned up. Cleanup is a
   * secondary durability concern, so an unlink failure must not throw over the committed
   * credential and turn a successful adoption into a caller-visible refresh error.
   */
  test("a cleanup failure after adopting a disk credential does not mask the committed token", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, source: "local-cli" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    const stored = getAccountCredential("anthropic", id)!;
    const pending = writeOAuthRefreshIntent("anthropic", id, credentialGeneration(stored));
    expect(markOAuthRefreshIntentCleanupPending(
      "anthropic",
      id,
      pending,
      "definitive-rejection",
    )).toMatchObject({ cleanupPending: "definitive-rejection" });

    seedClaudeCredentials("disk", "rt-new", Date.now() + 3600_000);
    const mock = mockRefreshFetch([new Response("unexpected", { status: 500 })]);

    // The intent carries an attemptId, so cleanup runs through the exact-match clear.
    // Fail it the way a locked or read-only file would.
    let cleanupAttempts = 0;
    const cleanupSpy = spyOn(storeModule, "clearOAuthRefreshIntentIfMatch").mockImplementation(() => {
      cleanupAttempts += 1;
      throw new OAuthRefreshIntentIOError("clear-cleanup-pending", new Error("forced cleanup failure (EROFS)"));
    });
    try {
      await expect(getValidAccessToken("anthropic")).resolves.toBe("disk");
    } finally {
      cleanupSpy.mockRestore();
    }

    // The adoption committed and no network refresh was attempted; only the guard survives.
    expect(cleanupAttempts).toBeGreaterThan(0);
    expect(mock.count()).toBe(0);
    expect(getCredential("anthropic")?.refresh).toBe("rt-new");
    expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
    expect(readOAuthRefreshIntent("anthropic", id)?.cleanupPending).toBe("definitive-rejection");
  });

  test("marked Anthropic local-cli account lazily recovers only from a newer disk generation", async () => {
    await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, source: "local-cli" });
    const id = getAccountSet("anthropic")!.activeAccountId;
    await markAccountNeedsReauth("anthropic", id, true);
    seedClaudeCredentials("same", "rt-old", 1);
    await expect(getValidAccessToken("anthropic")).rejects.toBeInstanceOf(OAuthLoginRequiredError);
    seedClaudeCredentials("recovered", "rt-new", Date.now() + 3600_000);
    await expect(getValidAccessToken("anthropic")).resolves.toBe("recovered");
    expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
  });

  test("Nous refresh-intent pre-dispatch write failure is non-terminal: account stays valid, fetch never runs", async () => {
    // Seed an expired Nous credential so the coordinator actually refreshes.
    await saveCredential("nous", { access: "old", refresh: "rt-old", expires: 1, accountId: "nous-acct" });
    const id = getAccountSet("nous")!.activeAccountId;
    const credential = getAccountCredential("nous", id)!;

    let fetchCalled = 0;
    globalThis.fetch = (async () => {
      fetchCalled += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    // Force the durable intent write (atomicWriteFile) to fail, deterministically
    // on every platform. The write happens BEFORE dispatch, so the coordinator
    // must surface a non-terminal operational error (not OAuthLoginRequiredError),
    // never call fetch, and NOT mark the account needsReauth — local persistence
    // breakage is not credential death.
    const writeSpy = spyOn(configModule, "atomicWriteFile").mockImplementation(() => {
      throw new Error("forced durable write failure (disk full)");
    });
    try {
      await expect(getValidAccessTokenForAccount("nous", id))
        .rejects.toBeInstanceOf(RefreshIntentIOError);
      expect(fetchCalled).toBe(0);
      expect(getCredential("nous")?.refresh).toBe("rt-old");
      expect(getAccountSet("nous")!.accounts[0]!.needsReauth).toBeUndefined();
    } finally {
      writeSpy.mockRestore();
    }
  });

  function nousAccessJwt(sub: string, scope: string = "inference:invoke"): string {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
      scope,
    })).toString("base64url");
    return `${header}.${payload}.sig`;
  }

  test("Nous coordinator happy path: rotated RT-B is persisted and the old RT-A intent is cleared", async () => {
    await saveCredential("nous", { access: "old", refresh: "rt-old", expires: 1, accountId: "nous-happy" });
    const id = getAccountSet("nous")!.activeAccountId;
    const credential = getAccountCredential("nous", id)!;

    const access = nousAccessJwt("nous-happy");
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: access,
      refresh_token: "rt-new",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    const resolved = await getValidAccessTokenForAccount("nous", id);
    expect(resolved).toBe(access);
    expect(getCredential("nous")?.refresh).toBe("rt-new");
    // After the store durably persisted RT-B, the coordinator cleared the
    // old-token intent: RT-A is no longer blocked.
    expect(nousRefreshIntentBlocksReplay("rt-old")).toBe(false);
    expect(getAccountSet("nous")!.accounts[0]!.needsReauth).toBeUndefined();
  });

  test("Nous post-persist intent-cleanup failure is non-fatal: rotation still resolves with RT-B", async () => {
    await saveCredential("nous", { access: "old", refresh: "rt-old", expires: 1, accountId: "nous-cleanup" });
    const id = getAccountSet("nous")!.activeAccountId;
    const credential = getAccountCredential("nous", id)!;

    const access = nousAccessJwt("nous-cleanup");
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: access,
      refresh_token: "rt-new",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    // Force the post-persist bookkeeping cleanup to fail. The rotated credential
    // is already committed by mergeAccountCredential at this point, so the
    // coordinator must still resolve with the fresh access token and must NOT
    // mark the account needsReauth.
    const cleanupSpy = spyOn(nousModule, "clearNousRefreshIntent").mockImplementation(() => {
      throw new Error("forced cleanup failure (EROFS)");
    });
    try {
      const resolved = await getValidAccessTokenForAccount("nous", id);
      expect(resolved).toBe(access);
      // The committed rotation survives the cleanup failure.
      expect(getCredential("nous")?.refresh).toBe("rt-new");
      expect(getAccountSet("nous")!.accounts[0]!.needsReauth).toBeUndefined();
      // The stale old-token intent may remain; it keys RT-A, which is no longer
      // stored, so it blocks nothing for the committed RT-B credential.
      expect(nousRefreshIntentBlocksReplay("rt-old")).toBe(true);
    } finally {
      cleanupSpy.mockRestore();
    }
  });

  test("Nous terminal insufficient_scope preserves rotated RT-B, marks needsReauth, and blocks the unusable access", async () => {
    await saveCredential("nous", { access: "old", refresh: "rt-old", expires: 1, accountId: "nous-scope" });
    const id = getAccountSet("nous")!.activeAccountId;
    const credential = getAccountCredential("nous", id)!;

    // RT-A is consumed; the server returns RT-B but an access JWT WITHOUT the
    // required inference:invoke scope.
    const unusableAccess = nousAccessJwt("nous-scope", "billing:manage");
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: unusableAccess,
      refresh_token: "rt-new",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    await expect(getValidAccessTokenForAccount("nous", id)).rejects.toBeInstanceOf(OAuthLoginRequiredError);

    // RT-B was persisted generation-safely: the stored refresh token is rt-new.
    const stored = getCredential("nous");
    expect(stored?.refresh).toBe("rt-new");
    // The unusable access token is NOT persisted as valid: the placeholder is
    // empty and the expiry is in the past, so it can never be routed.
    expect(stored?.access).toBe("");
    expect(stored!.expires).toBe(0);
    // RT-A's intent was cleared only after RT-B was durably persisted.
    expect(nousRefreshIntentBlocksReplay("rt-old")).toBe(false);
    // The account requires reauthentication.
    expect(getAccountSet("nous")!.accounts[0]!.needsReauth).toBe(true);
  });

  test("Nous RT-B persistence failure keeps RT-A intent blocking and still marks needsReauth", async () => {
    await saveCredential("nous", { access: "old", refresh: "rt-old", expires: 1, accountId: "nous-persist-fail" });
    const id = getAccountSet("nous")!.activeAccountId;
    const credential = getAccountCredential("nous", id)!;

    const unusableAccess = nousAccessJwt("nous-persist-fail", "billing:manage");
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: unusableAccess,
      refresh_token: "rt-new",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    // Force the RT-B persistence (mergeAccountCredential) to fail.
    const mergeSpy = spyOn(storeModule, "mergeAccountCredential").mockImplementation(() => {
      throw new Error("forced RT-B persistence failure (disk full)");
    });
    try {
      await expect(getValidAccessTokenForAccount("nous", id)).rejects.toBeInstanceOf(OAuthLoginRequiredError);
      // RT-A was consumed; its intent must remain blocking (never cleared).
      expect(nousRefreshIntentBlocksReplay("rt-old")).toBe(true);
      // The stored credential is untouched (still RT-A, still the old access).
      expect(getCredential("nous")?.refresh).toBe("rt-old");
      expect(getAccountSet("nous")!.accounts[0]!.needsReauth).toBe(true);
    } finally {
      mergeSpy.mockRestore();
    }
  });

  test("Nous RT-B preservation never overwrites a newer concurrent generation", async () => {
    await saveCredential("nous", { access: "old", refresh: "rt-old", expires: 1, accountId: "nous-superseded" });
    const id = getAccountSet("nous")!.activeAccountId;
    const credential = getAccountCredential("nous", id)!;

    const unusableAccess = nousAccessJwt("nous-superseded", "billing:manage");
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: unusableAccess,
      refresh_token: "rt-new",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    // A concurrent refresh already committed a newer generation (RT-C) before
    // this attempt's RT-B persistence runs; the merge must report superseded
    // and never overwrite it.
    const newerCredential = {
      access: "newer-access",
      refresh: "rt-concurrent",
      expires: Date.now() + 3600_000,
      accountId: "nous-superseded",
    };
    // The concurrent refresh commits RT-C through the real store write before
    // this attempt's RT-B persistence is detected as superseded.
    const realMerge = storeModule.mergeAccountCredential;
    const mergeSpy = spyOn(storeModule, "mergeAccountCredential").mockImplementation(async (provider, accountId, cred, opts) => {
      await realMerge(provider, accountId, newerCredential as never, { expectedGeneration: opts?.expectedGeneration });
      return { superseded: true, stored: newerCredential as never };
    });
    try {
      await expect(getValidAccessTokenForAccount("nous", id)).rejects.toBeInstanceOf(OAuthLoginRequiredError);
      // The concurrent credential is untouched.
      expect(getCredential("nous")?.refresh).toBe("rt-concurrent");
      // RT-A's intent is not cleared (RT-A was consumed; a later refresh of the
      // newer generation manages its own intent).
      expect(nousRefreshIntentBlocksReplay("rt-old")).toBe(true);
      // The newer generation is NOT marked needsReauth (generation-safe no-op).
      expect(getAccountSet("nous")!.accounts[0]!.needsReauth).toBeUndefined();
    } finally {
      mergeSpy.mockRestore();
    }
  });

  test("Nous RT-B preservation does not mark a credential committed by a concurrent writer", async () => {
    await saveCredential("nous", { access: "old", refresh: "rt-old", expires: 1, accountId: "nous-toctou" });
    const id = getAccountSet("nous")!.activeAccountId;

    const unusableAccess = nousAccessJwt("nous-toctou", "billing:manage");
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: unusableAccess,
      refresh_token: "rt-new",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    // The recovery write (RT-B) succeeds, then a concurrent login commits a
    // fresh, fully usable credential before the coordinator marks needsReauth.
    // The persisted-branch generation must be the one THIS write produced, so
    // the newer credential is never marked needsReauth.
    const realMerge = storeModule.mergeAccountCredential;
    const mergeSpy = spyOn(storeModule, "mergeAccountCredential").mockImplementation(async (provider, accountId, cred, opts) => {
      const outcome = await realMerge(provider, accountId, cred, opts);
      await saveCredential("nous", {
        access: nousAccessJwt("nous-toctou"),
        refresh: "rt-fresh-login",
        expires: Date.now() + 3600_000,
        accountId: "nous-toctou",
      });
      return outcome;
    });
    try {
      await expect(getValidAccessTokenForAccount("nous", id)).rejects.toBeInstanceOf(OAuthLoginRequiredError);
      // The concurrently committed, usable credential must remain usable.
      expect(getCredential("nous")?.refresh).toBe("rt-fresh-login");
      expect(getAccountSet("nous")!.accounts[0]!.needsReauth).toBeUndefined();
    } finally {
      mergeSpy.mockRestore();
    }
  });

  test("Nous RT-B cleanup failure after successful persistence keeps RT-B and marks needsReauth", async () => {
    await saveCredential("nous", { access: "old", refresh: "rt-old", expires: 1, accountId: "nous-cleanup-fail" });
    const id = getAccountSet("nous")!.activeAccountId;
    const credential = getAccountCredential("nous", id)!;

    const unusableAccess = nousAccessJwt("nous-cleanup-fail", "billing:manage");
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: unusableAccess,
      refresh_token: "rt-new",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    const cleanupSpy = spyOn(nousModule, "clearNousRefreshIntent").mockImplementation(() => {
      throw new Error("forced cleanup failure (EROFS)");
    });
    try {
      await expect(getValidAccessTokenForAccount("nous", id)).rejects.toBeInstanceOf(OAuthLoginRequiredError);
      // RT-B survived the cleanup failure.
      expect(getCredential("nous")?.refresh).toBe("rt-new");
      expect(getAccountSet("nous")!.accounts[0]!.needsReauth).toBe(true);
      // The stale RT-A intent may remain harmlessly (RT-A is no longer stored).
      expect(nousRefreshIntentBlocksReplay("rt-old")).toBe(true);
    } finally {
      cleanupSpy.mockRestore();
    }
  });
});
