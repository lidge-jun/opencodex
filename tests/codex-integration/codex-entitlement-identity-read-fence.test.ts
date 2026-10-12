import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedDeniedCodexAccountIdsForModel,
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../../src/codex/model-entitlements";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * How many times one denial pass reads account storage.
 *
 * `cachedDeniedCodexAccountIdsForModel` is synchronous and runs on the request path for the
 * flagship models, and it validates every cached (account, client version) entry against the
 * account's current credential. Resolving that identity per entry meant a full reload, reparse and
 * renormalize of `codex-accounts.json` per entry: at the documented cache budget -- 64 accounts,
 * four versions each -- one warm request could perform 256 synchronous full-store reads.
 *
 * These cases pin the read COUNT, which no behavioral assertion can see, alongside the validation
 * the count must not have bought: a stale identity is still rejected, and an excluded account still
 * opens nothing.
 */

const ASTRA = "gpt-6-astra";
const VERSION_A = "0.146.0";
const VERSION_B = "0.147.0";
const NOW = 1_800_000_000_000;

let TEST_DIR = "";
const previousHome = process.env.OPENCODEX_HOME;

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };

/** Count reads of the pool account store, whoever performs them. */
function countAccountStoreReads(): { reads: () => number; restore: () => void } {
  // Spying the `node:fs` namespace DOES observe production code that binds `readFileSync` as an
  // ESM named import, which is how `src/codex/account-store.ts` binds it. Established in-process
  // precedent: codex-account-delete-atomicity.test.ts asserts `toHaveBeenLastCalledWith` against a
  // read performed by production code, and codex-account-store.test.ts intercepts this module's own
  // `statSync`/`fstatSync` the same way. The case that does NOT work is a spawned child holding its
  // own `require("node:fs")` (codex-inject-integration.test.ts:146); nothing here spawns one, and
  // the calibration case below fails loudly if that ever stops being true.
  // `readFileSync` is heavily overloaded, so the pass-through is typed structurally and cast once
  // rather than trying to satisfy every overload: this counts calls, it does not model the API.
  const original = fs.readFileSync as (...args: unknown[]) => unknown;
  let reads = 0;
  const spy = spyOn(fs, "readFileSync");
  spy.mockImplementation(((...args: unknown[]) => {
    const target = args[0];
    if (typeof target === "string" && target.endsWith("codex-accounts.json")) reads += 1;
    return original(...args);
  }) as unknown as typeof fs.readFileSync);
  return { reads: () => reads, restore: () => { spy.mockRestore(); } };
}

/** Store a pool credential and return the identity string the reader will derive from it. */
function storedIdentity(accountId: string): string {
  saveCodexAccountCredential(accountId, {
    accessToken: `access-${accountId}`,
    refreshToken: `grant-${accountId}`,
    expiresAt: NOW + 3600_000,
    chatgptAccountId: `chatgpt-${accountId}`,
  });
  const record = readCodexAccountRecord(accountId)!;
  return `pool:${record.generation}:${record.credential!.chatgptAccountId}`;
}

describe("the denial pass resolves credential identity once, not once per cache entry", () => {
  beforeEach(() => {
    setIcaclsRunnerForTests(() => ICACLS_OK);
    setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
    TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-entitlement-read-fence-"));
    process.env.OPENCODEX_HOME = TEST_DIR;
    resetCodexModelEntitlementCacheForTests();
  });

  afterEach(async () => {
    await flushConfigDirHardeningForTests();
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (TEST_DIR) removeTreeWithRetry(TEST_DIR);
    TEST_DIR = "";
    resetCodexModelEntitlementCacheForTests();
  });

  test("six cache entries across three accounts cost one store read", () => {
    // Each account carries two client versions, which is two cache entries and, before this,
    // two full-store reads.
    for (const accountId of ["pool-a", "pool-b", "pool-c"]) {
      const identity = storedIdentity(accountId);
      seedCodexModelEntitlementsForTests(accountId, ["gpt-5.5"], NOW, VERSION_A, identity);
      seedCodexModelEntitlementsForTests(accountId, ["gpt-5.5"], NOW, VERSION_B, identity);
    }

    const counter = countAccountStoreReads();
    try {
      const denied = cachedDeniedCodexAccountIdsForModel(ASTRA, NOW);
      // The answer is unchanged: every account's confirmed roster omits Astra.
      expect([...(denied ?? [])].sort()).toEqual(["pool-a", "pool-b", "pool-c"]);
      expect(counter.reads()).toBe(1);
    } finally {
      counter.restore();
    }
  });

  test("the snapshot does not weaken the identity check it answers from", () => {
    // `stale` holds a roster recorded under a credential the account no longer has, so its denial
    // is evidence about a different identity and must not count. `current` matches and must.
    const staleIdentity = storedIdentity("stale");
    seedCodexModelEntitlementsForTests("stale", ["gpt-5.5"], NOW, VERSION_A, `${staleIdentity}-superseded`);
    const currentIdentity = storedIdentity("current");
    seedCodexModelEntitlementsForTests("current", ["gpt-5.5"], NOW, VERSION_A, currentIdentity);

    const counter = countAccountStoreReads();
    try {
      expect([...(cachedDeniedCodexAccountIdsForModel(ASTRA, NOW) ?? [])]).toEqual(["current"]);
      expect(counter.reads()).toBe(1);
    } finally {
      counter.restore();
    }
  });

  test("an account with no stored record stays unknown rather than being rejected outright", () => {
    // An UNREADABLE credential is not proof of anything. The store is read once and answers
    // `undefined` for this id, which leaves the entry in place exactly as before.
    seedCodexModelEntitlementsForTests("unstored", ["gpt-5.5"], NOW, VERSION_A, "test:unstored");
    storedIdentity("present-so-the-file-exists");

    const counter = countAccountStoreReads();
    try {
      expect([...(cachedDeniedCodexAccountIdsForModel(ASTRA, NOW) ?? [])]).toEqual(["unstored"]);
      expect(counter.reads()).toBe(1);
    } finally {
      counter.restore();
    }
  });

  test("a pass whose every entry is excluded opens no store at all", () => {
    // The resolver loads lazily for the same reason the fence is checked first: an excluded
    // account must not cause a read it was excluded to prevent.
    const identity = storedIdentity("fenced");
    seedCodexModelEntitlementsForTests("fenced", ["gpt-5.5"], NOW, VERSION_A, identity);
    seedCodexModelEntitlementsForTests("fenced", ["gpt-5.5"], NOW, VERSION_B, identity);

    const counter = countAccountStoreReads();
    try {
      expect(cachedDeniedCodexAccountIdsForModel(ASTRA, NOW, {
        excludeAccountIds: new Set(["fenced"]),
      })).toBeUndefined();
      expect(counter.reads()).toBe(0);
    } finally {
      counter.restore();
    }
  });

  test("the read counter observes production reads at all", () => {
    // Calibration for the zero-expecting case above, which is indistinguishable from a counter
    // that can see nothing. One `readCodexAccountRecord` is exactly one store read by
    // construction, so this pins the oracle rather than the behavior under test.
    storedIdentity("calibration");

    const counter = countAccountStoreReads();
    try {
      expect(readCodexAccountRecord("calibration")).not.toBeNull();
      expect(counter.reads()).toBe(1);
    } finally {
      counter.restore();
    }
  });
});
