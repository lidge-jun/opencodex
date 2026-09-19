import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwnedFileSpendJournal,
  loadOrCreateSpendLedgerSalt,
  SPEND_LEDGER_JOURNAL_FILENAME,
  SPEND_LEDGER_SALT_FILENAME,
  resetSharedSpendLedgerForTest,
} from "../../src/lib/spend-reservation-ledger";
import {
  acquireSpendLedgerOwner,
  mintSpendLedgerStorage,
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
