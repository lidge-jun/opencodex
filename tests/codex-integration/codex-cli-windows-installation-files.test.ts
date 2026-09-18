import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectWindowsInstallationFiles,
  setWindowsInstallationFilesOpenedForTests,
} from "../../src/codex/windows-installation-files";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const nativeTest = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
let fixture = "";
beforeEach(() => { fixture = mkdtempSync(join(tmpdir(), "ocx-install-files-")); });
afterEach(() => {
  setWindowsInstallationFilesOpenedForTests();
  removeTreeWithRetry(fixture);
});

describe("explicit Windows installation file snapshot", () => {
  test.each([
    "relative\\package.json", "C:package.json", "\\\\host\\share\\package.json",
    "\\\\?\\C:\\package.json", "C:\\test\\..\\package.json", "C:\\test\\.\\package.json",
    "C:\\test\\package.json:secret", "C:\\test\\NUL.txt", "C:\\test\\COM¹",
    "C:\\test\\name.\\package.json", "C:\\test\\name \\package.json",
  ])("refuses ambiguous or device path %s before native inspection", async path => {
    expect(await inspectWindowsInstallationFiles([{ path, maxBytes: 1024 }]))
      .toEqual({ kind: "refused", reason: "invalid-request" });
  });

  test("bounds the request before native inspection", async () => {
    expect(await inspectWindowsInstallationFiles([])).toEqual({ kind: "refused", reason: "invalid-request" });
    expect(await inspectWindowsInstallationFiles([{ path: "C:\\package.json", maxBytes: 1024 * 1024 + 1 }]))
      .toEqual({ kind: "refused", reason: "invalid-request" });
    expect(await inspectWindowsInstallationFiles(Array.from({ length: 13 }, () => ({ path: "C:\\package.json", maxBytes: 10 }))))
      .toEqual({ kind: "refused", reason: "invalid-request" });
    expect(await inspectWindowsInstallationFiles([
      { path: "C:\\node.exe", maxBytes: 256 * 1024 * 1024, hashOnly: true },
      { path: "C:\\other.exe", maxBytes: 256 * 1024 * 1024, hashOnly: true },
    ])).toEqual({ kind: "refused", reason: "invalid-request" });
  });

  nativeTest("reads real nested files under held ancestors and releases every handle", async () => {
    const nested = join(fixture, "npm", "node_modules", "fixture-package");
    mkdirSync(nested, { recursive: true });
    const manifest = join(nested, "package.json");
    const launcher = join(fixture, "npm", "fixture.cmd");
    writeFileSync(manifest, '{"name":"fixture-package","version":"1.0.0"}\n');
    writeFileSync(launcher, "@echo fixture\r\n");
    const result = await inspectWindowsInstallationFiles([
      { path: manifest, maxBytes: 1024 }, { path: launcher, maxBytes: 1024 },
    ]);
    expect(result.kind).toBe("observed");
    if (result.kind !== "observed") return;
    expect(result.files).toHaveLength(2);
    for (const file of result.files) {
      const bytes = readFileSync(file.path);
      expect(Buffer.from(file.bytes)).toEqual(bytes);
      expect(file.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(file.identity.size).toBe(bytes.length);
      expect(file.identity.fileId).toMatch(/^[a-f0-9]{32}$/);
      expect(file.identity.changeTime).toMatch(/^\d+$/);
    }
    renameSync(join(fixture, "npm"), join(fixture, "renamed"));
    expect(readFileSync(join(fixture, "renamed", "fixture.cmd"), "utf8")).toBe("@echo fixture\r\n");
  });

  nativeTest("does not follow a junction in an intermediate component or at the leaf", async () => {
    const target = join(fixture, "target");
    mkdirSync(target);
    writeFileSync(join(target, "package.json"), "original");
    const junction = join(fixture, "junction");
    symlinkSync(target, junction, "junction");
    expect(await inspectWindowsInstallationFiles([{ path: join(junction, "package.json"), maxBytes: 1024 }]))
      .toEqual({ kind: "refused", reason: "reparse-point" });
    expect(await inspectWindowsInstallationFiles([{ path: junction, maxBytes: 1024 }]))
      .toEqual({ kind: "refused", reason: "reparse-point" });
    expect(readFileSync(join(target, "package.json"), "utf8")).toBe("original");
  });

  nativeTest("refuses an existing writer instead of reading a mutable file", async () => {
    const path = join(fixture, "package.json");
    writeFileSync(path, "original");
    const writer = openSync(path, "r+");
    try {
      expect(await inspectWindowsInstallationFiles([{ path, maxBytes: 1024 }]))
        .toEqual({ kind: "refused", reason: "open-refused" });
    } finally { closeSync(writer); }
    expect((await inspectWindowsInstallationFiles([{ path, maxBytes: 1024 }])).kind).toBe("observed");
  });

  nativeTest("denies writes and ancestor renames throughout the multi-file observation window", async () => {
    const parent = join(fixture, "package");
    mkdirSync(parent);
    const first = join(parent, "package.json");
    const second = join(parent, "launcher.js");
    writeFileSync(first, "first-original");
    writeFileSync(second, "second-original");
    const blocked: boolean[] = [];
    setWindowsInstallationFilesOpenedForTests(() => {
      for (const action of [() => writeFileSync(first, "changed"), () => writeFileSync(second, "changed"),
        () => renameSync(parent, join(fixture, "moved"))]) {
        try { action(); blocked.push(false); } catch { blocked.push(true); }
      }
    });
    const result = await inspectWindowsInstallationFiles([{ path: first, maxBytes: 1024 }, { path: second, maxBytes: 1024 }]);
    expect(result.kind).toBe("observed");
    expect(blocked).toEqual([true, true, true]);
    expect(readFileSync(first, "utf8")).toBe("first-original");
    expect(readFileSync(second, "utf8")).toBe("second-original");
  });

  nativeTest("bounds text reads and streams a larger hash-only file without returning its contents", async () => {
    const path = join(fixture, "binary.fixture");
    const block = Buffer.alloc(65536, 0x6b);
    const expected = createHash("sha256");
    const fd = openSync(path, "w");
    try {
      for (let index = 0; index < 48; index++) { writeSync(fd, block); expected.update(block); }
    } finally { closeSync(fd); }
    expect(await inspectWindowsInstallationFiles([{ path, maxBytes: 1024 }]))
      .toEqual({ kind: "refused", reason: "size-limit" });
    const result = await inspectWindowsInstallationFiles([{ path, maxBytes: 4 * 1024 * 1024, hashOnly: true }]);
    expect(result.kind).toBe("observed");
    if (result.kind !== "observed") return;
    expect(result.files[0]!.bytes).toHaveLength(0);
    expect(result.files[0]!.identity.size).toBe(3 * 1024 * 1024);
    expect(result.files[0]!.digest).toBe(expected.digest("hex"));
  });
});
