import * as localTokens from "../../src/oauth/local-token-detect";
import * as storeModule from "../../src/oauth/store";
import { createHash } from "node:crypto";
import { getLoginStatus, OAUTH_PROVIDERS, refreshAnthropicAccountWithLock } from "../../src/oauth";
import { AnthropicTokenError, loginAnthropic, refreshAnthropicToken } from "../../src/oauth/anthropic";
import { anthropicOrganization, resolveAnthropicAccountIdentity } from "../../src/oauth/anthropic-identity";
import { captureOAuthAccountSelection, loadAuthStore, mutateStore, oauthMutationTailSnapshot, removeAccount, saveAccountCredential, setAccountPaused, setActiveAccount } from "../../src/oauth/store";
import type { OAuthCredentials } from "../../src/oauth/types";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidAccessToken, OAuthTokenRefreshStaleError } from "../../src/oauth";
import { credentialGeneration, getAccountCredential, getAccountSet, readOAuthRefreshIntent, saveCredential, writeOAuthRefreshIntent } from "../../src/oauth/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { OAuthReauthIdentityMismatchError, runLogin } from "../../src/oauth";
import { mergeAnthropicIdentity } from "../../src/oauth/anthropic-identity";
import { newerClaudeCredential } from "../../src/oauth/anthropic-continuity";
import { anthropicReauthSlotGuard, findAnthropicImportSlot, findAnthropicLoginSlot, observeAnthropicSlotOrganizations } from "../../src/oauth/anthropic-login-slot";
import { mergeOAuthOrganizationName, mergeOAuthPlan } from "../../src/oauth/plan";
import { AnthropicCrossInstanceDuplicateError, assertNoCrossAnthropicRegistration } from "../../src/oauth/store-anthropic-instance";
import type { AuthStore } from "../../src/oauth/store";
import type { OAuthController } from "../../src/oauth/types";
import type { OcxConfig } from "../../src/config";

const originalEnv = { HOME: process.env.HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
const originalFetch = globalThis.fetch;
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "anthropic-identity-"));
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "{}");
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(tmp);
});
function disk(access = "synthetic-other", refresh = "synthetic-other-refresh") {
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: access, refreshToken: refresh, expiresAt: Date.now() + 3600_000,
  } }));
}

test("unknown fully rotated Claude pair preserves row and pending intent without refresh or reauth", async () => {
  await saveCredential("anthropic", { access: "synthetic-old", refresh: "synthetic-consumed", expires: 1, source: "local-cli" });
  const id = getAccountSet("anthropic")!.activeAccountId;
  const stored = getAccountCredential("anthropic", id)!;
  const intent = writeOAuthRefreshIntent("anthropic", id, credentialGeneration(stored));
  disk();
  let posts = 0;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST") posts++;
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  await expect(getValidAccessToken("anthropic")).rejects.toThrow();
  expect(getAccountCredential("anthropic", id)).toEqual(stored);
  expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent);
  expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
  expect(posts).toBe(0);
});

function proof(access: string, accountUuid = "synthetic-account-a") {
  return { v: 1 as const, accountUuid, bearerSha256: createHash("sha256").update(access).digest("hex") };
}
async function seed(bound = true) {
  const credential: OAuthCredentials = { access: "synthetic-old", refresh: "synthetic-consumed", expires: 1,
    source: "local-cli", ...(bound ? { anthropicIdentity: proof("synthetic-old") } : {}) };
  await saveCredential("anthropic", credential);
  const id = getAccountSet("anthropic")!.activeAccountId;
  return { id, credential: getAccountCredential("anthropic", id)! };
}
function profiles(accountUuid = "synthetic-account-a") {
  globalThis.fetch = (async () => Response.json({ account: { uuid: accountUuid },
    organization: { uuid: "synthetic-shared-org" }, email: "shared@example.test" })) as typeof fetch;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const noRefresh = { ...OAUTH_PROVIDERS.anthropic!, refresh: async () => { throw new Error("refresh must not run"); } };

test("profile boundary uses fixed origin, exact bearer, no redirects and private proof", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url, init) => {
    request = { url: String(url), init };
    return Response.json({ account: { uuid: "synthetic-account-a" }, organization: { uuid: "other" } });
  }) as typeof fetch;
  expect(await resolveAnthropicAccountIdentity("synthetic-access")).toEqual(proof("synthetic-access"));
  expect(request!.url).toBe("https://api.anthropic.com/api/oauth/profile");
  expect(request!.init!.redirect).toBe("error");
  const headers = new Headers(request!.init!.headers);
  expect(headers.get("authorization")).toBe("Bearer synthetic-access");
  expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
  expect(headers.get("cache-control")).toBe("no-cache");
  expect(request!.init!.signal).toBeInstanceOf(AbortSignal);
});

for (const payload of [{ organization: { uuid: "synthetic-account-a" } }, { account: { uuid: "" } },
  { account: { uuid: " x " } }, { account: { uuid: 123 } }, { account: { uuid: "x".repeat(129) } },
  { account: { uuid: "x\ny" } }]) {
  test(`profile rejects malformed account shape ${JSON.stringify(payload).slice(0, 65)}`, async () => {
    globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
    expect(await resolveAnthropicAccountIdentity("synthetic-access")).toBeUndefined();
  });
}
for (const mode of ["malformed", "oversized", "redirect", "error", "timeout", "abort"] as const) {
  test(`profile refuses ${mode} without identity`, async () => {
    const ctrl = new AbortController();
    globalThis.fetch = (async (_url, init) => {
      if (mode === "timeout") throw new DOMException("synthetic", "TimeoutError");
      if (mode === "abort") {
        const body = new ReadableStream({ start() { ctrl.abort(); } });
        return new Response(body);
      }
      if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://example.test" } });
      if (mode === "error") return new Response(null, { status: 401 });
      return new Response(mode === "oversized" ? JSON.stringify({ account: { uuid: "a" }, pad: "x".repeat(65536) }) : "{");
    }) as typeof fetch;
    expect(await resolveAnthropicAccountIdentity("synthetic-access", ctrl.signal)).toBeUndefined();
  });
}

test("private binding roundtrips, stays out of summaries and stale binding is dropped", async () => {
  const { id, credential } = await seed();
  expect(loadAuthStore().anthropic!.accounts[0]!.credential.anthropicIdentity).toEqual(proof("synthetic-old"));
  const summary = JSON.stringify(getLoginStatus("anthropic"));
  expect(summary).not.toContain("anthropicIdentity");
  expect(summary).not.toContain("bearerSha256");
  await saveAccountCredential("anthropic", id, { ...credential, access: "synthetic-new" });
  expect(getAccountCredential("anthropic", id)!.anthropicIdentity).toBeUndefined();
  await saveAccountCredential("anthropic", id, { ...credential, anthropicIdentity: { ...proof(credential.access), v: 2 } as never });
  expect(getAccountCredential("anthropic", id)!.anthropicIdentity).toBeUndefined();
});

for (const bound of [true, false]) {
  test(`full rotation adopts same account with ${bound ? "stored" : "fresh old-bearer"} proof`, async () => {
    const { id, credential } = await seed(bound);
    const intent = writeOAuthRefreshIntent("anthropic", id, credentialGeneration(credential));
    const selection = captureOAuthAccountSelection("anthropic");
    disk();
    const observed: string[] = [];
    const result = await refreshAnthropicAccountWithLock("anthropic", id, noRefresh, credential, {
      resolveIdentity: async access => { observed.push(access); return proof(access); },
      afterPrePersistRead: () => { expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent); },
    });
    expect(result).toBe("synthetic-other");
    expect(observed.sort()).toEqual(bound ? ["synthetic-other"] : ["synthetic-old", "synthetic-other"]);
    expect(getAccountCredential("anthropic", id)!.anthropicIdentity).toEqual(proof("synthetic-other"));
    expect(captureOAuthAccountSelection("anthropic")).toEqual(selection);
    expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
  });
}

test("different UUID with same organization, email and path cannot replace or clear intent", async () => {
  const { id, credential } = await seed();
  const intent = writeOAuthRefreshIntent("anthropic", id, credentialGeneration(credential));
  disk(); profiles("synthetic-account-b");
  await expect(getValidAccessToken("anthropic")).rejects.toThrow();
  expect(getAccountCredential("anthropic", id)).toEqual(credential);
  expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent);
  expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
});

test("verified different CLI account may refresh its own stored grant without pending intent", async () => {
  const { id, credential } = await seed(); disk(); profiles("synthetic-account-b");
  const calls: string[] = [];
  expect(await refreshAnthropicAccountWithLock("anthropic", id, { ...noRefresh, refresh: async rt => {
    calls.push(rt); return { access: "synthetic-fresh", refresh: "synthetic-fresh-rt", expires: Date.now() + 3600_000 };
  } }, credential)).toBe("synthetic-fresh");
  expect(calls).toEqual(["synthetic-consumed"]);
  expect(getAccountCredential("anthropic", id)!.anthropicIdentity).toBeUndefined();
});

for (const shared of ["access", "refresh"] as const) {
  test(`shared ${shared} preserves metadata without minting stale bearer proof`, async () => {
    const { id, credential } = await seed();
    disk(shared === "access" ? credential.access : "synthetic-other", shared === "refresh" ? credential.refresh : "synthetic-other-rt");
    expect(await refreshAnthropicAccountWithLock("anthropic", id, noRefresh, credential)).toBe(shared === "access" ? credential.access : "synthetic-other");
    expect(getAccountCredential("anthropic", id)!.anthropicIdentity).toEqual(shared === "access" ? proof(credential.access) : undefined);
  });
}

for (const change of ["replacement", "login", "identity", "disk", "removal", "pause", "selection"] as const) {
  test(`identity await cannot commit after ${change}`, async () => {
    const { id, credential } = await seed(); disk();
    const intent = writeOAuthRefreshIntent("anthropic", id, credentialGeneration(credential));
    const started = deferred(), release = deferred();
    const operation = refreshAnthropicAccountWithLock("anthropic", id, noRefresh, credential, {
      resolveIdentity: async access => { started.resolve(); await release.promise; return proof(access); },
    });
    await started.promise;
    if (change === "replacement") await saveAccountCredential("anthropic", id, { ...credential, access: "synthetic-winner", expires: Date.now() + 3600_000 });
    if (change === "login") await saveAccountCredential("anthropic", id, credential, { rotateLoginId: true });
    if (change === "identity") await saveAccountCredential("anthropic", id, { ...credential, accountId: "synthetic-changed" });
    if (change === "disk") disk("synthetic-newer", "synthetic-newer-rt");
    if (change === "removal") await removeAccount("anthropic", id);
    if (change === "pause") await setAccountPaused("anthropic", id, true);
    if (change === "selection") await mutateStore(store => { store.anthropic!.selectionRevision = "00000000-0000-4000-8000-000000000001"; });
    const before = getAccountSet("anthropic");
    release.resolve();
    await expect(operation).rejects.toThrow();
    expect(getAccountSet("anthropic")).toEqual(before);
    // Removal owns intent cleanup; all other races preserve the consumed-token guard.
    if (change !== "removal") expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent);
  });
}

