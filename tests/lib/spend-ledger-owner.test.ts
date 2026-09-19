/** Cross-process ownership for the process-wide spend journal (#5123). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSpendLedgerOwner,
  SPEND_LEDGER_OWNER_FILENAME,
  SpendLedgerOwnerError,
  spendLedgerOwnerSnapshot,
  type SpendLedgerOwnerLease,
} from "../../src/lib/spend-ledger-owner";
import {
  SPEND_LEDGER_JOURNAL_FILENAME,
  SPEND_LEDGER_SALT_FILENAME,
  resetSharedSpendLedgerForTest,
  sharedSpendLedger,
  spendLedgerDiagnosticsSnapshot,
} from "../../src/lib/spend-reservation-ledger";
import { helperPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";

const childPath = helperPath("spend-ledger-owner-child.ts");
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

function spawnHolder(targetHome: string, mode: "observe" | "enforced", suffix: string) {
  const holdMarker = join(root, `held-${suffix}`);
  const releaseMarker = join(root, `release-${suffix}`);
  const child = Bun.spawn([process.execPath, childPath], {
    env: {
      ...process.env,
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

  test("a constructed singleton keeps its home after the final lease releases", () => {
    const first = acquireSpendLedgerOwner();
    leases.push(first);
    sharedSpendLedger();
    first.release();
    process.env.OPENCODEX_HOME = join(root, "state-b");
    let failure: unknown;
    try { acquireSpendLedgerOwner(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SpendLedgerOwnerError);
    expect((failure as SpendLedgerOwnerError).code).toBe("SPEND_LEDGER_OWNER_HOME_CONFLICT");
  });

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
