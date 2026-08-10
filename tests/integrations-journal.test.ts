import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../src/config";
import { SNAPSHOT_RETENTION, type JournalEntry } from "../src/integrations/journal";
import type { OwnershipRecord } from "../src/integrations/ownership";
import { createIntegrationStateStore, type IntegrationStateStore } from "../src/integrations/store";

/** Activation coverage for devlog/_fin/260802_client_toggle_api/021 §6. */
let root: string;
let store: IntegrationStateStore;

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "ocx-integrations-journal-")), "integrations");
  store = createIntegrationStateStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    opId: `op-${Math.random().toString(36).slice(2, 10)}`,
    clientId: "pi",
    kind: "apply",
    at: new Date().toISOString(),
    configPath: "/home/dev/.pi/agent/models.json",
    snapshot: { kind: "none" },
    resultFingerprint: "abc123",
    resultAbsent: false,
    priorRecord: null,
    ...overrides,
  };
}

/** True when the OS still lets us list `dir` despite the permission bit. */
function canStillList(dir: string): boolean {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

describe("append and read back", () => {
  test("rows come back newest first", () => {
    const first = entry({ opId: "first" });
    const second = entry({ opId: "second" });
    store.appendJournal(first);
    store.appendJournal(second);
    expect(store.listOperations().map(row => row.opId)).toEqual(["second", "first"]);
  });

  test("a torn final line is skipped, not thrown", () => {
    store.appendJournal(entry({ opId: "intact" }));
    // Simulate a crash mid-append.
    appendFileSync(join(root, "journal.jsonl"), '{"opId":"torn","clientI');
    expect(store.listOperations().map(row => row.opId)).toEqual(["intact"]);
  });

  test("filtering by client leaves other clients' rows alone", () => {
    store.appendJournal(entry({ opId: "pi-op", clientId: "pi" }));
    store.appendJournal(entry({ opId: "kimi-op", clientId: "kimi" }));
    expect(store.listOperations("kimi").map(row => row.opId)).toEqual(["kimi-op"]);
    expect(store.findOperation("pi-op")?.clientId).toBe("pi");
    expect(store.findOperation("absent-op")).toBeNull();
  });
});

describe("snapshots", () => {
  test("a missing file records `none`, which is not a failure", () => {
    const ref = store.captureSnapshot("pi", "op-1", null);
    expect(ref).toEqual({ kind: "none" });
    expect(store.readSnapshot(entry({ snapshot: ref }))).toEqual({ kind: "none" });
  });

  test("stored snapshots read back verbatim", () => {
    const ref = store.captureSnapshot("pi", "op-1", "original bytes\n");
    const read = store.readSnapshot(entry({ opId: "op-1", snapshot: ref }));
    expect(read.kind).toBe("stored");
    if (read.kind === "stored") expect(read.text).toBe("original bytes\n");
  });

  test("retention prunes files but never rows", () => {
    const opIds: string[] = [];
    for (let index = 0; index < SNAPSHOT_RETENTION + 1; index += 1) {
      const opId = `op-${index}`;
      opIds.push(opId);
      const snapshot = store.captureSnapshot("pi", opId, `bytes ${index}\n`);
      store.appendJournal(entry({ opId, snapshot }));
    }
    // Every row survives as history.
    expect(store.listOperations("pi", Number.MAX_SAFE_INTEGER)).toHaveLength(SNAPSHOT_RETENTION + 1);
    // The oldest snapshot's bytes are gone, and it reads as expired rather than
    // as "the file did not exist" — the distinction restore depends on.
    const oldest = store.findOperation(opIds[0]!)!;
    expect(store.readSnapshot(oldest)).toEqual({ kind: "expired" });
    expect(readdirSync(join(root, "snapshots", "pi"))).toHaveLength(SNAPSHOT_RETENTION);
  });

  test("ten BACKUPS are kept, not ten operations", () => {
    /*
     * An apply to an absent file records `snapshot: none` — a real row with
     * nothing stored. Retention used to take the newest ten ROWS and then
     * filter, so a history alternating stored and none kept only five backups
     * while the docs promised ten. Interleave them and count the files.
     */
    for (let index = 0; index < SNAPSHOT_RETENTION * 2; index += 1) {
      const opId = `op-${String(index).padStart(3, "0")}`;
      const snapshot = index % 2 === 0
        ? store.captureSnapshot("pi", opId, `bytes ${index}\n`)
        : { kind: "none" as const };
      store.appendJournal(entry({ opId, snapshot }));
    }
    expect(store.countSnapshots("pi")).toBe(SNAPSHOT_RETENTION);
  });

  test("counting distinguishes a genuine zero from an uninspectable directory", () => {
    // An absent directory is a real zero.
    expect(store.countSnapshots("pi")).toBe(0);
    store.captureSnapshot("pi", "op-1", "bytes\n");
    expect(store.countSnapshots("pi")).toBe(1);

    // An unreadable one is NOT zero. Reporting it as a healthy empty directory
    // would hide exactly the credential-bearing pile the count exists to
    // disclose, so make it genuinely uninspectable rather than stubbing readdir.
    const parent = join(root, "snapshots");
    chmodSync(parent, 0o000);
    try {
      // Running as root defeats the permission bit; only assert where the OS
      // actually enforces it.
      if (!canStillList(join(parent, "pi"))) {
        expect(store.countSnapshots("pi")).toBeNull();
      }
    } finally {
      chmodSync(parent, 0o700);
    }
  });
});

describe("maintenance marker", () => {
  test("a malformed marker cannot make a committed append look like a failure", () => {
    mkdirSync(root, { recursive: true });
    // `{}` parses fine but has no pruneFailures — a cast would leave it
    // undefined and the next mark/clear would throw AFTER the row committed.
    writeFileSync(join(root, "maintenance.json"), "{}\n");
    expect(() => store.appendJournal(entry({ opId: "committed" }))).not.toThrow();
    expect(store.findOperation("committed")).not.toBeNull();
    expect(store.readMaintenance()).toEqual({ pruneFailures: {} });
  });

  test("unknown clients and malformed entries are dropped, not trusted", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "maintenance.json"), JSON.stringify({
      pruneFailures: {
        pi: { at: "2026-08-02T00:00:00.000Z", error: "boom" },
        "not-a-client": { at: "x", error: "y" },
        kimi: { at: 42 },
      },
    }));
    expect(store.readMaintenance().pruneFailures).toEqual({
      pi: { at: "2026-08-02T00:00:00.000Z", error: "boom" },
    });
  });

  test("marking and clearing round-trip through the store's own root", () => {
    store.markPruneFailure("pi", "rmSync exploded");
    expect(store.readMaintenance().pruneFailures.pi?.error).toBe("rmSync exploded");
    store.clearPruneFailure("pi");
    expect(store.readMaintenance().pruneFailures.pi).toBeUndefined();
  });

  test("a pending failure is retried and cleared once pruning succeeds", () => {
    store.markPruneFailure("pi", "transient");
    store.retryPendingPrunes();
    expect(store.readMaintenance().pruneFailures.pi).toBeUndefined();
  });
});