test("persistence failure retains intent and old row after verified observation", async () => {
  const { id, credential } = await seed(); disk(); profiles();
  const intent = writeOAuthRefreshIntent("anthropic", id, credentialGeneration(credential));
  await expect(refreshAnthropicAccountWithLock("anthropic", id, noRefresh, credential, {
    afterPrePersistRead: () => { throw new Error("synthetic persistence failure"); },
  })).rejects.toThrow("synthetic persistence failure");
  expect(getAccountCredential("anthropic", id)).toEqual(credential);
  expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent);
});

test("authenticated token response binds the returned bearer", async () => {
  globalThis.fetch = (async () => Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-rt", expires_in: 3600,
    account: { uuid: "synthetic-account-a" } })) as typeof fetch;
  expect((await refreshAnthropicToken("synthetic-old-rt")).anthropicIdentity).toEqual(proof("synthetic-access"));
});

test("conflicting authenticated refresh proof fails with durable replay guard", async () => {
  const { id, credential } = await seed();
  await expect(refreshAnthropicAccountWithLock("anthropic", id, { ...noRefresh, refresh: async () => ({
    access: "synthetic-other", refresh: "synthetic-other-rt", expires: Date.now() + 3600_000,
    anthropicIdentity: proof("synthetic-other", "synthetic-account-b"),
  }) }, credential)).rejects.toThrow("identity changed");
  expect(getAccountCredential("anthropic", id)).toEqual(credential);
  expect(readOAuthRefreshIntent("anthropic", id)).toBeDefined();
});

test("explicit import preserves unrelated identityless slot and enriches only a continuous slot", async () => {
  const { id, credential } = await seed(false); disk(); profiles();
  const imported = await loginAnthropic({}, { importLocal: "only" });
  expect(imported.anthropicIdentity).toEqual(proof("synthetic-other"));
  await saveCredential("anthropic", imported, { preserveIdentityless: true });
  expect(getAccountCredential("anthropic", id)).toEqual(credential);
  expect(getAccountSet("anthropic")!.accounts).toHaveLength(2);
  const selection = captureOAuthAccountSelection("anthropic");
  const importId = selection!.accountId;
  await saveCredential("anthropic", imported, { preserveIdentityless: true });
  expect(getAccountSet("anthropic")!.accounts).toHaveLength(2);
  expect(getAccountSet("anthropic")!.activeAccountId).toBe(importId);
  expect(captureOAuthAccountSelection("anthropic")).toEqual(selection);
});

test("explicit import enriches legacy shared-token slot without changing its id or active choice", async () => {
  const { id } = await seed(false);
  await saveCredential("anthropic", { access: "synthetic-secondary", refresh: "synthetic-secondary-rt", expires: 1, accountId: "secondary" }, { preserveIdentityless: true });
  const active = getAccountSet("anthropic")!.activeAccountId;
  disk("synthetic-old"); profiles();
  const imported = await loginAnthropic({}, { importLocal: "only" });
  await saveCredential("anthropic", imported, { preserveIdentityless: true });
  expect(getAccountSet("anthropic")!.accounts).toHaveLength(2);
  expect(getAccountSet("anthropic")!.activeAccountId).toBe(active);
  expect(getAccountCredential("anthropic", id)!.anthropicIdentity).toEqual(proof("synthetic-old"));
});

// A CLI credential change while the writer is queued is caught by the awaited re-read inside it.
for (const mutation of ["login", "identity", "pause", "disk"] as const) {
  test(`serialized adoption guard catches queued ${mutation} after the profile recheck`, async () => {
    const { id, credential } = await seed(); disk();
    const intent = writeOAuthRefreshIntent("anthropic", id, credentialGeneration(credential));
    const observed = deferred(), finishProfile = deferred(), writerEntered = deferred(), finishWriter = deferred(), mergeEntered = deferred();
    const originalMerge = storeModule.mergeAccountCredential;
    const mergeSpy = spyOn(storeModule, "mergeAccountCredential").mockImplementation((...args) => {
      mergeEntered.resolve(); return originalMerge(...args);
    });
    const operation = refreshAnthropicAccountWithLock("anthropic", id, noRefresh, credential, {
      resolveIdentity: async access => { observed.resolve(); await finishProfile.promise; return proof(access); },
    });
    await observed.promise;
    const writer = mutateStore(async store => {
      writerEntered.resolve(); await finishWriter.promise;
      const row = store.anthropic!.accounts.find(a => a.id === id)!;
      if (mutation === "login") row.loginId = "00000000-0000-4000-8000-000000000002";
      if (mutation === "identity") row.credential.accountId = "synthetic-owner-changed";
      if (mutation === "pause") row.paused = true;
      if (mutation === "disk") disk("synthetic-newer-disk", "synthetic-newer-refresh");
    });
    try {
      await writerEntered.promise;
      finishProfile.resolve();
      await mergeEntered.promise;
      finishWriter.resolve();
      await writer;
      await expect(operation).rejects.toThrow();
      expect(getAccountCredential("anthropic", id)!.access).toBe(credential.access);
      expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent);
    } finally {
      finishProfile.resolve(); finishWriter.resolve(); mergeSpy.mockRestore();
    }
  });
}

for (const reread of ["unavailable", "rotated"] as const) {
  test(`adoption fails closed when the CLI re-read just before persistence is ${reread}`, async () => {
    const { id, credential } = await seed(); disk();
    const intent = writeOAuthRefreshIntent("anthropic", id, credentialGeneration(credential));
    const originalDetect = localTokens.detectClaudeCodeTokenAsync;
    let reads = 0;
    const detect = spyOn(localTokens, "detectClaudeCodeTokenAsync").mockImplementation(async () => {
      reads += 1;
      const observed = await originalDetect();
      if (reads === 1 || !observed) return observed;
      // A locked Keychain (timeout, backoff or a busy slot) reads as no credential.
      return reread === "unavailable" ? null : { ...observed, access: "synthetic-rotated", refresh: "synthetic-rotated-rt" };
    });
    const before = getAccountSet("anthropic");
    try {
      await expect(refreshAnthropicAccountWithLock("anthropic", id, noRefresh, credential, {
        resolveIdentity: async access => proof(access),
      })).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
      expect(reads).toBe(2);
      expect(getAccountSet("anthropic")).toEqual(before);
      expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent);
    } finally { detect.mockRestore(); }
  });
}

test("unavailable profile import remains identityless and cannot overwrite an unrelated slot", async () => {
  const { id, credential } = await seed(false); disk();
  const imported = await loginAnthropic({}, { importLocal: "only" });
  expect(imported.anthropicIdentity).toBeUndefined();
  await saveCredential("anthropic", imported);
  expect(getAccountSet("anthropic")!.accounts).toHaveLength(2);
  expect(getAccountCredential("anthropic", id)).toEqual(credential);
});

test("both bearer observations start together and mismatched bearer hashes are never trusted", async () => {
  const { id, credential } = await seed(false); disk();
  const both = deferred(); const calls: string[] = [];
  await expect(refreshAnthropicAccountWithLock("anthropic", id, noRefresh, credential, {
    resolveIdentity: async access => {
      calls.push(access); if (calls.length === 2) both.resolve();
      await both.promise;
      return proof("synthetic-wrong-bearer");
    },
  })).rejects.toThrow();
  expect(calls).toHaveLength(2);
  expect(getAccountCredential("anthropic", id)).toEqual(credential);
  expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
});

