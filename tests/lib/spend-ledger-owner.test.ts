/** Cross-process ownership for the process-wide spend journal (#5123). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSpendLedgerOwner,
  SPEND_LEDGER_OWNER_FILENAME,
  mintSpendLedgerStorage,
  SPEND_LEDGER_RESTART_PARENT_ENV,
  SpendLedgerOwnerError,
  spendLedgerRestartEnvironment,
  spendLedgerOwnerSnapshot,
  type SpendLedgerOwnerLease,
} from "../../src/lib/spend-ledger-owner";
import {
  SPEND_LEDGER_JOURNAL_FILENAME,
  SPEND_LEDGER_SALT_FILENAME,
  createOwnedFileSpendJournal,
  loadOrCreateSpendLedgerSalt,
  resetSharedSpendLedgerForTest,
  sharedSpendLedger,
  spendLedgerDiagnosticsSnapshot,
} from "../../src/lib/spend-reservation-ledger";
import { helperPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";

const childPath = helperPath("spend-ledger-owner-child.ts");
/** The shape the ledger actually takes: scopes plus the two token figures it books against. */
const reserveRequest = (sendId: string) => ({
  sendId,
  scopes: { rootId: "r1" },
  inputTokens: 1,
  outputCeilingTokens: 1,
});
let root = "";
let home = "";
let previousHome: string | undefined;
const children = new Set<ReturnType<typeof Bun.spawn>>();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-spend-owner-"));
  home = join(root, "state-a");
  previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  resetSharedSpendLedgerForTest();
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  children.clear();
  resetSharedSpendLedgerForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

function spawnHolder(
  targetHome: string,
  mode: "observe" | "enforced",
  suffix: string,
  extraEnv: Record<string, string> = {},
) {
  const holdMarker = join(root, `held-${suffix}`);
  const releaseMarker = join(root, `release-${suffix}`);
  const child = Bun.spawn([process.execPath, childPath], {
    env: {
      ...process.env,
      ...extraEnv,
      OPENCODEX_HOME: targetHome,
      OCX_SPEND_OWNER_CHILD: JSON.stringify({ holdMarker, releaseMarker, mode }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.add(child);
  return { child, holdMarker, releaseMarker };
}

async function waitForMarker(path: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + INTERNAL_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`owner child exited before holding: ${await new Response(child.stderr).text()}`);
    }
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for spend-ledger owner child");
}

async function childResult(child: ReturnType<typeof Bun.spawn>) {
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  children.delete(child);
  return JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}") as {
    status: string;
    code?: string;
    message?: string;
  };
}

function busyError(): SpendLedgerOwnerError {
  try { acquireSpendLedgerOwner(); }
  catch (error) {
    if (error instanceof SpendLedgerOwnerError) return error;
    throw error;
  }
  throw new Error("expected spend-ledger ownership refusal");
}

