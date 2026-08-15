import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLabDirs, labCommunityDir } from "../src/lab/paths";
import { listCommunityEvidence } from "../src/lab/public/community";
import {
  publicEvidenceMutationLockIsReclaimableForTests,
  publicEvidenceTryReclaimMutationLockForTests,
} from "../src/lab/public/mutation-lock";
import { PublicEvidenceValidationError } from "../src/lab/public/validate";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

describe("community mutation lock", () => {
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

  test("fails fast when a live owner holds the mutation lock", () => {
    const config = configDir();
    const lockPath = createLiveOwnerLock(config);
    const startedAt = performance.now();
    let failure: unknown;

    try {
      listCommunityEvidence(config);
    } catch (error) {
      failure = error;
    }

    const elapsedMs = performance.now() - startedAt;
    expect(failure).toBeInstanceOf(PublicEvidenceValidationError);
    expect((failure as PublicEvidenceValidationError).code).toBe("community_cache_busy");
    expect(elapsedMs).toBeLessThan(500);
    expect(existsSync(lockPath)).toBe(true);
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