test("profile deadline is ten seconds and cancellation reaches a pending fetch", async () => {
  const deadline = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const entered = deferred();
  globalThis.fetch = (async (_url, init) => {
    entered.resolve();
    return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const result = resolveAnthropicAccountIdentity("synthetic-access");
    await entered.promise;
    expect(timeout).toHaveBeenCalledWith(10_000);
    deadline.abort(new DOMException("synthetic", "TimeoutError"));
    expect(await result).toBeUndefined();
  } finally { timeout.mockRestore(); }
});

test("malformed UTF-8 profile and pre-aborted caller produce no identity", async () => {
  globalThis.fetch = (async () => new Response(new Uint8Array([0xff]))) as typeof fetch;
  expect(await resolveAnthropicAccountIdentity("synthetic-access")).toBeUndefined();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected"); }) as typeof fetch;
  expect(await resolveAnthropicAccountIdentity("synthetic-access", AbortSignal.abort())).toBeUndefined();
  expect(calls).toBe(0);
});

test("unverified matching account metadata cannot stand in for the old bearer proof", async () => {
  const { id, credential } = await seed(false);
  await saveAccountCredential("anthropic", id, { ...credential, accountId: "synthetic-account-a", email: "shared@example.test" });
  disk();
  const stored = getAccountCredential("anthropic", id)!;
  await expect(refreshAnthropicAccountWithLock("anthropic", id, noRefresh, stored, {
    resolveIdentity: async access => access === stored.access ? undefined : proof(access),
  })).rejects.toThrow();
  expect(getAccountCredential("anthropic", id)).toEqual(stored);
  expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
});


for (const mutation of ["relogin", "metadata", "health", "removal"] as const) {
  test(`initial account snapshot cannot adopt across concurrent ${mutation}`, async () => {
    const { id, credential } = await seed(); disk();
    const intent = writeOAuthRefreshIntent("anthropic", id, credentialGeneration(credential));
    const originalGet = storeModule.getAccountSet;
    let injected = false;
    let expected: ReturnType<typeof originalGet>;
    const read = spyOn(storeModule, "getAccountSet").mockImplementation(provider => {
      const snapshot = originalGet(provider);
      if (provider === "anthropic" && !injected) {
        injected = true;
        // Model another process committing just after this read's snapshot was obtained.
        const replacement = loadAuthStore();
        const row = replacement.anthropic!.accounts.find(account => account.id === id)!;
        if (mutation === "relogin") {
          row.loginId = "00000000-0000-4000-8000-000000000099";
          row.credential.source = "oauth";
          row.credential.email = "new-login@example.test";
        }
        if (mutation === "metadata") row.credential.accountId = "synthetic-new-identity";
        if (mutation === "health") row.needsReauth = true;
        if (mutation === "removal") delete replacement.anthropic;
        writeFileSync(storeModule.getAuthStorePath(), JSON.stringify(replacement));
        expected = originalGet(provider);
      }
      return snapshot;
    });
    try {
      await expect(refreshAnthropicAccountWithLock("anthropic", id, noRefresh, credential, {
        resolveIdentity: async access => proof(access),
      })).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
      expect(injected).toBe(true);
      expect(originalGet("anthropic")).toEqual(expected!);
      expect(readOAuthRefreshIntent("anthropic", id)).toEqual(intent);
    } finally { read.mockRestore(); }
  });
}


for (const cleanup of ["definitive-rejection", "pre-dispatch"] as const) {
  for (const persistent of [false, true]) {
    test(`different CLI account resumes ${cleanup} cleanup with ${persistent ? "persistent" : "temporary"} I/O failure`, async () => {
      const { id, credential } = await seed();
      const observed = async (access: string) => proof(access,
        access === credential.access ? "synthetic-account-a" : "synthetic-account-b");
      if (cleanup === "definitive-rejection") disk();
      const rejected = cleanup === "definitive-rejection"
        ? new AnthropicTokenError("synthetic rejection", 503, undefined) : new Error("synthetic pre-dispatch abort");
      const controller = new AbortController();
      if (cleanup === "pre-dispatch") controller.abort(rejected);
      const realClear = storeModule.clearOAuthRefreshIntentIfMatch;
      let clears = 0;
      const clear = spyOn(storeModule, "clearOAuthRefreshIntentIfMatch").mockImplementation((...args) => {
        clears++;
        if (persistent || clears === 1) throw new Error("synthetic intent unlink failure");
        return realClear(...args);
      });
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const refreshTokens: string[] = [];
      try {
        await expect(refreshAnthropicAccountWithLock("anthropic", id, {
          ...OAUTH_PROVIDERS.anthropic!, refresh: async token => { refreshTokens.push(token); throw rejected; },
        }, credential, { signal: controller.signal, resolveIdentity: observed })).rejects.toBe(rejected);
        const pending = readOAuthRefreshIntent("anthropic", id)!;
        expect(pending.cleanupPending).toBe(cleanup);
        expect(clears).toBe(1);
        disk();
        const retry = refreshAnthropicAccountWithLock("anthropic", id, {
          ...OAUTH_PROVIDERS.anthropic!, refresh: async token => {
            expect(clears).toBe(2);
            expect(readOAuthRefreshIntent("anthropic", id)?.cleanupPending).toBeUndefined();
            expect(readOAuthRefreshIntent("anthropic", id)?.attemptId).not.toBe(pending.attemptId);
            refreshTokens.push(token);
            return { access: "synthetic-a-refreshed", refresh: "synthetic-a-refresh", expires: Date.now() + 3600_000 };
          },
        }, credential, { resolveIdentity: observed });
        if (persistent) {
          await expect(retry).rejects.toMatchObject({ operation: "resume-cleanup", code: "OAUTH_REFRESH_INTENT_IO" });
          expect(clears).toBe(2);
          expect(getAccountCredential("anthropic", id)).toEqual(credential);
          expect(readOAuthRefreshIntent("anthropic", id)).toEqual(pending);
          expect(refreshTokens).toEqual(cleanup === "definitive-rejection" ? [credential.refresh] : []);
        } else {
          await expect(retry).resolves.toBe("synthetic-a-refreshed");
          expect(refreshTokens).toEqual(cleanup === "definitive-rejection"
            ? [credential.refresh, credential.refresh] : [credential.refresh]);
          expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
          expect(getAccountCredential("anthropic", id)?.access).toBe("synthetic-a-refreshed");
        }
        expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
      } finally { clear.mockRestore(); warn.mockRestore(); }
    });
  }
}

test("different CLI account never clears or replays an uncertain refresh intent", async () => {
  const { id, credential } = await seed(); disk();
  writeFileSync(storeModule.getAuthRefreshIntentPath("anthropic", id), "synthetic malformed intent");
  const pending = readOAuthRefreshIntent("anthropic", id);
  expect(pending?.uncertain).toBe(true);
  const clear = spyOn(storeModule, "clearOAuthRefreshIntentIfMatch");
  try {
    await expect(refreshAnthropicAccountWithLock("anthropic", id, noRefresh, credential, {
      resolveIdentity: async access => proof(access, access === credential.access ? "synthetic-account-a" : "synthetic-account-b"),
    })).rejects.toThrow();
    expect(clear).not.toHaveBeenCalled();
    expect(getAccountCredential("anthropic", id)).toEqual(credential);
    expect(readOAuthRefreshIntent("anthropic", id)).toEqual(pending);
  } finally { clear.mockRestore(); }
});


test("different CLI account can clear an obsolete intent after durable same-account adoption", async () => {
  const { id, credential } = await seed(); disk();
  const pending = writeOAuthRefreshIntent("anthropic", id, credentialGeneration(credential));
  const realClear = storeModule.clearOAuthRefreshIntentIfMatch;
  let clears = 0;
  const clear = spyOn(storeModule, "clearOAuthRefreshIntentIfMatch").mockImplementation((...args) => {
    if (++clears === 1) throw new Error("synthetic post-adoption unlink failure");
    return realClear(...args);
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(refreshAnthropicAccountWithLock("anthropic", id, noRefresh, credential, {
      resolveIdentity: async access => proof(access),
    })).resolves.toBe("synthetic-other");
    const adopted = getAccountCredential("anthropic", id)!;
    expect(readOAuthRefreshIntent("anthropic", id)).toEqual(pending);
    expect(credentialGeneration(adopted)).not.toBe(pending.generation);
    disk("synthetic-account-b-access", "synthetic-account-b-refresh");
    const sent: string[] = [];
    await expect(refreshAnthropicAccountWithLock("anthropic", id, {
      ...OAUTH_PROVIDERS.anthropic!, refresh: async token => {
        sent.push(token);
        return { access: "synthetic-a-fresh", refresh: "synthetic-a-fresh-refresh", expires: Date.now() + 3600_000 };
      },
    }, adopted, { resolveIdentity: async access => proof(access, "synthetic-account-b") })).resolves.toBe("synthetic-a-fresh");
    expect(sent).toEqual([adopted.refresh]);
    expect(readOAuthRefreshIntent("anthropic", id)).toBeUndefined();
    expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
  } finally { clear.mockRestore(); warn.mockRestore(); }
});


test("adoption reads the CLI generation only at observation and inside persistence", async () => {
  const { id, credential } = await seed(); disk();
  const originalDetect = localTokens.detectClaudeCodeTokenAsync;
  const reads: boolean[] = [];
  let insidePersistence = false;
  const detect = spyOn(localTokens, "detectClaudeCodeTokenAsync").mockImplementation(() => {
    reads.push(insidePersistence);
    return originalDetect();
  });
  try {
    await expect(refreshAnthropicAccountWithLock("anthropic", id, noRefresh, credential, {
      resolveIdentity: async access => proof(access),
      afterPrePersistRead: () => { insidePersistence = true; },
    })).resolves.toBe("synthetic-other");
    expect(reads).toEqual([false, true]);
  } finally { detect.mockRestore(); }
});

// One Claude account can belong to several organizations; each grant serves one of them.
const ORG_A = "0a0a0a0a-0000-4000-8000-00000000000a";
const ORG_B = "0b0b0b0b-0000-4000-8000-00000000000b";
function orgCredential(access: string, organizationUuid?: string, accountUuid = "synthetic-account-a"): OAuthCredentials {
  return { access, refresh: `${access}-refresh`, expires: Date.now() + 3600_000, source: "oauth",
    accountId: accountUuid, email: "shared@example.test",
    anthropicIdentity: { ...proof(access, accountUuid), ...(organizationUuid ? { organizationUuid } : {}) } };
}
/** Profile answers per bearer; a bearer without an entry is unavailable. Returns the bearers asked. */
function orgProfiles(organizationByBearer: Record<string, string>, accountUuid = "synthetic-account-a"): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    asked.push(bearer);
    const organization = organizationByBearer[bearer];
    return organization === undefined ? new Response(null, { status: 503 })
      : Response.json({ account: { uuid: accountUuid }, organization: { uuid: organization } });
  }) as typeof fetch;
  return asked;
}
const anthropicRows = () => getAccountSet("anthropic")!.accounts;
/** A grant whose exchange named only the email and organization, as when the profile read failed. */
function emailOnlyCredential(access: string, organizationUuid: string, email = "shared@example.test"): OAuthCredentials {
  return { access, refresh: `${access}-refresh`, expires: Date.now() + 3600_000, source: "oauth", email,
    anthropicOrganizationScope: { v: 1, organizationUuid, bearerSha256: proof(access).bearerSha256 } };
}

test("profile binds the grant's organization in canonical form; a malformed organization stays unknown", async () => {
  orgProfiles({ "synthetic-access": ORG_A.toUpperCase(), "synthetic-malformed": "not-an-organization" });
  expect(await resolveAnthropicAccountIdentity("synthetic-access")).toEqual({ ...proof("synthetic-access"), organizationUuid: ORG_A });
  expect(await resolveAnthropicAccountIdentity("synthetic-malformed")).toEqual(proof("synthetic-malformed"));
});

test("token response organization is bound to the returned bearer", async () => {
  globalThis.fetch = (async (_url, init) => init?.method === "POST"
    ? Response.json({ access_token: "synthetic-fresh", refresh_token: "synthetic-fresh-refresh", expires_in: 3600,
      account: { uuid: "synthetic-account-a" }, organization: { uuid: ORG_B } })
    : new Response(null, { status: 503 })) as typeof fetch;
  expect((await refreshAnthropicToken("synthetic-old-refresh")).anthropicIdentity)
    .toEqual({ ...proof("synthetic-fresh"), organizationUuid: ORG_B });
});

test("login of the same account in another organization adds a slot; same-organization login replaces its own", async () => {
  orgProfiles({});
  await saveCredential("anthropic", orgCredential("synthetic-org-a", ORG_A));
  const first = anthropicRows()[0]!.id;
  await saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
  expect(anthropicRows()).toHaveLength(2);
  const second = anthropicRows().find(row => row.id !== first)!.id;
  expect(getAccountSet("anthropic")!.activeAccountId).toBe(second);
  expect(getAccountCredential("anthropic", first)!.access).toBe("synthetic-org-a");
  await saveCredential("anthropic", orgCredential("synthetic-org-b-2", ORG_B));
  expect(anthropicRows()).toHaveLength(2);
  expect(getAccountCredential("anthropic", second)!.access).toBe("synthetic-org-b-2");
  expect(getAccountCredential("anthropic", first)!.access).toBe("synthetic-org-a");
});

test("a row saved without an organization is observed by its own bearer before a login picks its slot", async () => {
  await saveCredential("anthropic", orgCredential("synthetic-legacy"));
  const legacy = anthropicRows()[0]!;
  const asked = orgProfiles({ "synthetic-legacy": ORG_A });
  await saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
  expect(asked).toEqual(["synthetic-legacy"]);
  expect(anthropicRows()).toHaveLength(2);
  // Observation decides the slot only; the legacy row itself is not rewritten.
  expect(getAccountCredential("anthropic", legacy.id)).toEqual(legacy.credential);
  await saveCredential("anthropic", orgCredential("synthetic-org-a", ORG_A));
  expect(anthropicRows()).toHaveLength(2);
  expect(getAccountCredential("anthropic", legacy.id)!.anthropicIdentity)
    .toEqual({ ...proof("synthetic-org-a"), organizationUuid: ORG_A });
});

test("an unobservable or unproven organization keeps the historical same-account replacement", async () => {
  await saveCredential("anthropic", orgCredential("synthetic-legacy"));
  orgProfiles({});
  await saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
  expect(anthropicRows()).toHaveLength(1);
  expect(anthropicRows()[0]!.credential.access).toBe("synthetic-org-b");
  await saveCredential("anthropic", orgCredential("synthetic-unproven"));
  expect(anthropicRows()).toHaveLength(1);
  expect(anthropicRows()[0]!.credential.access).toBe("synthetic-unproven");
});

