import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProfile, handleClaudeDesktopCommand } from "../src/cli/claude-desktop";
import { buildClaudeDesktopState } from "../src/server/management-api";
import { loadConfig, saveConfig } from "../src/config";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let dir = "";
let previousHome: string | undefined;
let previousDesktopDir: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousDesktopDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "ocx-desktop-cli-"));
  process.env.OPENCODEX_HOME = join(dir, "ocx");
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(dir, "desktop");
  saveConfig({
    port: 10100,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["test-model"] },
    },
  } as OcxConfig);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDesktopDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopDir;
  removeTreeWithRetry(dir);
});

test("show --json, move, default and export use the same persisted profile", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand(["show", "--json"])).toBe(0);
    const state = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(state.profile.assignments["mock/test-model"].family).toBe("opus");

    expect(await handleClaudeDesktopCommand(["move", "mock/test-model", "sonnet", "--default"])).toBe(0);
    expect(loadConfig().claudeCode?.desktopProfile?.defaults.sonnet).toBe("mock/test-model");

    const target = join(dir, "profile.json");
    expect(await handleClaudeDesktopCommand(["export", target])).toBe(0);
    const exported = JSON.parse(readFileSync(target, "utf8"));
    expect(exported.assignments["mock/test-model"].family).toBe("sonnet");
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("import rejects invalid profiles without replacing saved state", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    await handleClaudeDesktopCommand(["move", "mock/test-model", "haiku", "--default"]);
    const before = structuredClone(loadConfig().claudeCode?.desktopProfile);
    const source = join(dir, "bad.json");
    writeFileSync(source, JSON.stringify({ version: 1, assignments: {}, defaults: { opus: "missing", fable: null, sonnet: null, haiku: null } }));
    expect(await handleClaudeDesktopCommand(["import", source])).toBe(1);
    expect(loadConfig().claudeCode?.desktopProfile).toEqual(before);
    expect(error).toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

test("desktopNativeModels:false omits native/* from show and exported profile", async () => {
  saveConfig({
    port: 10100,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["test-model"] },
    },
    claudeCode: { desktopNativeModels: false },
  } as OcxConfig);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand(["show", "--json"])).toBe(0);
    const state = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(state.models.every((model: { route: string }) => !model.route.startsWith("native/"))).toBe(true);
    expect(Object.keys(state.profile.assignments).every((route: string) => !route.startsWith("native/"))).toBe(true);

    const target = join(dir, "desktop-profile.json");
    expect(await handleClaudeDesktopCommand(["export", target])).toBe(0);
    const exported = JSON.parse(readFileSync(target, "utf8"));
    expect(Object.keys(exported.assignments).every((route: string) => !route.startsWith("native/"))).toBe(true);
  } finally {
    log.mockRestore();
  }
});

/*
 * #859. The Desktop alias reverse-map is process-local to whichever process
 * builds it. When a live proxy exists, apply must run inside THAT process
 * through the management API; a local-only write leaves the serving daemon
 * unable to decode aliases and the provider 400s.
 */
test("apply delegates to the live proxy management API instead of writing locally", async () => {
  const state = await buildClaudeDesktopState(loadConfig());
  const posted: Array<{ mode: string; profile: unknown }> = [];
  const result = await applyProfile(state.profile, "hybrid", {
    findLiveProxyImpl: async () => ({ pid: 4242, port: 10100, hostname: "127.0.0.1", source: "runtime" }),
    postApplyImpl: async (mode, profile) => {
      posted.push({ mode, profile });
      return { ok: true, path: "/daemon-side/path" };
    },
  });
  expect(posted.length).toBe(1);
  expect(posted[0]!.mode).toBe("hybrid");
  // The profile must cross the boundary; dropping it reintroduces #859's
  // stale-daemon variant.
  expect(posted[0]!.profile).toEqual(state.profile);
  expect(result.ok).toBe(true);
  expect(result.path).toBe("/daemon-side/path");
  // No local Desktop config write: the daemon performed it.
  expect(existsSync(join(dir, "desktop"))).toBe(false);
  // The CLI still persisted the profile itself.
  expect(loadConfig().claudeCode?.desktopProfile).toBeDefined();
});

test("apply writes locally only when no proxy is running", async () => {
  const state = await buildClaudeDesktopState(loadConfig());
  const result = await applyProfile(state.profile, "static", {
    findLiveProxyImpl: async () => null,
    postApplyImpl: async () => {
      throw new Error("must not be called without a live proxy");
    },
  });
  expect(result.ok).toBe(true);
  expect(existsSync(join(dir, "desktop"))).toBe(true);
});

test("no-arg and legacy mode flags apply Desktop config", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    // Deterministic: no live proxy in the test environment, so apply writes locally.
    const noProxy = { findLiveProxyImpl: async () => null };
    expect(await handleClaudeDesktopCommand([], noProxy)).toBe(0);
    expect(await handleClaudeDesktopCommand(["--static"], noProxy)).toBe(0);
    expect(readFileSync(join(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR!, "_meta.json"), "utf8")).toContain("opencodex");
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("usage errors on desktop verbs exit 2, not 1", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand(["status", "--wat"])).toBe(2);
    expect(await handleClaudeDesktopCommand(["status", "extra"])).toBe(2);
    expect(await handleClaudeDesktopCommand(["show", "--wat"])).toBe(2);
    expect(await handleClaudeDesktopCommand(["move"])).toBe(2);
    expect(await handleClaudeDesktopCommand(["nope"])).toBe(2);
    expect(await handleClaudeDesktopCommand(["apply", "--wat"])).toBe(2);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});
