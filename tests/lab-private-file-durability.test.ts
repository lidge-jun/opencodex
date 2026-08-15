import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupStalePrivateFileStages,
  isPrivateFileStageName,
  PRIVATE_FILE_STAGE_RETENTION_MS,
  publishPrivateFileExclusive,
  setPrivateFileCleanupSyncFaultForTests,
  setPrivateFileCommitFaultForTests,
} from "../src/lab/public/private-file";

const roots: string[] = [];

afterEach(() => {
  setPrivateFileCommitFaultForTests(null);
  setPrivateFileCleanupSyncFaultForTests(false);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-cl10-private-file-"));
  roots.push(root);
  return root;
}

describe("CL-10 private-file durability", () => {
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
