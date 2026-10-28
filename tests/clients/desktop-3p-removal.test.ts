import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as filesystem from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { readDesktopLibraryText, readDesktopLibraryBytes, MAX_DESKTOP_PROFILE_FILE_BYTES, parseMetadata, readDesktopProfileForeignKeys } from "../../src/claude/desktop-3p-library";
import { StoreIO } from "../../src/claude/desktop-remote-store-io";
import { DesktopStoreError } from "../../src/claude/desktop-remote-store-state";
import { saveConfig, readConfigDiagnostics } from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  inspectDesktop3pConfigLibrary,
  removeDesktop3pStandardPivot as removeDesktop3pStandardPivotProduction,
} from "../../src/claude/desktop-3p";

let previousHome: string | undefined;
let fixtureHome: string;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  fixtureHome = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-home-"));
  process.env.OPENCODEX_HOME = fixtureHome;
  saveConfig({ port: 10100, defaultProvider: "test", providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, liveModels: false, models: ["fixture-model"] } }, clientIntegrations: { "claude-desktop": false } } as OcxConfig);
  expect(readConfigDiagnostics().source).toBe("file");
  expect(readConfigDiagnostics().config.clientIntegrations?.["claude-desktop"]).toBe(false);
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(fixtureHome);
});

function removeDesktop3pStandardPivot(options: NonNullable<Parameters<typeof removeDesktop3pStandardPivotProduction>[0]> = {}) {
  const library = options.env?.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  if (!library) throw new Error("Desktop removal fixture must supply its library path");
  const previousLibrary = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = library;
  try {
    return removeDesktop3pStandardPivotProduction({
      ...options, lifecycleLockDeps: { lockPath: join(fixtureHome, "locks", "desktop.sqlite") },
    });
  } finally {
    if (previousLibrary === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousLibrary;
  }
}

function envFor(path: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: path };
}

function appliedFingerprint(path: string): string {
  return createHash("sha256").update(readFileSync(path, "utf8")).digest("hex").slice(0, 16);
}

test("an absent Desktop library is read-only and OFF is an idempotent no-op", () => {
  const library = join(mkdtempSync(join(tmpdir(), "ocx-desktop-remove-")), "missing");
  const options = { env: envFor(library) };
  expect(inspectDesktop3pConfigLibrary(options).kind).toBe("not_installed");
  expect(removeDesktop3pStandardPivot(options)).toMatchObject({ ok: true, changed: false, kind: "noop" });
  expect(existsSync(library)).toBe(false);
});

test("OFF selects a credential-free standard profile before deleting the owned profile and backup", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const id = "owned-profile";
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100",
    // Shape-only value: deliberately inert; never a credential.
    inferenceGatewayApiKey: "not-a-secret",
  }));
  writeFileSync(join(library, `${id}.json.bak`), "{}");

  const result = removeDesktop3pStandardPivot({ env: envFor(library), appliedFingerprint: appliedFingerprint(join(library, `${id}.json`)) });
  expect(result).toMatchObject({ ok: true, changed: true, kind: "removed" });
  expect(existsSync(join(library, `${id}.json`))).toBe(false);
  expect(existsSync(join(library, `${id}.json.bak`))).toBe(false);
  const metadata = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as { appliedId: string; entries: Array<{ id: string }> };
  expect(metadata.entries.map(entry => entry.id)).not.toContain(id);
  const standard = JSON.parse(readFileSync(join(library, `${metadata.appliedId}.json`), "utf8")) as Record<string, unknown>;
  expect(standard).toEqual({});
});

test("a selected path traversal id is refused without following it", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: "../outside", entries: [] }));
  const result = inspectDesktop3pConfigLibrary({ env: envFor(library) });
  expect(result).toMatchObject({ kind: "unsafe", reason: "unsafe_applied_id" });
  expect(removeDesktop3pStandardPivot({ env: envFor(library) }).kind).toBe("unsafe");
});

