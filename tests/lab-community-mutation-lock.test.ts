import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLabDirs, labCommunityDir } from "../src/lab/paths";
import { listCommunityEvidence } from "../src/lab/public/community";

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

describe("community mutation lock", () => {
  test("recovers a stale lock before reading committed cache state", () => {
    const config = configDir();
    const lockPath = join(labCommunityDir(config), ".mutation-lock");
    mkdirSync(lockPath, { mode: 0o700 });
    const stale = new Date(Date.now() - 120_000);
    utimesSync(lockPath, stale, stale);

    expect(listCommunityEvidence(config)).toEqual([]);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("fails closed when the lock path is not a directory", () => {
    const config = configDir();
    writeFileSync(join(labCommunityDir(config), ".mutation-lock"), "unsafe", "utf8");

    expect(() => listCommunityEvidence(config)).toThrow(/mutation lock is not a directory/i);
  });
});
