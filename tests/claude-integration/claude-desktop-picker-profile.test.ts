import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configIO from "../../src/config";
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
import { isOwnedDesktopEntry, isOwnedDesktopGatewayEntry } from "../../src/claude/desktop-3p-library";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root: string;
let library: string;
let configDir: string;
let previousHome: string | undefined;
let previousLibrary: string | undefined;

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
  saveConfig({
    port: 10100,
    defaultProvider: "test",
    providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, liveModels: false, models: ["fixture"] } },
    clientIntegrations: { "claude-desktop": false },
  } as any);
});

afterEach(() => {
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
});