test("a selected foreign standard profile is never mutated, but owned residue can be cleaned", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const foreign = "foreign-standard";
  const owned = "owned-residue";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({
    appliedId: foreign,
    entries: [{ id: foreign, name: "someone-else" }, { id: owned, name: "opencodex" }],
  }));
  writeFileSync(join(library, `${foreign}.json`), "{}\n");
  writeFileSync(join(library, `${owned}.json`), JSON.stringify({
    inferenceProvider: "gateway", inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
  }));

  expect(inspectDesktop3pConfigLibrary({ env: envFor(library) })).toMatchObject({ kind: "foreign", appliedId: foreign });
  expect(removeDesktop3pStandardPivot({ env: envFor(library) })).toMatchObject({ ok: true, changed: true, kind: "removed" });
  expect(readFileSync(join(library, `${foreign}.json`), "utf8")).toBe("{}\n");
  expect(existsSync(join(library, `${owned}.json`))).toBe(false);
  expect(JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"))).toMatchObject({ appliedId: foreign, entries: [{ id: foreign }] });
});

test("an owned but drifted gateway profile can still be disabled", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const id = "drifted-owned";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway", inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
  }));
  writeFileSync(join(library, `${id}.json.bak`), "{}");

  expect(inspectDesktop3pConfigLibrary({ env: envFor(library), appliedFingerprint: "other" }).kind).toBe("gateway_drifted");
  // Missing/mismatched fingerprint must not trap OFF: the selected row is still our
  // owned gateway, so disable pivots to standard and deletes the credential-bearing files.
  const result = removeDesktop3pStandardPivot({ env: envFor(library), appliedFingerprint: "other" });
  expect(result).toMatchObject({ ok: true, changed: true, kind: "removed" });
  expect(existsSync(join(library, `${id}.json`))).toBe(false);
  expect(existsSync(join(library, `${id}.json.bak`))).toBe(false);
  const metadata = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as { appliedId: string; entries: Array<{ id: string; name: string }> };
  expect(metadata.entries.map(entry => entry.id)).not.toContain(id);
  expect(metadata.entries.some(entry => entry.name === "opencodex-standard")).toBe(true);
  expect(JSON.parse(readFileSync(join(library, `${metadata.appliedId}.json`), "utf8"))).toEqual({});
});

test("an owned gateway with no saved fingerprint is treated as drifted and can be disabled", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const id = "fingerprint-missing";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway", inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
  }));

  expect(inspectDesktop3pConfigLibrary({ env: envFor(library), appliedFingerprint: null }).kind).toBe("gateway_drifted");
  expect(removeDesktop3pStandardPivot({ env: envFor(library), appliedFingerprint: null })).toMatchObject({
    ok: true, changed: true, kind: "removed",
  });
  expect(existsSync(join(library, `${id}.json`))).toBe(false);
});

test("a delete interruption leaves the standard pivot selected and reports only residual paths", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const id = "owned-profile";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway", inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
  }));
  writeFileSync(join(library, `${id}.json.bak`), "{}");

  const result = removeDesktop3pStandardPivot({
    env: envFor(library),
    appliedFingerprint: appliedFingerprint(join(library, `${id}.json`)),
    unlink: path => {
      if (path.endsWith(".bak")) throw new Error("injected delete failure");
      unlinkSync(path);
    },
  });
  expect(result).toMatchObject({ ok: false, changed: true, kind: "cleanup_incomplete" });
  expect(result.residualPaths).toEqual([join(library, `${id}.json.bak`)]);
  const metadata = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as { appliedId: string };
  expect(JSON.parse(readFileSync(join(library, `${metadata.appliedId}.json`), "utf8"))).toEqual({});
});