test("reauth of an organization slot refuses a grant for another organization", async () => {
  orgProfiles({});
  await saveCredential("anthropic", orgCredential("synthetic-org-a", ORG_A));
  const slot = anthropicRows()[0]!.id;
  const original = OAUTH_PROVIDERS.anthropic!.login;
  const config = (): OcxConfig => ({ port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} });
  const reauthWith = (credential: OAuthCredentials) => {
    OAUTH_PROVIDERS.anthropic!.login = async () => credential;
    return runLogin("anthropic", {} as OAuthController, { reauthAccountId: slot }, { loadConfig: config, saveConfig: () => {} });
  };
  try {
    await expect(reauthWith(orgCredential("synthetic-org-b", ORG_B))).rejects.toBeInstanceOf(OAuthReauthIdentityMismatchError);
    expect(getAccountCredential("anthropic", slot)!.access).toBe("synthetic-org-a");
    await reauthWith(orgCredential("synthetic-org-a-2", ORG_A));
    expect(getAccountCredential("anthropic", slot)!.access).toBe("synthetic-org-a-2");
  } finally { OAUTH_PROVIDERS.anthropic!.login = original; }
});

test("an email-only reauth of an organization slot refuses a grant for another organization", async () => {
  orgProfiles({});
  await saveCredential("anthropic", orgCredential("synthetic-org-a", ORG_A));
  const slot = anthropicRows()[0]!;
  const original = OAUTH_PROVIDERS.anthropic!.login;
  const config = (): OcxConfig => ({ port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} });
  // The exchange named only the email and organization, and the profile read is unavailable.
  const reauthWith = (access: string, organizationUuid: string) => {
    OAUTH_PROVIDERS.anthropic!.login = async () => ({ access, refresh: `${access}-refresh`, expires: Date.now() + 3600_000,
      source: "oauth", email: "shared@example.test",
      anthropicOrganizationScope: { v: 1, organizationUuid, bearerSha256: proof(access).bearerSha256 } });
    return runLogin("anthropic", {} as OAuthController, { reauthAccountId: slot.id }, { loadConfig: config, saveConfig: () => {} });
  };
  try {
    await expect(reauthWith("synthetic-email-b", ORG_B)).rejects.toBeInstanceOf(OAuthReauthIdentityMismatchError);
    expect(getAccountCredential("anthropic", slot.id)).toEqual(slot.credential);
    await reauthWith("synthetic-email-a", ORG_A);
    expect(getAccountCredential("anthropic", slot.id)!.access).toBe("synthetic-email-a");
  } finally { OAUTH_PROVIDERS.anthropic!.login = original; }
});

test.each([
  { scenario: "ASCII local-part case", storedEmail: "shared@example.test", email: "Shared@example.test", organization: ORG_A },
  { scenario: "Unicode domain spelling", storedEmail: "shared@bücher.example.test", email: "shared@Bücher.example.test", organization: ORG_A },
  { scenario: "IDN A-label spelling", storedEmail: "shared@xn--bcher-kva.example.test", email: "shared@XN--BCHER-KVA.example.test", organization: ORG_A },
  { scenario: "unknown target organization", storedEmail: "shared@example.test", email: "shared@Example.Test", organization: undefined },
])("scoped email-only reauth preserves the roster on $scenario", async ({ storedEmail, email, organization }) => {
  await saveCredential("anthropic", { ...orgCredential("synthetic-original", organization), email: storedEmail });
  const before = getAccountSet("anthropic")!;
  const original = OAUTH_PROVIDERS.anthropic!.login;
  const access = "synthetic-reauth";
  let writerReached = false;
  OAUTH_PROVIDERS.anthropic!.login = async () => ({
    access, refresh: "synthetic-reauth-refresh", expires: Date.now() + 3600_000, source: "oauth", email,
    anthropicOrganizationScope: { v: 1, organizationUuid: ORG_A, bearerSha256: proof(access).bearerSha256 },
  });
  try {
    await expect(runLogin("anthropic", {} as OAuthController, { reauthAccountId: before.activeAccountId }, {
      loadConfig: () => ({ port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} }),
      saveConfig: () => {},
      saveAccountCredential: (...args) => {
        writerReached = true;
        return saveAccountCredential(...args);
      },
    })).rejects.toBeInstanceOf(OAuthReauthIdentityMismatchError);
    expect(writerReached).toBe(organization === undefined);
    expect(getAccountSet("anthropic")).toEqual(before);
  } finally { OAUTH_PROVIDERS.anthropic!.login = original; }
});

test("scoped email-only reauth rechecks the current email under the writer lock", async () => {
  await saveCredential("anthropic", orgCredential("synthetic-original", ORG_A));
  const before = getAccountSet("anthropic")!;
  const slot = before.accounts[0]!;
  const access = "synthetic-reauth";
  const incoming: OAuthCredentials = {
    access, refresh: "synthetic-reauth-refresh", expires: Date.now() + 3600_000, source: "oauth",
    email: slot.credential.email,
    anthropicOrganizationScope: { v: 1, organizationUuid: ORG_A, bearerSha256: proof(access).bearerSha256 },
  };
  const assertAccounts = anthropicReauthSlotGuard(slot.id, incoming, new Map());
  await saveAccountCredential("anthropic", slot.id, { ...slot.credential, email: "Shared@example.test" });
  const changed = getAccountSet("anthropic")!;
  await expect(saveAccountCredential("anthropic", slot.id, incoming, { assertAccounts }))
    .rejects.toBeInstanceOf(OAuthReauthIdentityMismatchError);
  expect(getAccountSet("anthropic")).toEqual(changed);
});

test("scoped email-only reauth refuses when another row of the organization has the same email", async () => {
  orgProfiles({});
  await saveCredential("anthropic", orgCredential("synthetic-org-a", ORG_A));
  const target = anthropicRows()[0]!;
  await saveCredential("anthropic", orgCredential("synthetic-other-account", ORG_A, "synthetic-account-b"));
  const before = getAccountSet("anthropic")!;
  expect(before.accounts).toHaveLength(2);
  const original = OAUTH_PROVIDERS.anthropic!.login;
  OAUTH_PROVIDERS.anthropic!.login = async () => emailOnlyCredential("synthetic-reauth", ORG_A);
  try {
    await expect(runLogin("anthropic", {} as OAuthController, { reauthAccountId: target.id }, {
      loadConfig: () => ({ port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} }),
      saveConfig: () => {},
    })).rejects.toBeInstanceOf(OAuthReauthIdentityMismatchError);
    expect(getAccountSet("anthropic")).toEqual(before);
  } finally { OAUTH_PROVIDERS.anthropic!.login = original; }
  // A same-email row of another organization is not ambiguous.
  const otherOrganization = { id: "other", credential: orgCredential("synthetic-org-b", ORG_B, "synthetic-account-b"), addedAt: 0 };
  expect(() => anthropicReauthSlotGuard(target.id, emailOnlyCredential("synthetic-reauth", ORG_A), new Map())([target, otherOrganization]))
    .not.toThrow();
});

test.each([
  { scenario: "accepts the organization its own bearer proves", organization: ORG_A, accepted: true },
  { scenario: "refuses another organization its own bearer proves", organization: ORG_B, accepted: false },
  { scenario: "refuses when its profile is unavailable", organization: undefined, accepted: false },
  { scenario: "refuses a profile of another account", organization: ORG_A, accountUuid: "synthetic-account-b", accepted: false },
])("scoped email-only reauth of a legacy row $scenario", async ({ organization, accountUuid, accepted }) => {
  await saveCredential("anthropic", orgCredential("synthetic-legacy"));
  const legacy = anthropicRows()[0]!;
  const asked = orgProfiles(organization ? { "synthetic-legacy": organization } : {}, accountUuid);
  const original = OAUTH_PROVIDERS.anthropic!.login;
  OAUTH_PROVIDERS.anthropic!.login = async () => emailOnlyCredential("synthetic-reauth", ORG_A);
  try {
    const reauth = runLogin("anthropic", {} as OAuthController, { reauthAccountId: legacy.id }, {
      loadConfig: () => ({ port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} }),
      saveConfig: () => {},
    });
    if (accepted) {
      await reauth;
      expect(getAccountCredential("anthropic", legacy.id)!.access).toBe("synthetic-reauth");
    } else {
      await expect(reauth).rejects.toBeInstanceOf(OAuthReauthIdentityMismatchError);
      expect(getAccountCredential("anthropic", legacy.id)).toEqual(legacy.credential);
    }
    expect(asked).toEqual(["synthetic-legacy"]);
  } finally { OAUTH_PROVIDERS.anthropic!.login = original; }
});

test("own-grant refresh keeps the stored organization and never discards a rotated grant over it", () => {
  const stored = orgCredential("synthetic-old", ORG_A);
  const fresh = orgCredential("synthetic-new");
  expect(mergeAnthropicIdentity(fresh, stored, { sameGrant: true }).anthropicIdentity)
    .toEqual({ ...proof("synthetic-new"), organizationUuid: ORG_A });
  expect(mergeAnthropicIdentity(fresh, stored).anthropicIdentity).toEqual(proof("synthetic-new"));
  // The organization is a scope, not identity: fresh evidence wins instead of throwing after rotation.
  expect(mergeAnthropicIdentity(orgCredential("synthetic-new", ORG_B), stored, { sameGrant: true }).anthropicIdentity)
    .toEqual({ ...proof("synthetic-new"), organizationUuid: ORG_B });
});

test("on the same bearer, fresh organization proof replaces a retained exchange scope", () => {
  const previous: OAuthCredentials = { ...emailOnlyCredential("synthetic-same", ORG_A), accountId: "synthetic-account-a" };
  for (const sameGrant of [true, false]) {
    const fresh = orgCredential("synthetic-same", ORG_B);
    expect(anthropicOrganization({ ...fresh, ...mergeAnthropicIdentity(fresh, previous, { sameGrant }) })).toBe(ORG_B);
    // Fresh proof that names no organization still keeps the retained scope.
    const silent = orgCredential("synthetic-same");
    expect(anthropicOrganization({ ...silent, ...mergeAnthropicIdentity(silent, previous, { sameGrant }) })).toBe(ORG_A);
  }
});

test("own-grant refresh without account proof keeps the organization as the new bearer's scope", async () => {
  const previous = { ...orgCredential("synthetic-old", ORG_A), expires: 1 };
  await saveCredential("anthropic", previous);
  const id = getAccountSet("anthropic")!.activeAccountId;
  // The token response omits account and organization, and the profile read is unavailable.
  globalThis.fetch = (async (_url, init) => init?.method === "POST"
    ? Response.json({ access_token: "synthetic-fresh", refresh_token: "synthetic-fresh-refresh", expires_in: 3600 })
    : new Response(null, { status: 503 })) as typeof fetch;
  await expect(refreshAnthropicAccountWithLock("anthropic", id, OAUTH_PROVIDERS.anthropic!, previous))
    .resolves.toBe("synthetic-fresh");
  const rotated = getAccountCredential("anthropic", id)!;
  expect(rotated).toMatchObject({ refresh: "synthetic-fresh-refresh", accountId: previous.accountId });
  expect(rotated.anthropicIdentity).toBeUndefined();
  expect(rotated.anthropicOrganizationScope).toEqual({ v: 1, organizationUuid: ORG_A, bearerSha256: proof("synthetic-fresh").bearerSha256 });
  await saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
  expect(anthropicRows()).toHaveLength(2);
  expect(getAccountCredential("anthropic", id)).toEqual(rotated);
});

