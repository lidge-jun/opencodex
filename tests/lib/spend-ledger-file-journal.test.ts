import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileSpendJournal,
  loadOrCreateSpendLedgerSalt,
} from "../../src/lib/spend-reservation-ledger";

/** POSIX mode bits do not describe a Windows ACL, where hardenSecretPath does the work. */
const posixModes = process.platform !== "win32";
/**
 * These fixtures own their own temporary journal, so there is no shared state directory to
 * prove ownership of. The parameter is required precisely so opting out is written down here
 * rather than defaulted into a production caller by omission.
 */
const unowned = { assertMutation: (): void => { /* fixture-owned journal */ } };
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const line = (send: string): string => JSON.stringify({ v: 1, kind: "lost", send, at: 1 });

describe("spend ledger file journal", () => {
  test.skipIf(!posixModes)("a journal that already exists is re-hardened, not trusted", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-spend-journal-"));
    const path = join(dir, "spend-ledger.jsonl");
    const journal = createFileSpendJournal(path, unowned);

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
    const dir = mkdtempSync(join(tmpdir(), "ocx-spend-compact-"));
    const path = join(dir, "spend-ledger.jsonl");
    const journal = createFileSpendJournal(path, unowned);
    journal.append(line("alias-one"));
    journal.append(line("alias-two"));

    const rewrite = journal.rewrite;
    expect(rewrite).toBeDefined();
    rewrite?.call(journal, [line("checkpoint-stand-in")]);

    expect(readFileSync(path, "utf8")).toBe(line("checkpoint-stand-in") + "\n");
    expect(journal.read()).toHaveLength(1);
    // The temp file is renamed over the journal, never left in the home directory.
    expect(readdirSync(dir)).toEqual(["spend-ledger.jsonl"]);
    if (posixModes) expect(modeOf(path)).toBe(0o600);
  });

  test("the alias salt is minted once and reused, so replay still matches live requests", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-spend-salt-"));
    const path = join(dir, "spend-ledger.salt");

    const minted = loadOrCreateSpendLedgerSalt(path, unowned);
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
    // Stability is the whole contract: a salt that changed per process would alias the same
    // root id differently after a restart and hand every scope a fresh allowance.
    expect(loadOrCreateSpendLedgerSalt(path, unowned)).toBe(minted);
    if (posixModes) expect(modeOf(path)).toBe(0o600);
  });
});
