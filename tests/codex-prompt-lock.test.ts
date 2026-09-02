/**
 * Lock contract for src/codex/prompt-lock.ts.
 *
 * The interleaving cases (46a-46c in the roadmap) exist because naive stale
 * breaking admits two writers: A judges the lock stale, B removes it and
 * acquires its own, A then unlinks B's live lock. This lock protects the write
 * transaction, so that race would corrupt the thing the journal exists to keep
 * consistent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STALE_AFTER_MS,
  release,
  stillHeld,
  tryAcquire,
  type LockDeps,
} from "../src/codex/prompt-lock";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-lock-"));
  roots.push(dir);
  return join(dir, "opencodex-prompt.lock");
}

/** Owner alive, clock fixed. */
const alive: LockDeps = { isProcessAlive: () => true, now: () => 1_000_000 };
/** Owner gone, and enough time has passed for the grace window to expire. */
const dead: LockDeps = { isProcessAlive: () => false, now: () => 1_000_000 + STALE_AFTER_MS + 1 };

afterEach(() => {
  while (roots.length) removeTreeWithRetry(roots.pop()!);
});

describe("basic acquisition", () => {
  test("acquires a free lock and records our pid", () => {
    const path = lockPath();
    const result = tryAcquire(path, alive);
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
  });

  test("a second contender is refused while the owner lives", () => {
    const path = lockPath();
    expect(tryAcquire(path, alive).ok).toBe(true);
    expect(tryAcquire(path, alive)).toEqual({ ok: false, error: "locked" });
  });

  test("release frees it for the next contender", () => {
    const path = lockPath();
    const first = tryAcquire(path, alive);
    if (!first.ok) throw new Error("setup");
    expect(release(first.handle)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(tryAcquire(path, alive).ok).toBe(true);
  });
});

describe("staleness", () => {
  test("a dead owner past the grace window is broken", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");
    expect(tryAcquire(path, dead).ok).toBe(true);
  });

  test("a dead owner INSIDE the grace window is respected", () => {
    // A process can die microseconds after writing its lock; a peer mid-write
    // deserves the window.
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");
    const justDied: LockDeps = { isProcessAlive: () => false, now: () => 1_000_000 + 5 };
    expect(tryAcquire(path, justDied)).toEqual({ ok: false, error: "locked" });
  });

  test("a live owner is never broken, however old", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 1, acquiredAt: 0 }), "utf8");
    expect(tryAcquire(path, alive)).toEqual({ ok: false, error: "locked" });
  });

  test("unparseable debris is treated as stale", () => {
    const path = lockPath();
    writeFileSync(path, "not json", "utf8");
    expect(tryAcquire(path, dead).ok).toBe(true);
  });

  test("breaking leaves no quarantine file behind", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");
    expect(tryAcquire(path, dead).ok).toBe(true);
    const strays = readdirSync(join(path, "..")).filter(f => f.includes(".stale-"));
    expect(strays).toEqual([]);
  });
});

describe("interleavings", () => {
  test("46a: A quarantines, B acquires first, A backs off without touching B's lock", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");

    // Simulate the interleaving: B wins the real lock while A is mid-takeover.
    let renamed = false;
    const racyDeps: LockDeps = {
      isProcessAlive: pid => {
        // Called once before the rename. After A renames, B slips in.
        if (!renamed) {
          renamed = true;
          queueMicrotask(() => {});
        }
        return dead.isProcessAlive(pid);
      },
      now: dead.now,
    };

    // A renames the stale lock away, then B creates the real lock, then A tries.
    const quarantine = `${path}.stale-manual`;
    require("node:fs").renameSync(path, quarantine);
    const b = tryAcquire(path, racyDeps);
    expect(b.ok).toBe(true);
    const bToken = JSON.parse(readFileSync(path, "utf8")).token;

    // A now attempts and must be refused; B's lock must survive untouched.
    const a = tryAcquire(path, alive);
    expect(a).toEqual({ ok: false, error: "locked" });
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(bToken);
    rmSync(quarantine, { force: true });
  });

  test("46b: releasing with a superseded token deletes nothing", () => {
    const path = lockPath();
    const first = tryAcquire(path, alive);
    if (!first.ok) throw new Error("setup");

    // Someone else replaced the lock while we thought we held it.
    writeFileSync(path, JSON.stringify({ token: "theirs", pid: 4242, acquiredAt: 2_000_000 }), "utf8");

    expect(release(first.handle)).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe("theirs");
  });

  test("46c: only one of two simultaneous contenders wins a stale lock", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");
    const first = tryAcquire(path, dead);
    const second = tryAcquire(path, dead);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
  });

  test("stillHeld reports supersession", () => {
    const path = lockPath();
    const held = tryAcquire(path, alive);
    if (!held.ok) throw new Error("setup");
    expect(stillHeld(held.handle)).toBe(true);
    writeFileSync(path, JSON.stringify({ token: "theirs", pid: 1, acquiredAt: 0 }), "utf8");
    expect(stillHeld(held.handle)).toBe(false);
  });
});