test("Claude Code signed in to another organization is a different account, not a rotation", async () => {
  const stored: OAuthCredentials = { ...orgCredential("synthetic-old", ORG_A), source: "local-cli" };
  disk();
  const resolveTo = (organizationUuid: string) => async (access: string) => ({ ...proof(access), organizationUuid });
  expect((await newerClaudeCredential(stored, Date.now(), undefined, resolveTo(ORG_B))).kind).toBe("different");
  expect((await newerClaudeCredential(stored, Date.now(), undefined, resolveTo(ORG_A))).kind).toBe("adopt");
});

test("the other pool may hold the same account only for a proven different organization", () => {
  const store = (credential: OAuthCredentials): AuthStore => ({ anthropic: { activeAccountId: "a", accounts: [{ id: "a", credential }] } });
  const incoming = orgCredential("synthetic-pool-2", ORG_B);
  expect(() => assertNoCrossAnthropicRegistration(store(orgCredential("synthetic-pool-1", ORG_A)), "anthropic2", incoming)).not.toThrow();
  expect(() => assertNoCrossAnthropicRegistration(store(orgCredential("synthetic-pool-1", ORG_B)), "anthropic2", incoming))
    .toThrow(AnthropicCrossInstanceDuplicateError);
  expect(() => assertNoCrossAnthropicRegistration(store(orgCredential("synthetic-pool-1")), "anthropic2", incoming))
    .toThrow(AnthropicCrossInstanceDuplicateError);
});

test("a subscription label never crosses organizations of one account", () => {
  const previous = { ...orgCredential("synthetic-old", ORG_A), plan: "max_5x" };
  expect(mergeOAuthPlan(orgCredential("synthetic-new", ORG_B), previous)).toBeUndefined();
  expect(mergeOAuthPlan(orgCredential("synthetic-new", ORG_A), previous)).toBe("max_5x");
});

test("profile read fills the organization a token response left out", async () => {
  globalThis.fetch = (async (_url, init) => init?.method === "POST"
    ? Response.json({ access_token: "synthetic-fresh", refresh_token: "synthetic-fresh-refresh", expires_in: 3600,
      account: { uuid: "synthetic-account-a" } })
    : Response.json({ account: { uuid: "synthetic-account-a" }, organization: { uuid: ORG_A } })) as typeof fetch;
  expect((await refreshAnthropicToken("synthetic-old-refresh")).anthropicIdentity)
    .toEqual({ ...proof("synthetic-fresh"), organizationUuid: ORG_A });
});

test("an expired organization-less row is not asked and keeps the historical replacement", async () => {
  await saveCredential("anthropic", { ...orgCredential("synthetic-legacy"), expires: Date.now() - 1 });
  const asked = orgProfiles({ "synthetic-legacy": ORG_A });
  await saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
  expect(asked).toEqual([]);
  expect(anthropicRows()).toHaveLength(1);
  expect(anthropicRows()[0]!.credential.access).toBe("synthetic-org-b");
});

for (const source of ["oauth", "local-cli"] as const) {
  test(`${source} save refuses stale organization evidence without changing the row`, async () => {
    await saveCredential("anthropic", orgCredential("synthetic-before-refresh"));
    const refreshed = orgCredential("synthetic-refreshed");
    globalThis.fetch = (async () => {
      await mutateStore(store => { store.anthropic!.accounts[0]!.credential = refreshed; });
      return Response.json({ account: { uuid: refreshed.accountId }, organization: { uuid: ORG_A } });
    }) as typeof fetch;
    await expect(saveCredential("anthropic", { ...orgCredential("synthetic-org-b", ORG_B), source }))
      .rejects.toThrow("changed during organization verification");
    expect(anthropicRows()).toHaveLength(1);
    expect(anthropicRows()[0]!.credential).toEqual(refreshed);
  });
}

test("login, import and reauth refuse stale organization observations", async () => {
  const row = { id: "legacy", credential: orgCredential("synthetic-before-refresh"), addedAt: 0 };
  const incoming = orgCredential("synthetic-org-b", ORG_B);
  const observations = await observeAnthropicSlotOrganizations([row], incoming, undefined,
    async access => ({ ...proof(access), organizationUuid: ORG_A }));
  const refreshed = { ...row, credential: orgCredential("synthetic-refreshed") };
  expect(findAnthropicLoginSlot([row], incoming, observations)).toBeUndefined();
  expect(() => findAnthropicLoginSlot([refreshed], incoming, observations)).toThrow();
  expect(() => findAnthropicImportSlot([refreshed], { ...incoming, source: "local-cli" }, observations)).toThrow();
  const sharedRefresh = { ...refreshed, credential: { ...refreshed.credential, accountId: "synthetic-other",
    anthropicIdentity: undefined, refresh: incoming.refresh } };
  expect(() => findAnthropicImportSlot([sharedRefresh], { ...incoming, source: "local-cli" }, observations)).toThrow();
  const reauth = anthropicReauthSlotGuard(row.id, incoming, observations);
  expect(() => reauth([row])).toThrow(OAuthReauthIdentityMismatchError);
  expect(() => reauth([refreshed])).toThrow(OAuthReauthIdentityMismatchError);
  const target = { id: "target", credential: orgCredential("synthetic-target", ORG_A), addedAt: 0 };
  const siblingGuard = anthropicReauthSlotGuard(target.id, orgCredential("synthetic-org-a", ORG_A), observations);
  expect(() => siblingGuard([target, row])).toThrow(OAuthReauthIdentityMismatchError);
  expect(() => siblingGuard([target, refreshed])).toThrow(OAuthReauthIdentityMismatchError);
  const identityLost = { ...refreshed, credential: { ...refreshed.credential, anthropicIdentity: undefined, accountId: undefined } };
  expect(() => siblingGuard([target, identityLost])).toThrow(OAuthReauthIdentityMismatchError);
  const resolved = { ...refreshed, credential: orgCredential("synthetic-refreshed", ORG_B) };
  expect(findAnthropicLoginSlot([resolved], incoming, observations)).toBe(resolved);
  expect(findAnthropicImportSlot([resolved], { ...incoming, source: "local-cli" }, observations)).toBe(resolved);
  expect(() => reauth([resolved])).not.toThrow();
  expect(() => siblingGuard([target, resolved])).not.toThrow();
  const unrelated = { ...row, credential: orgCredential(row.credential.access, undefined, "synthetic-account-b") };
  expect(() => siblingGuard([target, unrelated])).not.toThrow();
});

test("a login with no proven organization never displaces a proven slot ahead of the active one", async () => {
  orgProfiles({});
  await saveCredential("anthropic", orgCredential("synthetic-org-a", ORG_A));
  const a = anthropicRows()[0]!.id;
  await saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
  const b = getAccountSet("anthropic")!.activeAccountId;
  await saveCredential("anthropic", orgCredential("synthetic-unproven"));
  expect(anthropicRows()).toHaveLength(2);
  expect(getAccountCredential("anthropic", b)!.access).toBe("synthetic-unproven");
  expect(getAccountCredential("anthropic", a)!.access).toBe("synthetic-org-a");
});

/** A legacy row (really org A) plus a proven org B row, the shape a first second-org login leaves. */
async function legacyAndOrgB() {
  await saveCredential("anthropic", orgCredential("synthetic-legacy"));
  const legacy = anthropicRows()[0]!;
  orgProfiles({ "synthetic-legacy": ORG_A });
  await saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
  const orgB = anthropicRows().find(row => row.id !== legacy.id)!.id;
  return { legacy, orgB };
}

test("Claude Code import for an organization lands in that organization's row, not a legacy one", async () => {
  const { legacy, orgB } = await legacyAndOrgB();
  await saveCredential("anthropic", { ...orgCredential("synthetic-cli-b", ORG_B), source: "local-cli" });
  expect(anthropicRows()).toHaveLength(2);
  expect(getAccountCredential("anthropic", legacy.id)).toEqual(legacy.credential);
  expect(getAccountCredential("anthropic", orgB)!.access).toBe("synthetic-cli-b");
});

test("reauth cannot turn a legacy row into a second copy of an organization another row holds", async () => {
  const { legacy } = await legacyAndOrgB();
  const original = OAUTH_PROVIDERS.anthropic!.login;
  const config = (): OcxConfig => ({ port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} });
  try {
    OAUTH_PROVIDERS.anthropic!.login = async () => orgCredential("synthetic-org-b-again", ORG_B);
    await expect(runLogin("anthropic", {} as OAuthController, { reauthAccountId: legacy.id }, { loadConfig: config, saveConfig: () => {} }))
      .rejects.toBeInstanceOf(OAuthReauthIdentityMismatchError);
    expect(getAccountCredential("anthropic", legacy.id)).toEqual(legacy.credential);
  } finally { OAUTH_PROVIDERS.anthropic!.login = original; }
});

test("reauth preserves the organization established by a legacy row's own bearer", async () => {
  await saveCredential("anthropic", orgCredential("synthetic-legacy"));
  const legacy = anthropicRows()[0]!;
  const asked = orgProfiles({ "synthetic-legacy": ORG_A });
  const original = OAUTH_PROVIDERS.anthropic!.login;
  const config = (): OcxConfig => ({ port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} });
  try {
    OAUTH_PROVIDERS.anthropic!.login = async () => orgCredential("synthetic-org-b", ORG_B);
    await expect(runLogin("anthropic", {}, { reauthAccountId: legacy.id }, { loadConfig: config, saveConfig: () => {} }))
      .rejects.toBeInstanceOf(OAuthReauthIdentityMismatchError);
    expect(asked).toEqual([legacy.credential.access]);
    expect(getAccountCredential("anthropic", legacy.id)).toEqual(legacy.credential);
  } finally { OAUTH_PROVIDERS.anthropic!.login = original; }
});

/**
 * A login for organization B and a reauth of a legacy row both pass their checks while another
 * writer holds the queue, and the login commits first. The reauth must decide again on the rows its
 * writer loads, not on the snapshot it read before queueing. Only the login can read the legacy
 * row's organization, so the reauth's own pre-lock checks pass and only the new sibling refuses it.
 */
async function reauthQueuedBehindLogin(reauthOrganization?: string) {
  await saveCredential("anthropic", orgCredential("synthetic-legacy"));
  const legacy = anthropicRows()[0]!;
  orgProfiles({ "synthetic-legacy": ORG_A });
  const original = OAUTH_PROVIDERS.anthropic!.login;
  const config = (): OcxConfig => ({ port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} });
  let reauthSettled = false;
  // Bounded below the test timeout, so a setup that never queues still reaches `finally`.
  const queued = async (count: number, settled = () => false) => {
    for (const deadline = Date.now() + 2_000; oauthMutationTailSnapshot().active < count;) {
      if (settled() || Date.now() > deadline) throw new Error(`mutation ${count} was never queued`);
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  };
  const gate = deferred();
  const held = mutateStore(() => gate.promise);
  let login: Promise<unknown> | undefined;
  let reauth: Promise<unknown> | undefined;
  try {
    await queued(1);
    login = saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
    await queued(2);
    orgProfiles({});
    OAUTH_PROVIDERS.anthropic!.login = async () => orgCredential("synthetic-reauth", reauthOrganization);
    reauth = runLogin("anthropic", {} as OAuthController, { reauthAccountId: legacy.id },
      { loadConfig: config, saveConfig: () => {} }).then(() => undefined, (error: unknown) => error)
      .finally(() => { reauthSettled = true; });
    await queued(3, () => reauthSettled);
    gate.resolve();
    await login;
    return { legacy, outcome: await reauth };
  } finally {
    gate.resolve();
    await held;
    await Promise.allSettled([login, reauth]);
    OAUTH_PROVIDERS.anthropic!.login = original;
  }
}

