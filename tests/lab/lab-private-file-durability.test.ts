import { samePath } from "../helpers/same-path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupStalePrivateFileStages,
  isPrivateFileStageName,
  PRIVATE_FILE_STAGE_RETENTION_MS,
  publishPrivateFileExclusive,
  setPrivateFileCleanupSyncFaultForTests,
  setPrivateFileCommitFaultForTests,
} from "../../src/lab/public/private-file";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  setPrivateFileCommitFaultForTests(null);
  setPrivateFileCleanupSyncFaultForTests(false);
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-cl10-private-file-"));
  roots.push(root);
  return root;
}

describe("CL-10 private-file durability", () => {
  test("published-stage cleanup preserves an adjacent NTFS-sized replacement", () => {
    const root = tempRoot(), finalPath = join(root, "bundle.json");
    const stagePath = join(root, `.bundle.json.${process.pid}.00000000-0000-4000-8000-000000000000.tmp`);
    fs.writeFileSync(finalPath, "final");
    fs.writeFileSync(stagePath, "replacement");
    const original = fs.lstatSync;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((path, options) => {
      const stats = options?.bigint ? original(path, { bigint: true }) : original(path);
      if (!samePath(path, finalPath) && !samePath(path, stagePath)) return stats;
      const ino = 9_007_199_254_740_992n + (samePath(path, stagePath) ? 1n : 0n);
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats,
        { ino: options?.bigint ? ino : Number(ino) });
    }) as typeof fs.lstatSync);
    try {
      expect(publishPrivateFileExclusive(finalPath, Buffer.from("candidate"))).toEqual({ created: false });
      expect(existsSync(stagePath)).toBe(true);
    } finally { spy.mockRestore(); }
  });
  test("POSIX parent-directory sync failure preserves the published stage until retry", () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const finalPath = join(root, "bundle.json");
    const bytes = Buffer.from("durable-public-evidence", "utf8");

    setPrivateFileCommitFaultForTests("parent_directory_sync");
    expect(() => publishPrivateFileExclusive(finalPath, bytes)).toThrow(/directory.*sync|durab/i);
    expect(existsSync(finalPath)).toBe(true);
    expect(readdirSync(root).filter(isPrivateFileStageName)).toHaveLength(1);

    setPrivateFileCommitFaultForTests(null);
    expect(publishPrivateFileExclusive(finalPath, bytes)).toEqual({ created: false });
    expect(readFileSync(finalPath).equals(bytes)).toBe(true);
    expect(readdirSync(root).filter(isPrivateFileStageName)).toEqual([]);
  });

  test("before-publish failure leaves no final path or staging entry and retry creates cleanly", () => {
    const root = tempRoot();
    const finalPath = join(root, "bundle.json");
    const bytes = Buffer.from("durable-public-evidence", "utf8");

    setPrivateFileCommitFaultForTests("before_publish");
    expect(() => publishPrivateFileExclusive(finalPath, bytes)).toThrow(/before publish/i);
    expect(existsSync(finalPath)).toBe(false);
    expect(readdirSync(root).filter(isPrivateFileStageName)).toEqual([]);

    setPrivateFileCommitFaultForTests(null);
    expect(publishPrivateFileExclusive(finalPath, bytes)).toEqual({ created: true });
    expect(readFileSync(finalPath).equals(bytes)).toBe(true);
    expect(readdirSync(root).filter(isPrivateFileStageName)).toEqual([]);
  });

  test("expired published crash witnesses are reclaimed without requiring a retry", () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const finalPath = join(root, "bundle.json");
    const bytes = Buffer.from("durable-public-evidence", "utf8");

    setPrivateFileCommitFaultForTests("parent_directory_sync");
    expect(() => publishPrivateFileExclusive(finalPath, bytes)).toThrow(/directory.*sync|durab/i);
    setPrivateFileCommitFaultForTests(null);

    const stages = readdirSync(root).filter(isPrivateFileStageName);
    expect(stages).toHaveLength(1);
    const stagePath = join(root, stages[0]!);
    const old = new Date(Date.now() - PRIVATE_FILE_STAGE_RETENTION_MS - 60_000);
    utimesSync(stagePath, old, old);

    cleanupStalePrivateFileStages(finalPath);

    expect(readFileSync(finalPath).equals(bytes)).toBe(true);
    expect(readdirSync(root).filter(isPrivateFileStageName)).toEqual([]);
  });

  test("stale cleanup keeps the crash witness when its pre-unlink directory sync fails", () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const finalPath = join(root, "bundle.json");
    const bytes = Buffer.from("durable-public-evidence", "utf8");

    setPrivateFileCommitFaultForTests("parent_directory_sync");
    expect(() => publishPrivateFileExclusive(finalPath, bytes)).toThrow(/directory.*sync|durab/i);
    setPrivateFileCommitFaultForTests(null);

    const stages = readdirSync(root).filter(isPrivateFileStageName);
    expect(stages).toHaveLength(1);
    const stagePath = join(root, stages[0]!);
    const old = new Date(Date.now() - PRIVATE_FILE_STAGE_RETENTION_MS - 60_000);
    utimesSync(stagePath, old, old);

    setPrivateFileCleanupSyncFaultForTests(true);
    expect(() => cleanupStalePrivateFileStages(finalPath)).toThrow(/cleanup.*directory.*sync/i);
    expect(readFileSync(finalPath).equals(bytes)).toBe(true);
    expect(readdirSync(root).filter(isPrivateFileStageName)).toHaveLength(1);

    setPrivateFileCleanupSyncFaultForTests(false);
    cleanupStalePrivateFileStages(finalPath);
    expect(readdirSync(root).filter(isPrivateFileStageName)).toEqual([]);
  });

  test("Windows publication does not require parent-directory fsync", () => {
    if (process.platform !== "win32") return;
    const root = tempRoot();
    const finalPath = join(root, "bundle.json");
    const bytes = Buffer.from("durable-public-evidence", "utf8");

    setPrivateFileCommitFaultForTests("parent_directory_sync");
    expect(publishPrivateFileExclusive(finalPath, bytes)).toEqual({ created: true });
    expect(readFileSync(finalPath).equals(bytes)).toBe(true);
    expect(readdirSync(root).filter(isPrivateFileStageName)).toEqual([]);
  });
});
