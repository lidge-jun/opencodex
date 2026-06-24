import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAutoStartEnabled, getConfigPath, getDefaultConfig, loadConfig } from "../src/config";

let testDir = "";

beforeEach(() => {
  testDir = join(tmpdir(), `ocx-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  process.env.OPENCODEX_HOME = testDir;
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("opencodex config defaults", () => {
  test("Codex autostart is enabled by default", () => {
    expect(getDefaultConfig().codexAutoStart).toBe(true);
    expect(codexAutoStartEnabled({})).toBe(true);
  });

  test("Codex autostart can be disabled explicitly", () => {
    expect(codexAutoStartEnabled({ codexAutoStart: false })).toBe(false);
    expect(codexAutoStartEnabled({ codexAutoStart: true })).toBe(true);
  });

  test("loads valid config from OPENCODEX_HOME", () => {
    writeFileSync(getConfigPath(), JSON.stringify({
      port: 12345,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
    }));

    expect(loadConfig()).toMatchObject({
      port: 12345,
      defaultProvider: "custom",
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
    });
  });

  test("backs up invalid JSON config before falling back to defaults", () => {
    writeFileSync(getConfigPath(), "{ invalid json");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const loaded = loadConfig();

    expect(loaded).toEqual(getDefaultConfig());
    const backups = readdirSync(testDir).filter(name => name.startsWith("config.json.invalid-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(testDir, backups[0]), "utf-8")).toBe("{ invalid json");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Could not load opencodex config"));
    errorSpy.mockRestore();
  });

  test("backs up structurally invalid config before falling back to defaults", () => {
    writeFileSync(getConfigPath(), JSON.stringify({ port: 10100 }));
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const loaded = loadConfig();

    expect(loaded).toEqual(getDefaultConfig());
    const backups = readdirSync(testDir).filter(name => name.startsWith("config.json.invalid-"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(testDir, backups[0]), "utf-8"))).toEqual({ port: 10100 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("providers"));
    errorSpy.mockRestore();
  });
});
