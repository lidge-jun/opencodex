import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlibabaBackupIntegrityError,
  backupConfigBeforeAlibabaRegionMigration,
} from "../src/providers/alibaba-region-backup";

test("absent source produces no backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-bak-"));
  try {
    expect(backupConfigBeforeAlibabaRegionMigration(join(dir, "config.json"))).toBe("absent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("creates a snapshot, then never replaces it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-bak-"));
  const configPath = join(dir, "config.json");
  const backupPath = `${configPath}.pre-alibaba-region-v1.bak`;
  try {
    writeFileSync(configPath, '{"before":true}', "utf8");
    expect(backupConfigBeforeAlibabaRegionMigration(configPath)).toBe("created");
    expect(readFileSync(backupPath, "utf8")).toBe('{"before":true}');
    expect(backupConfigBeforeAlibabaRegionMigration(configPath)).toBe("reused");
    expect(readFileSync(backupPath, "utf8")).toBe('{"before":true}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an existing snapshot is kept even after the config legitimately changes", () => {
  // The false positive an equality rule would have created: a snapshot from an
  // earlier aborted run plus ordinary later edits must not stop the proxy.
  const dir = mkdtempSync(join(tmpdir(), "ocx-bak-"));
  const configPath = join(dir, "config.json");
  const backupPath = `${configPath}.pre-alibaba-region-v1.bak`;
  try {
    writeFileSync(configPath, '{"before":true}', "utf8");
    expect(backupConfigBeforeAlibabaRegionMigration(configPath)).toBe("created");
    writeFileSync(configPath, '{"edited-by-the-user":true}', "utf8");
    expect(backupConfigBeforeAlibabaRegionMigration(configPath)).toBe("reused");
    // The earliest snapshot survives: it predates every migration.
    expect(readFileSync(backupPath, "utf8")).toBe('{"before":true}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a short copy is never published", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-bak-"));
  const configPath = join(dir, "config.json");
  try {
    writeFileSync(configPath, '{"before":true}', "utf8");
    expect(() => backupConfigBeforeAlibabaRegionMigration(configPath, {
      exists: existsSync,
      read: path => readFileSync(path),
      copy: (_source, destination) => { writeFileSync(destination, '{"bef', "utf8"); },
      publishNoReplace: linkSync,
      remove: path => rmSync(path, { force: true }),
    })).toThrow(AlibabaBackupIntegrityError);
    expect(existsSync(`${configPath}.pre-alibaba-region-v1.bak`)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed copy leaves no snapshot and no temp file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-bak-"));
  const configPath = join(dir, "config.json");
  try {
    writeFileSync(configPath, '{"before":true}', "utf8");
    const removed: string[] = [];
    expect(() => backupConfigBeforeAlibabaRegionMigration(configPath, {
      exists: existsSync,
      read: path => readFileSync(path),
      copy: () => { throw new Error("disk full"); },
      publishNoReplace: linkSync,
      remove: path => { removed.push(path); rmSync(path, { force: true }); },
    })).toThrow("disk full");
    expect(existsSync(`${configPath}.pre-alibaba-region-v1.bak`)).toBe(false);
    expect(removed).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
