/**
 * The quorum predicate must not read the auth store on every request.
 *
 * `hasAnthropicFailoverQuorum` decides whether an Anthropic request records the account that
 * served it, so it runs on the INITIAL resolution of ordinary traffic -- not only after a 429.
 * `getAccountSet` goes through `loadAuthStore`, which has no cache: it chmods the config dir,
 * chmods the secret, reads the whole file and normalizes it on every call. An uncached predicate
 * therefore puts a synchronous file read in front of every Anthropic turn.
 *
 * The generic module already solved this with a TTL-bounded count cache. These tests pin the same
 * three properties for the Anthropic twin: the read is shared inside the window, a fresh login is
 * still visible once it expires, and a rotation invalidates immediately rather than answering the
 * next question from a pre-failure count.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAnthropicAccountPoolState,
  clearAnthropicSessionAffinityForAccount,
  forgetAnthropicFailoverQuorum,
  hasAnthropicFailoverQuorum,
  resetAnthropicRoutingForManualSelection,
  rotateAnthropicAccountOn429,
} from "../../src/oauth/anthropic-routing";
import { getAccountSet, markAccountNeedsReauth, saveCredential } from "../../src/oauth/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;
let readSpy: ReturnType<typeof spyOn> | undefined;
let authReadsBefore = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-quorum-cache-"));
  process.env.OPENCODEX_HOME = home;
  // Pass-through spy (no mockImplementation): records calls, the real read still happens.
  readSpy = spyOn(fs, "readFileSync");
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
});

afterEach(() => {
  readSpy?.mockRestore();
  readSpy = undefined;
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

async function seed(count: number, offset = 0): Promise<string[]> {
  for (let i = offset; i < offset + count; i++) {
    await saveCredential("anthropic", {
      access: `access-${i}`,
      refresh: `refresh-${i}`,
      expires: Date.now() + 3_600_000,
      accountId: `uuid-${i}`,
      email: `user${i}@example.test`,
    } as never);
  }
  return getAccountSet("anthropic")?.accounts.map(a => a.id) ?? [];
}

/**
 * Observe the store read without stubbing the module: count `readFileSync` calls against
 * THIS home's auth.json — the syscall this cache exists to avoid.
 *
 * The previous observer pinned atime into the past and checked whether the read moved it.
 * On windows-latest NTFS last-access updates are disabled (fsutil DisableLastAccess = 3,
 * measured in run 33929916059), so `readFileSync` left atime untouched: the three
 * "invalidates immediately" cases could never see the read they assert on, and the
 * "shares one read" case passed vacuously. The spy sees the same syscall where the
 * platform cannot hide it. The path filter keeps refresh-intent files, lock snapshots and
 * `peekAuthStore` out of the count; only the hardened store read can satisfy the cache.
 */
function authReadCount(): number {
  const target = join(home, "auth.json");
  return (readSpy?.mock.calls ?? []).filter(([path]) => String(path) === target).length;
}

function markStoreUnread(): void {
  authReadsBefore = authReadCount();
}

function storeWasRead(): boolean {
  return authReadCount() > authReadsBefore;
}

describe("Anthropic failover quorum cache", () => {
  test("a burst of requests inside the TTL window shares one store read", async () => {
    const start = Date.now();
    await seed(2);
    // Prime the cache, then prove the next calls do not touch the file at all. This asserts
    // ZERO reads during hits, not one read per fill: a fill is getAccountSet plus up to two
    // getAccountCredential calls through isPoolCredentialUsable, each a store read.
    expect(hasAnthropicFailoverQuorum(start)).toBe(true);
    markStoreUnread();
    for (let i = 0; i < 25; i++) expect(hasAnthropicFailoverQuorum(start + i)).toBe(true);
    expect(storeWasRead()).toBe(false);
  });

  test("a fresh login is visible once the window expires", async () => {
    // The cache must not be able to strand an operator who just logged a second account in:
    // a stale false would keep failover off for exactly the traffic that needs it.
    const start = Date.now();
    await seed(1);
    expect(hasAnthropicFailoverQuorum(start)).toBe(false);
    await seed(1, 1);
    // Same instant: still the memoized answer.
    expect(hasAnthropicFailoverQuorum(start)).toBe(false);
    // Past the window: seen without any explicit invalidation call.
    expect(hasAnthropicFailoverQuorum(start + 2_001)).toBe(true);
  });

  test("a rotation invalidates immediately rather than waiting out the TTL", async () => {
    const start = Date.now();
    const ids = await seed(2);
    expect(hasAnthropicFailoverQuorum(start)).toBe(true);
    expect(rotateAnthropicAccountOn429({ providers: {} } as never, ids[0]!, null, null, start)).toBe(ids[1]);
    // The roster in use just changed, so the next question re-reads instead of answering from
    // the count taken before the failure.
    markStoreUnread();
    hasAnthropicFailoverQuorum(start + 1);
    expect(storeWasRead()).toBe(true);
  });

  test("the cache holds no credential material", async () => {
    // A boolean derived from a count. If this ever became an id or a token the cache would
    // outlive the store's own hardening, which is the thing loadAuthStore re-applies per read.
    await seed(2);
    expect(typeof hasAnthropicFailoverQuorum()).toBe("boolean");
  });

  test("a stale quorum cannot dispatch on a reauth-flagged account", async () => {
    // The one roster mutation this module cannot observe: a 401 elsewhere flags an account
    // needsReauth, dropping the real quorum to one while the cached `true` survives the TTL.
    //
    // The window is left unplumbed deliberately, so this pins the reason: a stale `true` only
    // lets the caller ASK. pickAlternateAnthropicAccount re-reads the roster, skips the flagged
    // account and answers null, so the 429 surfaces exactly as it would have. If that ever
    // stopped being true, the comment above the cache would be a lie and this fails.
    const start = Date.now();
    const ids = await seed(2);
    expect(hasAnthropicFailoverQuorum(start)).toBe(true);

    await markAccountNeedsReauth("anthropic", ids[1]!, true);
    // Deliberately NOT invalidating: this is the stale-cache state under test.
    expect(hasAnthropicFailoverQuorum(start + 1)).toBe(true);

    // The rotator admits the request, then finds nothing usable and refuses.
    expect(
      rotateAnthropicAccountOn429({ providers: {} } as never, ids[0]!, null, null, start + 1),
    ).toBeNull();
  });

  test("removing an account invalidates immediately, not after the TTL", async () => {
    // The management DELETE route calls clearAnthropicSessionAffinityForAccount for Anthropic.
    // Without invalidation there, deleting the second account would leave quorum true for up to
    // 2s -- long enough for a request to record an id whose credential is already gone.
    const start = Date.now();
    const ids = await seed(2);
    expect(hasAnthropicFailoverQuorum(start)).toBe(true);
    clearAnthropicSessionAffinityForAccount(ids[1]!);
    markStoreUnread();
    hasAnthropicFailoverQuorum(start + 1);
    expect(storeWasRead()).toBe(true);
  });

  test("a manual account selection invalidates immediately", async () => {
    // An operator picking an account is a statement about the roster, so the next activation
    // question must not be answered from a count read before it.
    const start = Date.now();
    const ids = await seed(2);
    expect(hasAnthropicFailoverQuorum(start)).toBe(true);
    resetAnthropicRoutingForManualSelection(ids[0]!);
    markStoreUnread();
    hasAnthropicFailoverQuorum(start + 1);
    expect(storeWasRead()).toBe(true);
  });
});