test("a reauth queued behind a login for the same organization is refused by the writer", async () => {
  const { legacy, outcome } = await reauthQueuedBehindLogin(ORG_B);
  expect(outcome).toBeInstanceOf(OAuthReauthIdentityMismatchError);
  const rows = anthropicRows();
  expect(rows).toHaveLength(2);
  expect(rows.filter(row => row.credential.anthropicIdentity?.organizationUuid === ORG_B)).toHaveLength(1);
  const kept = rows.find(row => row.id === legacy.id)!;
  expect(kept.credential).toEqual(legacy.credential);
  expect(kept.loginId).toBe(legacy.loginId);
});

test("the queued reauth still writes its own or an unreported organization", async () => {
  for (const organization of [ORG_A, undefined]) {
    const { legacy, outcome } = await reauthQueuedBehindLogin(organization);
    expect(outcome).toBeUndefined();
    expect(anthropicRows()).toHaveLength(2);
    expect(getAccountCredential("anthropic", legacy.id)!.access).toBe("synthetic-reauth");
    await mutateStore(store => { delete store.anthropic; });
  }
});

test("a stored proof without an organization asks its own bearer before adopting another organization", async () => {
  const stored: OAuthCredentials = { ...orgCredential("synthetic-old"), source: "local-cli" };
  disk();
  const asked: string[] = [];
  const resolve = async (access: string) => {
    asked.push(access);
    return { ...proof(access), organizationUuid: access === "synthetic-other" ? ORG_B : ORG_A };
  };
  expect((await newerClaudeCredential(stored, Date.now(), undefined, resolve)).kind).toBe("different");
  expect(asked.sort()).toEqual(["synthetic-old", "synthetic-other"]);
});

test("automatic full rotation of an unknown organization in a multi-slot account preserves both rows", async () => {
  await saveCredential("anthropic", { ...orgCredential("synthetic-legacy"), source: "local-cli" });
  const legacy = anthropicRows()[0]!;
  orgProfiles({ "synthetic-legacy": ORG_A });
  await saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
  const before = anthropicRows();
  const intent = writeOAuthRefreshIntent("anthropic", legacy.id, credentialGeneration(legacy.credential));
  disk();
  await expect(refreshAnthropicAccountWithLock("anthropic", legacy.id, noRefresh, legacy.credential, {
    resolveIdentity: async access => ({ ...proof(access), ...(access === "synthetic-other" ? { organizationUuid: ORG_B } : {}) }),
  })).rejects.toThrow();
  expect(anthropicRows()).toEqual(before);
  expect(readOAuthRefreshIntent("anthropic", legacy.id)).toEqual(intent);
  await expect(refreshAnthropicAccountWithLock("anthropic", legacy.id, noRefresh, legacy.credential, {
    resolveIdentity: async access => ({ ...proof(access), organizationUuid: ORG_A }),
  })).resolves.toBe("synthetic-other");
  expect(anthropicRows().find(row => row.id !== legacy.id)).toEqual(before.find(row => row.id !== legacy.id));
  expect(readOAuthRefreshIntent("anthropic", legacy.id)).toBeUndefined();
});

test("automatic adoption rechecks a sibling's organization inside the writer", async () => {
  await saveCredential("anthropic", { ...orgCredential("synthetic-old", ORG_A), source: "local-cli" });
  const target = anthropicRows()[0]!;
  await saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
  const siblingId = anthropicRows().find(row => row.id !== target.id)!.id;
  const started = deferred();
  const proceed = deferred();
  disk();
  const adoption = refreshAnthropicAccountWithLock("anthropic", target.id, noRefresh, target.credential, {
    resolveIdentity: async access => {
      started.resolve();
      await proceed.promise;
      return { ...proof(access), organizationUuid: ORG_A };
    },
  });
  const result = adoption.then(() => undefined, (error: unknown) => error);
  try {
    await started.promise;
    // A concurrent update changes only the sibling's grant while the target is being observed.
    await saveAccountCredential("anthropic", siblingId, orgCredential("synthetic-sibling-updated", ORG_A));
  } finally {
    proceed.resolve();
    await result;
  }
  expect(await result).toBeInstanceOf(OAuthTokenRefreshStaleError);
  expect(getAccountCredential("anthropic", target.id)).toEqual(target.credential);
  expect(getAccountCredential("anthropic", siblingId)?.access).toBe("synthetic-sibling-updated");
});

test("a fresh old-bearer profile without an organization is read only once", async () => {
  const stored: OAuthCredentials = { ...orgCredential("synthetic-old"), source: "local-cli", anthropicIdentity: undefined };
  const asked: string[] = [];
  disk();
  await newerClaudeCredential(stored, Date.now(), undefined, async access => {
    asked.push(access);
    return { ...proof(access), ...(access === "synthetic-other" ? { organizationUuid: ORG_A } : {}) };
  });
  expect(asked.sort()).toEqual(["synthetic-old", "synthetic-other"]);
});

test("automatic full rotation respects organization ownership across both Anthropic pools", async () => {
  const legacy = { ...orgCredential("synthetic-old"), anthropicIdentity: undefined, source: "local-cli" as const };
  await saveCredential("anthropic", legacy);
  await saveCredential("anthropic2", orgCredential("synthetic-pool-2", ORG_B));
  const target = anthropicRows()[0]!;
  const sibling = getAccountSet("anthropic2")!;
  const intent = writeOAuthRefreshIntent("anthropic", target.id, credentialGeneration(target.credential));
  disk();
  const adopt = (oldOrganization: string | undefined, newOrganization: string) =>
    refreshAnthropicAccountWithLock("anthropic", target.id, noRefresh, target.credential, {
      resolveIdentity: async access => ({ ...proof(access), organizationUuid: access === target.credential.access
        ? oldOrganization : newOrganization }),
    });

  await expect(adopt(ORG_B, ORG_B)).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
  await expect(adopt(undefined, ORG_A)).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
  expect(anthropicRows()).toEqual([target]);
  expect(getAccountSet("anthropic2")).toEqual(sibling);
  expect(readOAuthRefreshIntent("anthropic", target.id)).toEqual(intent);
  await expect(adopt(ORG_A, ORG_A)).resolves.toBe("synthetic-other");
  expect(getAccountSet("anthropic2")).toEqual(sibling);
  expect(readOAuthRefreshIntent("anthropic", target.id)).toBeUndefined();
});

test("automatic full rotation refuses a same-account row of unknown organization in the other pool", async () => {
  await saveCredential("anthropic", { ...orgCredential("synthetic-old"), anthropicIdentity: undefined, source: "local-cli" });
  await saveCredential("anthropic2", orgCredential("synthetic-pool-2"));
  const target = anthropicRows()[0]!;
  const sibling = getAccountSet("anthropic2")!;
  const intent = writeOAuthRefreshIntent("anthropic", target.id, credentialGeneration(target.credential));
  disk();
  await expect(refreshAnthropicAccountWithLock("anthropic", target.id, noRefresh, target.credential, {
    resolveIdentity: async access => ({ ...proof(access), organizationUuid: ORG_A }),
  })).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
  expect(anthropicRows()).toEqual([target]);
  expect(getAccountSet("anthropic2")).toEqual(sibling);
  expect(readOAuthRefreshIntent("anthropic", target.id)).toEqual(intent);
});

function profileOnlyTokenResponse(
  profileAccount = "synthetic-account-a", tokenAccount?: string, tokenOrganization?: string, profileOrganization: string | null = ORG_B,
) {
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST") return Response.json({
      access_token: "synthetic-fresh", refresh_token: "synthetic-fresh-refresh", expires_in: 3600,
      ...(tokenAccount ? { account: { uuid: tokenAccount } } : {}),
      ...(tokenOrganization ? { organization: { uuid: tokenOrganization } } : {}),
    });
    const bearer = new Headers(init?.headers).get("authorization");
    expect(bearer).toBe("Bearer synthetic-fresh");
    return Response.json({ account: { uuid: profileAccount }, organization: { uuid: profileOrganization, name: "Synthetic Org B" } });
  }) as typeof fetch;
}

test("an OAuth grant without a token account UUID uses both proofs from its bearer profile", async () => {
  profileOnlyTokenResponse();
  const credential = await refreshAnthropicToken("synthetic-old-refresh");
  expect(credential).toMatchObject({ accountId: "synthetic-account-a", organizationName: "Synthetic Org B",
    anthropicIdentity: { ...proof("synthetic-fresh"), organizationUuid: ORG_B } });
});

test("a profile can fill the missing account while retaining the exchange organization", async () => {
  for (const profileOrganization of [ORG_B, null]) {
    profileOnlyTokenResponse(undefined, undefined, ORG_B.toUpperCase(), profileOrganization);
    const credential = await refreshAnthropicToken("synthetic-old-refresh");
    expect(credential.anthropicIdentity).toEqual({ ...proof("synthetic-fresh"), organizationUuid: ORG_B });
    expect(credential.organizationName).toBe(profileOrganization ? "Synthetic Org B" : undefined);
  }
});

test("browser login with a profile-only organization leaves the active grant intact", async () => {
  await saveCredential("anthropic", orgCredential("synthetic-org-a", ORG_A));
  const first = anthropicRows()[0]!;
  profileOnlyTokenResponse();
  const config = (): OcxConfig => ({ port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} });
  let state: string | null = null;
  await runLogin("anthropic", {
    onAuth: ({ url }) => { state = new URL(url).searchParams.get("state"); },
    onManualCodeInput: async () => `synthetic-code#${state}`,
  }, { codeMode: true }, { loadConfig: config, saveConfig: () => {} });
  expect(anthropicRows()).toHaveLength(2);
  expect(getAccountCredential("anthropic", first.id)).toEqual(first.credential);
  expect(anthropicRows().find(row => row.id !== first.id)?.credential.anthropicIdentity?.organizationUuid).toBe(ORG_B);
});

test.each([
  { organization: ORG_B, sameSlot: false },
  { organization: ORG_A, sameSlot: true },
])("browser login honors exchange organization $organization when the profile is unavailable", async ({ organization, sameSlot }) => {
  await saveCredential("anthropic", orgCredential("synthetic-org-a", ORG_A));
  const before = getAccountSet("anthropic")!;
  const active = before.accounts[0]!;
  globalThis.fetch = (async (_url, init) => init?.method === "POST"
    ? Response.json({ access_token: "synthetic-fresh", refresh_token: "synthetic-fresh-refresh", expires_in: 3600,
      organization: { uuid: organization.toUpperCase() } })
    : new Response(null, { status: 503 })) as typeof fetch;
  const config = (): OcxConfig => ({ port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} });
  let state: string | null = null;
  await runLogin("anthropic", {
    onAuth: ({ url }) => { state = new URL(url).searchParams.get("state"); },
    onManualCodeInput: async () => `synthetic-code#${state}`,
  }, {}, { loadConfig: config, saveConfig: () => {} });

  const after = getAccountSet("anthropic")!;
  if (sameSlot) {
    expect(after.activeAccountId).toBe(active.id);
    expect(after.accounts).toHaveLength(1);
  } else {
    expect(getAccountCredential("anthropic", active.id)).toEqual(active.credential);
    expect(after.activeAccountId).not.toBe(active.id);
    expect(after.accounts).toHaveLength(2);
  }
  const saved = getAccountCredential("anthropic", after.activeAccountId)!;
  expect(saved.access).toBe("synthetic-fresh");
  expect(anthropicOrganization(saved)).toBe(organization);
  expect(saved.accountId).toBeUndefined();
  expect(saved.anthropicIdentity).toBeUndefined();
});

