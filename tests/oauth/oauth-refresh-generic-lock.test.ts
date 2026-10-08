import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getValidAccessTokenForAccount,
  refreshGenericAccountWithLock,
  OAuthLoginRequiredError,
  OAUTH_PROVIDERS,
} from "../../src/oauth";
import type { OAuthCredentials } from "../../src/oauth/types";
import { ChatGptTokenError } from "../../src/oauth/chatgpt";
import { getAccountCredential, getAccountSet, saveCredential } from "../../src/oauth/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Gate/CAS refresh races can exceed the 5s default under windows-latest contention
// (same flake class as kiro-oauth / oauth queue budgets).
setDefaultTimeout(30_000);

const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
const origKimiRefresh = OAUTH_PROVIDERS.kimi!.refresh;
let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `oauth-generic-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
});

afterEach(() => {
  OAUTH_PROVIDERS.kimi!.refresh = origKimiRefresh;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = origOcxHome;
  removeTreeWithRetry(tmp);
});

async function seedExpiredKimi(): Promise<string> {
  await saveCredential("kimi", {
    access: "kimi-old",
    refresh: "rt-old",
    expires: Date.now() - 1,
    accountId: "kimi-acct",
  });
  return getAccountSet("kimi")!.activeAccountId;
}

function stubKimiRefresh(
  handler: (refreshToken: string) => Promise<OAuthCredentials>,
): { calls: () => number } {
  let refreshCalls = 0;
  OAUTH_PROVIDERS.kimi!.refresh = async (refreshToken: string) => {
    refreshCalls++;
    return handler(refreshToken);
  };
  return { calls: () => refreshCalls };
}

describe("generic OAuth refresh lock + CAS", () => {
  test("ten concurrent generic refreshes share one IdP call and same credential", async () => {
    const accountId = await seedExpiredKimi();
    const tracker = stubKimiRefresh(async () => ({
      access: "kimi-fresh",
      refresh: "rotated-refresh",
      expires: Date.now() + 3_600_000,
    }));

    const results = await Promise.all(
      Array.from({ length: 10 }, () => getValidAccessTokenForAccount("kimi", accountId)),
    );

    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("kimi-fresh");
    expect(tracker.calls()).toBe(1);
    expect(getAccountCredential("kimi", accountId)?.refresh).toBe("rotated-refresh");
  });

  test("failed refresh clears single-flight so a later call can retry", async () => {
    const accountId = await seedExpiredKimi();
    let refreshCalls = 0;
    OAUTH_PROVIDERS.kimi!.refresh = async () => {
      refreshCalls++;
      if (refreshCalls === 1) throw new Error("network down");
      return {
        access: "kimi-recovered",
        refresh: "rotated-refresh",
        expires: Date.now() + 3_600_000,
      };
    };

    await expect(getValidAccessTokenForAccount("kimi", accountId)).rejects.toThrow("network down");
    await expect(getValidAccessTokenForAccount("kimi", accountId)).resolves.toBe("kimi-recovered");
    expect(refreshCalls).toBe(2);
  });

  test("after lock acquire, a newer disk credential is adopted without a second IdP call", async () => {
    const accountId = await seedExpiredKimi();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tracker = stubKimiRefresh(async () => {
      await gate;
      return {
        access: "stale-refresh-result",
        refresh: "rt-from-idp",
        expires: Date.now() + 3_600_000,
      };
    });

    const pending = getValidAccessTokenForAccount("kimi", accountId);
    while (tracker.calls() === 0) await Bun.sleep(1);

    await saveCredential("kimi", {
      access: "writer-fresh",
      refresh: "writer-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "kimi-acct",
    });
    release();

    await expect(pending).resolves.toBe("writer-fresh");
    expect(tracker.calls()).toBe(1);
    expect(getAccountCredential("kimi", accountId)?.refresh).toBe("writer-refresh");
  });

  test("older refresh result cannot overwrite newer stored token", async () => {
    const accountId = await seedExpiredKimi();
    let reject!: () => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const tracker = stubKimiRefresh(
      () => new Promise<OAuthCredentials>((_, rejectPromise) => {
        started();
        reject = () => rejectPromise(new Error("late idp failure"));
      }),
    );

    const pending = getValidAccessTokenForAccount("kimi", accountId);
    await began;
    await saveCredential("kimi", {
      access: "newer-writer",
      refresh: "newer-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "kimi-acct",
    });
    reject();
    await expect(pending).rejects.toThrow("late idp failure");
    expect(getAccountCredential("kimi", accountId)?.access).toBe("newer-writer");
    expect(getAccountCredential("kimi", accountId)?.refresh).toBe("newer-refresh");
  });

  test("late refresh result adopts superseding fresh credential via CAS", async () => {
    const accountId = await seedExpiredKimi();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tracker = stubKimiRefresh(async () => {
      await gate;
      return {
        access: "late-idp-access",
        refresh: "late-idp-refresh",
        expires: Date.now() + 3_600_000,
      };
    });

    const pending = getValidAccessTokenForAccount("kimi", accountId);
    while (tracker.calls() === 0) await Bun.sleep(1);

    await saveCredential("kimi", {
      access: "superseding-writer",
      refresh: "superseding-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "kimi-acct",
    });
    release();

    await expect(pending).resolves.toBe("superseding-writer");
    expect(getAccountCredential("kimi", accountId)?.refresh).toBe("superseding-refresh");
    expect(tracker.calls()).toBe(1);
  });

  test("terminal refresh failure marks needsReauth only for matching generation", async () => {
    const accountId = await seedExpiredKimi();
    let reject!: () => void;
    let refreshCalls = 0;
    const gate = new Promise<never>((_, rejectPromise) => {
      reject = () => rejectPromise(new Error("invalid_grant"));
    });
    OAUTH_PROVIDERS.kimi!.refresh = async () => {
      refreshCalls++;
      return gate;
    };

    const pending = getValidAccessTokenForAccount("kimi", accountId);
    while (refreshCalls === 0) await Bun.sleep(1);
    await saveCredential("kimi", {
      access: "replacement",
      refresh: "replacement-rt",
      expires: Date.now() + 3_600_000,
      accountId: "kimi-acct",
    });
    reject();

    await expect(pending).rejects.toBeInstanceOf(OAuthLoginRequiredError);
    expect(getAccountCredential("kimi", accountId)?.access).toBe("replacement");
    expect(getAccountSet("kimi")!.accounts.find(a => a.id === accountId)!.needsReauth).toBeUndefined();
  });
});

describe("ChatGPT refresh through the registered provider", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  async function seedExpiredChatgpt(): Promise<string> {
    await saveCredential("chatgpt", {
      access: "chatgpt-old", refresh: "rt-old", expires: Date.now() - 1, accountId: "chatgpt-acct",
    });
    return getAccountSet("chatgpt")!.activeAccountId;
  }

  test("a nested terminal endpoint response marks the account needsReauth", async () => {
    const accountId = await seedExpiredChatgpt();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ error: { code: "refresh_token_expired", message: "synthetic private text" } }, { status: 401 });
    }) as typeof fetch;
    await expect(getValidAccessTokenForAccount("chatgpt", accountId)).rejects.toBeInstanceOf(OAuthLoginRequiredError);
    expect(getAccountSet("chatgpt")!.accounts.find(a => a.id === accountId)!.needsReauth).toBe(true);
    expect(calls).toBe(1);
  });

  test("a transient endpoint failure does not mark needsReauth and a later refresh can recover", async () => {
    const accountId = await seedExpiredChatgpt();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 503 });
      return Response.json({ access_token: "chatgpt-fresh", refresh_token: "rt-new", expires_in: 3600 });
    }) as typeof fetch;
    await expect(getValidAccessTokenForAccount("chatgpt", accountId)).rejects.toBeInstanceOf(ChatGptTokenError);
    expect(getAccountSet("chatgpt")!.accounts.find(a => a.id === accountId)!.needsReauth).toBeUndefined();
    await expect(getValidAccessTokenForAccount("chatgpt", accountId)).resolves.toBe("chatgpt-fresh");
    expect(getAccountCredential("chatgpt", accountId)?.refresh).toBe("rt-new");
    expect(calls).toBe(2);
  });

  test("the registry forwards caller cancellation and releases the refresh lock", async () => {
    const accountId = await seedExpiredChatgpt();
    const caller = new AbortController();
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      started();
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as typeof fetch;
    const pending = refreshGenericAccountWithLock("chatgpt", accountId, OAUTH_PROVIDERS.chatgpt!,
      getAccountCredential("chatgpt", accountId)!, { signal: caller.signal });
    const reason = new DOMException("synthetic cancellation", "AbortError");
    const rejected = pending.catch((error: unknown) => error);
    await began;
    caller.abort(reason);
    expect(await rejected).toBe(reason);
    expect(getAccountSet("chatgpt")!.accounts.find(a => a.id === accountId)!.needsReauth).toBeUndefined();
    globalThis.fetch = (async () => Response.json({ access_token: "recovered", refresh_token: "rt-new", expires_in: 3600 })) as typeof fetch;
    await expect(getValidAccessTokenForAccount("chatgpt", accountId)).resolves.toBe("recovered");
  });

  test("a late terminal response cannot mark a replacement credential needsReauth", async () => {
    const accountId = await seedExpiredChatgpt();
    let release!: (response: Response) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = (() => new Promise<Response>(resolve => { release = resolve; started(); })) as typeof fetch;
    const pending = getValidAccessTokenForAccount("chatgpt", accountId);
    await began;
    await saveCredential("chatgpt", {
      access: "replacement", refresh: "replacement-rt", expires: Date.now() + 3_600_000, accountId: "chatgpt-acct",
    });
    release(Response.json({ error: "refresh_token_invalidated" }, { status: 401 }));
    await expect(pending).rejects.toBeInstanceOf(OAuthLoginRequiredError);
    expect(getAccountCredential("chatgpt", accountId)?.refresh).toBe("replacement-rt");
    expect(getAccountSet("chatgpt")!.accounts.find(a => a.id === accountId)!.needsReauth).toBeUndefined();
  });
});
