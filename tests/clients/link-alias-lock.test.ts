import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAliasLock, aliasLockPath, AliasLockError } from "../../src/link/alias-lock";
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

test("release is idempotent and a symlinked lock file is refused, never followed", async () => {
  const lock = await acquireAliasLock("pen-x", { lockDir: dir });
  lock.release(); lock.release();
  const target = join(dir, "elsewhere");
  writeFileSync(target, "");
  symlinkSync(target, aliasLockPath("pen-y", dir));
  const error = await acquireAliasLock("pen-y", { lockDir: dir, waitMs: 0 }).catch(e => e);
  expect((error as AliasLockError).code).toBe("link_alias_lock_failed");
});