describe("real process ownership", () => {
  test("only a parent-exit restart environment carries the handoff marker", () => {
    const source = { OCX_SPEND_LEDGER_RESTART_PARENT_PID: "stale", KEEP_ME: "yes" };
    expect(spendLedgerRestartEnvironment(source)).toEqual({ KEEP_ME: "yes" });
    expect(spendLedgerRestartEnvironment(source, 4242)).toEqual({
      KEEP_ME: "yes",
      OCX_SPEND_LEDGER_RESTART_PARENT_PID: "4242",
    });
  });

  for (const [holderMode, contenderMode] of [["observe", "enforced"], ["enforced", "observe"]] as const) {
    test(`${holderMode} and ${contenderMode} configurations contend identically`, async () => {
      const holder = spawnHolder(home, holderMode, `${holderMode}-${contenderMode}`);
      await waitForMarker(holder.holdMarker, holder.child);
      const refusal = busyError();
      expect(refusal.code).toBe("SPEND_LEDGER_OWNER_BUSY");
      writeFileSync(holder.releaseMarker, "release");
      expect((await childResult(holder.child)).status).toBe("acquired");
    }, SPAWN_BUDGET_MS);
  }

  test("independent state directories are independent", async () => {
    const holder = spawnHolder(home, "observe", "independent");
    await waitForMarker(holder.holdMarker, holder.child);
    const other = acquireSpendLedgerOwner(join(root, "state-b"));
    expect(spendLedgerOwnerSnapshot().ownership).toBe("held");
    other.release();
    writeFileSync(holder.releaseMarker, "release");
    await childResult(holder.child);
  }, SPAWN_BUDGET_MS);

  test("graceful release lets the next process acquire", async () => {
    const holder = spawnHolder(home, "observe", "graceful");
    await waitForMarker(holder.holdMarker, holder.child);
    writeFileSync(holder.releaseMarker, "release");
    await childResult(holder.child);
    const next = acquireSpendLedgerOwner();
    next.release();
  }, SPAWN_BUDGET_MS);

  test("a marked restart child waits for the parent lease while an ordinary sibling fails immediately", async () => {
    const parent = acquireSpendLedgerOwner();
    const ordinary = spawnHolder(home, "observe", "ordinary-sibling");
    expect((await childResult(ordinary.child)).code).toBe("SPEND_LEDGER_OWNER_BUSY");

    const restart = spawnHolder(home, "observe", "restart-child", {
      [SPEND_LEDGER_RESTART_PARENT_ENV]: String(process.pid),
    });
    await Bun.sleep(25);
    expect(restart.child.exitCode).toBeNull();
    parent.release();
    await waitForMarker(restart.holdMarker, restart.child);
    writeFileSync(restart.releaseMarker, "release");
    expect((await childResult(restart.child)).status).toBe("acquired");
  }, SPAWN_BUDGET_MS);

  test("an abruptly killed owner is reacquirable without replacing the lock file", async () => {
    const holder = spawnHolder(home, "observe", "killed");
    await waitForMarker(holder.holdMarker, holder.child);
    const lockPath = join(home, SPEND_LEDGER_OWNER_FILENAME);
    const journalPath = join(home, SPEND_LEDGER_JOURNAL_FILENAME);
    const saltPath = join(home, SPEND_LEDGER_SALT_FILENAME);
    const before = [lockPath, journalPath, saltPath].map(path => ({ path, stat: statSync(path) }));
    holder.child.kill("SIGKILL");
    await holder.child.exited;
    children.delete(holder.child);
    const next = acquireSpendLedgerOwner();
    for (const entry of before) {
      const after = statSync(entry.path);
      expect(after.size).toBe(entry.stat.size);
      if (process.platform !== "win32") expect(after.ino).toBe(entry.stat.ino);
    }
    next.release();
  }, SPAWN_BUDGET_MS);
});

