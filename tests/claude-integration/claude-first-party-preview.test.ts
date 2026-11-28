import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registeredClaudeConfigDirs } from "../../src/claude/auth-detect";
import { observeClaudeDesktopMode } from "../../src/claude/desktop-first-party";
import { previewClaudeFirstPartySettings, type FirstPartySettingsChange } from "../../src/claude/first-party-preview";
import { firstPartyDesired, reconcileClaudeFirstPartySettings } from "../../src/claude/first-party-settings";
import { claudeFirstPartyTransition } from "../../src/claude/first-party-transition";
import { claudeInterceptCaCertPath } from "../../src/claude/intercept/local-ca";
import { claudeInterceptProxyTokenPath } from "../../src/claude/intercept/proxy-auth";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Catch-up 010, G-002: the first-party preview must report exactly the settings.json keys the
 * switch changes. Every case runs the preview, checks it wrote nothing, then runs the switch's
 * own path (the shared persisted transition, then reconcile with the adopted block) in the same
 * temporary homes and compares the key-level diff. Values never appear in a preview.
 */
let root = "";
let claudeHome = "";
let oldLibrary: string | undefined;
const options = () => ({ opencodexConfigDir: root, claudeConfigDir: claudeHome });
const settingsPath = () => join(claudeHome, "settings.json");

function cfg(extra: { desktop?: boolean; cli?: boolean; desktopMode?: "first-party" | "gateway" | null; intercept?: boolean; port?: number } = {}): OcxConfig {
  const claudeCode: Record<string, unknown> = {};
  if (extra.desktopMode !== null) claudeCode.desktopMode = extra.desktopMode ?? "first-party";
  if (extra.cli) claudeCode.cliFirstParty = true;
  if (extra.intercept === false) claudeCode.intercept = { enabled: false };
  return { port: extra.port ?? 10100, defaultProvider: "openai", providers: {},
    clientIntegrations: { "claude-desktop": extra.desktop === true }, claudeCode } as unknown as OcxConfig;
}

function env(): Record<string, unknown> {
  if (!existsSync(settingsPath())) return {};
  return (JSON.parse(readFileSync(settingsPath(), "utf8")) as { env?: Record<string, unknown> }).env ?? {};
}

function writeEnv(value: Record<string, unknown>): void {
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ theme: "dark", env: value }, null, 2));
}

function diff(before: Record<string, unknown>, after: Record<string, unknown>): FirstPartySettingsChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: FirstPartySettingsChange[] = [];
  for (const key of keys) {
    const had = Object.hasOwn(before, key);
    const has = Object.hasOwn(after, key);
    if (!had && has) changes.push({ file: "settings.json", key: `env.${key}`, change: "add" });
    else if (had && !has) changes.push({ file: "settings.json", key: `env.${key}`, change: "remove" });
    else if (before[key] !== after[key]) changes.push({ file: "settings.json", key: `env.${key}`, change: "update" });
  }
  return changes;
}

const sorted = (changes: FirstPartySettingsChange[]) => [...changes].sort((a, b) => a.key.localeCompare(b.key));

/** Every file under root with its bytes, to prove a preview wrote, minted and deleted nothing. */
function snapshot(dir = root): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(out, snapshot(path));
    else out[path] = readFileSync(path, "base64");
  }
  return out;
}

/** The switch's path: shared transition on the persisted config, reconcile with the adopted block. */
function realSwitch(live: OcxConfig, persisted: OcxConfig, requested: boolean) {
  const { nextBlock } = claudeFirstPartyTransition(persisted, requested, options());
  const reconciled = { ...live, claudeCode: nextBlock } as OcxConfig;
  return reconcileClaudeFirstPartySettings(reconciled, firstPartyDesired(reconciled, observeClaudeDesktopMode(reconciled, options())), options());
}

