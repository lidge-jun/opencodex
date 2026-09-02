import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getValidAccessTokenForAccount,
  OAuthLoginRequiredError,
  OAUTH_PROVIDERS,
} from "../src/oauth";
import type { OAuthCredentials } from "../src/oauth/types";
import { getAccountCredential, getAccountSet, saveCredential } from "../src/oauth/store";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