describe("in-process references and privacy", () => {
  let leases: SpendLedgerOwnerLease[] = [];
  afterEach(() => {
    for (const lease of leases.splice(0).reverse()) lease.release();
  });

  test("two leases share ownership and one release does not free it", async () => {
    const first = acquireSpendLedgerOwner();
    const second = acquireSpendLedgerOwner();
    leases.push(first, second);
    first.release();
    const holder = spawnHolder(home, "observe", "references");
    expect((await childResult(holder.child)).code).toBe("SPEND_LEDGER_OWNER_BUSY");
    second.release();
    expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
  }, SPAWN_BUDGET_MS);

  test("one process refuses a second different state directory", () => {
    leases.push(acquireSpendLedgerOwner());
    let failure: unknown;
    try { acquireSpendLedgerOwner(join(root, "state-b")); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SpendLedgerOwnerError);
    expect((failure as SpendLedgerOwnerError).code).toBe("SPEND_LEDGER_OWNER_HOME_CONFLICT");
  });

  test("releasing the final lease frees the process to own a different state directory", () => {
    // The refusal above is about two homes owned at once. Once ownership is gone the singleton
    // has no directory to belong to, so it is discarded with the lease: the next home builds its
    // own ledger by replaying its own journal. Keeping the old binding instead would strand a
    // process that legitimately serves one home and then another.
    const first = acquireSpendLedgerOwner();
    sharedSpendLedger();
    first.release();
    expect(spendLedgerDiagnosticsSnapshot()).toMatchObject({ ownership: "unheld", initialized: false });

    process.env.OPENCODEX_HOME = join(root, "state-b");
    const second = acquireSpendLedgerOwner();
    leases.push(second);
    sharedSpendLedger();
    expect(spendLedgerDiagnosticsSnapshot()).toMatchObject({ ownership: "held", initialized: true });
    expect(existsSync(join(root, "state-b", SPEND_LEDGER_OWNER_FILENAME))).toBe(true);
  });

  test("a retained ledger stays refused after the same home is owned again", () => {
    // The dangerous case is not a different directory, it is the same one owned again. The
    // retained handle carries totals from before the gap, and another writer may have appended
    // to the journal while nobody held the lock.
    const first = acquireSpendLedgerOwner();
    const retained = sharedSpendLedger();
    first.release();

    const second = acquireSpendLedgerOwner();
    leases.push(second);
    let failure: unknown;
    try { retained.snapshot("root", "r1"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SpendLedgerOwnerError);
    expect((failure as SpendLedgerOwnerError).code).toBe("SPEND_LEDGER_OWNER_NOT_HELD");

    let mutation: unknown;
    try { retained.reserve(reserveRequest("s1")); } catch (error) { mutation = error; }
    expect(mutation).toBeInstanceOf(SpendLedgerOwnerError);

    // Reads are refused for the same reason writes are: the figures describe a journal this
    // handle no longer owns.
    for (const read of [
      () => retained.knows("s1"),
      () => retained.exhausted("root", "r1"),
      () => retained.policy,
      () => retained.degraded,
      () => retained.persistFailures,
      () => retained.corruptRecords,
    ]) {
      expect(read).toThrow(SpendLedgerOwnerError);
    }

    // A handle taken under the new ownership works and sees the journal as it is now.
    expect(() => sharedSpendLedger().snapshot("root", "r1")).not.toThrow();
  });

  test("storage this module did not mint is not accepted as proof", () => {
    // The defect this closes: a required guard the caller supplies can be a guard that does
    // nothing, so a look-alike object must be refused on identity rather than on shape.
    const lease = acquireSpendLedgerOwner();
    leases.push(lease);
    const forged = {
      path: join(home, SPEND_LEDGER_JOURNAL_FILENAME),
      assert(): void { /* a caller-supplied guard proves nothing */ },
    } as unknown as Parameters<typeof createOwnedFileSpendJournal>[0];

    expect(() => createOwnedFileSpendJournal(forged)).toThrow(SpendLedgerOwnerError);
    expect(() => loadOrCreateSpendLedgerSalt(forged)).toThrow(SpendLedgerOwnerError);
    expect(existsSync(join(home, SPEND_LEDGER_JOURNAL_FILENAME))).toBe(false);
  });

  test("minting refuses a name that is not a plain file in the owned directory", () => {
    const lease = acquireSpendLedgerOwner();
    leases.push(lease);
    for (const name of ["../escape.jsonl", "nested/child.jsonl", ".."]) {
      expect(() => mintSpendLedgerStorage(name)).toThrow(SpendLedgerOwnerError);
    }
  });

  test("a dangling journal symlink is refused rather than followed", () => {
    const lease = acquireSpendLedgerOwner();
    leases.push(lease);
    const journal = join(home, SPEND_LEDGER_JOURNAL_FILENAME);
    const target = join(root, "elsewhere.jsonl");
    symlinkSync(target, journal);

    let failure: unknown;
    try { sharedSpendLedger().reserve(reserveRequest("s1")); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SpendLedgerOwnerError);
    // The point of the case: the link's target must not have been created by following it.
    expect(existsSync(target)).toBe(false);
  });

  test("a retained shared ledger refuses mutation after its final lease releases", async () => {
    const lease = acquireSpendLedgerOwner();
    const retained = sharedSpendLedger();
    lease.release();
    const holder = spawnHolder(home, "observe", "retained-handle");
    await waitForMarker(holder.holdMarker, holder.child);
    let failure: unknown;
    try {
      retained.reserve({
        sendId: "retained",
        scopes: { rootId: "retained-root" },
        inputTokens: 1,
        outputCeilingTokens: 1,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SpendLedgerOwnerError);
    expect((failure as SpendLedgerOwnerError).code).toBe("SPEND_LEDGER_OWNER_NOT_HELD");
    writeFileSync(holder.releaseMarker, "release");
    await childResult(holder.child);
  }, SPAWN_BUDGET_MS);

  test("busy refusal contains no private identity or filesystem data", async () => {
    const holder = spawnHolder(home, "observe", "privacy");
    await waitForMarker(holder.holdMarker, holder.child);
    const refusal = busyError();
    const text = `${refusal.name} ${refusal.code} ${refusal.message}`.toLowerCase();
    for (const secret of [home.toLowerCase(), String(process.pid), "spend-ledger.jsonl", "child-root", "account", "scope", "request"]) {
      expect(text).not.toContain(secret);
    }
    writeFileSync(holder.releaseMarker, "release");
    await childResult(holder.child);
  }, SPAWN_BUDGET_MS);

  test("diagnostics do not construct or create ledger files", () => {
    leases.push(acquireSpendLedgerOwner());
    expect(spendLedgerDiagnosticsSnapshot()).toEqual({
      ownership: "held",
      initialized: false,
      configured: false,
      degraded: false,
      persistFailures: 0,
      corruptRecords: 0,
    });
    expect(existsSync(join(home, SPEND_LEDGER_JOURNAL_FILENAME))).toBe(false);
    expect(existsSync(join(home, SPEND_LEDGER_SALT_FILENAME))).toBe(false);
  });
});

describe("backing file identity", () => {
  const expectBackingAliasesRefused = (kind: "hardlink" | "symlink"): void => {
    const first = acquireSpendLedgerOwner(home);
    sharedSpendLedger().reserve({
      sendId: "first",
      scopes: { rootId: "first-root" },
      inputTokens: 1,
      outputCeilingTokens: 1,
    });
    first.release();
    resetSharedSpendLedgerForTest();

    for (const filename of [SPEND_LEDGER_JOURNAL_FILENAME, SPEND_LEDGER_SALT_FILENAME]) {
      const otherHome = join(root, `${kind}-${filename}`);
      const prepared = acquireSpendLedgerOwner(otherHome);
      prepared.release();
      const source = join(home, filename);
      const destination = join(otherHome, filename);
      if (kind === "hardlink") linkSync(source, destination);
      else symlinkSync(source, destination);
      const owner = acquireSpendLedgerOwner(otherHome);
      process.env.OPENCODEX_HOME = otherHome;
      let failure: unknown;
      try { sharedSpendLedger(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(SpendLedgerOwnerError);
      expect((failure as SpendLedgerOwnerError).code).toBe("SPEND_LEDGER_OWNER_UNAVAILABLE");
      owner.release();
      resetSharedSpendLedgerForTest();
    }
  };

  test("hard-linked owner files fail closed", () => {
    const linkedHome = join(root, "owner-hardlink");
    mkdirSync(linkedHome, { recursive: true });
    const target = join(root, "owner-hardlink-target");
    writeFileSync(target, "owner");
    linkSync(target, join(linkedHome, SPEND_LEDGER_OWNER_FILENAME));
    let failure: unknown;
    try { acquireSpendLedgerOwner(linkedHome); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SpendLedgerOwnerError);
    expect((failure as SpendLedgerOwnerError).code).toBe("SPEND_LEDGER_OWNER_UNAVAILABLE");
  });

  test.skipIf(process.platform === "win32")("symbolically linked owner files fail closed", () => {
    const linkedHome = join(root, "owner-symlink");
    mkdirSync(linkedHome, { recursive: true });
    const target = join(root, "owner-symlink-target");
    writeFileSync(target, "owner");
    symlinkSync(target, join(linkedHome, SPEND_LEDGER_OWNER_FILENAME));
    let failure: unknown;
    try { acquireSpendLedgerOwner(linkedHome); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SpendLedgerOwnerError);
    expect((failure as SpendLedgerOwnerError).code).toBe("SPEND_LEDGER_OWNER_UNAVAILABLE");
  });

  test("invalid or unusable owner databases fail closed", () => {
    const invalidHome = join(root, "owner-invalid");
    mkdirSync(invalidHome, { recursive: true });
    writeFileSync(join(invalidHome, SPEND_LEDGER_OWNER_FILENAME), "not sqlite");
    let invalid: unknown;
    try { acquireSpendLedgerOwner(invalidHome); } catch (error) { invalid = error; }
    expect(invalid).toBeInstanceOf(SpendLedgerOwnerError);
    expect((invalid as SpendLedgerOwnerError).code).toBe("SPEND_LEDGER_OWNER_UNAVAILABLE");

    const unusableHome = join(root, "owner-unusable");
    mkdirSync(join(unusableHome, SPEND_LEDGER_OWNER_FILENAME), { recursive: true });
    let unusable: unknown;
    try { acquireSpendLedgerOwner(unusableHome); } catch (error) { unusable = error; }
    expect(unusable).toBeInstanceOf(SpendLedgerOwnerError);
    expect((unusable as SpendLedgerOwnerError).code).toBe("SPEND_LEDGER_OWNER_UNAVAILABLE");
  });

  test("linked journals and salts cannot cross independent homes", () => {
    expectBackingAliasesRefused("hardlink");
  });

  test.skipIf(process.platform === "win32")("symbolically linked journals and salts fail closed", () => {
    expectBackingAliasesRefused("symlink");
  });

  test("the shared ledger requires a live lease", () => {
    let failure: unknown;
    try { sharedSpendLedger(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SpendLedgerOwnerError);
    expect((failure as SpendLedgerOwnerError).code).toBe("SPEND_LEDGER_OWNER_NOT_HELD");
  });
});
