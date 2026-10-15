import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getValidAccessTokenForAccount,
  MAX_OAUTH_TOKEN_REFRESH_WAITERS,
  OAuthTokenRefreshBusyError,
  OAuthTokenRefreshStaleError,
  OAUTH_PROVIDERS,
  seedOAuthTokenRefreshFlightsForTests,
} from "../../src/oauth";
import { credentialGeneration, getAccountCredential, getAccountSet, readOAuthRefreshIntent,
  saveCredential, writeOAuthRefreshIntent } from "../../src/oauth/store";
import { AnthropicTokenError } from "../../src/oauth/anthropic";
import * as store from "../../src/oauth/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const original = { home: process.env.HOME, ocx: process.env.OPENCODEX_HOME,
  claude: process.env.CLAUDE_CONFIG_DIR, fetch: globalThis.fetch,
  anthropic: OAUTH_PROVIDERS.anthropic!.refresh, kimi: OAUTH_PROVIDERS.kimi!.refresh };
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "oauth-stale-capacity-"));
  process.env.HOME = home;
  process.env.OPENCODEX_HOME = join(home, "ocx");
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "{}");
  globalThis.fetch = (async () => Response.json({ account: { uuid: "synthetic-stale-account" } })) as unknown as typeof fetch;
});
afterEach(() => {
  OAUTH_PROVIDERS.anthropic!.refresh = original.anthropic;
  OAUTH_PROVIDERS.kimi!.refresh = original.kimi;
  globalThis.fetch = original.fetch;
  for (const [key, value] of [["HOME", original.home], ["OPENCODEX_HOME", original.ocx], ["CLAUDE_CONFIG_DIR", original.claude]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  removeTreeWithRetry(home);
});
async function seed(provider: "anthropic" | "kimi") {
  await saveCredential(provider, { access: "fixture-old", refresh: "fixture-refresh", expires: 1, accountId: "fixture-account" });
  return getAccountSet(provider)!.activeAccountId;
}

// A rejected admission must not discard the stale owner's generation-bound intent evidence.
test("saturated stale post-dispatch owner remains retryable after all 256 consumers settle", async () => {
  const id = await seed("anthropic");
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  OAUTH_PROVIDERS.anthropic!.refresh = async (_token, signal) => {
    calls++;
    started();
    return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  };
  const waiting = Array.from({ length: MAX_OAUTH_TOKEN_REFRESH_WAITERS }, () =>
    getValidAccessTokenForAccount("anthropic", id).catch(error => error));
  await entered;
  const intent = readOAuthRefreshIntent("anthropic", id);
  expect(intent?.flightId).toBeString();
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
  try {
    await expect(getValidAccessTokenForAccount("anthropic", id)).rejects.toBeInstanceOf(OAuthTokenRefreshBusyError);
    expect((await Promise.all(waiting)).every(error => error instanceof OAuthTokenRefreshStaleError)).toBe(true);
    await expect(getValidAccessTokenForAccount("anthropic", id)).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
    expect(calls).toBe(1);
    expect(getAccountSet("anthropic")!.accounts.find(a => a.id === id)?.needsReauth).not.toBe(true);
    expect(readOAuthRefreshIntent("anthropic", id)).toMatchObject({ ...intent, staleOwner: true });
  } finally { clock.mockRestore(); await Promise.all(waiting); }
});

test("saturated stale pre-dispatch owner retains evidence for one safe replacement after capacity releases", async () => {
  const id = await seed("anthropic");
  const kimiId = await seed("kimi");
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  OAUTH_PROVIDERS.kimi!.refresh = async () => {
    started(); await blocked;
    return { access: "fixture-kimi-new", refresh: "fixture-kimi-next", expires: Date.now() + 3_600_000 };
  };
  let calls = 0;
  OAUTH_PROVIDERS.anthropic!.refresh = async () => {
    calls++;
    return { access: "fixture-anthropic-new", refresh: "fixture-anthropic-next", expires: Date.now() + 3_600_000 };
  };
  const waiting = Array.from({ length: MAX_OAUTH_TOKEN_REFRESH_WAITERS }, () =>
    getValidAccessTokenForAccount("kimi", kimiId).catch(error => error));
  await entered;
  const flightId = "fixture-pre-dispatch-owner";
  writeOAuthRefreshIntent("anthropic", id, credentialGeneration(getAccountCredential("anthropic", id)!), Date.now() - 120_001, flightId);
  const stale = seedOAuthTokenRefreshFlightsForTests([{ key: `anthropic\0${id}`, startedAt: Date.now() - 120_001, flightId, dispatched: false }]);
  const stopped = stale.promises[0]!.catch(error => error);
  try {
    await expect(getValidAccessTokenForAccount("anthropic", id)).rejects.toBeInstanceOf(OAuthTokenRefreshBusyError);
    expect(await stopped).toBeInstanceOf(OAuthTokenRefreshStaleError);
    finish(); await Promise.all(waiting);
    await expect(getValidAccessTokenForAccount("anthropic", id)).resolves.toBe("fixture-anthropic-new");
    expect(calls).toBe(1);
    expect(getAccountSet("anthropic")!.accounts.find(a => a.id === id)?.needsReauth).not.toBe(true);
    expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
  } finally { finish(); await Promise.all(waiting); stale.cleanup(); }
});

for (const outcome of ["rejected", "rotated", "marker-io"] as const) {
  test(`saturated stale owner preserves late ${outcome} settlement`, async () => {
    const id = await seed("anthropic");
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    let calls = 0;
    OAUTH_PROVIDERS.anthropic!.refresh = async () => {
      calls++;
      if (calls === 1) {
        started(); await blocked; // Deliberately ignore abort, like the real Anthropic adapter.
        if (outcome === "rejected") throw new AnthropicTokenError("fixture unavailable", 503, undefined);
        if (outcome === "marker-io") throw new OAuthTokenRefreshStaleError();
      }
      return { access: "fixture-late-new", refresh: "fixture-late-next", expires: Date.now() + 3_600_000 };
    };
    const waiting = Array.from({ length: MAX_OAUTH_TOKEN_REFRESH_WAITERS }, () =>
      getValidAccessTokenForAccount("anthropic", id).catch(error => error));
    await entered;
    const intent = readOAuthRefreshIntent("anthropic", id);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
    const marker = outcome === "marker-io"
      ? spyOn(store, "markOAuthRefreshIntentStaleOwner").mockImplementation(() => { throw new Error("fixture retirement IO failure"); })
      : undefined;
    try {
      await expect(getValidAccessTokenForAccount("anthropic", id)).rejects.toBeInstanceOf(OAuthTokenRefreshBusyError);
      expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent);
      finish();
      const settled = await Promise.all(waiting);
      expect(settled.every(result => outcome === "rotated" ? result === "fixture-late-new" : result instanceof OAuthTokenRefreshStaleError)).toBe(true);
      if (outcome === "marker-io") {
        expect(marker).toHaveBeenCalledTimes(1);
        expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent);
        marker!.mockRestore();
        clock.mockRestore(); // Retained aborted owners remain stale even if wall-clock time moves back.
        await expect(getValidAccessTokenForAccount("anthropic", id)).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
        expect(readOAuthRefreshIntent("anthropic", id)).toMatchObject({ ...intent, staleOwner: true });
        expect(calls).toBe(1);
      } else {
        expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
        await expect(getValidAccessTokenForAccount("anthropic", id)).resolves.toBe("fixture-late-new");
        expect(calls).toBe(outcome === "rejected" ? 2 : 1);
      }
      expect(getAccountSet("anthropic")!.accounts.find(a => a.id === id)?.needsReauth).not.toBe(true);
    } finally { marker?.mockRestore(); clock.mockRestore(); finish(); await Promise.all(waiting); }
  });
}

