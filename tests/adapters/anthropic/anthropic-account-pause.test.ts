import { rotateAnthropicAccountOn429 } from "../../helpers/anthropic-shared-quota";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState } from "../../../src/codex/pool-rotation";
import { fetchProviderModels } from "../../../src/codex/catalog/provider-models";
import { clearModelCache } from "../../../src/codex/model-cache";
import * as outbound from "../../../src/lib/provider-outbound";
import { OAuthAccountPausedError, OAuthLoginRequiredError, OAUTH_PROVIDERS, refreshAnthropicAccountWithLock } from "../../../src/oauth";
import { AnthropicTokenError } from "../../../src/oauth/anthropic";
import * as localTokens from "../../../src/oauth/local-token-detect";
import {
  bindAnthropicSessionAffinity, clearAnthropicAccountPoolState, getAnthropicAccountHealthSnapshot,
  getAnthropicPoolAccessSnapshot, getEligibleAnthropicAccounts, hasAnthropicFailoverQuorum,
  promoteAnthropicActiveAccount, resolveAnthropicAccountForSession,
} from "../../../src/oauth/anthropic-routing";
import {
  captureOAuthAccountSelection, createOAuthRefreshIntentLock, getAccountCredential, getAccountSet,
  markAccountNeedsReauth, removeAccount, saveAccountCredential, saveCredential, setAccountPaused, setActiveAccount,
} from "../../../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import { fetchAnthropicQuota } from "../../../src/providers/quota/vendor-probes-oauth";
import type { OcxAccountPoolQuotaWindow, OcxAccountPoolRotationStrategy, OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const originalFetchForSuite = globalThis.fetch;
let home: string;
let ids: string[];
beforeEach(async () => {
  globalThis.fetch = (async () => { throw new Error("Unexpected network request in account-pause test"); }) as typeof fetch;
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-pause-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache();
  for (let i = 0; i < 3; i++) await saveCredential("anthropic", {
    access: `synthetic-access-${i}`, refresh: `synthetic-refresh-${i}`,
    expires: Date.now() + 3_600_000, accountId: `pause-${i}`, source: "oauth",
  });
  ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
});
afterEach(() => {
  globalThis.fetch = originalFetchForSuite;
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
function config(enabled = true, strategy: OcxAccountPoolRotationStrategy = "quota", quotaWindow: OcxAccountPoolQuotaWindow = "five-hour"): OcxConfig {
  return { port: 0, defaultProvider: "anthropic", providers: {
    anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
  }, anthropicAccountPool: { enabled, strategy, quotaWindow } };
}

for (const strategy of ["quota", "round-robin", "fill-first"] as const) {
  for (const window of ["five-hour", "weekly", "max-utilization"] as const) {
    test(`${strategy}/${window}: paused active, manual and affined accounts cannot win`, async () => {
      const [a, b, c] = ids as [string, string, string];
      const cfg = config(true, strategy, window);
      resolveAnthropicAccountForSession("session", cfg); // Cache the initial manual preference.
      bindAnthropicSessionAffinity("session", a);
      setCachedProviderAccountQuotaForTests("anthropic", a, { fiveHourPercent: 0, weeklyPercent: 0, updatedAt: Date.now() });
      await setAccountPaused("anthropic", a, true);
      await setAccountPaused("anthropic", b, true);
      expect(getEligibleAnthropicAccounts()).toEqual([c]);
      expect(resolveAnthropicAccountForSession("session", cfg).accountId).toBe(c);
      expect(resolveAnthropicAccountForSession(null, cfg).accountId).toBe(c);
      expect(rotateAnthropicAccountOn429(cfg, b, "60")).toBe(c);
    });
  }
}

test("pause invalidates quorum immediately; disabled-pool reactive failover skips paused successors", async () => {
  const [a, b, c] = ids as [string, string, string];
  expect(hasAnthropicFailoverQuorum()).toBe(true);
  await setAccountPaused("anthropic", b, true);
  expect(rotateAnthropicAccountOn429(config(false), a, "60")).toBe(c);
  await setAccountPaused("anthropic", a, true);
  expect(hasAnthropicFailoverQuorum()).toBe(false);
  // The turn on A was already sent when it was paused; B stays excluded, C can recover it.
  expect(rotateAnthropicAccountOn429(config(false), a, "60")).toBe(c);
  await setAccountPaused("anthropic", b, false);
  expect(hasAnthropicFailoverQuorum()).toBe(true);
});

test("pause does not promote a background local-CLI credential within the refresh skew", async () => {
  const [a, b, c] = ids as [string, string, string];
  const background = getAccountCredential("anthropic", b)!;
  await saveAccountCredential("anthropic", b, { ...background, source: "local-cli", expires: Date.now() + 30_000 });
  const result = await setAccountPaused("anthropic", a, true);
  expect(result).toMatchObject({ status: "updated", activeAccountChanged: true, activeAccountId: c });
  expect(getAccountSet("anthropic")!.accounts.find(row => row.id === b)?.paused).not.toBe(true);
  expect(getAccountCredential("anthropic", b)?.access).toBe(background.access);
});

for (const excluded of ["paused", "needsReauth"] as const) {
  test(`legacy pause fallback skips ${excluded} rows and wraps in ring order`, async () => {
    const [a, b, c] = ids as [string, string, string];
    for (const id of ids) await saveAccountCredential("anthropic", id, { ...getAccountCredential("anthropic", id)!, source: undefined });
    await setActiveAccount("anthropic", c);
    if (excluded === "paused") await setAccountPaused("anthropic", a, true);
    else await markAccountNeedsReauth("anthropic", a, true);
    expect(await setAccountPaused("anthropic", c, true)).toMatchObject({ activeAccountChanged: true, activeAccountId: b });
  });
}

for (const source of [undefined, "invalid-source"] as const) {
  test(`pause preserves ring order for Anthropic credentials with ${source ?? "missing"} provenance`, async () => {
    const [a, b, c] = ids as [string, string, string];
    const background = getAccountCredential("anthropic", b)!;
    await saveAccountCredential("anthropic", b, { ...background, source: source as typeof background.source });
    expect(getAccountCredential("anthropic", b)?.source).toBeUndefined();
    expect(await setAccountPaused("anthropic", a, true)).toMatchObject({
      status: "updated", activeAccountChanged: true, activeAccountId: b,
    });
    expect(getAccountCredential("anthropic", b)?.access).toBe(background.access);
  });

  for (const selection of ["fallback", "explicit"] as const) {
    test(`${selection} ${source ?? "source-less"} legacy account keeps quota, discovery and stored refresh without CLI adoption`, async () => {
      const [a, b, c] = ids as [string, string, string];
      const legacy = { ...getAccountCredential("anthropic", b)!, source: source as "oauth" | undefined };
      await saveAccountCredential("anthropic", b, legacy);
      await setAccountPaused("anthropic", c, true);
      const originalFetch = globalThis.fetch;
      const usageBearers: Array<string | null> = [];
      const modelBearers: Array<string | null> = [];
      const refreshTokens: string[] = [];
      const detect = spyOn(localTokens, "detectClaudeCodeToken").mockImplementation(() => {
        throw new Error("legacy accounts must not read external Claude credentials");
      });
      const refreshed = { access: "synthetic-legacy-refreshed", refresh: "synthetic-legacy-rotated", expires: Date.now() + 3_600_000 };
      const refresh = spyOn(OAUTH_PROVIDERS.anthropic!, "refresh").mockImplementation(async token => {
        refreshTokens.push(token);
        return refreshed;
      });
      globalThis.fetch = (async (input, init) => {
        // Every possible fetch stays inside this fixture, including unexpected URLs.
        expect(String(input)).toBe("https://api.anthropic.com/api/oauth/usage");
        usageBearers.push(new Headers(init?.headers).get("authorization"));
        return Response.json({ five_hour: { utilization: 25 } });
      }) as typeof fetch;
      const models = spyOn(outbound, "providerOutboundGet").mockImplementation(async (_name, _provider, url, init, deps) => {
        expect(url).toBe("https://api.anthropic.com/v1/models?limit=1000");
        expect(await deps?.beforeSend?.()).toBe(true);
        modelBearers.push(new Headers(init?.headers).get("authorization"));
        return Response.json({ data: [{ id: "claude-fixture-legacy" }] });
      });
      const provider = config().providers.anthropic!;
      try {
        clearModelCache();
        if (selection === "fallback") {
          expect(await setAccountPaused("anthropic", a, true)).toMatchObject({ activeAccountChanged: true, activeAccountId: b });
        } else {
          expect(await setActiveAccount("anthropic", b)).toBe(true);
          await setAccountPaused("anthropic", a, true);
        }
        expect((await fetchAnthropicQuota("anthropic"))?.quota.fiveHourPercent).toBe(25);
        expect((await fetchProviderModels("anthropic", provider, 0)).map(model => model.id)).toContain("claude-fixture-legacy");
        expect(usageBearers).toEqual([`Bearer ${legacy.access}`]);
        expect(modelBearers).toEqual([`Bearer ${legacy.access}`]);
        expect(getAccountCredential("anthropic", b)?.source).toBeUndefined();
        expect(refreshTokens).toEqual([]);

        await saveAccountCredential("anthropic", b, { ...legacy, expires: 1 });
        clearModelCache();
        expect((await fetchProviderModels("anthropic", provider, 0)).map(model => model.id)).toContain("claude-fixture-legacy");
        expect((await fetchAnthropicQuota("anthropic"))?.quota.fiveHourPercent).toBe(25);
        expect(refreshTokens).toEqual([legacy.refresh]);
        expect(modelBearers).toEqual([`Bearer ${legacy.access}`, `Bearer ${refreshed.access}`]);
        expect(usageBearers).toEqual([`Bearer ${legacy.access}`, `Bearer ${refreshed.access}`]);
        expect(detect).not.toHaveBeenCalled();
        expect(getAccountCredential("anthropic", b)).toMatchObject({ ...refreshed, accountId: legacy.accountId, source: "oauth" });
        expect(getAccountSet("anthropic")!.accounts.find(account => account.id === a)?.paused).toBe(true);
      } finally {
        models.mockRestore(); refresh.mockRestore(); detect.mockRestore();
        globalThis.fetch = originalFetch;
        clearModelCache();
      }
    });
  }
}

test("a promoted local-CLI account cannot adopt another account after entering the refresh skew", async () => {
  const [a, b] = ids as [string, string, string];
  const now = Date.now();
  const background = { ...getAccountCredential("anthropic", b)!, email: "synthetic-b@example.test", source: "local-cli" as const, expires: now + 120_000 };
  await saveAccountCredential("anthropic", b, background);
  expect(await setAccountPaused("anthropic", a, true)).toMatchObject({ activeAccountId: b, activeAccountChanged: true });
  const pausedCredential = getAccountCredential("anthropic", a)!;
  const detect = spyOn(localTokens, "detectClaudeCodeToken").mockReturnValue({ ...pausedCredential, source: "local-cli" });
  const refreshed = { access: "synthetic-b-refreshed", refresh: "synthetic-b-refresh", expires: now + 3_600_000 };
  const sent: string[] = [];
  try {
    expect(await refreshAnthropicAccountWithLock("anthropic", b, {
      ...OAUTH_PROVIDERS.anthropic!, refresh: async token => { sent.push(token); return refreshed; },
    }, background, { now: () => now + 60_001, resolveIdentity: async access => ({
      v: 1, accountUuid: access === background.access ? "synthetic-account-b" : "synthetic-account-a",
      bearerSha256: createHash("sha256").update(access).digest("hex"),
    }) })).toBe(refreshed.access);
    expect(sent).toEqual([background.refresh]);
    expect(getAccountCredential("anthropic", b)).toMatchObject({
      ...refreshed, source: "oauth", accountId: background.accountId, email: background.email,
    });
    expect(getAccountCredential("anthropic", a)).toEqual(pausedCredential);
    expect(getAccountSet("anthropic")!.accounts.find(row => row.id === a)?.paused).toBe(true);
  } finally { detect.mockRestore(); }
});

test("missing provenance does not change non-Anthropic pause fallback", async () => {
  for (const accountId of ["synthetic-xai-a", "synthetic-xai-b"]) {
    await saveCredential("xai", { access: accountId, refresh: accountId, expires: Date.now() + 3_600_000, accountId });
  }
  const [a, b] = getAccountSet("xai")!.accounts;
  await setActiveAccount("xai", a!.id);
  expect(await setAccountPaused("xai", a!.id, true)).toMatchObject({ activeAccountId: b!.id, activeAccountChanged: true });
});

test("all-paused refusal and resume preserve credentials and cooldown, independent of pool enable", async () => {
  const a = ids[0]!;
  const credential = getAccountCredential("anthropic", a);
  rotateAnthropicAccountOn429(config(), a, "60");
  const health = getAnthropicAccountHealthSnapshot(a);
  for (const id of ids) await setAccountPaused("anthropic", id, true);
  for (const enabled of [true, false]) expect(resolveAnthropicAccountForSession("old", config(enabled))).toMatchObject({ accountId: null, reason: "paused" });
  await expect(getAnthropicPoolAccessSnapshot(a)).rejects.toBeInstanceOf(OAuthAccountPausedError);
  expect(await setActiveAccount("anthropic", a)).toBe(false);
  await setAccountPaused("anthropic", a, false);
  expect(getAccountCredential("anthropic", a)).toEqual(credential);
  expect(getAnthropicAccountHealthSnapshot(a)).toEqual(health);
  expect(getAccountSet("anthropic")!.activeAccountId).toBe(a);
});

test("model routes cannot restore a paused account, but explicit fallback can widen", async () => {
  const [a, b, c] = ids as [string, string, string];
  await setAccountPaused("anthropic", a, true);
  await setAccountPaused("anthropic", b, true);
  const route = { position: 1, accounts: [a, b], fallback: false };
  expect(resolveAnthropicAccountForSession("", config(), Date.now(), route).reason).toBe("paused");
  expect(resolveAnthropicAccountForSession("", config(), Date.now(), { ...route, fallback: true }).accountId).toBe(c);
});

test("pause and pause-resume ABA both invalidate an earlier credential proposal", async () => {
  const a = ids[0]!;
  const selection = captureOAuthAccountSelection("anthropic");
  const snapshot = await getAnthropicPoolAccessSnapshot(a);
  await setAccountPaused("anthropic", a, true);
  expect(await promoteAnthropicActiveAccount(a, selection, { config: config(), expectedCredentialGeneration: snapshot.generation })).toBeNull();
  await setAccountPaused("anthropic", a, false);
  // Resume preserves the credential but cannot authorize a proposal captured before pause.
  expect(await promoteAnthropicActiveAccount(a, selection, { config: config() })).toBeNull();
  expect(await promoteAnthropicActiveAccount(a, captureOAuthAccountSelection("anthropic"), { config: config() })).not.toBeNull();
});

test("pause during an asynchronous credential refresh prevents returning its bearer", async () => {
  const a = ids[0]!;
  const credential = getAccountCredential("anthropic", a)!;
  await saveAccountCredential("anthropic", a, { ...credential, expires: 0 });
  const refresh = spyOn(OAUTH_PROVIDERS.anthropic!, "refresh").mockImplementation(async () => {
    await setAccountPaused("anthropic", a, true);
    return { ...credential, access: "synthetic-after-wait", refresh: "synthetic-after-wait-refresh" };
  });
  try {
    await expect(getAnthropicPoolAccessSnapshot(a)).rejects.toBeInstanceOf(OAuthAccountPausedError);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Keep an already-rotated refresh token for resume without authorizing this request.
    expect(getAccountCredential("anthropic", a)?.access).toBe("synthetic-after-wait");
  } finally { refresh.mockRestore(); }
});

test("pause is durable, idempotent, preserved on relogin and removed with its account", async () => {
  const a = ids[0]!;
  const credential = getAccountCredential("anthropic", a)!;
  await Promise.all([setAccountPaused("anthropic", a, true), setAccountPaused("anthropic", ids[1]!, true)]);
  expect((await setAccountPaused("anthropic", a, true)).status).toBe("unchanged");
  clearAnthropicAccountPoolState();
  expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).anthropic.accounts.filter((row: { paused?: boolean }) => row.paused)).toHaveLength(2);
  await saveCredential("anthropic", credential);
  expect(getAccountSet("anthropic")!.accounts.find(row => row.id === a)?.paused).toBe(true);
  await removeAccount("anthropic", a);
  await saveCredential("anthropic", credential);
  expect(getAccountSet("anthropic")!.accounts.find(row => row.credential.accountId === credential.accountId)?.paused).toBeUndefined();
});

test("refresh waiting for its lock observes a newly persisted pause without upstream use", async () => {
  const a = ids[0]!;
  const lock = createOAuthRefreshIntentLock("anthropic", a);
  const originalAcquire = lock.acquire.bind(lock);
  lock.acquire = async () => { await setAccountPaused("anthropic", a, true); return originalAcquire(); };
  let sends = 0;
  await expect(refreshAnthropicAccountWithLock("anthropic", a, {
    ...OAUTH_PROVIDERS.anthropic!, refresh: async () => { sends++; throw new Error("unexpected refresh"); },
  }, getAccountCredential("anthropic", a)!, { intentLock: lock })).rejects.toBeInstanceOf(OAuthAccountPausedError);
  expect(sends).toBe(0);
});

test("refresh finishing after pause preserves rotated credentials; late failure preserves health", async () => {
  const a = ids[0]!;
  const original = getAccountCredential("anthropic", a)!;
  await refreshAnthropicAccountWithLock("anthropic", a, {
    ...OAUTH_PROVIDERS.anthropic!, refresh: async () => {
      await setAccountPaused("anthropic", a, true);
      return { ...original, access: "synthetic-rotated", refresh: "synthetic-rotated-refresh" };
    },
  }, original);
  expect(getAccountCredential("anthropic", a)?.access).toBe("synthetic-rotated");
  expect(getAccountSet("anthropic")!.accounts.find(row => row.id === a)?.paused).toBe(true);
  await setAccountPaused("anthropic", a, false);
  await expect(refreshAnthropicAccountWithLock("anthropic", a, {
    ...OAUTH_PROVIDERS.anthropic!, refresh: async () => {
      await setAccountPaused("anthropic", a, true);
      throw new AnthropicTokenError("synthetic rejection", 400, "invalid_grant");
    },
  }, getAccountCredential("anthropic", a)!)).rejects.toBeInstanceOf(OAuthLoginRequiredError);
  expect(getAccountSet("anthropic")!.accounts.find(row => row.id === a)?.needsReauth).not.toBe(true);
});