test.each<{
  scenario: string;
  outcome: "reuse" | "add" | "refuse";
  organization?: string;
  email?: string;
  storedEmail?: string;
  legacy?: boolean;
  unidentified?: boolean;
}>([
  { scenario: "reuses an exact same-organization email", outcome: "reuse" },
  { scenario: "reuses a trimmed email with an ASCII domain case variant", email: " shared@Example.Test ", outcome: "reuse" },
  { scenario: "preserves a slot with an ASCII local-part case variant", email: "Shared@example.test", outcome: "add" },
  { scenario: "preserves a slot with a Unicode local-part case collision", storedEmail: "k@example.test", email: "K@example.test", outcome: "add" },
  { scenario: "preserves a slot with a different Unicode local-part encoding", storedEmail: "é@example.test", email: "e\u0301@example.test", outcome: "add" },
  { scenario: "preserves a slot with a differently spelled IDN", storedEmail: "shared@bücher.example.test", email: "shared@Bücher.example.test", outcome: "add" },
  { scenario: "preserves a slot with a differently spelled IDN A-label", storedEmail: "shared@xn--bcher-kva.example.test", email: "shared@XN--BCHER-KVA.example.test", outcome: "add" },
  { scenario: "adds a different-organization slot", organization: ORG_B, outcome: "add" },
  { scenario: "preserves a legacy slot with the same email and unknown organization", legacy: true, outcome: "add" },
  { scenario: "preserves an unidentified active row during normal sign-in", unidentified: true, outcome: "add" },
  { scenario: "refuses ambiguous same-organization slots", outcome: "refuse" },
])("email-only browser login $scenario when the profile is unavailable", async ({
  organization = ORG_A, email = "shared@example.test", storedEmail = "shared@example.test", legacy, unidentified, outcome,
}) => {
  const credential = { ...orgCredential("synthetic-org-a", ORG_A), email: unidentified ? undefined : storedEmail };
  if (legacy || unidentified) {
    credential.accountId = undefined;
    credential.anthropicIdentity = undefined;
  }
  await saveCredential("anthropic", credential);
  if (outcome === "refuse") await saveCredential("anthropic", orgCredential("synthetic-other-account", ORG_A, "synthetic-account-b"));
  const before = getAccountSet("anthropic")!;
  const original = before.accounts[0]!;
  if (outcome === "refuse") expect(before.accounts).toHaveLength(2);
  if (legacy || unidentified) expect(anthropicOrganization(original.credential)).toBeUndefined();

  let profileReads = 0;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST") return Response.json({
      access_token: "synthetic-fresh", refresh_token: "synthetic-fresh-refresh", expires_in: 3600,
      account: { email_address: email }, organization: { uuid: organization },
    });
    profileReads++;
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  const config = (): OcxConfig => ({ port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} });
  let state: string | null = null;
  const login = runLogin("anthropic", {
    onAuth: ({ url }) => { state = new URL(url).searchParams.get("state"); },
    onManualCodeInput: async () => `synthetic-code#${state}`,
  }, { codeMode: true, ...(unidentified ? {} : { forceLogin: true }) }, { loadConfig: config, saveConfig: () => {} });

  if (outcome === "refuse") {
    await expect(login).rejects.toThrow("Multiple Anthropic login slots match");
    expect(getAccountSet("anthropic")).toEqual(before);
  } else {
    await login;
    const after = getAccountSet("anthropic")!;
    if (outcome === "reuse") {
      expect(after.accounts).toHaveLength(1);
      expect(after.activeAccountId).toBe(original.id);
    } else {
      expect(after.accounts).toHaveLength(2);
      expect(after.activeAccountId).not.toBe(original.id);
      expect(getAccountCredential("anthropic", original.id)).toEqual(original.credential);
    }
    const saved = getAccountCredential("anthropic", after.activeAccountId)!;
    expect(saved.access).toBe("synthetic-fresh");
    expect(anthropicOrganization(saved)).toBe(organization);
    expect(saved.accountId).toBeUndefined();
    expect(saved.anthropicIdentity).toBeUndefined();
  }
  expect(profileReads).toBe(legacy ? 2 : 1);
});

test.each([
  { scenario: "a reassigned email", profiles: { "synthetic-email-only": ORG_A }, accountUuid: "synthetic-account-b" },
  { scenario: "an unavailable profile", profiles: {}, accountUuid: "synthetic-account-a" },
] as const)("UUID recovery appends a slot for $scenario", async ({ profiles, accountUuid }) => {
  await saveCredential("anthropic", emailOnlyCredential("synthetic-email-only", ORG_A));
  const slot = anthropicRows()[0]!;
  expect(slot.credential.accountId).toBeUndefined();
  const asked = orgProfiles(profiles, accountUuid);
  const incoming = orgCredential("synthetic-incoming", ORG_A);
  await saveCredential("anthropic", incoming);
  expect(anthropicRows()).toHaveLength(2);
  expect(anthropicRows().find(row => row.id === slot.id)).toEqual(slot);
  expect(getAccountSet("anthropic")!.activeAccountId).not.toBe(slot.id);
  expect(getAccountCredential("anthropic", getAccountSet("anthropic")!.activeAccountId)).toEqual(incoming);
  expect(asked).toEqual([slot.credential.access]);
});

test.each(["shared refresh token", "matching profile UUID"] as const)(
  "UUID recovery reuses the email-only slot with a %s", async continuity => {
    await saveCredential("anthropic", emailOnlyCredential("synthetic-email-only", ORG_A));
    const slot = anthropicRows()[0]!;
    const sharedRefresh = continuity === "shared refresh token";
    const asked = orgProfiles(sharedRefresh ? {} : { [slot.credential.access]: ORG_A });
    const incoming = { ...orgCredential("synthetic-incoming", ORG_A), email: "shared@Example.Test" };
    if (sharedRefresh) incoming.refresh = slot.credential.refresh;
    await saveCredential("anthropic", incoming);
    expect(anthropicRows()).toHaveLength(1);
    expect(getAccountSet("anthropic")!.activeAccountId).toBe(slot.id);
    expect(getAccountCredential("anthropic", slot.id)).toEqual(incoming);
    expect(asked).toEqual(sharedRefresh ? [] : [slot.credential.access]);
  },
);