for (const outcome of ["rejected", "marker-io"] as const) {
  test(`unsaturated stale owner retains late ${outcome} evidence until settlement`, async () => {
    const id = await seed("anthropic");
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    let calls = 0;
    OAUTH_PROVIDERS.anthropic!.refresh = async () => {
      if (++calls === 1) {
        started(); await blocked;
        if (outcome === "rejected") throw new AnthropicTokenError("fixture unavailable", 503, undefined);
        throw new OAuthTokenRefreshStaleError();
      }
      return { access: "fixture-unsaturated-new", refresh: "fixture-unsaturated-next", expires: Date.now() + 3_600_000 };
    };
    const old = getValidAccessTokenForAccount("anthropic", id).catch(error => error);
    await entered;
    const intent = readOAuthRefreshIntent("anthropic", id);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
    const marker = spyOn(store, "markOAuthRefreshIntentStaleOwner");
    const info = spyOn(console, "info").mockImplementation(() => {});
    if (outcome === "marker-io") marker.mockImplementation(() => { throw new Error("fixture retirement IO failure"); });
    let replacement: Promise<unknown[]> | undefined;
    try {
      replacement = Promise.all(Array.from({ length: 8 }, () =>
        getValidAccessTokenForAccount("anthropic", id).catch(error => error)));
      await Promise.resolve(); await Promise.resolve();
      // The old attempt still holds the lock and has no definitive result. No marker yet.
      expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent);
      expect(marker).not.toHaveBeenCalled();
      finish();
      expect(await old).toBeInstanceOf(OAuthTokenRefreshStaleError);
      const results = await replacement;
      if (outcome === "rejected") {
        expect(results).toEqual(Array(8).fill("fixture-unsaturated-new"));
        expect(calls).toBe(2);
        expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
      } else {
        expect(results.every(result => result instanceof OAuthTokenRefreshStaleError)).toBe(true);
        expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent);
        const notices = info.mock.calls.map(([message]) => message)
          .filter(message => String(message).includes("OAuth refresh flight retirement deferred"));
        expect(notices).toEqual(["[opencodex] OAuth refresh flight retirement deferred provider=anthropic reason=storage_failure"]);
        marker.mockRestore(); clock.mockRestore();
        await expect(getValidAccessTokenForAccount("anthropic", id)).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
        expect(readOAuthRefreshIntent("anthropic", id)).toMatchObject({ ...intent, staleOwner: true });
        expect(calls).toBe(1);
      }
      expect(getAccountSet("anthropic")!.accounts.find(row => row.id === id)?.needsReauth).not.toBe(true);
    } finally { info.mockRestore(); marker.mockRestore(); clock.mockRestore(); finish(); await old; await replacement; }
  });
}