describe("store isolation", () => {
  test("everything a store writes stays under its own root", () => {
    const other = join(mkdtempSync(join(tmpdir(), "ocx-other-")), "integrations");
    try {
      const otherStore = createIntegrationStateStore(other);
      otherStore.appendJournal(entry({ opId: "elsewhere" }));
      otherStore.captureSnapshot("pi", "elsewhere", "bytes\n");
      otherStore.markPruneFailure("pi", "boom");

      // Nothing leaked into the first store.
      expect(store.listOperations()).toEqual([]);
      expect(store.readMaintenance()).toEqual({ pruneFailures: {} });
      expect(existsSync(join(root, "snapshots", "pi", "elsewhere"))).toBe(false);
      // And the other store really did do the work.
      expect(otherStore.findOperation("elsewhere")).not.toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a crafted opId cannot write outside the bound store", () => {
    // The id normally comes from randomUUID(), but it also arrives from a
    // persisted row. A value like "../../escaped" would put snapshot bytes
    // anywhere on disk.
    expect(() => store.captureSnapshot("kimi", "../../escaped", "x")).toThrow(/unsafe opId/);
    expect(() => store.captureSnapshot("kimi", "a/b", "x")).toThrow(/unsafe opId/);
  });

  test("a crafted relPath cannot read outside the bound store", () => {
    const entry: JournalEntry = {
      opId: "o", clientId: "kimi", kind: "apply", at: new Date().toISOString(),
      configPath: "/tmp/whatever",
      snapshot: { kind: "stored", relPath: "../../../../../../etc/passwd" },
      resultFingerprint: "", resultAbsent: false, priorRecord: null,
    };
    expect(() => store.readSnapshot(entry)).toThrow(/escapes the integration store/);
  });

  test("a prune failure keeps the row, marks retention, and a later run clears it", () => {
    // Contract: 006 §5. The row must survive a pruning failure, the marker must
    // record it, and a later successful prune must clear both the marker and
    // the excess snapshots. Failure is induced by making the snapshot
    // directory unreadable rather than by stubbing, so the real errno path runs.
    const clientId = "kimi" as const;
    for (let i = 0; i < SNAPSHOT_RETENTION + 3; i += 1) {
      const opId = `op-${String(i).padStart(3, "0")}`;
      const snapshot = store.captureSnapshot(clientId, opId, `bytes-${i}`);
      store.appendJournal({
        opId, clientId, kind: "apply", at: new Date(2026, 0, 1, 0, i).toISOString(),
        configPath: "/tmp/whatever", snapshot,
        resultFingerprint: `f${i}`, resultAbsent: false, priorRecord: null,
      });
    }
    // Pruning already ran post-commit, so the bound holds here.
    expect(store.countSnapshots(clientId)).toBeLessThanOrEqual(SNAPSHOT_RETENTION);

    const dir = join(root, "snapshots", clientId);
    const rowsBefore = store.listOperations(clientId).length;
    chmodSync(dir, 0o000);
    try {
      // Go through the REAL post-commit path: appendOperation prunes and marks
      // by itself. Calling markPruneFailure by hand would prove nothing about
      // whether a pruning failure can take the committed row down with it.
      const failed = store.pruneSnapshots(clientId);
      // Running as root would defeat the permission bit; only assert the
      // contract when the failure actually occurred.
      if (!failed.ok) {
        expect(() => store.appendJournal({
          opId: "after-prune-broke", clientId, kind: "apply", at: new Date().toISOString(),
          configPath: "/tmp/whatever", snapshot: { kind: "none" },
          resultFingerprint: "later", resultAbsent: false, priorRecord: null,
        })).not.toThrow();
        // The row committed even though the maintenance that follows it failed.
        expect(store.findOperation("after-prune-broke")).not.toBeNull();
        expect(store.listOperations(clientId).length).toBe(rowsBefore + 1);
        // …and the failure was recorded for a later retry.
        expect(store.readMaintenance().pruneFailures[clientId]).toBeDefined();
      }
    } finally {
      chmodSync(dir, 0o700);
    }

    // A later operation retries and clears the marker.
    store.retryPendingPrunes();
    expect(store.readMaintenance().pruneFailures[clientId]).toBeUndefined();
    expect(store.countSnapshots(clientId)).toBeLessThanOrEqual(SNAPSHOT_RETENTION);
  });

  test("a temp-rooted store leaves the real ownership manifest untouched", () => {
    // atomicWriteFile records writes in the opencodex uninstall manifest, but
    // that registration refuses any path outside the process config dir. This
    // pins the property every other test in this file depends on: an isolated
    // store touches no global state.
    const manifest = join(getConfigDir(), ".opencodex-ownership.json");
    const before = existsSync(manifest) ? readFileSync(manifest, "utf8") : null;
    store.captureSnapshot("kimi", "manifest-probe", "bytes");
    const after = existsSync(manifest) ? readFileSync(manifest, "utf8") : null;
    expect(after).toBe(before);
    expect(existsSync(join(root, "snapshots", "kimi", "manifest-probe"))).toBe(true);
  });

  /**
   * The writer never touches `writeRecord` directly — it goes through
   * `store.io()`. If that seam resolved the default root, a test (or a second
   * store) would silently rewrite the developer's own records file, so bind the
   * check to the seam the writer actually uses.
   */
  test("records written through the io() seam land in the bound store", () => {
    const record: OwnershipRecord = {
      clientId: "pi",
      configPath: "/home/dev/.pi/agent/models.json",
      fileFingerprint: "f".repeat(16),
      blockFingerprint: "b".repeat(16),
      fragmentPaths: [["providers", "opencodex"]],
      appliedAt: "2026-08-02T00:00:00.000Z",
      opId: "io-seam",
    };
    const io = store.io();
    io.putRecord(record);
    expect(store.readRecords().pi?.opId).toBe("io-seam");
    expect(existsSync(join(root, "records.json"))).toBe(true);

    // A second store rooted elsewhere sees nothing of it, and dropping through
    // the seam removes it from the same place it was written.
    const other = join(mkdtempSync(join(tmpdir(), "ocx-io-seam-")), "integrations");
    try {
      expect(createIntegrationStateStore(other).readRecords().pi).toBeUndefined();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    io.dropRecord("pi");
    expect(store.readRecords().pi).toBeUndefined();

    // And the journal seam writes to the same root rather than the default one.
    io.appendJournal(entry({ opId: "io-seam-row" }));
    expect(store.findOperation("io-seam-row")).not.toBeNull();
    expect(readFileSync(join(root, "journal.jsonl"), "utf8")).toContain("io-seam-row");
  });

  /**
   * Restore puts provenance back alongside the bytes, so `priorRecord` has to
   * survive JSON exactly. A dropped `fragmentPaths` would leave a restored file
   * whose owned paths are unknown — and disable would then remove nothing.
   */
  test("priorRecord round-trips through the journal unchanged", () => {
    const priorRecord: OwnershipRecord = {
      clientId: "kimi",
      configPath: "/home/dev/.kimi/config.toml",
      fileFingerprint: "0123456789abcdef",
      blockFingerprint: "fedcba9876543210",
      fragmentPaths: [["providers", "opencodex"], ["models", "opencodex/x"]],
      appliedAt: "2026-08-01T09:00:00.000Z",
      opId: "previous-op",
    };
    store.appendJournal(entry({ opId: "with-prior", clientId: "kimi", priorRecord }));
    expect(store.findOperation("with-prior")?.priorRecord).toEqual(priorRecord);
  });
});