test.each([
  { outcome: "refuses a shared token", sharedRefresh: true },
  { outcome: "appends with a distinct token", sharedRefresh: false },
])("UUID recovery $outcome when the candidate bearer changes before the writer lock", async ({ sharedRefresh }) => {
  await saveCredential("anthropic", emailOnlyCredential("synthetic-email-only", ORG_A));
  const slot = anthropicRows()[0]!;
  const incoming = orgCredential("synthetic-incoming", ORG_A);
  const rotated = emailOnlyCredential("synthetic-rotated", ORG_A);
  if (sharedRefresh) rotated.refresh = incoming.refresh;
  const asked = orgProfiles({ [slot.credential.access]: ORG_A });
  const gate = deferred();
  const locked = deferred();
  const held = mutateStore(async store => {
    locked.resolve();
    await gate.promise;
    store.anthropic!.accounts[0]!.credential = rotated;
  });
  await locked.promise;
  const login = saveCredential("anthropic", incoming).catch((error: unknown) => error);
  try {
    for (const deadline = Date.now() + 2_000; oauthMutationTailSnapshot().active < 2;) {
      if (Date.now() > deadline) throw new Error("UUID recovery did not queue behind the writer");
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(asked).toEqual([slot.credential.access]);
  } finally {
    gate.resolve();
    await Promise.all([held, login]);
  }
  expect(anthropicRows()).toHaveLength(sharedRefresh ? 1 : 2);
  expect(getAccountCredential("anthropic", slot.id)).toEqual(rotated);
  if (sharedRefresh) {
    expect(await login).toMatchObject({ message: "This Anthropic refresh token already belongs to another slot. Try signing in again." });
    expect(getAccountSet("anthropic")!.activeAccountId).toBe(slot.id);
  } else {
    expect(getAccountCredential("anthropic", getAccountSet("anthropic")!.activeAccountId)).toEqual(incoming);
  }
});

test.each(["anthropic", "anthropic2"] as const)("%s login cannot persist a refresh token owned by another slot", async provider => {
  const owner = orgCredential("synthetic-owner", ORG_A);
  await saveCredential(provider, owner);
  const authFile = Bun.file(storeModule.getAuthStorePath());
  const before = await authFile.text();
  const incoming = { ...orgCredential("synthetic-other-org", ORG_B), refresh: owner.refresh };

  const login = saveCredential(provider, incoming);
  await expect(login).rejects.toThrow("Try signing in again");
  expect(await authFile.text()).toBe(before);
  expect(getAccountSet(provider)!.accounts.map(row => row.credential.refresh)).toEqual([owner.refresh]);
});

test.each(["anthropic", "anthropic2"] as const)("%s reauth refuses a sibling's refresh token and accepts its own", async provider => {
  const target = orgCredential("synthetic-target", ORG_A);
  const sibling = emailOnlyCredential("synthetic-sibling", ORG_B);
  const targetId = (await storeModule.saveCredentialWithReceipt(provider, target))!.accountId;
  const siblingId = (await storeModule.saveCredentialWithReceipt(provider, sibling))!.accountId;
  expect(siblingId).not.toBe(targetId);
  const storedSibling = getAccountCredential(provider, siblingId)!;
  expect(storedSibling.accountId).toBeUndefined();

  const authFile = Bun.file(storeModule.getAuthStorePath());
  const before = await authFile.bytes();
  const fresh = orgCredential("synthetic-reauth", ORG_A);
  const login = spyOn(OAUTH_PROVIDERS[provider]!, "login");
  try {
    login.mockResolvedValue({ ...fresh, refresh: storedSibling.refresh });
    await expect(runLogin(provider, {}, { reauthAccountId: targetId }))
      .rejects.toThrow("This Anthropic refresh token already belongs to another slot. Try signing in again.");
    expect(await authFile.bytes()).toEqual(before);

    login.mockResolvedValue({ ...fresh, refresh: target.refresh });
    await runLogin(provider, {}, { reauthAccountId: targetId });
    expect(getAccountCredential(provider, targetId)).toMatchObject({ access: fresh.access, refresh: target.refresh });
    expect(getAccountCredential(provider, siblingId)).toEqual(storedSibling);
  } finally { login.mockRestore(); }
});

test("UUID recovery preserves an unidentified active row when continuity is unavailable", async () => {
  await saveCredential("anthropic", { access: "synthetic-legacy", refresh: "synthetic-legacy-refresh", expires: 1 });
  const legacy = anthropicRows()[0]!;
  await saveCredential("anthropic", emailOnlyCredential("synthetic-email-only", ORG_A));
  await setActiveAccount("anthropic", legacy.id);
  const before = getAccountSet("anthropic")!;
  expect(before.activeAccountId).toBe(legacy.id);
  expect(before.accounts).toHaveLength(2);
  const incoming = orgCredential("synthetic-incoming", ORG_A);
  await saveCredential("anthropic", incoming);
  const after = getAccountSet("anthropic")!;
  expect(after.accounts).toHaveLength(3);
  expect(after.accounts.slice(0, 2)).toEqual(before.accounts);
  expect(getAccountCredential("anthropic", after.activeAccountId)).toEqual(incoming);
});

test("UUID recovery refuses ambiguous slots and preserves other accounts and organizations", () => {
  const incoming = orgCredential("synthetic-incoming", ORG_A);
  const row = (id: string, credential: OAuthCredentials) => ({ id, credential, addedAt: 0 });
  const emailOnly = row("email-only", emailOnlyCredential("synthetic-email-only", ORG_A));
  // Never a row of another known account or organization, and never a guess between candidates.
  expect(findAnthropicLoginSlot([row("other-account", orgCredential("synthetic-other", ORG_A, "synthetic-account-b"))], incoming)).toBeUndefined();
  expect(findAnthropicLoginSlot([row("other-organization", emailOnlyCredential("synthetic-org-b", ORG_B))], incoming)).toBeUndefined();
  expect(() => findAnthropicLoginSlot([emailOnly, row("twin", emailOnlyCredential("synthetic-twin", ORG_A))], incoming))
    .toThrow("Multiple Anthropic login slots match");
  expect(() => findAnthropicLoginSlot([emailOnly, row("other-account", orgCredential("synthetic-other", ORG_A, "synthetic-account-b"))], incoming))
    .toThrow("Multiple Anthropic login slots match");
});

test("browser login refuses a conflicting profile organization when the exchange omits the account", async () => {
  await saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
  const before = getAccountSet("anthropic")!;
  profileOnlyTokenResponse(undefined, undefined, ORG_A.toUpperCase());
  const config = (): OcxConfig => ({ port: 10100, defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {} });
  let state: string | null = null;
  await expect(runLogin("anthropic", {
    onAuth: ({ url }) => { state = new URL(url).searchParams.get("state"); },
    onManualCodeInput: async () => `synthetic-code#${state}`,
  }, { codeMode: true }, { loadConfig: config, saveConfig: () => {} })).rejects.toThrow("organization");
  expect(getAccountSet("anthropic")).toEqual(before);
});

test("refresh keeps the rotated grant without binding a conflicting profile organization", async () => {
  profileOnlyTokenResponse(undefined, undefined, ORG_A);
  const credential = await refreshAnthropicToken("synthetic-old-refresh");
  expect(credential.refresh).toBe("synthetic-fresh-refresh");
  expect(credential.anthropicIdentity).toBeUndefined();
  expect(credential.organizationName).toBeUndefined();
});

test("partial refresh scope governs later login even when the profile repeats a conflicting organization", async () => {
  const previous = { ...orgCredential("synthetic-old"), expires: 1 };
  await saveCredential("anthropic", previous);
  const id = getAccountSet("anthropic")!.activeAccountId;
  profileOnlyTokenResponse(undefined, undefined, ORG_A);
  await expect(refreshAnthropicAccountWithLock("anthropic", id, OAUTH_PROVIDERS.anthropic!, previous))
    .resolves.toBe("synthetic-fresh");
  const rotated = getAccountCredential("anthropic", id)!;
  expect(rotated).toMatchObject({ refresh: "synthetic-fresh-refresh", accountId: previous.accountId });
  expect(rotated.anthropicIdentity).toBeUndefined();
  expect(rotated.organizationName).toBeUndefined();

  const asked = orgProfiles({ "synthetic-fresh": ORG_B });
  await saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
  expect(anthropicRows()).toHaveLength(2);
  expect(getAccountCredential("anthropic", id)).toEqual(rotated);
  expect(asked).toEqual([]);
  expect(anthropicOrganization(rotated)).toBe(ORG_A);
  expect(anthropicOrganization({ ...rotated, access: "synthetic-different" })).toBeUndefined();
  expect(getLoginStatus("anthropic").accounts!.find(row => row.id === id)).not.toHaveProperty("anthropicOrganizationScope");
  await saveCredential("anthropic", orgCredential("synthetic-org-a", ORG_A));
  expect(anthropicRows()).toHaveLength(2);
  expect(getAccountCredential("anthropic", id)?.access).toBe("synthetic-org-a");
});

test("partial refresh scope survives a same-bearer account write and protects an identity-less legacy slot", async () => {
  const previous: OAuthCredentials = { access: "synthetic-old", refresh: "synthetic-old-refresh", expires: 1, source: "oauth" };
  await saveCredential("anthropic", previous);
  const id = getAccountSet("anthropic")!.activeAccountId;
  profileOnlyTokenResponse(undefined, undefined, ORG_A);
  await refreshAnthropicAccountWithLock("anthropic", id, OAUTH_PROVIDERS.anthropic!, previous);
  const rotated = getAccountCredential("anthropic", id)!;
  expect(rotated.accountId).toBeUndefined();
  expect(anthropicOrganization(rotated)).toBe(ORG_A);

  await saveAccountCredential("anthropic", id, { ...rotated, anthropicOrganizationScope: undefined });
  orgProfiles({ "synthetic-fresh": ORG_B });
  await saveCredential("anthropic", orgCredential("synthetic-org-b", ORG_B));
  expect(anthropicRows()).toHaveLength(2);
  expect(getAccountCredential("anthropic", id)).toEqual(rotated);
});

test("a profile for a different proven account leaves token identity and labels untouched", async () => {
  profileOnlyTokenResponse("synthetic-account-b", "synthetic-account-a");
  const credential = await refreshAnthropicToken("synthetic-old-refresh");
  expect(credential.anthropicIdentity).toEqual(proof("synthetic-fresh"));
  expect(credential.organizationName).toBeUndefined();
});

/** Token and profile answers for one grant of synthetic-account-a; profile 503 when `profile` is undefined. */
function orgNameFetch(organizationUuid: string, profile?: Record<string, unknown>) {
  globalThis.fetch = (async (_url, init) => init?.method === "POST"
    ? Response.json({ access_token: "synthetic-fresh", refresh_token: "synthetic-fresh-refresh", expires_in: 3600,
      account: { uuid: "synthetic-account-a" }, organization: { uuid: organizationUuid } })
    : profile === undefined ? new Response(null, { status: 503 })
      : Response.json({ account: { uuid: "synthetic-account-a" }, organization: profile })) as typeof fetch;
}

test("the profile names the grant's organization and status shows it as display-only metadata", async () => {
  orgNameFetch(ORG_A, { uuid: ORG_A, name: " Synthetic Org A " });
  await saveCredential("anthropic", await refreshAnthropicToken("synthetic-old-refresh"));
  const row = getLoginStatus("anthropic").accounts![0]!;
  expect(row.organizationName).toBe("Synthetic Org A");
  expect(row).not.toHaveProperty("anthropicIdentity");
  for (const [profile, expected] of [
    // No organization in the profile: it cannot confirm the token response's, so nothing is observed.
    [{ name: "Synthetic Org A" }, undefined],
    [{ uuid: ORG_A, name: "bad\u0007name" }, null],
    [{ uuid: ORG_A, name: "Synthetic\u202eOrg" }, null],
  ] as const) {
    orgNameFetch(ORG_A, profile);
    expect((await refreshAnthropicToken("synthetic-old-refresh")).organizationName).toBe(expected);
  }
  // A profile for another organization than the token response observed a different grant: its
  // name and tier stay unobserved, so the stored labels of this grant survive the merge.
  orgNameFetch(ORG_A, { uuid: ORG_B, name: "Synthetic Org B", rate_limit_tier: "default_claude_max_20x" });
  const mismatched = await refreshAnthropicToken("synthetic-old-refresh");
  expect(mismatched.organizationName).toBeUndefined();
  expect(mismatched.plan).toBeUndefined();
});

test("each organization row keeps its own name", async () => {
  orgProfiles({});
  await saveCredential("anthropic", { ...orgCredential("synthetic-org-a", ORG_A), organizationName: "Synthetic Org A" });
  await saveCredential("anthropic", { ...orgCredential("synthetic-org-b", ORG_B), organizationName: "Synthetic Org B" });
  expect(getLoginStatus("anthropic").accounts!.map(row => row.organizationName).sort())
    .toEqual(["Synthetic Org A", "Synthetic Org B"]);
});

test("an organization name is kept through an unread profile but never crosses organizations", async () => {
  const previous = { ...orgCredential("synthetic-old", ORG_A), organizationName: "Synthetic Org A" };
  expect(mergeOAuthOrganizationName(orgCredential("synthetic-new", ORG_A), previous)).toBe("Synthetic Org A");
  expect(mergeOAuthOrganizationName(orgCredential("synthetic-new", ORG_B), previous)).toBeUndefined();
  expect(mergeOAuthOrganizationName({ ...orgCredential("synthetic-new", ORG_A), organizationName: null }, previous)).toBeNull();
  // A name claims which organization a row serves: an unknown organization on either side drops it.
  expect(mergeOAuthOrganizationName(orgCredential("synthetic-new"), previous)).toBeUndefined();
  expect(mergeOAuthOrganizationName(orgCredential("synthetic-new", ORG_A),
    { ...orgCredential("synthetic-old"), organizationName: "Synthetic Org A" })).toBeUndefined();
  await saveCredential("anthropic", { ...previous, expires: 1 });
  const id = getAccountSet("anthropic")!.activeAccountId;
  orgNameFetch(ORG_A);
  await refreshAnthropicAccountWithLock("anthropic", id, OAUTH_PROVIDERS.anthropic!, getAccountCredential("anthropic", id)!);
  expect(getLoginStatus("anthropic").accounts![0]!.organizationName).toBe("Synthetic Org A");
  orgNameFetch(ORG_A, { uuid: ORG_A, name: "Synthetic Org A Renamed" });
  await mutateStore(store => { store.anthropic!.accounts[0]!.credential.expires = 1; });
  await refreshAnthropicAccountWithLock("anthropic", id, OAUTH_PROVIDERS.anthropic!, getAccountCredential("anthropic", id)!);
  expect(getLoginStatus("anthropic").accounts![0]!.organizationName).toBe("Synthetic Org A Renamed");
});

test("adopting Claude Code's rotated refresh token on the same bearer keeps the organization name", async () => {
  const stored: OAuthCredentials = { ...orgCredential("synthetic-same", ORG_A), source: "local-cli",
    organizationName: "Synthetic Org A", expires: Date.now() + 120_000 };
  disk("synthetic-same", "synthetic-rotated-refresh");
  const observation = await newerClaudeCredential(stored, Date.now());
  expect(observation.kind).toBe("adopt");
  if (observation.kind === "adopt") {
    expect(observation.credential.refresh).toBe("synthetic-rotated-refresh");
    expect(observation.credential.organizationName).toBe("Synthetic Org A");
  }
});
