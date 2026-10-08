import { afterEach, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs";
import * as nodeCrypto from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeInterceptCaCertPath, claudeInterceptStateDir, ensureLocalInterceptCa } from "../../src/claude/intercept/local-ca";
import { setLocalCaFileHooksForTests } from "../../src/claude/intercept/local-ca-files";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-ca-files-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  setLocalCaFileHooksForTests(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")("local CA rejects a symlink directory without modifying its external target", () => {
  const root = fixture();
  const outside = fixture();
  const marker = join(outside, "marker");
  writeFileSync(marker, "external", { mode: 0o640 });
  symlinkSync(outside, claudeInterceptStateDir(root));
  expect(() => ensureLocalInterceptCa(root)).toThrow();
  expect(readdirSync(outside)).toEqual(["marker"]);
  expect(readFileSync(marker, "utf8")).toBe("external");
  expect(statSync(marker).mode & 0o777).toBe(0o640);
});

for (const name of ["ca.key", "ca.pem", "ca-publication.sqlite", "ca-publication.sqlite-journal"]) {
  test.skipIf(process.platform === "win32")(`local CA rejects symlink ${name} before reading or replacing it`, () => {
    const root = fixture();
    const first = ensureLocalInterceptCa(root);
    const dir = claudeInterceptStateDir(root);
    const outside = join(fixture(), "external");
    writeFileSync(outside, "external", { mode: 0o640 });
    const path = join(dir, name);
    rmSync(path, { force: true });
    symlinkSync(outside, path);
    expect(() => ensureLocalInterceptCa(root)).toThrow();
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("external");
    expect(statSync(outside).mode & 0o777).toBe(0o640);
    if (name !== "ca.pem") expect(readFileSync(claudeInterceptCaCertPath(root), "utf8")).toBe(first.certPem);
  });
  test(`local CA rejects nonregular ${name} without deleting it`, () => {
    const root = fixture();
    ensureLocalInterceptCa(root);
    const path = join(claudeInterceptStateDir(root), name);
    rmSync(path, { force: true });
    mkdirSync(path);
    expect(() => ensureLocalInterceptCa(root)).toThrow();
    expect(statSync(path).isDirectory()).toBe(true);
  });
}

for (const name of ["ca.key", "ca.pem", "ca-publication.sqlite"]) {
  test(`local CA refuses multiply linked ${name} and preserves the external link`, () => {
    const root = fixture();
    ensureLocalInterceptCa(root);
    const path = join(claudeInterceptStateDir(root), name);
    const outside = join(fixture(), "linked");
    linkSync(path, outside);
    const original = readFileSync(outside);
    expect(() => ensureLocalInterceptCa(root)).toThrow();
    expect(readFileSync(outside)).toEqual(original);
    expect(statSync(path).ino).toBe(statSync(outside).ino);
  });
}

for (const [name, mode] of [["", 0o755], ["ca.key", 0o644], ["ca.pem", 0o666], ["ca-publication.sqlite", 0o644]] as const) {
  test.skipIf(process.platform === "win32")(`local CA refuses unsafe POSIX permissions on ${name || "directory"}`, () => {
    const root = fixture();
    const ca = ensureLocalInterceptCa(root);
    const path = join(claudeInterceptStateDir(root), name);
    chmodSync(path, mode);
    expect(() => ensureLocalInterceptCa(root)).toThrow();
    expect(statSync(path).mode & 0o777).toBe(mode);
    expect(readFileSync(claudeInterceptCaCertPath(root), "utf8")).toBe(ca.certPem);
  });
}

