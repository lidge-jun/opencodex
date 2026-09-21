import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createOwnedFileSpendJournal,
  loadOrCreateSpendLedgerSalt,
  SPEND_LEDGER_JOURNAL_FILENAME,
  SPEND_LEDGER_SALT_FILENAME,
  resetSharedSpendLedgerForTest,
  setSpendJournalFaultForTests,
} from "../../src/lib/spend-reservation-ledger";
import {
  acquireSpendLedgerOwner,
  mintSpendLedgerStorage,
  SpendLedgerOwnerError,
  type SpendLedgerOwnerLease,
} from "../../src/lib/spend-ledger-owner";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/** POSIX mode bits do not describe a Windows ACL, where hardenSecretPath does the work. */
const posixModes = process.platform !== "win32";
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const line = (send: string): string => JSON.stringify({ v: 1, kind: "lost", send, at: 1 });

const homes: string[] = [];
const leases: SpendLedgerOwnerLease[] = [];
let previousHome: string | undefined;

/**
 * A real lease over a throwaway state directory.
 *
 * These cases cover the production persistence, hardening and compaction paths, so they use the
 * production entrypoints rather than a stand-in: storage is minted by the owner module from the
 * directory it owns, which is the only way to obtain it.
 */
function ownedHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  previousHome ??= process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  resetSharedSpendLedgerForTest();
  leases.push(acquireSpendLedgerOwner());
  return home;
}

afterEach(() => {
  setSpendJournalFaultForTests(undefined);
  for (const lease of leases.splice(0)) {
    try { lease.release(); } catch { /* a failed release must not mask the case's result */ }
  }
  resetSharedSpendLedgerForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  previousHome = undefined;
  for (const home of homes.splice(0)) removeTreeWithRetry(home);
});