test("interrupted cleanup prefers the selected opencodex row and reports another owned row as residue", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const selected = "selected-owned";
  const residual = "residual-owned";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({
    appliedId: selected,
    entries: [{ id: selected, name: "opencodex" }, { id: residual, name: "opencodex" }],
  }));
  for (const id of [selected, residual]) {
    writeFileSync(join(library, `${id}.json`), JSON.stringify({
      inferenceProvider: "gateway", inferenceCredentialKind: "static",
      inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
    }));
  }

  const result = removeDesktop3pStandardPivot({ env: envFor(library), appliedFingerprint: appliedFingerprint(join(library, `${selected}.json`)) });
  expect(result).toMatchObject({ ok: false, changed: true, kind: "cleanup_incomplete" });
  expect(existsSync(join(library, `${selected}.json`))).toBe(false);
  expect(result.residualPaths).toContain(join(library, `${residual}.json`));
});


test("regular Desktop library reads preserve the exact text and foreign keys", () => {
  const path = join(fixtureHome, "regular.json");
  const source = JSON.stringify({ entries: [], foreign: "설정 값" }) + "\n";
  writeFileSync(path, source);
  expect(readDesktopLibraryText(path)).toBe(source);
  expect(parseMetadata(path).entries).toEqual([]);
  expect(readDesktopProfileForeignKeys(path).foreign).toBe("설정 값");
  expect(readFileSync(path, "utf8")).toBe(source);
});

test("Desktop library reads refuse directories without reading their contents", () => {
  expect(() => readDesktopLibraryText(fixtureHome)).toThrow("desktop_config_not_regular");
});

test.skipIf(process.platform === "win32")("Desktop library reads refuse symlinks without modifying the target", () => {
  const target = join(fixtureHome, "target.json");
  const link = join(fixtureHome, "link.json");
  writeFileSync(target, "{}\n");
  filesystem.symlinkSync(target, link);
  expect(() => readDesktopLibraryText(link)).toThrow("desktop_config_not_regular");
  expect(readFileSync(target, "utf8")).toBe("{}\n");
  expect(filesystem.lstatSync(link).isSymbolicLink()).toBe(true);
});

for (const entry of ["_meta.json", "selected.json"]) {
  test.skipIf(process.platform === "win32")(`Desktop inspection refuses a FIFO at ${entry} without a writer`, () => {
    const library = join(fixtureHome, "fifo-library");
    mkdirSync(library);
    if (entry !== "_meta.json") writeFileSync(join(library, "_meta.json"), JSON.stringify({
      appliedId: "selected", entries: [{ id: "selected", name: "foreign-fixture" }],
    }));
    const fifo = join(library, entry);
    expect(spawnSync("mkfifo", [fifo], { timeout: 5000 }).status).toBe(0);
    // Bound the parent even if a regression opens the FIFO synchronously. The child imports
    // the real inspector and does not use a simulated read or start a production listener.
    const code = `import { inspectDesktop3pConfigLibrary } from ${JSON.stringify(repoPath("src/claude/desktop-3p.ts"))};
      console.log(JSON.stringify(inspectDesktop3pConfigLibrary({env:{OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR:${JSON.stringify(library)}}})));`;
    const child = spawnSync(process.execPath, ["--no-env-file", "-e", code], {
      env: { ...process.env }, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim()).kind).toBe(entry === "_meta.json" ? "unsafe" : "broken");
    expect(filesystem.lstatSync(fifo).isFIFO()).toBe(true);
  }, 20000);
}

test.skipIf(process.platform === "win32")("a regular-to-FIFO replacement between stat and open is refused", () => {
  const path = join(fixtureHome, "race.json");
  const fifo = join(fixtureHome, "replacement");
  writeFileSync(path, "{}");
  expect(spawnSync("mkfifo", [fifo], { timeout: 5000 }).status).toBe(0);
  const open = filesystem.openSync;
  const opening = spyOn(filesystem, "openSync").mockImplementation((target, flags, mode) => {
    if (target === path) filesystem.renameSync(fifo, path);
    return open(target, flags, mode);
  });
  try {
    expect(() => readDesktopLibraryText(path)).toThrow("desktop_config_not_regular");
    expect(filesystem.lstatSync(path).isFIFO()).toBe(true);
  } finally { opening.mockRestore(); }
});

