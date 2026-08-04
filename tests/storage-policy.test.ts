import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageCleanupPolicy } from "../src/types";
import {
  BUSY_DEFER_MS,
  computeNextRun,
  defaultStorageCleanupPolicy,
  isPolicyDue,
  normalizeStorageCleanupPolicy,
  parseStorageCleanupPolicyInput,
  percentForAtLeastCount,
  runStorageCleanupPolicy,
  selectReduceToBytes,
  selectPolicyPreview,
} from "../src/storage/policy";
import {
  listArchivedCandidates,
  selectOldestPercent,
  type ArchivedCandidate,
  type CleanupResult,
  type ExecuteCleanupOptions,
} from "../src/storage/cleanup";

// seedHome() writes real files plus a sqlite fixture for every case it backs.
// On a slow windows-latest runner those cases land at 6-8s against bun's 5s
// default and fail deterministically (issue #727, run 30507689929) while a
// faster runner passes the same code — locally the whole file is 144ms. The
// sibling storage-cleanup suite already carries { timeout: 20_000 } /
// { timeout: 30_000 } per case for exactly this reason; one file-level budget
// covers every seedHome site here.
setDefaultTimeout(30_000);

const OLD = new Date("2026-01-01T00:00:00Z");
const MID = new Date("2026-02-01T00:00:00Z");
const NEW = new Date("2026-03-01T00:00:00Z");

let home = "";

afterEach(() => {
  if (home) {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    home = "";
  }
});