describe("spend ledger file journal", () => {
  test.skipIf(!posixModes || process.getuid?.() === 0)(
    "an entry that cannot be read is refused rather than reported absent", () => {
    const dir = ownedHome("ocx-spend-journal-unreadable-");
    const journal = createOwnedFileSpendJournal(mintSpendLedgerStorage(SPEND_LEDGER_JOURNAL_FILENAME));
    journal.append(line("alias-one"));

    const before = readdirSync(dir).sort();
    // Deny traversal of the owned directory, so the entry's lstat fails with EACCES instead of
    // ENOENT. Answering "absent" for that is what this pins: the file-safety assertion is
    // skipped for an entry that reads as missing, so a journal nobody can inspect would have
    // been appended to as though the slot were empty.
    chmodSync(dir, 0o000);
    try {
      // Refused, and refused in the module's own vocabulary rather than with the errno and path
      // of a state file. WHICH gate notices first is platform-dependent: where the directory
      // cannot be traversed at all, the ownership check cannot resolve it before the entry is
      // ever inspected. Both are the same refusal, so the type and the absence of a leaked path
      // are what this pins; the seam-driven case below pins the exact message everywhere.
      let refusal: unknown;
      try { journal.read(); } catch (error) { refusal = error; }
      expect(refusal).toBeInstanceOf(SpendLedgerOwnerError);
      expect((refusal as Error).message).not.toContain(dir);
    } finally {
      chmodSync(dir, 0o700);
    }
    // Nothing was created or reset while the directory was unreadable.
    expect(readdirSync(dir).sort()).toEqual(before);
    // The same entry is readable again once the directory is, so the refusal was about the
    // failed inspection and not about the journal's own contents.
    expect(journal.read()).toHaveLength(1);
  });

  test("a genuinely absent entry still reads as empty", () => {
    ownedHome("ocx-spend-journal-absent-");
    // The ENOENT control for the case above: absent is still absent, and only absent is.
    expect(createOwnedFileSpendJournal(mintSpendLedgerStorage(SPEND_LEDGER_JOURNAL_FILENAME)).read()).toEqual([]);
  });

  test("a journal whose entry cannot be inspected refuses on every platform", () => {
    const dir = ownedHome("ocx-spend-journal-stat-fault-");
    const journalPath = join(dir, SPEND_LEDGER_JOURNAL_FILENAME);
    const journal = createOwnedFileSpendJournal(mintSpendLedgerStorage(SPEND_LEDGER_JOURNAL_FILENAME));
    journal.append(line("alias-one"));
    const original = readFileSync(journalPath, "utf8");
    const before = readdirSync(dir).sort();

    // The chmod case above is real but POSIX-only and meaningless as root. This one is the same
    // contract proved everywhere: only the JOURNAL's own inspection fails, the salt stays
    // readable, and every other filesystem step is real.
    for (const code of ["EACCES", "EIO"] as const) {
      // Matched by entry name, not by full path: the owned home is the REAL path of the
      // directory, and on macOS the temp root is a symlink, so an equality check against the
      // path this case built never fired and the fault silently did nothing.
      setSpendJournalFaultForTests((step, target) => {
        if (step !== "stat" || basename(target) !== SPEND_LEDGER_JOURNAL_FILENAME) return;
        throw Object.assign(new Error(`injected ${code}`), { code });
      });
      expect(() => journal.read()).toThrowError(SpendLedgerOwnerError);
      expect(() => journal.append(line("alias-two"))).toThrow(/could not be inspected safely/);
      setSpendJournalFaultForTests(undefined);
    }

    // Refused, not reset: no truncation, no new entries, and the salt is still mintable.
    expect(readFileSync(journalPath, "utf8")).toBe(original);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(loadOrCreateSpendLedgerSalt(mintSpendLedgerStorage(SPEND_LEDGER_SALT_FILENAME))).toMatch(/^[0-9a-f]{32,}$/);
  });

  test.skipIf(!posixModes)("a journal that already exists is re-hardened, not trusted", () => {
    const dir = ownedHome("ocx-spend-journal-");
    const path = join(dir, SPEND_LEDGER_JOURNAL_FILENAME);
    const journal = createOwnedFileSpendJournal(mintSpendLedgerStorage(SPEND_LEDGER_JOURNAL_FILENAME));

    journal.append(line("alias-one"));
    expect(modeOf(path)).toBe(0o600);

    // `mode` in a write option applies only when the file is CREATED. A journal left
    // group-readable by an older build, a restored backup or a lax umask would keep that mode
    // for its whole life, which is the gap this closes.
    chmodSync(path, 0o644);
    journal.append(line("alias-two"));
    expect(modeOf(path)).toBe(0o600);

    chmodSync(path, 0o644);
    expect(journal.read()).toHaveLength(2);
    expect(modeOf(path)).toBe(0o600);
  });

  test("compaction replaces the journal atomically and leaves no temp behind", () => {
    const dir = ownedHome("ocx-spend-compact-");
    const path = join(dir, SPEND_LEDGER_JOURNAL_FILENAME);
    const journal = createOwnedFileSpendJournal(mintSpendLedgerStorage(SPEND_LEDGER_JOURNAL_FILENAME));
    journal.append(line("alias-one"));
    journal.append(line("alias-two"));

    const rewrite = journal.rewrite;
    expect(rewrite).toBeDefined();
    rewrite?.call(journal, [line("checkpoint-stand-in")]);

    expect(readFileSync(path, "utf8")).toBe(line("checkpoint-stand-in") + "\n");
    expect(journal.read()).toHaveLength(1);
    // The temp file is renamed over the journal, never left in the home directory. Asserted as
    // the absence of a compaction temp rather than an exact listing, because the owned state
    // directory also holds the lease database this case had to acquire to write at all.
    expect(readdirSync(dir).filter(name => name.includes(".compact-"))).toEqual([]);
    expect(readdirSync(dir)).toContain(SPEND_LEDGER_JOURNAL_FILENAME);
    if (posixModes) expect(modeOf(path)).toBe(0o600);
  });

  /**
   * Compaction failure paths, driven through the journal's own fault seam.
   *
   * The temp name carries random bytes, so a failure that leaves it behind is not one stale file
   * but one per attempt. Each case below drives the same compaction repeatedly and asserts the
   * directory holds no compaction residue and the original journal is untouched.
   */
  for (const step of ["validate", "harden", "rename"] as const) {
    test(`a compaction that fails at ${step} leaves no temp behind`, () => {
      const dir = ownedHome(`ocx-spend-compact-${step}-`);
      const path = join(dir, SPEND_LEDGER_JOURNAL_FILENAME);
      const journal = createOwnedFileSpendJournal(mintSpendLedgerStorage(SPEND_LEDGER_JOURNAL_FILENAME));
      journal.append(line("alias-one"));
      const original = readFileSync(path, "utf8");

      setSpendJournalFaultForTests((actual) => {
        if (actual === step) throw new Error(`fault injected at ${step}`);
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(() => journal.rewrite?.call(journal, [line("checkpoint")])).toThrow(/fault injected/);
      }
      setSpendJournalFaultForTests(undefined);

      expect(readdirSync(dir).filter(name => name.includes(".compact-"))).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(original);
    });
  }

  test("a compaction whose write stops partway leaves neither residue nor a truncated journal", () => {
    const dir = ownedHome("ocx-spend-compact-partial-");
    const path = join(dir, SPEND_LEDGER_JOURNAL_FILENAME);
    const journal = createOwnedFileSpendJournal(mintSpendLedgerStorage(SPEND_LEDGER_JOURNAL_FILENAME));
    journal.append(line("alias-one"));
    const original = readFileSync(path, "utf8");

    // The entry already exists by the time the write runs, which is the case the exclusive
    // create exists to make unambiguous. A real prefix goes in first, so this is a SHORT write
    // rather than a failure before any byte landed: the residue that must be cleaned is a file
    // with content in it.
    setSpendJournalFaultForTests((actual, temp) => {
      if (actual !== "write") return;
      expect(existsSync(temp)).toBe(true);
      appendFileSync(temp, line("half-written").slice(0, 12), { encoding: "utf8" });
      expect(readFileSync(temp, "utf8").length).toBeGreaterThan(0);
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(() => journal.rewrite?.call(journal, [line("checkpoint")])).toThrow(/no space left/);
    }
    setSpendJournalFaultForTests(undefined);

    expect(readdirSync(dir).filter(name => name.includes(".compact-"))).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("a compaction candidate that already exists is left exactly as it was", () => {
    const dir = ownedHome("ocx-spend-compact-eexist-");
    const journal = createOwnedFileSpendJournal(mintSpendLedgerStorage(SPEND_LEDGER_JOURNAL_FILENAME));
    journal.append(line("alias-one"));

    // Occupy the exact candidate name before the exclusive create reaches it. The create then
    // fails EEXIST, and because this call never created the entry it must not remove it.
    let occupied: string | undefined;
    setSpendJournalFaultForTests((actual, temp) => {
      if (actual !== "create" || occupied !== undefined) return;
      occupied = temp;
      writeFileSync(temp, "not ours\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    });
    expect(() => journal.rewrite?.call(journal, [line("checkpoint")])).toThrow();
    setSpendJournalFaultForTests(undefined);

    expect(occupied).toBeDefined();
    expect(readFileSync(occupied!, "utf8")).toBe("not ours\n");
  });

  test("the alias salt is minted once and reused, so replay still matches live requests", () => {
    const dir = ownedHome("ocx-spend-salt-");
    const path = join(dir, SPEND_LEDGER_SALT_FILENAME);

    const minted = loadOrCreateSpendLedgerSalt(mintSpendLedgerStorage(SPEND_LEDGER_SALT_FILENAME));
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
    // Stability is the whole contract: a salt that changed per process would alias the same
    // root id differently after a restart and hand every scope a fresh allowance.
    expect(loadOrCreateSpendLedgerSalt(mintSpendLedgerStorage(SPEND_LEDGER_SALT_FILENAME))).toBe(minted);
    if (posixModes) expect(modeOf(path)).toBe(0o600);
  });
});