test.skipIf(process.platform === "win32")("a regular-to-symlink replacement between stat and open is refused", () => {
  const path = join(fixtureHome, "race-link.json");
  const target = join(fixtureHome, "link-target.json");
  const link = join(fixtureHome, "link-replacement");
  writeFileSync(path, "{}");
  writeFileSync(target, "{}");
  filesystem.symlinkSync(target, link);
  const open = filesystem.openSync;
  const opening = spyOn(filesystem, "openSync").mockImplementation((target_, flags, mode) => {
    if (target_ === path) filesystem.renameSync(link, path);
    return open(target_, flags, mode);
  });
  try {
    expect(() => readDesktopLibraryText(path)).toThrow("desktop_config_not_regular");
    expect(filesystem.lstatSync(path).isSymbolicLink()).toBe(true);
  } finally { opening.mockRestore(); }
});

test("Desktop library reads accept the byte boundary and refuse a larger file", () => {
  const path = join(fixtureHome, "bounded.json");
  const source = "{}" + " ".repeat(MAX_DESKTOP_PROFILE_FILE_BYTES - 2);
  writeFileSync(path, source);
  expect(readDesktopLibraryText(path)).toBe(source);
  writeFileSync(path, source + " ");
  expect(() => readDesktopLibraryText(path)).toThrow("desktop_config_too_large");
  expect(readFileSync(path, "utf8")).toBe(source + " ");
});

test("Desktop library reads bound growth after descriptor validation", () => {
  const path = join(fixtureHome, "growing.json");
  writeFileSync(path, "0");
  const read = filesystem.readSync;
  let grew = false;
  let consumed = 0;
  const reading = spyOn(filesystem, "readSync").mockImplementation((fd, buffer, offset, length, position) => {
    if (!grew) {
      grew = true;
      filesystem.appendFileSync(path, "0".repeat(65));
    }
    const count = read(fd, buffer, offset, length, position);
    consumed += count;
    return count;
  });
  try {
    expect(() => readDesktopLibraryBytes(path, 64)).toThrow("desktop_config_too_large");
    expect(grew).toBe(true);
    expect(consumed).toBe(65);
  } finally { reading.mockRestore(); }
});

test("Desktop library reads refuse a path removed after descriptor validation", () => {
  const path = join(fixtureHome, "removed-during-read.json");
  writeFileSync(path, "{}");
  const read = filesystem.readSync;
  let removed = false;
  const reading = spyOn(filesystem, "readSync").mockImplementation((fd, buffer, offset, length, position) => {
    const count = read(fd, buffer, offset, length, position);
    if (!removed) { removed = true; unlinkSync(path); }
    return count;
  });
  try {
    expect(() => readDesktopLibraryBytes(path)).toThrow("desktop_config_not_regular");
    expect(removed).toBe(true);
  } finally { reading.mockRestore(); }
});

// Both the selected gateway pivot and foreign-selected residue cleanup must preflight
// serialized metadata before creating a standard row or deleting any profile/backup.
test.each([true, false])("oversized removal metadata preserves all files with selected gateway=%s", selectedGateway => {
  const library = join(fixtureHome, "oversized-removal");
  mkdirSync(library);
  const owned = "owned-profile";
  const foreign = "foreign-profile";
  const metadata = {
    appliedId: selectedGateway ? owned : foreign,
    entries: [{ id: owned, name: "opencodex" }, { id: foreign, name: "Personal" }],
    foreignRows: Array(500_000).fill("x"),
  };
  const metadataBefore = JSON.stringify(metadata);
  expect(Buffer.byteLength(metadataBefore)).toBeLessThan(MAX_DESKTOP_PROFILE_FILE_BYTES);
  expect(Buffer.byteLength(JSON.stringify(metadata, null, 2) + "\n")).toBeGreaterThan(MAX_DESKTOP_PROFILE_FILE_BYTES);
  const originals: Array<[string, string]> = [
    ["_meta.json", metadataBefore],
    [`${owned}.json`, JSON.stringify({
      inferenceProvider: "gateway", inferenceCredentialKind: "static",
      inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
    })],
    [`${owned}.json.bak`, '{"originalBackup":true}\n'],
    [`${foreign}.json`, '{"foreign":true}\n'],
  ];
  for (const [name, content] of originals) writeFileSync(join(library, name), content);
  const options = { env: envFor(library), appliedFingerprint: appliedFingerprint(join(library, `${owned}.json`)) };
  expect(inspectDesktop3pConfigLibrary(options).kind).toBe(selectedGateway ? "gateway_ours" : "foreign");
  const namesBefore = filesystem.readdirSync(library).sort();
  const unlinked: string[] = [];
  const result = removeDesktop3pStandardPivot({
    ...options, unlink: path => { unlinked.push(path); unlinkSync(path); },
  });
  expect(result).toMatchObject({ ok: false, changed: false, kind: "write_failed", reason: "desktop_mutation_failed" });
  expect(unlinked).toEqual([]);
  expect(filesystem.readdirSync(library).sort()).toEqual(namesBefore);
  for (const [name, content] of originals) expect(readFileSync(join(library, name), "utf8")).toBe(content);
}, 20_000);

