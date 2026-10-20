import * as pickerFilesystem from "node:fs";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as clientLifecycle from "../../src/client/lifecycle-lock";
import * as configIO from "../../src/config";
import * as desktopLibrary from "../../src/claude/desktop-3p-library";
import { saveConfig } from "../../src/config";
import {
  inspectDesktopPickerProfile,
  applyDesktopPickerProfile,
  removeDesktopPickerProfile,
} from "../../src/claude/desktop-picker-profile";
import {
  inspectDesktop3pConfigLibrary,
  removeDesktop3pStandardPivot,
  writeDesktop3pConfig,
} from "../../src/claude/desktop-3p";
import { isOwnedDesktopEntry, isOwnedDesktopGatewayEntry, MAX_DESKTOP_PROFILE_FILE_BYTES } from "../../src/claude/desktop-3p-library";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root: string;
let library: string;
let configDir: string;
let previousHome: string | undefined;
let previousLibrary: string | undefined;
let restoreLifecycleLock: (() => void) | undefined;
const realClientLifecycleSync = clientLifecycle.withClientLifecycleSync;

function env(): NodeJS.ProcessEnv {
  return { ...process.env, OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: library };
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function writeMetadata(value: Record<string, unknown>): void {
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, "_meta.json"), JSON.stringify(value, null, 2) + "\n");
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousLibrary = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  root = mkdtempSync(join(tmpdir(), "ocx-desktop-picker-profile-"));
  library = join(root, "desktop");
  configDir = join(root, "ocx");
  mkdirSync(library, { recursive: true });
  process.env.OPENCODEX_HOME = configDir;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = library;
  // Keep real SQLite exclusion and lease checks, but isolate the user-scoped lock too.
  const lifecycleLock = spyOn(clientLifecycle, "withClientLifecycleSync").mockImplementation(
    (work, deps) => realClientLifecycleSync(work, {
      ...deps, lockPath: deps?.lockPath ?? join(root, "locks", "lifecycle.sqlite"),
    }),
  );
  restoreLifecycleLock = () => lifecycleLock.mockRestore();
  saveConfig({
    port: 10100,
    defaultProvider: "test",
    providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, liveModels: false, models: ["fixture"] } },
    clientIntegrations: { "claude-desktop": false },
  } as any);
});

afterEach(() => {
  restoreLifecycleLock?.();
  restoreLifecycleLock = undefined;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousLibrary === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousLibrary;
  removeTreeWithRetry(root);
});

