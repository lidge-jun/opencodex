import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClaudeDesktopCommand } from "../src/cli/claude-desktop";
import { loadConfig, saveConfig } from "../src/config";
import type { OcxConfig } from "../src/types";

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
  rmSync(dir, { recursive: true, force: true });
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

test("no-arg and legacy mode flags apply Desktop config", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand([])).toBe(0);
    expect(await handleClaudeDesktopCommand(["--static"])).toBe(0);
    expect(readFileSync(join(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR!, "_meta.json"), "utf8")).toContain("opencodex");
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});
