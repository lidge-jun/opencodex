import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../src/config";
import type { QuotaResetEvent } from "../../src/quota/reset-detector";
import {
  claimCountForTests,
  claimQuotaReset,
  forgetLastObservedWindows,
  hasSeenQuotaReset,
  listRecentQuotaResetEvents,
  recordQuotaResetEvent,
  resetQuotaResetStoreForTests,
  swapLastObservedWindows,
} from "../../src/quota/reset-seen-store";

const DAY = 24 * 60 * 60_000;
/**
 * Real wall clock, not a fixed constant.
 *
 * prune() reads Date.now() for age comparisons on purpose (a backdated claim must not change
 * unrelated keys' retention), so a hardcoded epoch would look decades stale and be pruned the
 * moment it was written.
 */
const NOW = Date.now();

function event(key: string): QuotaResetEvent {
  return {
    kind: "surprise",
    scope: "codex",
    accountTag: "tag00000",
    window: "weekly",
    detectedAt: NOW,
    key,
  };
}

beforeEach(() => {
  resetQuotaResetStoreForTests();
});

describe("quota reset claim store", () => {
  test("claimQuotaReset returns false when the claim is not durable", () => {
    // The caller reads true as "durably claimed, safe to dispatch". Two paths broke that.

    // 1. prune() evicts the just-added claim: its deadline is already past and it is older
    //    than CLAIM_MAX_AGE_MS, so the claim is gone before the function returns.
    const ancient = NOW - 100 * DAY;
    expect(claimQuotaReset("pruned-immediately", ancient, ancient + 1)).toBe(false);
    expect(hasSeenQuotaReset("pruned-immediately")).toBe(false);

    // 2. The write fails. persistNow() swallowed every error, so a read-only or full disk
    //    still reported a durable claim and the next start re-notified.
    // atomicWriteFile writes a sibling temp file in the config dir, so replacing that
    // directory with a regular file makes the real write fail without touching the module.
    const configDir = getConfigDir();
    rmSync(configDir, { recursive: true, force: true });
    writeFileSync(configDir, "not a directory");
    try {
      expect(claimQuotaReset("write-fails", NOW)).toBe(false);
    } finally {
      rmSync(configDir, { force: true });
      mkdirSync(configDir, { recursive: true });
    }
  });

  test("a key can be claimed exactly once", () => {
    expect(claimQuotaReset("k1", NOW)).toBe(true);
    expect(claimQuotaReset("k1", NOW)).toBe(false);
    expect(hasSeenQuotaReset("k1")).toBe(true);
    expect(hasSeenQuotaReset("k2")).toBe(false);
  });

  test("concurrent observers of one key produce exactly one winner", () => {
    // No await between the two calls: this is the poller-versus-live-response race.
    const results = [claimQuotaReset("race", NOW), claimQuotaReset("race", NOW)];
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("a claim is on disk the moment it is made, with no flush", () => {
    // No test-only flush: the claim path writes synchronously, because an unref'd 250 ms
    // debounce loses the claim when the process exits right after detecting — the exact case a
    // restart guarantee has to cover.
    expect(claimQuotaReset("persisted", NOW, NOW + DAY)).toBe(true);
    const raw = readFileSync(join(getConfigDir(), "quota-reset-state.json"), "utf8");
    expect(JSON.parse(raw).claims.persisted).toBeDefined();

    resetQuotaResetStoreForTests();
    expect(hasSeenQuotaReset("persisted")).toBe(true);
    expect(claimQuotaReset("persisted", NOW + 60_000)).toBe(false);
  });

  test("a claim survives a real second process", async () => {
    const script = join(getConfigDir(), "claim-probe.ts");
    const storeUrl = new URL("../../src/quota/reset-seen-store.ts", import.meta.url).href;
    writeFileSync(script, [
      `const store = await import(${JSON.stringify(storeUrl)});`,
      `console.log(String(store.claimQuotaReset("cross-process", Date.now(), Date.now() + 86400000)));`,
    ].join("\n"));

    const run = async (): Promise<string> => {
      const proc = Bun.spawn([process.execPath, script], {
        env: { ...process.env, OPENCODEX_HOME: getConfigDir() },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, out, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode, `claim probe failed: ${stderr}\nstdout: ${out}`).toBe(0);
      return out.trim();
    };

    expect(await run()).toBe("true");
    // A second OS process must see the first one's claim. A debounced write failed this
    // silently: the timer is unref'd, so the first process exited before persisting.
    expect(await run()).toBe("false");
  });

  test("the hard ceiling bounds the map even when every claim is live", () => {
    const now = Date.now();
    const future = now + 365 * DAY;
    const path = join(getConfigDir(), "quota-reset-state.json");
    // Seed below the cap: fixture construction is not the behavior under test.
    // Hydration does not prune; only the real insertions below cross the boundary.
    const seeded = Object.fromEntries(Array.from({ length: 1_023 }, (_, index) => [
      `live-${index}`, { at: now, resetAt: future + index },
    ]));
    writeFileSync(path, JSON.stringify({ version: 1, claims: seeded, events: [] }));
    resetQuotaResetStoreForTests();
    expect(claimCountForTests()).toBe(1_023);
    expect(claimQuotaReset("boundary", now, future + 1_023)).toBe(true);
    expect(claimCountForTests()).toBe(1_024);

    // All deadlines are live, so only hard-cap eviction can retain the nearer
    // claim while evicting the furthest one. Both successful claims really persist.
    expect(claimQuotaReset("nearer", now, future - 1)).toBe(true);
    expect(claimCountForTests()).toBe(1_024);
    expect(hasSeenQuotaReset("boundary")).toBe(false);
    const expected = { ...seeded, nearer: { at: now, resetAt: future - 1 } };
    expect(JSON.parse(readFileSync(path, "utf8")).claims).toEqual(expected);

    // An overflowing newcomer can itself be evicted: never report it durable.
    expect(claimQuotaReset("furthest", now, future + 2_000)).toBe(false);
    expect(hasSeenQuotaReset("furthest")).toBe(false);
    expect(claimCountForTests()).toBe(1_024);
    expect(JSON.parse(readFileSync(path, "utf8")).claims).toEqual(expected);
    resetQuotaResetStoreForTests();
    expect(claimCountForTests()).toBe(1_024);
    expect(hasSeenQuotaReset("nearer")).toBe(true);
    expect(hasSeenQuotaReset("boundary")).toBe(false);
    expect(hasSeenQuotaReset("furthest")).toBe(false);
  });

  test("a corrupt state file hydrates to empty without throwing", () => {
    writeFileSync(join(getConfigDir(), "quota-reset-state.json"), "{not json");
    resetQuotaResetStoreForTests();
    expect(() => hasSeenQuotaReset("anything")).not.toThrow();
    expect(hasSeenQuotaReset("anything")).toBe(false);
  });

  test("an old settled claim is pruned", () => {
    claimQuotaReset("stale", NOW - 100 * DAY, NOW - 99 * DAY);
    claimQuotaReset("fresh", NOW);
    expect(hasSeenQuotaReset("stale")).toBe(false);
    expect(hasSeenQuotaReset("fresh")).toBe(true);
  });

  test("an old claim whose window is still open is KEPT", () => {
    // A monthly key is legitimately older than the age floor while remaining current;
    // pruning it would let the same reset notify twice.
    claimQuotaReset("live-monthly", NOW - 100 * DAY, NOW + DAY);
    claimQuotaReset("fresh", NOW);
    expect(hasSeenQuotaReset("live-monthly")).toBe(true);
  });

  test("the event ring is bounded and newest-first", () => {
    for (let index = 0; index < 120; index += 1) recordQuotaResetEvent(event(`k${index}`));
    const recent = listRecentQuotaResetEvents();
    expect(recent).toHaveLength(100);
    expect(recent[0]?.key).toBe("k119");
    expect(listRecentQuotaResetEvents(5)).toHaveLength(5);
  });
});

describe("the observed-window map evicts the least recently observed row", () => {
  test("a continuously observed scope survives 64 newcomers", () => {
    // The bound is 64 rows. Re-setting an existing key does NOT move it in a Map, so before
    // the delete-then-set fix the EARLIEST-INSERTED row was evicted — which on a real install
    // is the long-lived codex account observed on every response, while 63 transient rows
    // survived. The cost is not a duplicate notification (claims are separate) but a MISSED
    // one: a re-baselined row has no previous value to diff against.
    const hot = { window: "weekly", percent: 50, resetAt: NOW + DAY } as const;
    swapLastObservedWindows("codex", "hottag00", [hot]);

    for (let index = 0; index < 64; index += 1) {
      // Keep re-observing the hot row, exactly as a busy install would.
      swapLastObservedWindows("codex", "hottag00", [hot]);
      swapLastObservedWindows(`provider-${index}`, "tag00000", [hot]);
    }

    // Still present means the next transition on it can still be detected.
    expect(swapLastObservedWindows("codex", "hottag00", [hot])).toBeDefined();
  });

  test("an abandoned row is the one that goes", () => {
    const windows = [{ window: "weekly", percent: 10, resetAt: NOW + DAY }];
    swapLastObservedWindows("abandoned", "tag00000", windows);
    for (let index = 0; index < 64; index += 1) {
      swapLastObservedWindows(`live-${index}`, "tag00000", windows);
    }
    // Never observed again, so it is genuinely the least recently used: it re-baselines.
    expect(swapLastObservedWindows("abandoned", "tag00000", windows)).toBeUndefined();
  });
});

describe("a cleared quota row forgets its baseline", () => {
  test("forgetting one tag leaves the others intact", () => {
    const windows = [{ window: "weekly", percent: 77, resetAt: NOW + DAY }];
    swapLastObservedWindows("codex", "tagaaaaa", windows);
    swapLastObservedWindows("codex", "tagbbbbb", windows);

    forgetLastObservedWindows("codex", "tagaaaaa");

    expect(swapLastObservedWindows("codex", "tagaaaaa", windows)).toBeUndefined();
    expect(swapLastObservedWindows("codex", "tagbbbbb", windows)).toBeDefined();
  });

  test("forgetting a whole scope leaves other scopes intact", () => {
    const windows = [{ window: "weekly", percent: 77, resetAt: NOW + DAY }];
    swapLastObservedWindows("codex", "tagaaaaa", windows);
    swapLastObservedWindows("codex", "tagbbbbb", windows);
    swapLastObservedWindows("anthropic", "tagaaaaa", windows);

    forgetLastObservedWindows("codex");

    expect(swapLastObservedWindows("codex", "tagaaaaa", windows)).toBeUndefined();
    expect(swapLastObservedWindows("codex", "tagbbbbb", windows)).toBeUndefined();
    expect(swapLastObservedWindows("anthropic", "tagaaaaa", windows)).toBeDefined();
  });

  test("forgetting a baseline does NOT release the claim ledger", () => {
    // A cleared row must not re-notify a reset it already reported, and claims are the only
    // thing preventing that.
    expect(claimQuotaReset("codex|tagaaaaa|weekly|1", NOW, NOW + DAY)).toBe(true);
    forgetLastObservedWindows("codex", "tagaaaaa");
    expect(claimQuotaReset("codex|tagaaaaa|weekly|1", NOW, NOW + DAY)).toBe(false);
  });
});

describe("the debounced write cannot be starved", () => {
  test("sustained sub-debounce activity still reaches disk", async () => {
    // Measured on the unfixed version: 75 observations at 40 ms produced ZERO writes, because a
    // re-arming debounce pushes its own deadline out on every call. A busy install that is then
    // SIGKILLed loses its whole baseline, which defeats the across-a-restart guarantee.
    //
    // Asserts on the CONTENT reaching disk, not on the file existing: the file is already there
    // from earlier hydration, so an existence check passes with or without the fix and proves
    // nothing. Verified by removing the cap and watching this fail.
    resetQuotaResetStoreForTests();
    const path = join(getConfigDir(), "quota-reset-state.json");
    writeFileSync(path, JSON.stringify({ version: 1, claims: {}, events: [] }));

    const windows = [{ window: "weekly", percent: 42, resetAt: NOW + DAY }];
    // ~1.5 s of traffic at 40 ms: far faster than the 250 ms debounce, so every call defers.
    for (let index = 0; index < 38; index += 1) {
      swapLastObservedWindows("codex", "starvetag", windows);
      await new Promise(resolve => setTimeout(resolve, 40));
    }

    // The staleness cap must have forced a write while the traffic was still arriving.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
      observed?: Record<string, unknown>;
    };
    expect(Object.keys(onDisk.observed ?? {}).some(key => key.includes("starvetag"))).toBe(true);
  });
});