function expectPreviewMatchesSwitch(live: OcxConfig, requested: boolean, persisted: OcxConfig = live): FirstPartySettingsChange[] {
  const before = snapshot();
  const preview = previewClaudeFirstPartySettings({ live, persisted, enabled: requested, options: options() });
  expect(snapshot()).toEqual(before);
  if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
  expect(JSON.stringify(preview)).not.toContain("127.0.0.1");
  // Values never leave the preview: not the CA path, not the proxy token.
  expect(JSON.stringify(preview)).not.toContain(claudeInterceptCaCertPath(root));
  const token = existsSync(claudeInterceptProxyTokenPath(root)) ? readFileSync(claudeInterceptProxyTokenPath(root), "utf8").trim() : "";
  if (token) expect(JSON.stringify(preview)).not.toContain(token);
  const envBefore = env();
  const result = realSwitch(live, persisted, requested);
  expect(result.ok).toBe(true);
  expect(sorted(preview.changes)).toEqual(sorted(diff(envBefore, env())));
  return preview.changes;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-first-party-preview-"));
  claudeHome = join(root, "claude");
  oldLibrary = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "library");
});
afterEach(() => {
  if (oldLibrary === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = oldLibrary;
  removeTreeWithRetry(root);
});

describe("enabling CLI first-party", () => {
  test("a fresh home adds the proxy, the CA and the loopback bypass; nothing is minted by the preview", () => {
    const changes = expectPreviewMatchesSwitch(cfg(), true);
    expect(changes.map(c => `${c.key}:${c.change}`).sort()).toEqual(["env.HTTPS_PROXY:add", "env.NODE_EXTRA_CA_CERTS:add", "env.NO_PROXY:add"]);
  });

  test("a user NO_PROXY without loopback is extended (update), one covering everything is left alone", () => {
    writeEnv({ NO_PROXY: "corp.example" });
    expect(expectPreviewMatchesSwitch(cfg(), true).find(c => c.key === "env.NO_PROXY")?.change).toBe("update");
    removeTreeWithRetry(root);
    mkdirSync(root, { recursive: true });
    writeEnv({ NO_PROXY: "*" });
    expect(expectPreviewMatchesSwitch(cfg(), true).some(c => c.key === "env.NO_PROXY")).toBe(false);
  });

  test("an applied env previews no change, and a moved port previews the proxy update", () => {
    expect(realSwitch(cfg(), cfg(), true).ok).toBe(true);
    expect(expectPreviewMatchesSwitch(cfg({ cli: true }), true)).toEqual([]);
    const moved = expectPreviewMatchesSwitch(cfg({ cli: true, port: 10300 }), true);
    expect(moved).toEqual([{ file: "settings.json", key: "env.HTTPS_PROXY", change: "update" }]);
  });

  test("the switch's refusals are previewed: foreign env, unreadable settings, disabled intercept", () => {
    writeEnv({ HTTPS_PROXY: "http://proxy.corp:8080", NODE_EXTRA_CA_CERTS: "/corp/ca.pem" });
    const foreign = previewClaudeFirstPartySettings({ live: cfg(), persisted: cfg(), enabled: true, options: options() });
    expect(foreign).toMatchObject({ ok: false, reason: "foreign_env" });
    expect(realSwitch(cfg(), cfg(), true)).toMatchObject({ ok: false, reason: "foreign_env" });

    writeFileSync(settingsPath(), "{broken");
    expect(previewClaudeFirstPartySettings({ live: cfg(), persisted: cfg(), enabled: true, options: options() }))
      .toMatchObject({ ok: false, reason: "unreadable" });

    const disabled = cfg({ intercept: false });
    expect(previewClaudeFirstPartySettings({ live: disabled, persisted: disabled, enabled: true, options: options() }))
      .toMatchObject({ ok: false, reason: "intercept_disabled" });
  });

  test("the preview never creates the proxy token or the local CA", () => {
    previewClaudeFirstPartySettings({ live: cfg(), persisted: cfg(), enabled: true, options: options() });
    expect(existsSync(claudeInterceptProxyTokenPath(root))).toBe(false);
    expect(existsSync(claudeInterceptCaCertPath(root))).toBe(false);
  });
});

describe("turning CLI first-party off", () => {
  test("a missing receipt is optional and an oversized receipt makes the preview unreadable", () => {
    writeEnv({ NODE_EXTRA_CA_CERTS: claudeInterceptCaCertPath(root) });
    const config = cfg({ cli: true, desktopMode: "gateway" });
    const input = { live: config, persisted: config, enabled: false, options: options() };
    expect(previewClaudeFirstPartySettings(input).ok).toBe(true);
    writeFileSync(join(claudeHome, "opencodex-no-proxy.json"), "{}".padEnd(2 * 1024 * 1024 + 1025));
    expect(previewClaudeFirstPartySettings(input)).toMatchObject({ ok: false, reason: "unreadable" });
  });

  test("a CLI-only env is removed, restoring NO_PROXY from its receipt", () => {
    expect(realSwitch(cfg({ desktopMode: "gateway" }), cfg({ desktopMode: "gateway" }), true).ok).toBe(true);
    const on = cfg({ cli: true, desktopMode: "gateway" });
    const changes = expectPreviewMatchesSwitch(on, false);
    expect(changes.map(c => `${c.key}:${c.change}`).sort()).toEqual(["env.HTTPS_PROXY:remove", "env.NODE_EXTRA_CA_CERTS:remove", "env.NO_PROXY:remove"]);
  });

  test("a NO_PROXY the user edited after the apply is kept", () => {
    expect(realSwitch(cfg({ desktopMode: "gateway" }), cfg({ desktopMode: "gateway" }), true).ok).toBe(true);
    writeEnv({ ...env(), NO_PROXY: "edited.example" });
    const changes = expectPreviewMatchesSwitch(cfg({ cli: true, desktopMode: "gateway" }), false);
    expect(changes.some(c => c.key === "env.NO_PROXY")).toBe(false);
  });

  test("an env Desktop still wants is retained, pinned or inferred", () => {
    expect(realSwitch(cfg({ desktop: true }), cfg({ desktop: true }), true).ok).toBe(true);
    expect(expectPreviewMatchesSwitch(cfg({ desktop: true, cli: true }), false)).toEqual([]);
    // Unpinned: the transition pins the mode it observes after the flag clears.
    const unpinned = cfg({ desktop: true, cli: true, desktopMode: null });
    expect(expectPreviewMatchesSwitch(unpinned, false)).toEqual([]);
  });

  test("the transition runs on the persisted config, not the live snapshot", () => {
    expect(realSwitch(cfg({ desktop: true }), cfg({ desktop: true }), true).ok).toBe(true);
    const live = cfg({ desktop: true, cli: true, desktopMode: null });
    const persisted = cfg({ desktop: true, cli: true, desktopMode: "gateway" });
    // Live alone would infer Desktop first-party and retain the env; the persisted pin releases it.
    expect(previewClaudeFirstPartySettings({ live, persisted: live, enabled: false, options: options() })).toMatchObject({ ok: true, changes: [] });
    const changes = expectPreviewMatchesSwitch(live, false, persisted);
    expect(changes.some(c => c.key === "env.NODE_EXTRA_CA_CERTS" && c.change === "remove")).toBe(true);
  });
});

describe("registered Claude homes", () => {
  test("the default home comes first; extras are expanded, deduplicated, and only what is listed", () => {
    const fakeHome = join(root, "user");
    const homes = registeredClaudeConfigDirs({ claudeCode: { extraConfigDirs: [
      "~/work-claude", join(root, "abs"), "relative/skip", join(fakeHome, ".claude"), "~/work-claude",
    ] } } as OcxConfig, { HOME: fakeHome });
    expect(homes).toEqual([
      { dir: join(fakeHome, ".claude"), source: "default" },
      { dir: join(fakeHome, "work-claude"), source: "extra" },
      { dir: join(root, "abs"), source: "extra" },
    ]);
    expect(registeredClaudeConfigDirs({ claudeCode: {} } as OcxConfig, { HOME: fakeHome })).toHaveLength(1);
  });
});
