import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { protectedHomeForTests } from "../../src/lib/test-home-guard";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAliasLock, aliasLockPath, AliasLockError, ALIAS_LOCK_WAIT_MS } from "../../src/link/alias-lock";
import { ENROLLMENT_DEADLINE_MS } from "../../src/cli/link-enrollment";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/** O1: enrollment and revoke of one alias are serialized by a lock file; a second holder waits. */
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocx-alias-lock-")); });
afterEach(() => { if (dir) removeTreeWithRetry(dir); });

function clock() {
  let now = 0;
  const sleeps: number[] = [];
  return { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; }, sleeps };
}

test("a second holder of the same alias waits until the first releases, in any case of the alias", async () => {
  const c = clock();
  const first = await acquireAliasLock("pen-7f3a9c", { lockDir: dir, now: c.now, sleep: c.sleep });
  let acquired = false;
  const second = acquireAliasLock("PEN-7f3a9c", { lockDir: dir, now: c.now, waitMs: 10_000, pollMs: 250,
    sleep: async ms => { await c.sleep(ms); if (c.sleeps.length === 3) first.release(); } }).then(lock => { acquired = true; return lock; });
  const lock = await second;
  expect(acquired).toBe(true);
  expect(c.sleeps).toEqual([250, 250, 250]);
  lock.release();
});

test("another alias does not wait", async () => {
  const c = clock();
  const first = await acquireAliasLock("pen-a", { lockDir: dir, now: c.now, sleep: c.sleep });
  const other = await acquireAliasLock("pen-b", { lockDir: dir, now: c.now, sleep: c.sleep });
  expect(c.sleeps).toEqual([]);
  first.release(); other.release();
});

test("past the bound the waiter gives up with link_alias_lock_busy and the holder keeps the lock", async () => {
  const c = clock();
  const first = await acquireAliasLock("pen-7f3a9c", { lockDir: dir, now: c.now, sleep: c.sleep });
  const error = await acquireAliasLock("pen-7f3a9c", { lockDir: dir, now: c.now, sleep: c.sleep, waitMs: 1000, pollMs: 250 }).catch(e => e);
  expect(error).toBeInstanceOf(AliasLockError);
  expect((error as AliasLockError).code).toBe("link_alias_lock_busy");
  first.release();
  const again = await acquireAliasLock("pen-7f3a9c", { lockDir: dir, now: c.now, sleep: c.sleep, waitMs: 0 });
  again.release();
});

test("an aborted request stops waiting at the next poll and takes no lock", async () => {
  const c = clock();
  const holder = await acquireAliasLock("pen-7f3a9c", { lockDir: dir, now: c.now, sleep: c.sleep });
  const controller = new AbortController();
  const error = await acquireAliasLock("pen-7f3a9c", { lockDir: dir, now: c.now, waitMs: 100_000, pollMs: 250, signal: controller.signal,
    sleep: async ms => { await c.sleep(ms); if (c.sleeps.length === 2) controller.abort(); if (c.sleeps.length > 4) throw new Error("kept waiting after the abort"); } }).catch(e => e);
  expect((error as AliasLockError).code).toBe("link_alias_lock_aborted");
  expect(c.sleeps).toEqual([250, 250]);
  holder.release();
  const next = await acquireAliasLock("pen-7f3a9c", { lockDir: dir, waitMs: 0 });
  next.release();
});

test("the wait is bounded below the CLI's enrollment deadline, so a waiter still has time to finish", () => {
  expect(ALIAS_LOCK_WAIT_MS).toBeLessThan(ENROLLMENT_DEADLINE_MS);
  expect(ALIAS_LOCK_WAIT_MS).toBeLessThanOrEqual(ENROLLMENT_DEADLINE_MS / 3);
});

test("a lock directory inside the real OpenCodex home is refused under test before anything is created", async () => {
  // Written after the guard was added: before it, this call would have created directories in the live home.
  const lockDir = join(protectedHomeForTests(), "link", "locks");
  const existed = existsSync(lockDir);
  const error = await acquireAliasLock("pen-guard", { lockDir, waitMs: 0 }).catch(e => e);
  expect((error as AliasLockError).code).toBe("link_alias_lock_failed");
  expect(existsSync(lockDir)).toBe(existed);
});

test("release is idempotent and a symlinked lock file is refused, never followed", async () => {
  const lock = await acquireAliasLock("pen-x", { lockDir: dir });
  lock.release(); lock.release();
  const target = join(dir, "elsewhere");
  writeFileSync(target, "");
  symlinkSync(target, aliasLockPath("pen-y", dir));
  const error = await acquireAliasLock("pen-y", { lockDir: dir, waitMs: 0 }).catch(e => e);
  expect((error as AliasLockError).code).toBe("link_alias_lock_failed");
});