describe("Claude Desktop picker profile", () => {
  test("creates an egress-only row, records the prior selection, and is idempotent", () => {
    const previous = "foreign-selected";
    writeFileSync(join(library, `${previous}.json`), "{\"foreign\":true}\n");
    writeMetadata({ appliedId: previous, foreignMeta: true, entries: [{ id: previous, name: "Personal" }] });

    const first = applyDesktopPickerProfile({ proxyPort: 41234, env: env(), configDir });
    expect(first).toMatchObject({ ok: true, changed: true });
    if (!first.ok) throw new Error(first.reason);
    expect(readFileSync(first.path, "utf8")).toBe('{"egressProxyUrl":"http://127.0.0.1:41234"}\n');
    // POSIX permission bits only: Windows reports 0o666 for any writable file (ACLs carry the
    // real protection), the same exemption claude-picker-ca.test.ts makes for its key file.
    if (process.platform !== "win32") expect(statSync(first.path).mode & 0o777).toBe(0o600);
    const metadata = readJson(join(library, "_meta.json"));
    expect(metadata.foreignMeta).toBe(true);
    expect(Object.keys(metadata).filter(key => key.toLowerCase().includes("opencodex"))).toEqual([]);
    const picker = metadata.entries.find((entry: { name: string }) => entry.name === "opencodex-picker");
    expect(metadata.appliedId).toBe(picker.id);
    const statePath = join(configDir, "claude-picker", "profile-state.json");
    expect(readJson(statePath)).toEqual({ entryId: picker.id, previousAppliedId: previous });
    if (process.platform !== "win32") expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(inspectDesktopPickerProfile({ env: env(), configDir })).toMatchObject({ kind: "applied", proxyUrl: "http://127.0.0.1:41234" });

    expect(applyDesktopPickerProfile({ proxyPort: 41234, env: env(), configDir })).toMatchObject({ ok: true, changed: false, path: first.path });
    expect(applyDesktopPickerProfile({ proxyPort: 41235, env: env(), configDir })).toMatchObject({ ok: true, changed: true });
    expect(readJson(join(configDir, "claude-picker", "profile-state.json")).previousAppliedId).toBe(previous);
  });

  test("refuses a selected gateway and preserves foreign rows when removing", () => {
    const gateway = "gateway";
    writeFileSync(join(library, `${gateway}.json`), "{}\n");
    writeMetadata({ appliedId: gateway, entries: [{ id: gateway, name: "opencodex" }] });
    expect(applyDesktopPickerProfile({ proxyPort: 41234, env: env(), configDir })).toEqual({ ok: false, reason: "gateway_selected" });

    const foreign = "foreign";
    writeFileSync(join(library, `${foreign}.json`), "{\"foreign\":true}\n");
    writeMetadata({ appliedId: foreign, entries: [{ id: foreign, name: "Personal" }] });
    const applied = applyDesktopPickerProfile({ proxyPort: 41234, env: env(), configDir });
    expect(applied.ok).toBe(true);
    const removed = removeDesktopPickerProfile({ env: env(), configDir });
    expect(removed).toMatchObject({ ok: true, changed: true });
    expect(readJson(join(library, "_meta.json"))).toMatchObject({ appliedId: foreign, entries: [{ id: foreign, name: "Personal" }] });
    expect(readFileSync(join(library, `${foreign}.json`), "utf8")).toBe("{\"foreign\":true}\n");
    expect(existsSync(join(configDir, "claude-picker", "profile-state.json"))).toBe(false);
  });

  test("falls back to a standard row when the previous selection disappeared", () => {
    const foreign = "foreign";
    writeFileSync(join(library, `${foreign}.json`), "{}\n");
    writeMetadata({ appliedId: foreign, entries: [{ id: foreign, name: "Personal" }] });
    expect(applyDesktopPickerProfile({ proxyPort: 41234, env: env(), configDir }).ok).toBe(true);
    unlinkSync(join(library, `${foreign}.json`));
    writeMetadata({ appliedId: readJson(join(library, "_meta.json")).appliedId, entries: readJson(join(library, "_meta.json")).entries.filter((entry: { id: string }) => entry.id !== foreign) });
    const removed = removeDesktopPickerProfile({ env: env(), configDir });
    expect(removed).toMatchObject({ ok: true, changed: true });
    const metadata = readJson(join(library, "_meta.json"));
    expect(metadata.entries.some((entry: { name: string }) => entry.name === "opencodex-picker")).toBe(false);
    expect(metadata.entries.find((entry: { id: string }) => entry.id === metadata.appliedId).name).toBe("opencodex-standard");
    expect(readFileSync(join(library, `${metadata.appliedId}.json`), "utf8")).toBe("{}\n");
  });

  test("rolls back the profile and state when metadata publication fails", () => {
    const previous = "foreign";
    writeFileSync(join(library, `${previous}.json`), "{\"foreign\":true}\n");
    writeMetadata({ appliedId: previous, foreignMeta: "keep", entries: [{ id: previous, name: "Personal" }] });
    const beforeMeta = readFileSync(join(library, "_meta.json"), "utf8");
    const realWrite = configIO.atomicWriteFile;
    const failure = spyOn(configIO, "atomicWriteFile").mockImplementation((path, content, io, hooks) => {
      if (path === join(library, "_meta.json")) throw new Error("metadata failure");
      return realWrite(path, content, io, hooks);
    });
    try {
      expect(applyDesktopPickerProfile({ proxyPort: 41234, env: env(), configDir })).toEqual({ ok: false, reason: "write_failed" });
    } finally {
      failure.mockRestore();
    }
    expect(readFileSync(join(library, "_meta.json"), "utf8")).toBe(beforeMeta);
    expect(readFileSync(join(library, `${previous}.json`), "utf8")).toBe("{\"foreign\":true}\n");
    expect(inspectDesktopPickerProfile({ env: env(), configDir })).toEqual({ kind: "absent" });
    expect(existsSync(join(configDir, "claude-picker", "profile-state.json"))).toBe(false);
  });

  test("gateway writes and removal leave the picker row alone", () => {
    const foreign = "foreign";
    writeFileSync(join(library, `${foreign}.json`), "{}\n");
    writeMetadata({ appliedId: foreign, entries: [{ id: foreign, name: "Personal" }] });
    const applied = applyDesktopPickerProfile({ proxyPort: 41234, env: env(), configDir });
    expect(applied.ok).toBe(true);
    saveConfig({
      port: 10100,
      defaultProvider: "test",
      providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, liveModels: false, models: ["fixture"] } },
      clientIntegrations: { "claude-desktop": true },
    } as any);
    expect(writeDesktop3pConfig(10100, [], [], undefined, "static", undefined, undefined, { lockPath: join(root, "locks", "desktop.sqlite") }).written).toBe(true);
    const pickerId = readJson(join(configDir, "claude-picker", "profile-state.json")).entryId;
    expect(existsSync(join(library, `${pickerId}.json`))).toBe(true);
    expect(removeDesktop3pStandardPivot({ env: env(), replaceWhileEnabled: true })).toMatchObject({ ok: true });
    expect(existsSync(join(library, `${pickerId}.json`))).toBe(true);
    expect(inspectDesktopPickerProfile({ env: env(), configDir })).toMatchObject({ kind: "not_selected", entryId: pickerId });
  });

  test("the shared Desktop inspection treats a selected picker row as owned standard", () => {
    const picker = "picker";
    writeFileSync(join(library, `${picker}.json`), '{"egressProxyUrl":"http://127.0.0.1:41234"}\n');
    writeMetadata({ appliedId: picker, entries: [{ id: picker, name: "opencodex-picker" }] });
    expect(isOwnedDesktopEntry({ id: picker, name: "opencodex-picker" })).toBe(true);
    expect(isOwnedDesktopGatewayEntry({ id: picker, name: "opencodex-picker" })).toBe(false);
    expect(inspectDesktop3pConfigLibrary({ env: env() })).toMatchObject({ kind: "standard", appliedId: picker });
  });

  // Multi-MiB real-file fixtures plus ACL-hardened writes need extra Windows wall-clock budget.
  test("oversized picker metadata refuses before profile and state writes", () => {
    const id = "foreign-selected";
    writeFileSync(join(library, `${id}.json`), "{}\n");
    const metadata = {
      appliedId: id, entries: [{ id, name: "Personal" }],
      foreignRows: Array(500_000).fill("x"),
    };
    const before = JSON.stringify(metadata);
    expect(Buffer.byteLength(before)).toBeLessThan(MAX_DESKTOP_PROFILE_FILE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(metadata, null, 2))).toBeGreaterThan(MAX_DESKTOP_PROFILE_FILE_BYTES);
    const path = join(library, "_meta.json");
    writeFileSync(path, before);
    const names = readdirSync(library).sort();
    const serialize = spyOn(desktopLibrary, "serializeDesktopLibraryJson");
    try {
      expect(applyDesktopPickerProfile({ proxyPort: 41234, env: env(), configDir }))
        .toEqual({ ok: false, reason: "write_failed" });
      expect(serialize).toHaveBeenCalledTimes(1);
    } finally {
      serialize.mockRestore();
    }
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(library).sort()).toEqual(names);
    expect(existsSync(join(configDir, "claude-picker", "profile-state.json"))).toBe(false);
  }, 20_000);

  test.each([
    ["selected with a previous row", true, true],
    ["selected without a previous row", true, false],
    ["unselected", false, true],
  ] as const)("oversized removal metadata preserves all artifacts: %s", (_name, selected, previousExists) => {
    const picker = "picker", previous = "foreign";
    const metadata = {
      appliedId: selected ? picker : previous,
      entries: [
        { id: picker, name: "opencodex-picker" },
        ...(previousExists ? [{ id: previous, name: "Personal" }] : []),
      ],
      foreignRows: Array(500_000).fill("x"),
    };
    const compact = JSON.stringify(metadata);
    expect(Buffer.byteLength(compact)).toBeLessThan(MAX_DESKTOP_PROFILE_FILE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(metadata, null, 2))).toBeGreaterThan(MAX_DESKTOP_PROFILE_FILE_BYTES);
    const metaPath = join(library, "_meta.json"), profilePath = join(library, `${picker}.json`);
    const backupPath = `${profilePath}.bak`, statePath = join(configDir, "claude-picker", "profile-state.json");
    mkdirSync(join(configDir, "claude-picker"), { recursive: true });
    writeFileSync(metaPath, compact);
    writeFileSync(profilePath, '{"egressProxyUrl":"http://127.0.0.1:41234"}\n');
    writeFileSync(backupPath, '{"egressProxyUrl":"http://127.0.0.1:41233"}\n');
    writeFileSync(statePath, JSON.stringify({ entryId: picker, previousAppliedId: previous }) + "\n");
    if (previousExists) writeFileSync(join(library, `${previous}.json`), '{"foreign":true}\n');
    const paths = [metaPath, profilePath, backupPath, statePath];
    const snapshots = paths.map(path => readFileSync(path, "utf8"));
    const names = readdirSync(library).sort();

    expect(removeDesktopPickerProfile({ env: env(), configDir }))
      .toEqual({ ok: false, reason: "desktop_config_too_large" });
    expect(paths.map(path => readFileSync(path, "utf8"))).toEqual(snapshots);
    expect(readdirSync(library).sort()).toEqual(names);
  }, 20_000);

  test("a non-regular picker profile path inspects as unsafe instead of blocking", () => {
    const picker = "picker";
    mkdirSync(join(library, `${picker}.json`));
    writeMetadata({ appliedId: picker, entries: [{ id: picker, name: "opencodex-picker" }] });
    expect(inspectDesktopPickerProfile({ env: env(), configDir })).toEqual({ kind: "unsafe", reason: "desktop_config_not_regular" });
  });

  test("a FIFO swapped onto the picker profile path refuses instead of waiting", () => {
    // Windows has no POSIX FIFO entry; the directory case above covers the portable contract.
    if (process.platform === "win32") return;
    const picker = "picker";
    const result = spawnSync("mkfifo", [join(library, `${picker}.json`)]);
    expect(result.status).toBe(0);
    writeMetadata({ appliedId: picker, entries: [{ id: picker, name: "opencodex-picker" }] });
    expect(inspectDesktopPickerProfile({ env: env(), configDir })).toEqual({ kind: "unsafe", reason: "desktop_config_not_regular" });
    expect(applyDesktopPickerProfile({ proxyPort: 41234, env: env(), configDir })).toEqual({ ok: false, reason: "write_failed" });
  });
});