test("StoreIO limits a growing read to its tighter cap plus one sentinel byte", () => {
  const path = join(fixtureHome, "store-growing.json");
  const maxBytes = 64;
  const original = "{}\n";
  const appended = " ".repeat(maxBytes + 1);
  writeFileSync(path, original);
  const read = filesystem.readSync;
  let grew = false;
  let consumed = 0;
  const reading = spyOn(filesystem, "readSync").mockImplementation((fd, buffer, offset, length, position) => {
    if (!grew) { grew = true; filesystem.appendFileSync(path, appended); }
    const count = read(fd, buffer, offset, length, position);
    consumed += count;
    return count;
  });
  try {
    let failure: unknown;
    try { new StoreIO().read(path, maxBytes); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(DesktopStoreError);
    expect(failure).toMatchObject({ reason: "unsafe" });
    expect(grew).toBe(true);
    expect(consumed).toBe(maxBytes + 1);
  } finally { reading.mockRestore(); }
  expect(readFileSync(path, "utf8")).toBe(original + appended);
});

test("bounded reader accepts an empty regular file unchanged", () => {
  const path = join(fixtureHome, "empty.json");
  writeFileSync(path, "");
  expect(readDesktopLibraryBytes(path, 64)).toEqual(Buffer.alloc(0));
  expect(readDesktopLibraryText(path)).toBe("");
  expect(filesystem.statSync(path).size).toBe(0);
});

test("bounded reader caps growth from an empty file at limit plus one", () => {
  const path = join(fixtureHome, "empty-growing.json");
  writeFileSync(path, "");
  const read = filesystem.readSync;
  let grew = false, consumed = 0;
  const reading = spyOn(filesystem, "readSync").mockImplementation((fd, buffer, offset, length, position) => {
    if (!grew) { grew = true; filesystem.appendFileSync(path, "x".repeat(80)); }
    const count = read(fd, buffer, offset, length, position); consumed += count; return count;
  });
  try {
    expect(() => readDesktopLibraryBytes(path, 64)).toThrow("desktop_config_too_large");
    expect(grew).toBe(true); expect(consumed).toBe(65);
    expect(readFileSync(path, "utf8")).toBe("x".repeat(80));
  } finally { reading.mockRestore(); }
});

for (const timing of ["before open", "after read"] as const) {
  // Windows refuses rename-over-open with EPERM before the intended identity recheck.
  test.skipIf(process.platform === "win32" && timing === "after read")(`bounded reader refuses a same-byte regular inode replacement ${timing}`, () => {
    const path = join(fixtureHome, "inode.json"), replacement = join(fixtureHome, "other-inode.json");
    writeFileSync(path, "{}"); writeFileSync(replacement, "{}");
    const original = filesystem.statSync(path, { bigint: true });
    const next = filesystem.statSync(replacement, { bigint: true });
    expect(next.ino).not.toBe(original.ino);
    const open = filesystem.openSync, read = filesystem.readSync;
    let changed = false;
    const swap = () => { if (!changed) { filesystem.renameSync(replacement, path); changed = true; } };
    const opening = spyOn(filesystem, "openSync").mockImplementation((target, flags, mode) => {
      if (target === path && timing === "before open") swap();
      return open(target, flags, mode);
    });
    const reading = spyOn(filesystem, "readSync").mockImplementation((fd, buffer, offset, length, position) => {
      const count = read(fd, buffer, offset, length, position);
      if (timing === "after read") swap();
      return count;
    });
    try {
      expect(() => readDesktopLibraryBytes(path)).toThrow("desktop_config_not_regular");
      expect(changed).toBe(true); expect(filesystem.statSync(path, { bigint: true }).ino).toBe(next.ino);
    } finally { reading.mockRestore(); opening.mockRestore(); }
    expect(readFileSync(path, "utf8")).toBe("{}");
  });
}

// Deterministic comparison coverage: inject only ctimeNs, avoiding filesystem clock granularity.
// This does not attest a real OS ctime transition or POSIX metadata behavior on Windows.
for (const timing of ["descriptor", "path recheck"] as const) {
  test(`bounded reader refuses a ctime-only observation change at ${timing}`, () => {
    const path = join(fixtureHome, "ctime.json"); writeFileSync(path, "{}");
    const original = filesystem.lstatSync(path, { bigint: true });
    const changed = { ...original, ctimeNs: original.ctimeNs + 1n, isFile: () => true };
    expect(changed.dev).toBe(original.dev); expect(changed.ino).toBe(original.ino);
    expect(changed.size).toBe(original.size);
    const fstat = filesystem.fstatSync, lstat = filesystem.lstatSync;
    let pathCalls = 0, injected = false;
    const descriptor = spyOn(filesystem, "fstatSync").mockImplementation(((fd: number, options: any) => {
      if (timing === "descriptor") { injected = true; return changed; }
      return fstat(fd, options);
    }) as typeof filesystem.fstatSync);
    const observing = spyOn(filesystem, "lstatSync").mockImplementation(((target: filesystem.PathLike, options: any) => {
      if (target === path && ++pathCalls > 1 && timing === "path recheck") { injected = true; return changed; }
      return lstat(target, options);
    }) as typeof filesystem.lstatSync);
    try {
      expect(() => readDesktopLibraryBytes(path)).toThrow("desktop_config_not_regular");
      expect(injected).toBe(true);
    } finally { observing.mockRestore(); descriptor.mockRestore(); }
    expect(readFileSync(path, "utf8")).toBe("{}");
    expect(filesystem.statSync(path, { bigint: true }).ino).toBe(original.ino);
  });
}

// Windows timestamp update/share semantics are not a POSIX ctime receipt. Keep the
// portable injected comparisons above; execute this real timestamp case on POSIX.
// Re-applying the same atime/mtime moves ctime only when the kernel clock has ticked since the
// last metadata change; on coarse-tick filesystems one immediate call often leaves it unchanged.
// Repeat the identical utimes until ctime has really advanced, so the reader always faces a real
// ctime-only transition and never a no-op that would rightly read back "{}".
test.skipIf(process.platform === "win32")("bounded reader refuses a real ctime-only change after read on POSIX", () => {
  const path = join(fixtureHome, "real-ctime.json"); writeFileSync(path, "{}");
  filesystem.utimesSync(path, 1, 1);
  const before = filesystem.statSync(path, { bigint: true }), read = filesystem.readSync;
  let changed = false;
  const reading = spyOn(filesystem, "readSync").mockImplementation((fd, buffer, offset, length, position) => {
    const count = read(fd, buffer, offset, length, position);
    if (!changed) {
      const deadline = Date.now() + 5_000;
      do filesystem.utimesSync(path, 1, 1);
      while (filesystem.statSync(path, { bigint: true }).ctimeNs === before.ctimeNs && Date.now() < deadline);
      changed = filesystem.statSync(path, { bigint: true }).ctimeNs !== before.ctimeNs;
    }
    return count;
  });
  let outcome: unknown;
  try { outcome = readDesktopLibraryBytes(path); } catch (error) { outcome = error; }
  finally { reading.mockRestore(); }
  // Assert the precondition first: a rejection is only owed once ctime really moved.
  expect(changed).toBe(true);
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain("desktop_config_not_regular");
  const after = filesystem.statSync(path, { bigint: true });
  expect(after.ctimeNs).not.toBe(before.ctimeNs);
  for (const key of ["dev", "ino", "size", "mode", "mtimeNs"] as const) expect(after[key]).toBe(before[key]);
  expect(readFileSync(path, "utf8")).toBe("{}");
});

for (const selectedGateway of [true, false]) for (const extra of [0, 1]) {
  test(`standard removal preflights exact output limit+${extra}, selected gateway=${selectedGateway}`, () => {
    const library = join(fixtureHome, "boundary-removal"); mkdirSync(library);
    const foreign = { id: "foreign", name: "Personal", extension: { tags: ["preserve"] } };
    const owned = { id: "owned", name: "opencodex" };
    const metadata = { appliedId: selectedGateway ? owned.id : foreign.id, entries: [owned, foreign], foreignMeta: { nested: [1, "keep"] }, pad: "" };
    const standard = { id: "0".repeat(36), name: "opencodex-standard" };
    const expected = selectedGateway
      ? { ...metadata, appliedId: standard.id, entries: [...metadata.entries, standard] }
      : { ...metadata, entries: [foreign] };
    metadata.pad = "x".repeat(MAX_DESKTOP_PROFILE_FILE_BYTES + extra - Buffer.byteLength(JSON.stringify(expected, null, 2) + "\n"));
    expected.pad = metadata.pad;
    expect(Buffer.byteLength(JSON.stringify(expected, null, 2) + "\n")).toBe(MAX_DESKTOP_PROFILE_FILE_BYTES + extra);
    const before = JSON.stringify(metadata); expect(Buffer.byteLength(before)).toBeLessThan(MAX_DESKTOP_PROFILE_FILE_BYTES);
    writeFileSync(join(library, "_meta.json"), before);
    writeFileSync(join(library, "owned.json"), '{"inferenceProvider":"gateway","inferenceCredentialKind":"static","inferenceGatewayBaseUrl":"http://127.0.0.1:10100","inferenceGatewayApiKey":"not-a-secret"}');
    writeFileSync(join(library, "owned.json.bak"), "backup"); writeFileSync(join(library, "foreign.json"), '{"foreign":true}\n');
    const names = filesystem.readdirSync(library).sort(), snapshots = names.map(n => readFileSync(join(library, n), "utf8"));
    const unlinked: string[] = [];
    const result = removeDesktop3pStandardPivot({ env: envFor(library), unlink: path => { unlinked.push(path); unlinkSync(path); } });
    if (extra) {
      expect(result).toMatchObject({ ok: false, changed: false, kind: "write_failed" });
      expect(unlinked).toEqual([]); expect(filesystem.readdirSync(library).sort()).toEqual(names);
      expect(names.map(n => readFileSync(join(library, n), "utf8"))).toEqual(snapshots);
    } else {
      expect(result).toMatchObject({ ok: true, changed: true, kind: "removed" });
      const after = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
      expect(after.foreignMeta).toEqual(metadata.foreignMeta); expect(after.entries.find((e: any) => e.id === foreign.id)).toEqual(foreign);
      expect(readFileSync(join(library, "foreign.json"), "utf8")).toBe('{"foreign":true}\n');
      expect(existsSync(join(library, "owned.json"))).toBe(false);
      if (selectedGateway) expect(JSON.parse(readFileSync(join(library, `${after.appliedId}.json`), "utf8"))).toEqual({});
      else expect(after.appliedId).toBe(foreign.id);
    }
  }, 20_000);
}
