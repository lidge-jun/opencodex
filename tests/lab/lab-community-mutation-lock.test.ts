import { samePath } from "../helpers/same-path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLabDirs, labCommunityDir } from "../../src/lab/paths";
import { listCommunityEvidence } from "../../src/lab/public/community";
import {
  publicEvidenceMutationLockIsReclaimableForTests,
  publicEvidenceTryReclaimMutationLockForTests,
  withPublicEvidenceMutationLock,
} from "../../src/lab/public/mutation-lock";
import { PublicEvidenceValidationError } from "../../src/lab/public/validate";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function configDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-community-lock-"));
  roots.push(root);
  ensureLabDirs(root);
  return root;
}

function createLiveOwnerLock(config: string): string {
  const lockPath = join(labCommunityDir(config), ".mutation-lock");
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(
    join(lockPath, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      token: "00000000-0000-4000-8000-000000000000",
      createdAt: Date.now(),
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return lockPath;
}

const SUCCESSOR_TOKEN = "11111111-1111-4111-8111-111111111111";

/** Put a different live owner's lock directory at the canonical path and return its identity. */
function installSuccessorLock(lockPath: string): { dev: bigint; ino: bigint } {
  fs.rmSync(lockPath, { recursive: true, force: true });
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(join(lockPath, "owner.json"),
    JSON.stringify({ pid: process.pid, token: SUCCESSOR_TOKEN, createdAt: Date.now() }),
    { encoding: "utf8", mode: 0o600 });
  const stat = lstatSync(lockPath, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

function expectSuccessorIntact(lockPath: string, identity: { dev: bigint; ino: bigint }): void {
  const stat = lstatSync(lockPath, { bigint: true });
  expect([stat.dev, stat.ino]).toEqual([identity.dev, identity.ino]);
  expect(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).token).toBe(SUCCESSOR_TOKEN);
}

/**
 * Replace the canonical lock with a successor's directory immediately before the first rename
 * that `matches`: the state a paused process finds after its checks when another process
 * replaced the lock in between. `afterMove` runs right after that rename.
 */
function replaceLockBeforeRename(
  lockPath: string,
  matches: (from: string, to: string) => boolean,
  afterMove?: () => void,
) {
  const realRename = fs.renameSync;
  const state: { successor: { dev: bigint; ino: bigint } | null } = { successor: null };
  const spy = spyOn(fs, "renameSync").mockImplementation(((from, to) => {
    if (!state.successor && matches(String(from), String(to))) {
      state.successor = installSuccessorLock(lockPath);
      realRename(from, to);
      afterMove?.();
      return;
    }
    return realRename(from, to);
  }) as typeof fs.renameSync);
  return { spy, state };
}

/**
 * Replace the canonical lock with a successor's directory immediately before the first step
 * that moves or removes the lock or its owner record, whichever protocol takes it.
 */
function replaceLockBeforeFirstMutation(lockPath: string) {
  const realRename = fs.renameSync, realRmdir = fs.rmdirSync;
  const state: { successor: { dev: bigint; ino: bigint } | null } = { successor: null };
  const before = (path: fs.PathLike) => {
    if (!state.successor && (samePath(path, lockPath) || samePath(path, join(lockPath, "owner.json")))) {
      state.successor = installSuccessorLock(lockPath);
    }
  };
  const rename = spyOn(fs, "renameSync").mockImplementation(((from, to) => {
    before(from); return realRename(from, to);
  }) as typeof fs.renameSync);
  const rmdir = spyOn(fs, "rmdirSync").mockImplementation(((path, options) => {
    before(path); return realRmdir(path, options);
  }) as typeof fs.rmdirSync);
  return { spy: { mockRestore: () => { rename.mockRestore(); rmdir.mockRestore(); } }, state };
}

function detachedLockNames(config: string): string[] {
  return fs.readdirSync(labCommunityDir(config)).filter(name => name.startsWith(".mutation-lock-"));
}

function lockEntries(lockPath: string): string[] {
  return fs.readdirSync(lockPath).sort();
}

describe("community mutation lock", () => {
  test("release leaves a successor lock that replaced the checked directory in place", () => {
    const config = configDir();
    const lockPath = join(labCommunityDir(config), ".mutation-lock");
    const { spy, state } = replaceLockBeforeFirstMutation(lockPath);
    try {
      withPublicEvidenceMutationLock(config, () => {});
    } finally { spy.mockRestore(); }
    expect(state.successor).not.toBeNull();
    expectSuccessorIntact(lockPath, state.successor!);
    expect(lockEntries(lockPath)).toEqual(["owner.json"]);
    expect(detachedLockNames(config)).toEqual([]);
  });

  test("stale reclaim leaves a successor lock that replaced the claimed directory in place", () => {
    const config = configDir();
    const lockPath = join(labCommunityDir(config), ".mutation-lock");
    mkdirSync(lockPath, { mode: 0o700 });
    const stale = new Date(Date.now() - (25 * 60 * 60 * 1000));
    utimesSync(lockPath, stale, stale);
    const { spy, state } = replaceLockBeforeRename(lockPath, (from, to) =>
      samePath(from, lockPath) && /\.mutation-lock-stale-/.test(to));
    let reclaimed: boolean;
    try {
      reclaimed = publicEvidenceTryReclaimMutationLockForTests(config);
    } finally { spy.mockRestore(); }
    expect(reclaimed).toBe(false);
    expectSuccessorIntact(lockPath, state.successor!);
    expect(lockEntries(lockPath)).toEqual(["owner.json"]);
    expect(detachedLockNames(config)).toEqual([]);
  });

  test("discarding a failed acquisition leaves a successor lock that replaced it in place", () => {
    const config = configDir();
    const lockPath = join(labCommunityDir(config), ".mutation-lock");
    const realWrite = fs.writeFileSync;
    const write = spyOn(fs, "writeFileSync").mockImplementation(((path, data, options) => {
      if (/\.owner-[0-9a-f-]{36}\.tmp$/.test(String(path))) throw new Error("injected owner publication failure");
      return realWrite(path, data, options);
    }) as typeof fs.writeFileSync);
    const { spy, state } = replaceLockBeforeFirstMutation(lockPath);
    try {
      expect(() => withPublicEvidenceMutationLock(config, () => {})).toThrow("injected owner publication failure");
    } finally { spy.mockRestore(); write.mockRestore(); }
    expectSuccessorIntact(lockPath, state.successor!);
    expect(detachedLockNames(config)).toEqual([]);
  });

  test("a moved lock with a live owner survives a later acquisition's detached cleanup", () => {
    const config = configDir();
    const lockPath = join(labCommunityDir(config), ".mutation-lock");
    mkdirSync(lockPath, { mode: 0o700 });
    const stale = new Date(Date.now() - (25 * 60 * 60 * 1000));
    utimesSync(lockPath, stale, stale);
    // The successor is moved, then the canonical name is taken before it can be put back.
    const { spy, state } = replaceLockBeforeRename(lockPath, (from, to) =>
      samePath(from, lockPath) && /\.mutation-lock-stale-/.test(to), () => mkdirSync(lockPath, { mode: 0o700 }));
    try {
      expect(publicEvidenceTryReclaimMutationLockForTests(config)).toBe(false);
    } finally { spy.mockRestore(); }
    const detached = detachedLockNames(config);
    expect(detached).toHaveLength(1);
    fs.rmdirSync(lockPath);
    let ran = false;
    withPublicEvidenceMutationLock(config, () => { ran = true; });
    expect(ran).toBe(true);
    expect(detachedLockNames(config)).toEqual(detached);
    expectSuccessorIntact(join(labCommunityDir(config), detached[0]!), state.successor!);
  });

  test("release keeps a lock directory that holds another process's reclaim claim", () => {
    const config = configDir();
    const lockPath = join(labCommunityDir(config), ".mutation-lock");
    withPublicEvidenceMutationLock(config, () => {
      writeFileSync(join(lockPath, ".reclaim.json"),
        JSON.stringify({ pid: process.pid, token: SUCCESSOR_TOKEN, createdAt: Date.now() }),
        { encoding: "utf8", mode: 0o600 });
    });
    expect(lockEntries(lockPath)).toEqual([".reclaim.json"]);
    expect(detachedLockNames(config)).toEqual([]);
  });

  test("an acquisition whose fresh directory is removed before its owner write retries", () => {
    const config = configDir();
    const lockPath = join(labCommunityDir(config), ".mutation-lock");
    const realWrite = fs.writeFileSync;
    let removed = 0;
    const write = spyOn(fs, "writeFileSync").mockImplementation(((path, data, options) => {
      if (removed === 0 && /\.owner-[0-9a-f-]{36}\.tmp$/.test(String(path))) {
        removed += 1;
        fs.rmdirSync(lockPath);
      }
      return realWrite(path, data, options);
    }) as typeof fs.writeFileSync);
    let ran = false;
    try {
      withPublicEvidenceMutationLock(config, () => { ran = existsSync(join(lockPath, "owner.json")); });
    } finally { write.mockRestore(); }
    expect(removed).toBe(1);
    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("release removes its own lock directory and leaves no detached copy", () => {
    const config = configDir();
    const lockPath = join(labCommunityDir(config), ".mutation-lock");
    let held = false;
    withPublicEvidenceMutationLock(config, () => { held = existsSync(join(lockPath, "owner.json")); });
    expect(held).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(detachedLockNames(config)).toEqual([]);
  });

  test("does not publish into a lock replaced with an adjacent NTFS-sized identity", () => {
    const config = configDir();
    const lockPath = join(labCommunityDir(config), ".mutation-lock");
    const original = fs.lstatSync;
    let observations = 0;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((path, options) => {
      const stats = options?.bigint ? original(path, { bigint: true }) : original(path);
      if (!samePath(path, lockPath)) return stats;
      const ino = 9_007_199_254_740_992n + BigInt(Math.min(observations++, 1));
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats,
        { ino: options?.bigint ? ino : Number(ino) });
    }) as typeof fs.lstatSync);
    try {
      expect(() => withPublicEvidenceMutationLock(config, () => {})).toThrow(PublicEvidenceValidationError);
    } finally { spy.mockRestore(); }
  });
  test("recovers an ancient incomplete lock before reading committed cache state", () => {
    const config = configDir();
    const lockPath = join(labCommunityDir(config), ".mutation-lock");
    mkdirSync(lockPath, { mode: 0o700 });
    const stale = new Date(Date.now() - (25 * 60 * 60 * 1000));
    utimesSync(lockPath, stale, stale);

    expect(listCommunityEvidence(config)).toEqual([]);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("does not reclaim an old lock while its recorded owner process is alive", () => {
    const config = configDir();
    const lockPath = join(labCommunityDir(config), ".mutation-lock");
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        token: "00000000-0000-4000-8000-000000000000",
        createdAt: Date.now() - (25 * 60 * 60 * 1000),
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    expect(publicEvidenceMutationLockIsReclaimableForTests(config)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("rejects a live owner after one check without running protected work or changing ownership", () => {
    const config = configDir();
    const lockPath = createLiveOwnerLock(config);
    const lockBefore = lstatSync(lockPath);
    const ownerBefore = readFileSync(join(lockPath, "owner.json"));
    let ranProtectedWork = false;
    let failure: unknown;

    // Observe the real signal-zero owner check. A retry loop must not poll a
    // live owner before eventually returning the same refusal.
    const ownerCheck = spyOn(process, "kill");
    try {
      try {
        withPublicEvidenceMutationLock(config, () => { ranProtectedWork = true; });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(PublicEvidenceValidationError);
      expect((failure as PublicEvidenceValidationError).code).toBe("community_cache_busy");
      expect(ranProtectedWork).toBe(false);
      expect(readFileSync(join(lockPath, "owner.json"))).toEqual(ownerBefore);
      const lockAfter = lstatSync(lockPath);
      expect([lockAfter.dev, lockAfter.ino]).toEqual([lockBefore.dev, lockBefore.ino]);
      expect(ownerCheck).toHaveBeenCalledTimes(1);
      expect(ownerCheck).toHaveBeenCalledWith(process.pid, 0);
    } finally {
      ownerCheck.mockRestore();
    }
  });

  test("a competing reclaim claim prevents a second stale reclaimer from deleting the lock", () => {
    const config = configDir();
    const lockPath = join(labCommunityDir(config), ".mutation-lock");
    mkdirSync(lockPath, { mode: 0o700 });
    const stale = new Date(Date.now() - (25 * 60 * 60 * 1000));
    utimesSync(lockPath, stale, stale);
    writeFileSync(
      join(lockPath, ".reclaim.json"),
      JSON.stringify({ token: "00000000-0000-4000-8000-000000000000" }),
      { encoding: "utf8", mode: 0o600 },
    );

    expect(publicEvidenceTryReclaimMutationLockForTests(config)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("cleans detached lock quarantine before scanning community quota state", () => {
    const config = configDir();
    const quarantinePath = join(
      labCommunityDir(config),
      ".mutation-lock-release-123-00000000-0000-4000-8000-000000000000",
    );
    mkdirSync(quarantinePath, { mode: 0o700 });
    writeFileSync(join(quarantinePath, "owner.json"), "stale", { mode: 0o600 });

    expect(listCommunityEvidence(config)).toEqual([]);
    expect(existsSync(quarantinePath)).toBe(false);
  });

  test("fails closed when the lock path is not a directory", () => {
    const config = configDir();
    writeFileSync(join(labCommunityDir(config), ".mutation-lock"), "unsafe", "utf8");

    expect(() => listCommunityEvidence(config)).toThrow(/mutation lock is not a directory/i);
  });
});