describe("picker boundary and recovery receipts", () => {
  for (const operation of ["apply", "remove selected", "remove fallback", "remove unselected"] as const) for (const extra of [0, 1]) {
    test(`${operation} preflights exact metadata output limit+${extra} and preserves extensions`, () => {
      const picker = { id: "picker", name: "opencodex-picker", extension: { keep: [1, "picker"] } };
      const foreign = { id: "foreign", name: "Personal", extension: { keep: [2, "foreign"] } };
      const selected = operation === "remove selected" || operation === "remove fallback";
      const fallback = operation === "remove fallback";
      const metadata = { appliedId: selected ? picker.id : foreign.id, entries: fallback ? [picker] : [picker, foreign], foreignMeta: { keep: [true, "nested"] }, pad: "" };
      const standard = { id: "0".repeat(36), name: "opencodex-standard" };
      const projected = operation === "apply" ? { ...metadata, appliedId: picker.id }
        : fallback ? { ...metadata, appliedId: standard.id, entries: [...metadata.entries, standard] }
        : selected ? { ...metadata, appliedId: foreign.id }
        : { ...metadata, entries: [foreign] };
      metadata.pad = "x".repeat(MAX_DESKTOP_PROFILE_FILE_BYTES + extra - Buffer.byteLength(JSON.stringify(projected, null, 2) + "\n"));
      projected.pad = metadata.pad;
      expect(Buffer.byteLength(JSON.stringify(projected, null, 2) + "\n")).toBe(MAX_DESKTOP_PROFILE_FILE_BYTES + extra);
      const beforeMeta = JSON.stringify(metadata); expect(Buffer.byteLength(beforeMeta)).toBeLessThan(MAX_DESKTOP_PROFILE_FILE_BYTES);
      writeFileSync(join(library, "_meta.json"), beforeMeta);
      writeFileSync(join(library, "picker.json"), '{"egressProxyUrl":"http://127.0.0.1:41233"}\n');
      writeFileSync(join(library, "picker.json.bak"), "old backup");
      writeFileSync(join(library, "foreign.json"), '{"unowned":{"preserve":true}}\n');
      mkdirSync(join(configDir, "claude-picker"), { recursive: true });
      const statePath = join(configDir, "claude-picker", "profile-state.json");
      writeFileSync(statePath, JSON.stringify({ entryId: picker.id, previousAppliedId: foreign.id }) + "\n");
      const names = readdirSync(library).sort(), originals = names.map(n => readFileSync(join(library, n), "utf8"));
      const beforeState = readFileSync(statePath, "utf8");
      const result = operation === "apply"
        ? applyDesktopPickerProfile({ proxyPort: 41234, env: env(), configDir })
        : removeDesktopPickerProfile({ env: env(), configDir });
      if (extra) {
        expect(result).toEqual({ ok: false, reason: operation === "apply" ? "write_failed" : "desktop_config_too_large" });
        expect(readdirSync(library).sort()).toEqual(names);
        expect(names.map(n => readFileSync(join(library, n), "utf8"))).toEqual(originals);
        expect(readFileSync(statePath, "utf8")).toBe(beforeState);
      } else {
        expect(result).toMatchObject({ ok: true, changed: true });
        const after = readJson(join(library, "_meta.json"));
        expect(after.foreignMeta).toEqual(metadata.foreignMeta);
        if (!fallback) expect(after.entries.find((e: any) => e.id === foreign.id)).toEqual(foreign);
        expect(readFileSync(join(library, "foreign.json"), "utf8")).toBe('{"unowned":{"preserve":true}}\n');
        if (operation === "apply") {
          expect(after.entries.find((e: any) => e.id === picker.id)).toEqual(picker);
          expect(after.appliedId).toBe(picker.id);
        } else {
          expect(after.entries.some((e: any) => e.id === picker.id)).toBe(false);
          expect(existsSync(join(library, "picker.json"))).toBe(false); expect(existsSync(statePath)).toBe(false);
          if (fallback) expect(readJson(join(library, `${after.appliedId}.json`))).toEqual({});
          else expect(after.appliedId).toBe(foreign.id);
        }
      }
    }, 20_000);
  }

  for (const existing of [true, false]) {
    test(`picker reports failure when metadata publication and ${existing ? "rollback restore" : "rollback cleanup"} fail`, () => {
      const foreign = "foreign"; writeFileSync(join(library, `${foreign}.json`), '{"foreign":true}\n');
      writeMetadata({ appliedId: foreign, foreignMeta: { keep: true }, entries: [{ id: foreign, name: "Personal" }] });
      let profile: string | undefined;
      if (existing) {
        const first = applyDesktopPickerProfile({ proxyPort: 41233, env: env(), configDir });
        expect(first.ok).toBe(true); if (!first.ok) throw new Error("fixture setup failed"); profile = first.path;
      }
      const meta = join(library, "_meta.json"), beforeMeta = readFileSync(meta, "utf8");
      const realWrite = configIO.atomicWriteFile, rename = pickerFilesystem.renameSync, unlink = pickerFilesystem.unlinkSync;
      let metadataFailed = false, recoveryFailed = false;
      const writing = spyOn(configIO, "atomicWriteFile").mockImplementation((path, content, io, hooks) => {
        if (path === meta) { metadataFailed = true; throw new Error("fixture metadata failure"); }
        if (path.startsWith(library) && path.endsWith(".json") && path !== meta) profile = path;
        return realWrite(path, content, io, hooks);
      });
      const renaming = spyOn(pickerFilesystem, "renameSync").mockImplementation((source, destination) => {
        // The atomic writer renames onto the symlink-resolved target, so on macOS (/var -> /private/var)
        // the destination is the canonical spelling of the profile path; compare both spellings.
        const restoring = profile !== undefined
          && (destination === profile || destination === join(realpathSync(dirname(profile)), basename(profile)));
        if (existing && metadataFailed && restoring) { recoveryFailed = true; throw new Error("fixture restore failure"); }
        return rename(source, destination);
      });
      const removing = spyOn(pickerFilesystem, "unlinkSync").mockImplementation(path => {
        if (!existing && metadataFailed && path === profile) { recoveryFailed = true; throw new Error("fixture cleanup failure"); }
        return unlink(path);
      });
      try {
        expect(applyDesktopPickerProfile({ proxyPort: 41234, env: env(), configDir })).toEqual({ ok: false, reason: "write_failed" });
        expect(metadataFailed).toBe(true); expect(recoveryFailed).toBe(true);
        expect(readFileSync(meta, "utf8")).toBe(beforeMeta);
        // A failed rollback leaves a real residue; do not mistake the opaque failure for restoration.
        expect(readJson(profile!).egressProxyUrl).toBe("http://127.0.0.1:41234");
        expect(readFileSync(join(library, `${foreign}.json`), "utf8")).toBe('{"foreign":true}\n');
      } finally { removing.mockRestore(); renaming.mockRestore(); writing.mockRestore(); }
    });
  }
});