test("local CA ignores predictable predecessor temp names and leaves external fixtures intact", () => {
  const root = fixture();
  const dir = claudeInterceptStateDir(root);
  mkdirSync(dir, { mode: 0o700 });
  const oldTemp = join(dir, `ca.key.${process.pid}.tmp`);
  writeFileSync(oldTemp, "reserved predecessor", { mode: 0o600 });
  const ca = ensureLocalInterceptCa(root);
  expect(readFileSync(oldTemp, "utf8")).toBe("reserved predecessor");
  expect(readFileSync(join(dir, "ca.key"), "utf8")).toBe(ca.keyPem);
  expect(readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([`ca.key.${process.pid}.tmp`]);
});

test("unsafe key is rejected even when its certificate is missing", () => {
  const root = fixture();
  ensureLocalInterceptCa(root);
  const dir = claudeInterceptStateDir(root);
  unlinkSync(claudeInterceptCaCertPath(root));
  const path = join(dir, "ca.key");
  const external = join(fixture(), "linked-key");
  linkSync(path, external);
  const before = readFileSync(external);
  expect(() => ensureLocalInterceptCa(root)).toThrow();
  expect(readFileSync(external)).toEqual(before);
  expect(statSync(path).nlink).toBe(2);
});

for (const name of ["", "ca.key", "ca.pem", "ca-publication.sqlite"]) {
  test.skipIf(process.platform === "win32")(`local CA rejects foreign POSIX ownership on ${name || "directory"}`, () => {
    const root = fixture();
    ensureLocalInterceptCa(root);
    const target = join(claudeInterceptStateDir(root), name);
    const original = filesystem.lstatSync;
    const uid = process.geteuid!();
    const probe = spyOn(filesystem, "lstatSync").mockImplementation((path, options) => {
      const stat = original(path, options);
      if (String(path) !== target) return stat;
      const foreign = Object.create(stat);
      Object.defineProperty(foreign, "uid", { value: options && "bigint" in options && options.bigint ? BigInt(uid + 1) : uid + 1 });
      return foreign;
    });
    try { expect(() => { ensureLocalInterceptCa(root); }).toThrow("safe owner-controlled"); }
    finally { probe.mockRestore(); }
    expect(filesystem.lstatSync(target).uid).toBe(uid);
  });
}

test.skipIf(process.platform === "win32")("local CA rejects a key substituted between inspection and pinned read", () => {
  const root = fixture();
  ensureLocalInterceptCa(root);
  const path = join(claudeInterceptStateDir(root), "ca.key");
  const external = join(fixture(), "outside");
  writeFileSync(external, "external fixture", { mode: 0o640 });
  setLocalCaFileHooksForTests({ beforeRead(target) {
    if (target !== path) return;
    unlinkSync(path);
    symlinkSync(external, path);
  } });
  expect(() => { ensureLocalInterceptCa(root); }).toThrow();
  expect(readFileSync(external, "utf8")).toBe("external fixture");
  expect(statSync(external).mode & 0o777).toBe(0o640);
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
});

test.skipIf(process.platform === "win32")("local CA never writes key bytes to a substituted empty temporary path", () => {
  const root = fixture();
  const external = join(fixture(), "outside");
  writeFileSync(external, "external fixture", { mode: 0o640 });
  let substituted: string | undefined;
  setLocalCaFileHooksForTests({ beforeWrite(path) {
    expect(statSync(path).size).toBe(0);
    substituted = path;
    unlinkSync(path);
    symlinkSync(external, path);
  } });
  expect(() => { ensureLocalInterceptCa(root); }).toThrow();
  expect(substituted).toBeDefined();
  expect(lstatSync(substituted!).isSymbolicLink()).toBe(true);
  expect(readFileSync(external, "utf8")).toBe("external fixture");
  expect(statSync(external).mode & 0o777).toBe(0o640);
});

test.skipIf(process.platform === "win32")("local CA publication refuses a newly substituted destination and preserves its external target", () => {
  const root = fixture();
  const external = join(fixture(), "outside");
  writeFileSync(external, "external fixture", { mode: 0o640 });
  setLocalCaFileHooksForTests({ beforePublish(path) { symlinkSync(external, path); } });
  expect(() => { ensureLocalInterceptCa(root); }).toThrow();
  expect(readFileSync(external, "utf8")).toBe("external fixture");
  expect(statSync(external).mode & 0o777).toBe(0o640);
  expect(lstatSync(join(claudeInterceptStateDir(root), "ca.key")).isSymbolicLink()).toBe(true);
});

test("a concurrent publisher fails under the lease while both PEM files are staged", () => {
  const root = fixture();
  const attempts: string[] = [];
  setLocalCaFileHooksForTests({ beforePublish(path) {
    attempts.push(path);
    expect(() => { ensureLocalInterceptCa(root); }).toThrow("client_lifecycle_busy");
  } });
  const first = ensureLocalInterceptCa(root);
  expect(attempts).toHaveLength(2);
  setLocalCaFileHooksForTests(null);
  expect(ensureLocalInterceptCa(root).certPem).toBe(first.certPem);
  expect(ensureLocalInterceptCa(root).keyPem).toBe(first.keyPem);
  expect(readdirSync(claudeInterceptStateDir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test.skipIf(process.platform === "win32")("exclusive nofollow staging refuses a preexisting random-temp symlink", () => {
  const root = fixture();
  const dir = claudeInterceptStateDir(root);
  mkdirSync(dir, { mode: 0o700 });
  const external = join(fixture(), "outside");
  writeFileSync(external, "external fixture", { mode: 0o640 });
  const temp = join(dir, `.ca.key.${process.pid}.${"00".repeat(16)}.tmp`);
  symlinkSync(external, temp);
  const random = spyOn(nodeCrypto, "randomBytes").mockReturnValue(Buffer.alloc(16));
  try { expect(() => { ensureLocalInterceptCa(root); }).toThrow(); }
  finally { random.mockRestore(); }
  expect(lstatSync(temp).isSymbolicLink()).toBe(true);
  expect(readFileSync(external, "utf8")).toBe("external fixture");
  expect(statSync(external).mode & 0o777).toBe(0o640);
});

test("filesystem read denial escapes corruption regeneration and preserves the safe pair", () => {
  const root = fixture();
  const first = ensureLocalInterceptCa(root);
  const key = join(claudeInterceptStateDir(root), "ca.key");
  let writes = 0;
  setLocalCaFileHooksForTests({ beforeRead(path) {
    if (path === key) throw Object.assign(new Error("injected read denial"), { code: "EACCES" });
  }, beforeWrite() { writes++; } });
  expect(() => { ensureLocalInterceptCa(root); }).toThrow("injected read denial");
  expect(writes).toBe(0);
  expect(readFileSync(key, "utf8")).toBe(first.keyPem);
  expect(readFileSync(claudeInterceptCaCertPath(root), "utf8")).toBe(first.certPem);
});

test("local CA rejects a descriptor for a different inode before key bytes are read", () => {
  const root = fixture();
  ensureLocalInterceptCa(root);
  const key = join(claudeInterceptStateDir(root), "ca.key");
  const external = join(fixture(), "outside");
  writeFileSync(external, "external fixture", { mode: 0o600 });
  const originalOpen = filesystem.openSync;
  const originalRead = filesystem.readSync;
  let foreignFd: number | undefined;
  let foreignReads = 0;
  const opened = spyOn(filesystem, "openSync").mockImplementation((path, flags, mode) => {
    if (String(path) === key) { foreignFd = originalOpen(external, flags, mode); return foreignFd; }
    return originalOpen(path, flags, mode);
  });
  const reads = spyOn(filesystem, "readSync").mockImplementation((...args) => {
    if (args[0] === foreignFd) foreignReads++;
    return originalRead(...args);
  });
  try { expect(() => { ensureLocalInterceptCa(root); }).toThrow("safe owner-controlled"); }
  finally { reads.mockRestore(); opened.mockRestore(); }
  expect(foreignFd).toBeDefined();
  expect(foreignReads).toBe(0);
  expect(readFileSync(external, "utf8")).toBe("external fixture");
});
