import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLabDirs, labCommunityDir, labRoot } from "../../src/lab/paths";
import { listCommunityEvidence } from "../../src/lab/public/community";
import {
  publicEvidenceLegacyMutationLockBlocksForTests,
  withPublicEvidenceMutationLock,
} from "../../src/lab/public/mutation-lock";
import { PublicEvidenceValidationError } from "../../src/lab/public/validate";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

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

function legacyLockPath(config: string): string {
  return join(labCommunityDir(config), ".mutation-lock");
}

function createLegacyOwnerLock(config: string, createdAt = Date.now(), pid = process.pid): string {
  const lockPath = legacyLockPath(config);
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(
    join(lockPath, "owner.json"),
    JSON.stringify({ pid, token: "00000000-0000-4000-8000-000000000000", createdAt }),
    { encoding: "utf8", mode: 0o600 },
  );
  return lockPath;
}

function busyFailure(run: () => unknown): PublicEvidenceValidationError {
  let failure: unknown;
  try { run(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PublicEvidenceValidationError);
  expect((failure as PublicEvidenceValidationError).code).toBe("community_cache_busy");
  return failure as PublicEvidenceValidationError;
}

describe("community mutation lock", () => {
  test("acquire and release never rename or remove the canonical lock path or its contents", () => {
    const config = configDir();
    const lockPath = legacyLockPath(config);
    const touched: string[] = [];
    const watch = (name: string, path: fs.PathLike) => {
      const text = String(path);
      if (text === lockPath || text.startsWith(lockPath + "\\") || text.startsWith(lockPath + "/")) touched.push(`${name} ${text}`);
    };
    const realRename = fs.renameSync, realRm = fs.rmSync, realRmdir = fs.rmdirSync, realUnlink = fs.unlinkSync;
    const spies = [
      spyOn(fs, "renameSync").mockImplementation(((from, to) => { watch("rename", from); return realRename(from, to); }) as typeof fs.renameSync),
      spyOn(fs, "rmSync").mockImplementation(((path, options) => { watch("rm", path); return realRm(path, options); }) as typeof fs.rmSync),
      spyOn(fs, "rmdirSync").mockImplementation(((path, options) => { watch("rmdir", path); return realRmdir(path, options); }) as typeof fs.rmdirSync),
      spyOn(fs, "unlinkSync").mockImplementation(((path) => { watch("unlink", path); return realUnlink(path); }) as typeof fs.unlinkSync),
    ];
    let ran = false;
    try {
      withPublicEvidenceMutationLock(config, () => { ran = true; });
      // An older build's ancient lock no longer blocks, and it is still never moved or removed.
      mkdirSync(lockPath, { mode: 0o700 });
      const stale = new Date(Date.now() - (25 * 60 * 60 * 1000));
      utimesSync(lockPath, stale, stale);
      withPublicEvidenceMutationLock(config, () => {});
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(ran).toBe(true);
    expect(touched).toEqual([]);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("a second holder in the same process is refused without running its work", () => {
    const config = configDir();
    let inner = false, outer = false;
    withPublicEvidenceMutationLock(config, () => {
      busyFailure(() => withPublicEvidenceMutationLock(config, () => { inner = true; }));
      outer = true;
    });
    expect(outer).toBe(true);
    expect(inner).toBe(false);
    let after = false;
    withPublicEvidenceMutationLock(config, () => { after = true; });
    expect(after).toBe(true);
  });

  test("a holder that throws releases the lock", () => {
    const config = configDir();
    expect(() => withPublicEvidenceMutationLock(config, () => { throw new Error("protected work failed"); }))
      .toThrow("protected work failed");
    let ran = false;
    withPublicEvidenceMutationLock(config, () => { ran = true; });
    expect(ran).toBe(true);
  });

  test("another process holding the lock is refused, and its crash releases the lock", async () => {
    const config = configDir();
    const child = Bun.spawn([process.execPath, "-e", [
      `const { writeSync } = require("node:fs");`,
      `const { withPublicEvidenceMutationLock } = require(${JSON.stringify(repoPath("src/lab/public/mutation-lock.ts"))});`,
      `withPublicEvidenceMutationLock(${JSON.stringify(config)}, () => {`,
      `  writeSync(1, "held\\n");`,
      `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SPAWN_BUDGET_MS});`,
      `});`,
    ].join("\n")], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      let seen = "";
      while (!seen.includes("held\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`lock holder exited early: ${await new Response(child.stderr).text()}`);
        seen += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      let ran = false;
      busyFailure(() => withPublicEvidenceMutationLock(config, () => { ran = true; }));
      expect(ran).toBe(false);
      child.kill("SIGKILL");
      await child.exited;
      withPublicEvidenceMutationLock(config, () => { ran = true; });
      expect(ran).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, SPAWN_BUDGET_MS);

  test("the lock database lives outside the community cache and is never followed when unsafe", () => {
    const config = configDir();
    withPublicEvidenceMutationLock(config, () => {});
    const lockDb = join(labRoot(config), "public-evidence-mutation.sqlite");
    expect(lstatSync(lockDb).isFile()).toBe(true);
    expect(listCommunityEvidence(config)).toEqual([]);

    const linked = configDir();
    const target = join(linked, "elsewhere.sqlite");
    writeFileSync(target, "");
    linkSync(target, join(labRoot(linked), "public-evidence-mutation.sqlite"));
    expect(() => withPublicEvidenceMutationLock(linked, () => {})).toThrow(/mutation lock is unsafe/);

    const directory = configDir();
    mkdirSync(join(labRoot(directory), "public-evidence-mutation.sqlite"));
    let ran = false;
    expect(() => withPublicEvidenceMutationLock(directory, () => { ran = true; })).toThrow(/mutation lock is unsafe/);
    expect(ran).toBe(false);
  });

  test("an older build's live directory lock is honoured once and left untouched", () => {
    const config = configDir();
    const lockPath = createLegacyOwnerLock(config);
    const lockBefore = lstatSync(lockPath, { bigint: true });
    const ownerBefore = readFileSync(join(lockPath, "owner.json"));
    let ranProtectedWork = false;

    // Observe the real signal-zero owner check: exactly one, with no retry loop.
    const ownerCheck = spyOn(process, "kill");
    try {
      busyFailure(() => withPublicEvidenceMutationLock(config, () => { ranProtectedWork = true; }));
      expect(ownerCheck).toHaveBeenCalledTimes(1);
      expect(ownerCheck).toHaveBeenCalledWith(process.pid, 0);
    } finally {
      ownerCheck.mockRestore();
    }
    expect(ranProtectedWork).toBe(false);
    expect(readFileSync(join(lockPath, "owner.json"))).toEqual(ownerBefore);
    const lockAfter = lstatSync(lockPath, { bigint: true });
    expect([lockAfter.dev, lockAfter.ino]).toEqual([lockBefore.dev, lockBefore.ino]);
  });

  test("an older build's recent ownerless directory blocks, and an ancient one does not", () => {
    const config = configDir();
    const lockPath = legacyLockPath(config);
    mkdirSync(lockPath, { mode: 0o700 });
    expect(publicEvidenceLegacyMutationLockBlocksForTests(config)).toBe(true);

    const stale = new Date(Date.now() - (25 * 60 * 60 * 1000));
    utimesSync(lockPath, stale, stale);
    expect(publicEvidenceLegacyMutationLockBlocksForTests(config)).toBe(false);
    expect(listCommunityEvidence(config)).toEqual([]);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("an older build's lock with a live owner blocks even when old enough for the ownerless rule", () => {
    const config = configDir();
    createLegacyOwnerLock(config, Date.now() - (25 * 60 * 60 * 1000));
    expect(publicEvidenceLegacyMutationLockBlocksForTests(config)).toBe(true);
  });

  test("a lock file replaced between inspection and locking is refused before protected work", () => {
    const config = configDir();
    const lockDb = join(labRoot(config), "public-evidence-mutation.sqlite");
    const original = fs.lstatSync;
    let observations = 0;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((path, options) => {
      const stats = options?.bigint ? original(path, { bigint: true }) : original(path);
      if (String(path) !== lockDb) return stats;
      // Adjacent NTFS-sized identities: equal as numbers, distinct as bigints.
      const ino = 9_007_199_254_740_992n + BigInt(Math.min(observations++, 1));
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino: options?.bigint ? ino : Number(ino) });
    }) as typeof fs.lstatSync);
    let ran = false;
    try {
      expect(() => withPublicEvidenceMutationLock(config, () => { ran = true; })).toThrow(/changed while opening/);
    } finally { spy.mockRestore(); }
    expect(observations).toBe(2);
    expect(ran).toBe(false);
    let after = false;
    withPublicEvidenceMutationLock(config, () => { after = true; });
    expect(after).toBe(true);
  });

  test.skipIf(process.platform === "win32")("the lock file is created private to the user", () => {
    const config = configDir();
    withPublicEvidenceMutationLock(config, () => {});
    expect(lstatSync(join(labRoot(config), "public-evidence-mutation.sqlite")).mode & 0o777).toBe(0o600);
  });

  test("detached cleanup keeps an older build's moved lock whose owner is alive", () => {
    const config = configDir();
    const live = join(labCommunityDir(config), ".mutation-lock-release-123-11111111-1111-4111-8111-111111111111");
    mkdirSync(live, { mode: 0o700 });
    writeFileSync(join(live, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "11111111-1111-4111-8111-111111111111", createdAt: Date.now() }),
      { encoding: "utf8", mode: 0o600 });
    withPublicEvidenceMutationLock(config, () => {});
    expect(existsSync(join(live, "owner.json"))).toBe(true);
    // A kept lock directory is lock bookkeeping, not a cache object: scans skip it.
    expect(listCommunityEvidence(config)).toEqual([]);
    expect(existsSync(join(live, "owner.json"))).toBe(true);
  });

  test("cleans an older build's detached lock quarantine before scanning community quota state", () => {
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

  test("fails closed when the older build's lock path is not a directory", () => {
    const config = configDir();
    writeFileSync(legacyLockPath(config), "unsafe", "utf8");

    expect(() => listCommunityEvidence(config)).toThrow(/mutation lock is not a directory/i);
  });
});
