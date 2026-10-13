import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { readBoundedRegularFileSync } from "../../src/lib/bounded-file-read";

const repoRoot = repoPath();
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-bounded-read-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function afterOpenedStat(mutate: () => void, read: () => Buffer): Buffer {
  const original = fs.fstatSync;
  let changed = false;
  const stat = spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: fs.StatOptions) => {
    const opened = original(fd, options);
    if (!changed) { changed = true; mutate(); }
    return opened;
  }) as typeof fs.fstatSync);
  try { return read(); }
  finally { stat.mockRestore(); expect(changed).toBe(true); }
}

function canCreateFileSymlink(): boolean {
  if (process.platform !== "win32") return true;
  const directory = mkdtempSync(join(tmpdir(), "ocx-bounded-symlink-probe-"));
  try {
    const target = join(directory, "target.json");
    writeFileSync(target, "fixture");
    try { symlinkSync(target, join(directory, "link.json"), "file"); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return false;
      throw error;
    }
    return true;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("readBoundedRegularFileSync", () => {
  test("reads a bounded regular file", () => {
    const path = join(root, "config.json");
    writeFileSync(path, '{"ok":true}');
    expect(readBoundedRegularFileSync(path, 32).toString("utf8")).toBe(readFileSync(path, "utf8"));
  });

  test("small files do not allocate the configured limit", () => {
    const path = join(root, "tiny.json");
    writeFileSync(path, '{"ok":true}');
    const initialized = spyOn(Buffer, "alloc");
    const uninitialized = spyOn(Buffer, "allocUnsafe");
    try {
      const result = readBoundedRegularFileSync(path, 4 * 1024 * 1024);
      const sizes = [...initialized.mock.calls, ...uninitialized.mock.calls].map(([size]) => size);
      expect(result.toString("utf8")).toBe('{"ok":true}');
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
    } finally { initialized.mockRestore(); uninitialized.mockRestore(); }
  });

  test("reads an empty file without returning unwritten buffer bytes", () => {
    const path = join(root, "empty.json");
    writeFileSync(path, "");
    expect(readBoundedRegularFileSync(path, 32).length).toBe(0);
  });

  test("grows the buffer for data appended after the descriptor size check", () => {
    const path = join(root, "growing.json");
    writeFileSync(path, "tiny");
    const grown = Buffer.alloc(96 * 1024, 0x61);
    const result = afterOpenedStat(() => writeFileSync(path, grown), () => readBoundedRegularFileSync(path, 128 * 1024));
    expect(result.equals(grown)).toBe(true);
  });

  test("keeps the overflow probe when a file grows past the limit after fstat", () => {
    const path = join(root, "overflow.json");
    writeFileSync(path, "tiny");
    expect(() => afterOpenedStat(() => writeFileSync(path, "x".repeat(33)),
      () => readBoundedRegularFileSync(path, 32))).toThrow("file exceeds byte limit");
  });

  test("returns only bytes actually read if the file shrinks after fstat", () => {
    const path = join(root, "shrinking.json");
    writeFileSync(path, "a longer initial document");
    const result = afterOpenedStat(() => writeFileSync(path, "ok"), () => readBoundedRegularFileSync(path, 64));
    expect(result.toString("utf8")).toBe("ok");
    expect(result.length).toBe(2);
  });

  test("accepts a file exactly at the byte limit", () => {
    const path = join(root, "boundary.json");
    const content = Buffer.alloc(64 * 1024 + 3, 0x62);
    writeFileSync(path, content);
    expect(readBoundedRegularFileSync(path, content.length).equals(content)).toBe(true);
  });

  test("rejects oversized files", () => {
    const path = join(root, "large.json");
    writeFileSync(path, "x".repeat(33));
    expect(() => readBoundedRegularFileSync(path, 32)).toThrow();
  });

  test.skipIf(!canCreateFileSymlink())("rejects final symlinks", () => {
    const path = join(root, "target.json");
    writeFileSync(path, "fixture");
    const link = join(root, "linked.json");
    symlinkSync(path, link, "file");
    expect(() => readBoundedRegularFileSync(link, 64)).toThrow();
  });

  test.skipIf(process.platform === "win32")("rejects a FIFO without blocking", () => {
    const fifo = join(root, "input.pipe");
    const created = spawnSync("mkfifo", [fifo], { timeout: 2_000 });
    expect(created.status).toBe(0);
    const result = spawnSync(process.execPath, ["--eval", `
      const { readBoundedRegularFileSync } = require("./src/lib/bounded-file-read.ts");
      try { readBoundedRegularFileSync(process.env.BOUNDED_READ_FIFO, 1024); process.exitCode = 2; }
      catch { process.exitCode = 0; }
    `], {
      cwd: repoRoot,
      env: { ...process.env, BOUNDED_READ_FIFO: fifo },
      timeout: 2_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
