import * as localTokens from "../../src/oauth/local-token-detect";
import * as storeModule from "../../src/oauth/store";
import { createHash } from "node:crypto";
import { getLoginStatus, OAUTH_PROVIDERS, refreshAnthropicAccountWithLock } from "../../src/oauth";
import { AnthropicTokenError, loginAnthropic, refreshAnthropicToken } from "../../src/oauth/anthropic";
import { resolveAnthropicAccountIdentity } from "../../src/oauth/anthropic-identity";
import { captureOAuthAccountSelection, loadAuthStore, mutateStore, removeAccount, saveAccountCredential, setAccountPaused } from "../../src/oauth/store";
import type { OAuthCredentials } from "../../src/oauth/types";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidAccessToken, OAuthTokenRefreshStaleError } from "../../src/oauth";
import { credentialGeneration, getAccountCredential, getAccountSet, readOAuthRefreshIntent, saveCredential, writeOAuthRefreshIntent } from "../../src/oauth/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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
  const originalDetect = localTokens.detectClaudeCodeToken;
  const reads: boolean[] = [];
  let insidePersistence = false;
  const detect = spyOn(localTokens, "detectClaudeCodeToken").mockImplementation(() => {
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