function seedHome(sizes: Array<{ name: string; bytes: number; when: Date }>): string {
  home = mkdtempSync(join(tmpdir(), "ocx-storage-policy-"));
  mkdirSync(join(home, "archived_sessions"));
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER)`);
  const insert = db.prepare(
    `INSERT INTO threads VALUES ($id, $path, 1)`,
  );
  db.exec("BEGIN");
  for (const entry of sizes) {
    const path = join(home, "archived_sessions", entry.name);
    writeFileSync(path, "x".repeat(entry.bytes));
    utimesSync(path, entry.when, entry.when);
    insert.run({ $id: entry.name, $path: `archived_sessions/${entry.name}` });
  }
  db.exec("COMMIT");
  db.close();
  return home;
}

/** Minimal ArchivedCandidate list for pure selection math (no FS). */
function syntheticCandidates(
  count: number,
  bytesEach: number,
): ArchivedCandidate[] {
  return Array.from({ length: count }, (_, i) => {
    const relPath = `archived_sessions/rollout-${String(i).padStart(3, "0")}.jsonl`;
    const mtimeMs = OLD.getTime() + i * 60_000;
    return {
      relPath,
      absPath: relPath,
      bytes: bytesEach,
      mtimeMs,
      physicalRelPaths: [relPath],
      physicalFiles: [{ relPath, bytes: bytesEach, mtimeMs }],
    };
  });
}

function policy(partial: Partial<StorageCleanupPolicy> & Pick<StorageCleanupPolicy, "enabled" | "trigger" | "target">): StorageCleanupPolicy {
  return normalizeStorageCleanupPolicy({
    schedule: "manual",
    mode: "quarantine",
    ...partial,
  });
}

describe("normalizeStorageCleanupPolicy", () => {
  test("defaults enabled false and never enables implicitly", () => {
    const d = defaultStorageCleanupPolicy();
    expect(d.enabled).toBe(false);
    expect(normalizeStorageCleanupPolicy(undefined).enabled).toBe(false);
    expect(normalizeStorageCleanupPolicy({}).enabled).toBe(false);
    expect(normalizeStorageCleanupPolicy({ enabled: "yes" }).enabled).toBe(false);
    expect(normalizeStorageCleanupPolicy({ enabled: true }).enabled).toBe(true);
  });

  test("permanent mode only when explicitly set", () => {
    expect(normalizeStorageCleanupPolicy({ mode: "permanent" }).mode).toBe("permanent");
    expect(normalizeStorageCleanupPolicy({ mode: "nope" }).mode).toBe("quarantine");
    expect(normalizeStorageCleanupPolicy({}).mode).toBe("quarantine");
  });

  test("malformed persisted target fails closed (does not enable delete-oldest 25%)", () => {
    const both = normalizeStorageCleanupPolicy({
      enabled: true,
      target: { reduceToBytes: 1, removeOldestPercent: 25 },
    });
    expect(both.enabled).toBe(false);
    expect(both.target).toEqual({ removeOldestPercent: 25 });

    const empty = normalizeStorageCleanupPolicy({ enabled: true, target: {} });
    expect(empty.enabled).toBe(false);

    const badType = normalizeStorageCleanupPolicy({ enabled: true, target: "percent" });
    expect(badType.enabled).toBe(false);

    const missingTarget = normalizeStorageCleanupPolicy({ enabled: true });
    expect(missingTarget.enabled).toBe(true);
    expect(missingTarget.target).toEqual({ removeOldestPercent: 25 });
  });
});

describe("pinned threads (#858)", () => {
  function pinOldest(homeDir: string): void {
    const db = new Database(join(homeDir, "state_5.sqlite"));
    db.exec("ALTER TABLE threads ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE threads SET is_pinned = 1 WHERE id = 'rollout-old.jsonl'");
    db.close();
  }

  test("percent selection excludes pinned threads and backfills the next-oldest", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
      { name: "rollout-mid.jsonl", bytes: 200, when: MID },
      { name: "rollout-new.jsonl", bytes: 300, when: NEW },
    ]);
    pinOldest(dir);
    const sel = selectPolicyPreview(
      policy({ enabled: true, trigger: { archivedBytesOver: 0 }, target: { removeOldestPercent: 50 } }),
      dir,
    );
    expect(sel.count).toBe(1);
    expect(sel.bytes).toBe(200);
  });

  test("reduceToBytes exact selection excludes pinned threads", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
      { name: "rollout-mid.jsonl", bytes: 200, when: MID },
      { name: "rollout-new.jsonl", bytes: 300, when: NEW },
    ]);
    pinOldest(dir);
    const sel = selectPolicyPreview(
      policy({ enabled: true, trigger: { archivedBytesOver: 0 }, target: { reduceToBytes: 300 } }),
      dir,
    );
    expect(sel.candidateRelPaths).toEqual(["archived_sessions/rollout-mid.jsonl"]);
  });
});

describe("selection helpers", () => {
  test("selectReduceToBytes takes oldest until under target", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
      { name: "rollout-mid.jsonl", bytes: 100, when: MID },
      { name: "rollout-new.jsonl", bytes: 100, when: NEW },
    ]);
    const all = listArchivedCandidates(dir);
    expect(all.map(c => c.relPath)).toEqual([
      "archived_sessions/rollout-old.jsonl",
      "archived_sessions/rollout-mid.jsonl",
      "archived_sessions/rollout-new.jsonl",
    ]);
    const selected = selectReduceToBytes(all, 150);
    expect(selected.map(c => c.relPath)).toEqual([
      "archived_sessions/rollout-old.jsonl",
      "archived_sessions/rollout-mid.jsonl",
    ]);
    expect(selected.reduce((s, c) => s + c.bytes, 0)).toBe(200);
  });

  test("percentForAtLeastCount maps to selectOldestPercent counts", () => {
    expect(percentForAtLeastCount(4, 0)).toBe(0);
    expect(percentForAtLeastCount(4, 4)).toBe(100);
    // selectOldestPercent uses max(1, floor(n*pct/100)), so pct=1 already yields 1 of 4
    expect(percentForAtLeastCount(4, 1)).toBe(1);
    expect(percentForAtLeastCount(4, 2)).toBe(50);
  });

  test("selectPolicyPreview backfills percent past pending oldest archive", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
      { name: "rollout-mid.jsonl", bytes: 100, when: MID },
      { name: "rollout-new.jsonl", bytes: 100, when: NEW },
    ]);
    const stage = join(dir, ".trash", "99000");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "restore-pending.json"), JSON.stringify({
      version: 1,
      filesRestored: true,
      acceptedDestRels: ["archived_sessions/rollout-old.jsonl"],
      pending: { state: true, logs: false, memories: false, goals: false },
    }));

    const preview = selectPolicyPreview(
      policy({
        enabled: true,
        trigger: { archivedBytesOver: 1 },
        target: { removeOldestPercent: 34 },
        schedule: "manual",
        mode: "quarantine",
      }),
      dir,
    );
    expect(preview.count).toBe(1);
    expect(preview.bytes).toBe(100);
  });

  test("selectPolicyPreview reduceToBytes skips pending oldest and keeps backfilling", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
      { name: "rollout-mid.jsonl", bytes: 100, when: MID },
      { name: "rollout-new.jsonl", bytes: 100, when: NEW },
    ]);
    const stage = join(dir, ".trash", "99001");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "restore-pending.json"), JSON.stringify({
      version: 1,
      filesRestored: true,
      acceptedDestRels: ["archived_sessions/rollout-old.jsonl"],
      pending: { state: true, logs: false, memories: false, goals: false },
    }));

    const preview = selectPolicyPreview(
      policy({
        enabled: true,
        trigger: { archivedBytesOver: 1 },
        target: { reduceToBytes: 100 },
        schedule: "manual",
        mode: "quarantine",
      }),
      dir,
    );
    expect(preview.count).toBe(2);
    expect(preview.candidateRelPaths).toEqual([
      "archived_sessions/rollout-mid.jsonl",
      "archived_sessions/rollout-new.jsonl",
    ]);
  });

  test("selectPolicyPreview honors removeOldestPercent", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 50, when: OLD },
      { name: "rollout-new.jsonl", bytes: 50, when: NEW },
    ]);
    const preview = selectPolicyPreview(
      policy({
        enabled: true,
        trigger: { archivedBytesOver: 0 },
        target: { removeOldestPercent: 50 },
      }),
      dir,
    );
    expect(preview.count).toBe(1);
    expect(preview.percent).toBe(50);
    expect(preview.bytes).toBe(50);
  });

  test("selectPolicyPreview honors reduceToBytes via oldest files", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
      { name: "rollout-mid.jsonl", bytes: 100, when: MID },
      { name: "rollout-new.jsonl", bytes: 100, when: NEW },
    ]);
    const preview = selectPolicyPreview(
      policy({
        enabled: true,
        trigger: { archivedBytesOver: 0 },
        target: { reduceToBytes: 100 },
      }),
      dir,
    );
    // Need to free 200 → exactly two oldest (not percent-rounded to more)
    expect(preview.count).toBe(2);
    expect(preview.bytes).toBe(200);
    expect(preview.candidateRelPaths).toEqual([
      "archived_sessions/rollout-old.jsonl",
      "archived_sessions/rollout-mid.jsonl",
    ]);
  });

  test("selectPolicyPreview reduceToBytes keeps a single candidate when percent would over-select", () => {
    // Percent mapping over-selects when n>100 and only one file is needed by bytes:
    // pct=1 → floor(n/100) files. Prove that without seeding hundreds of files on disk —
    // Windows CI FS makes a 100-file fixture exceed bun's default 5s harness timeout.
    const synthetic = syntheticCandidates(200, 10);
    const desired = selectReduceToBytes(synthetic, 1990); // total 2000 → free 10 → one file
    expect(desired).toHaveLength(1);
    const pct = percentForAtLeastCount(synthetic.length, desired.length);
    expect(selectOldestPercent(synthetic, pct).length).toBeGreaterThan(1);

    // FS integration: exact preview path (percent:0 + candidateRelPaths), small fixture.
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 10, when: OLD },
      { name: "rollout-new.jsonl", bytes: 990, when: NEW },
    ]);
    const preview = selectPolicyPreview(
      policy({
        enabled: true,
        trigger: { archivedBytesOver: 0 },
        target: { reduceToBytes: 990 }, // total 1000 → free 10 → only the 10-byte oldest
      }),
      dir,
    );
    expect(preview.percent).toBe(0);
    expect(preview.count).toBe(1);
    expect(preview.bytes).toBe(10);
    expect(preview.candidateRelPaths).toEqual(["archived_sessions/rollout-old.jsonl"]);
  });
});

describe("schedule helpers", () => {
  test("computeNextRun for daily/weekly; manual/startup unset", () => {
    const now = 1_700_000_000_000;
    expect(computeNextRun("daily", now)).toBe(now + 24 * 60 * 60 * 1000);
    expect(computeNextRun("weekly", now)).toBe(now + 7 * 24 * 60 * 60 * 1000);
    expect(computeNextRun("manual", now)).toBeUndefined();
    expect(computeNextRun("startup", now)).toBeUndefined();
  });

  test("isPolicyDue respects schedule and reason", () => {
    const base = policy({
      enabled: true,
      trigger: { archivedBytesOver: 0 },
      target: { removeOldestPercent: 10 },
      schedule: "manual",
    });
    expect(isPolicyDue(base, 1, "manual")).toBe(true);
    expect(isPolicyDue(base, 1, "startup")).toBe(false);
    expect(isPolicyDue({ ...base, schedule: "startup" }, 1, "startup")).toBe(true);
    expect(isPolicyDue({ ...base, schedule: "startup" }, 1, "schedule")).toBe(false);
    expect(isPolicyDue({ ...base, schedule: "startup", nextRun: 100 }, 50, "schedule")).toBe(false);
    expect(isPolicyDue({ ...base, schedule: "startup", nextRun: 100 }, 100, "schedule")).toBe(true);
    expect(isPolicyDue({ ...base, schedule: "daily", nextRun: 100 }, 50, "schedule")).toBe(false);
    expect(isPolicyDue({ ...base, schedule: "daily", nextRun: 100 }, 100, "schedule")).toBe(true);
    expect(isPolicyDue({ ...base, enabled: false, schedule: "daily" }, 1, "manual")).toBe(false);
  });

  test("parseStorageCleanupPolicyInput preserves nextRun when schedule unchanged", () => {
    const prev = policy({
      enabled: true,
      trigger: { archivedBytesOver: 100 },
      target: { removeOldestPercent: 10 },
      schedule: "daily",
      nextRun: 9_999,
    });
    const parsed = parseStorageCleanupPolicyInput(
      {
        enabled: true,
        trigger: { archivedBytesOver: 200 },
        target: { removeOldestPercent: 20 },
        schedule: "daily",
        mode: "quarantine",
      },
      prev,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.policy.nextRun).toBe(9_999);
    expect(parsed.policy.trigger.archivedBytesOver).toBe(200);
  });

  test("parseStorageCleanupPolicyInput recomputes nextRun when schedule changes", () => {
    const prev = policy({
      enabled: true,
      trigger: { archivedBytesOver: 100 },
      target: { removeOldestPercent: 10 },
      schedule: "manual",
    });
    const before = Date.now();
    const parsed = parseStorageCleanupPolicyInput(
      {
        enabled: true,
        trigger: { archivedBytesOver: 100 },
        target: { removeOldestPercent: 10 },
        schedule: "daily",
        mode: "quarantine",
      },
      prev,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.policy.nextRun).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
  });
});

describe("runStorageCleanupPolicy", () => {
  test("disabled never calls execute", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 1000, when: OLD },
    ]);
    let calls = 0;
    const stored: StorageCleanupPolicy[] = [
      policy({
        enabled: false,
        trigger: { archivedBytesOver: 0 },
        target: { removeOldestPercent: 100 },
      }),
    ];
    const result = runStorageCleanupPolicy({
      reason: "manual",
      force: true,
      codexHome: dir,
      loadPolicy: () => stored[0]!,
      savePolicy: p => { stored[0] = p; },
      execute: () => {
        calls += 1;
        return { ok: true, mode: "quarantine", percent: 100, count: 1, bytes: 1000, removedPaths: [] };
      },
    });
    expect(result.skipped).toBe("disabled");
    expect(calls).toBe(0);
    expect(existsSync(join(dir, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
  });

  test("under threshold no-ops without execute", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
    ]);
    let calls = 0;
    const stored: StorageCleanupPolicy[] = [
      policy({
        enabled: true,
        trigger: { archivedBytesOver: 10_000 },
        target: { removeOldestPercent: 100 },
        schedule: "daily",
      }),
    ];
    const now = 5_000;
    const result = runStorageCleanupPolicy({
      reason: "schedule",
      force: true,
      now,
      codexHome: dir,
      loadPolicy: () => stored[0]!,
      savePolicy: p => { stored[0] = p; },
      execute: () => {
        calls += 1;
        return { ok: true, mode: "quarantine", percent: 100, count: 0, bytes: 0, removedPaths: [] };
      },
    });
    expect(result.skipped).toBe("under_threshold");
    expect(calls).toBe(0);
    expect(stored[0]!.nextRun).toBe(computeNextRun("daily", now));
    expect(existsSync(join(dir, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
  });

  test("over threshold runs quarantine mode and records lastRun", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
      { name: "rollout-new.jsonl", bytes: 100, when: NEW },
    ]);
    const stored: StorageCleanupPolicy[] = [
      policy({
        enabled: true,
        trigger: { archivedBytesOver: 50 },
        target: { removeOldestPercent: 50 },
        mode: "quarantine",
      }),
    ];
    let seen: ExecuteCleanupOptions | undefined;
    const result = runStorageCleanupPolicy({
      reason: "manual",
      force: true,
      now: 9_000,
      codexHome: dir,
      loadPolicy: () => stored[0]!,
      savePolicy: p => { stored[0] = p; },
      execute: (opts): CleanupResult => {
        seen = opts;
        return {
          ok: true,
          mode: opts.mode,
          percent: opts.percent,
          count: 1,
          bytes: 100,
          removedPaths: ["archived_sessions/rollout-old.jsonl"],
          trashDir: ".trash/9000",
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(seen?.mode).toBe("quarantine");
    expect(seen?.percent).toBe(50);
    expect(result.freedBytes).toBe(100);
    expect(result.removed).toBe(1);
    expect(stored[0]!.lastRun).toEqual({ at: 9_000, freedBytes: 100, removed: 1 });
  });

  test("permanent mode is passed through when set on policy", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
    ]);
    const stored: StorageCleanupPolicy[] = [
      policy({
        enabled: true,
        trigger: { archivedBytesOver: 0 },
        target: { removeOldestPercent: 100 },
        mode: "permanent",
      }),
    ];
    let mode: string | undefined;
    runStorageCleanupPolicy({
      reason: "manual",
      force: true,
      codexHome: dir,
      loadPolicy: () => stored[0]!,
      savePolicy: p => { stored[0] = p; },
      execute: (opts): CleanupResult => {
        mode = opts.mode;
        return { ok: true, mode: "permanent", percent: 100, count: 1, bytes: 100, removedPaths: [] };
      },
    });
    expect(mode).toBe("permanent");
  });

  test("codex_busy defers nextRun without lastRun mutation", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
    ]);
    const stored: StorageCleanupPolicy[] = [
      policy({
        enabled: true,
        trigger: { archivedBytesOver: 0 },
        target: { removeOldestPercent: 100 },
        schedule: "daily",
        lastRun: { at: 1, freedBytes: 10, removed: 1 },
      }),
    ];
    const now = 20_000;
    const result = runStorageCleanupPolicy({
      reason: "manual",
      force: true,
      now,
      codexHome: dir,
      loadPolicy: () => stored[0]!,
      savePolicy: p => { stored[0] = p; },
      execute: (): CleanupResult => ({
        ok: false,
        mode: "quarantine",
        percent: 100,
        count: 0,
        bytes: 0,
        removedPaths: [],
        error: "codex_busy",
      }),
    });
    expect(result.deferred).toBe("codex_busy");
    expect(stored[0]!.nextRun).toBe(now + BUSY_DEFER_MS);
    expect(stored[0]!.lastRun).toEqual({ at: 1, freedBytes: 10, removed: 1 });
    expect(existsSync(join(dir, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
  });

  test("end-to-end quarantine execute against fixture home", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
      { name: "rollout-new.jsonl", bytes: 200, when: NEW },
    ]);
    const stored: StorageCleanupPolicy[] = [
      policy({
        enabled: true,
        trigger: { archivedBytesOver: 50 },
        target: { removeOldestPercent: 50 },
        mode: "quarantine",
      }),
    ];
    const result = runStorageCleanupPolicy({
      reason: "manual",
      force: true,
      now: 42_000,
      codexHome: dir,
      loadPolicy: () => stored[0]!,
      savePolicy: p => { stored[0] = p; },
    });
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(1);
    expect(result.freedBytes).toBe(100);
    expect(existsSync(join(dir, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
    expect(existsSync(join(dir, ".trash"))).toBe(true);
  });

  test("end-to-end reduceToBytes removes the exact candidate set", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
      { name: "rollout-mid.jsonl", bytes: 100, when: MID },
      { name: "rollout-new.jsonl", bytes: 100, when: NEW },
    ]);
    const stored: StorageCleanupPolicy[] = [
      policy({
        enabled: true,
        trigger: { archivedBytesOver: 0 },
        target: { reduceToBytes: 100 },
        mode: "quarantine",
      }),
    ];
    let seen: ExecuteCleanupOptions | undefined;
    const result = runStorageCleanupPolicy({
      reason: "manual",
      force: true,
      now: 55_000,
      codexHome: dir,
      loadPolicy: () => stored[0]!,
      savePolicy: p => { stored[0] = p; },
      execute: (opts): CleanupResult => {
        seen = opts;
        return {
          ok: true,
          mode: opts.mode,
          percent: opts.percent,
          count: opts.candidateRelPaths?.length ?? 0,
          bytes: 200,
          removedPaths: opts.candidateRelPaths ?? [],
          trashDir: ".trash/55000",
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(seen?.candidateRelPaths).toEqual([
      "archived_sessions/rollout-old.jsonl",
      "archived_sessions/rollout-mid.jsonl",
    ]);
    expect(result.removed).toBe(2);
  });

  test("completion merges run metadata into concurrent policy edits", () => {
    const dir = seedHome([
      { name: "rollout-old.jsonl", bytes: 100, when: OLD },
      { name: "rollout-new.jsonl", bytes: 100, when: NEW },
    ]);
    const stored: StorageCleanupPolicy[] = [
      policy({
        enabled: true,
        trigger: { archivedBytesOver: 50 },
        target: { removeOldestPercent: 50 },
        schedule: "manual",
        mode: "quarantine",
      }),
    ];
    const now = 77_000;
    const result = runStorageCleanupPolicy({
      reason: "manual",
      force: true,
      now,
      codexHome: dir,
      loadPolicy: () => stored[0]!,
      savePolicy: p => { stored[0] = p; },
      execute: (): CleanupResult => {
        // Simulate a concurrent PUT while the job holds the start-of-run snapshot.
        stored[0] = policy({
          enabled: false,
          trigger: { archivedBytesOver: 999 },
          target: { reduceToBytes: 42 },
          schedule: "daily",
          mode: "permanent",
        });
        return {
          ok: true,
          mode: "quarantine",
          percent: 50,
          count: 1,
          bytes: 100,
          removedPaths: ["archived_sessions/rollout-old.jsonl"],
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(stored[0]!.enabled).toBe(false);
    expect(stored[0]!.trigger).toEqual({ archivedBytesOver: 999 });
    expect(stored[0]!.target).toEqual({ reduceToBytes: 42 });
    expect(stored[0]!.schedule).toBe("daily");
    expect(stored[0]!.mode).toBe("permanent");
    expect(stored[0]!.lastRun).toEqual({ at: now, freedBytes: 100, removed: 1 });
    expect(stored[0]!.nextRun).toBe(computeNextRun("daily", now));
    expect(result.policy).toEqual(stored[0]);
  });
});
