import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  portableRenameNoReplaceErrorCode,
  renameNoReplace,
  setRenameNoReplaceBackendForTests,
} from "../src/lib/rename-no-replace";

afterEach(() => setRenameNoReplaceBackendForTests(undefined));

describe("atomic no-replace rename", () => {
  test("normalizes platform-specific native errors", () => {
    expect(portableRenameNoReplaceErrorCode("win32", 183)).toBe("EEXIST");
    expect(portableRenameNoReplaceErrorCode("win32", 17)).toBe("EXDEV");
    expect(portableRenameNoReplaceErrorCode("win32", 206)).toBe("ENAMETOOLONG");
    expect(portableRenameNoReplaceErrorCode("linux", 17)).toBe("EEXIST");
    expect(portableRenameNoReplaceErrorCode("linux", 38)).toBe("ENOTSUP");
    expect(portableRenameNoReplaceErrorCode("darwin", 102)).toBe("ENOTSUP");
  });

  test("moves an absent destination and never overwrites an existing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-rename-no-replace-"));
    try {
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      writeFileSync(source, "source", "utf8");
      renameNoReplace(source, destination);
      expect(existsSync(source)).toBe(false);
      expect(readFileSync(destination, "utf8")).toBe("source");

      writeFileSync(source, "second source", "utf8");
      let thrown: unknown;
      try { renameNoReplace(source, destination); } catch (error) { thrown = error; }
      expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe("EEXIST");
      expect((thrown as NodeJS.ErrnoException | undefined)?.path).toBe(source);
      expect((thrown as NodeJS.ErrnoException & { dest?: string } | undefined)?.dest).toBe(destination);
      expect(readFileSync(source, "utf8")).toBe("second source");
      expect(readFileSync(destination, "utf8")).toBe("source");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("moves the symlink entry rather than its target", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-rename-no-replace-link-"));
    try {
      const target = join(dir, "target");
      const source = join(dir, "source-link");
      const destination = join(dir, "destination-link");
      writeFileSync(target, "target", "utf8");
      symlinkSync(target, source, "file");
      renameNoReplace(source, destination);
      expect(existsSync(source)).toBe(false);
      expect(lstatSync(destination).isSymbolicLink()).toBe(true);
      expect(readlinkSync(destination)).toBe(target);
      expect(readFileSync(target, "utf8")).toBe("target");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "win32")("moves absolute Windows paths longer than MAX_PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-rename-no-replace-long-"));
    try {
      let dir = root;
      while (dir.length < 280) dir = join(dir, "segment-0123456789abcdef");
      mkdirSync(dir, { recursive: true });
      const source = join(dir, "source");
      const destination = join(dir, "destination");
      expect(source.length).toBeGreaterThan(260);
      writeFileSync(source, "long path", "utf8");
      renameNoReplace(source, destination);
      expect(existsSync(source)).toBe(false);
      expect(readFileSync(destination, "utf8")).toBe("long path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects NUL paths with source and destination metadata", () => {
    let thrown: unknown;
    try { renameNoReplace("source\0suffix", "destination"); } catch (error) { thrown = error; }
    expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe("EINVAL");
    expect((thrown as NodeJS.ErrnoException | undefined)?.path).toBe("source\0suffix");
    expect((thrown as NodeJS.ErrnoException & { dest?: string } | undefined)?.dest).toBe("destination");
  });

  test("fails closed when the native backend is unavailable", () => {
    setRenameNoReplaceBackendForTests(null);
    let thrown: unknown;
    try { renameNoReplace("source", "destination"); } catch (error) { thrown = error; }
    expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe("ENOTSUP");
    expect((thrown as NodeJS.ErrnoException | undefined)?.path).toBe("source");
  });

  test("preserves native missing-source metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-rename-no-replace-missing-"));
    try {
      const source = join(dir, "missing");
      const destination = join(dir, "destination");
      let thrown: unknown;
      try { renameNoReplace(source, destination); } catch (error) { thrown = error; }
      expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
      expect((thrown as NodeJS.ErrnoException | undefined)?.path).toBe(source);
      expect((thrown as NodeJS.ErrnoException & { dest?: string } | undefined)?.dest).toBe(destination);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
