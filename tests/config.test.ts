import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  codexAutoStartEnabled,
  getConfigPath,
  getDefaultConfig,
  getPidPath,
  getRuntimePortPath,
  isValidProviderName,
  isOcxStartCommandLine,
  loadConfig,
  parsePidFile,
  readConfigDiagnostics,
  readRuntimePort,
  removePid,
  removeRuntimePort,
  writeRuntimePort,
  writePid,
} from "../src/config";

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-config-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

function backupNames(): string[] {
  return readdirSync(testDir).filter(name => name.startsWith("config.json.invalid-"));
}

function writeConfig(content: unknown): void {
  writeFileSync(
    getConfigPath(),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf-8",
  );
}

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
    writeConfig({
      port: 12345,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      codexAutoStart: false,
    });

    expect(loadConfig()).toMatchObject({
      port: 12345,
      defaultProvider: "custom",
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      codexAutoStart: false,
    });
  });

  test("reads valid config diagnostics without mutation", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      codexAutoStart: false,
    });

    const diagnostics = readConfigDiagnostics();

    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config).toMatchObject({
      port: 12345,
      defaultProvider: "custom",
      codexAutoStart: false,
    });
    expect(backupNames()).toHaveLength(0);
  });

  test("missing config diagnostics use defaults without creating files", () => {
    const beforeFiles = readdirSync(testDir).sort();
    const diagnostics = readConfigDiagnostics();
    const afterFiles = readdirSync(testDir).sort();

    expect(diagnostics).toEqual({
      config: getDefaultConfig(),
      source: "default",
      error: null,
    });
    expect(afterFiles).toEqual(beforeFiles);
  });

  test("malformed config diagnostics fall back without backup or raw content", () => {
    writeConfig('{ "apiKey": "sk-secret-leak", invalid json');
    const beforeFiles = readdirSync(testDir).sort();

    const diagnostics = readConfigDiagnostics();
    const afterFiles = readdirSync(testDir).sort();

    expect(diagnostics.config).toEqual(getDefaultConfig());
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toBe("invalid_json");
    expect(JSON.stringify(diagnostics)).not.toContain("sk-secret-leak");
    expect(afterFiles).toEqual(beforeFiles);
    expect(backupNames()).toHaveLength(0);
  });

  test("resolves relative OPENCODEX_HOME once to an absolute config directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-parent-"));
    const oldCwd = process.cwd();
    try {
      process.env.OPENCODEX_HOME = "relative-home";
      process.chdir(parent);
      const firstPath = getConfigPath();
      const expectedConfigDir = resolve("relative-home");

      process.chdir(tmpdir());

      expect(firstPath).toBe(join(expectedConfigDir, "config.json"));
      expect(getConfigPath()).toBe(firstPath);
      expect(getPidPath()).toBe(join(expectedConfigDir, "ocx.pid"));
    } finally {
      process.chdir(oldCwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("uses the default home when OPENCODEX_HOME is unset", () => {
    delete process.env.OPENCODEX_HOME;

    expect(getConfigPath()).toBe(join(homedir(), ".opencodex", "config.json"));
    expect(getPidPath()).toBe(join(homedir(), ".opencodex", "ocx.pid"));
  });

  test("loads UTF-8 BOM config files written by Windows tools", () => {
    writeFileSync(
      getConfigPath(),
      `\uFEFF${JSON.stringify({
        port: 23456,
        providers: {
          custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
        },
        defaultProvider: "custom",
      })}`,
      "utf-8",
    );

    expect(loadConfig()).toMatchObject({
      port: 23456,
      defaultProvider: "custom",
    });
  });

  test("backs up invalid JSON config before falling back to defaults", () => {
    writeConfig("{ invalid json");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      expect(loaded).toEqual(getDefaultConfig());
      const backups = backupNames();
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(testDir, backups[0]), "utf-8")).toBe("{ invalid json");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Could not load opencodex config"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("repairs structurally incomplete config by merging defaults instead of rejecting", () => {
    writeConfig({ port: 10100 });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      // Merge should fill in missing providers and defaultProvider from defaults
      expect(loaded.port).toBe(10100);
      expect(loaded.defaultProvider).toBe("openai");
      expect(loaded.providers).toBeDefined();
      // No backup created — config was repaired, not rejected
      const backups = backupNames();
      expect(backups).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("repaired"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("backs up config when defaultProvider is absent from providers", () => {
    writeConfig({
      port: 10100,
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
      defaultProvider: "missing",
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      expect(loaded).toEqual(getDefaultConfig());
      const backups = backupNames();
      expect(backups).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("defaultProvider must exist in providers"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("diagnoses config with unsafe provider URLs or sensitive headers", () => {
    for (const provider of [
      { adapter: "openai-chat", baseUrl: "file:///tmp/provider" },
      { adapter: "openai-chat", baseUrl: "https://user:pass@example.test/v1" },
      { adapter: "openai-chat", baseUrl: "https://example.test/v1?token=secret" },
      { adapter: "openai-chat", baseUrl: "https://example.test/v1", headers: { Authorization: "Bearer secret" } },
      { adapter: "openai-chat", baseUrl: "https://example.test/v1", headers: { "X-Custom": "ok\r\nInjected: yes" } },
    ]) {
      rmSync(testDir, { recursive: true, force: true });
      mkdirSync(testDir, { recursive: true });
      writeConfig({
        port: 10100,
        providers: { custom: provider },
        defaultProvider: "custom",
      });

      const diagnostics = readConfigDiagnostics();

      expect(diagnostics.config).toEqual(getDefaultConfig());
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain("providers.custom");
      expect(JSON.stringify(diagnostics)).not.toContain("Bearer secret");
    }
  });

  test("validates provider context cap maps explicitly", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      providerContextCaps: { custom: 350_000 },
    });

    expect(loadConfig().providerContextCaps).toEqual({ custom: 350_000 });

    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      providerContextCaps: { custom: -1 },
    });

    const diagnostics = readConfigDiagnostics();

    expect(diagnostics.config).toEqual(getDefaultConfig());
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("providerContextCaps");
  });

  test("validates the global context cap value", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      contextCapValue: 500_000,
    });

    expect(loadConfig().contextCapValue).toBe(500_000);

    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      contextCapValue: -5,
    });

    const diagnostics = readConfigDiagnostics();

    expect(diagnostics.config).toEqual(getDefaultConfig());
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("contextCapValue");
  });

  test("backs up config when provider validation fails during load", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", headers: { Authorization: "Bearer secret" } },
      },
      defaultProvider: "custom",
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      expect(loaded).toEqual(getDefaultConfig());
      expect(backupNames()).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("providers.custom.headers"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("provider names reject namespace-breaking and reserved object keys", () => {
    expect(isValidProviderName("openrouter")).toBe(true);
    expect(isValidProviderName("ollama-cloud")).toBe(true);
    expect(isValidProviderName("openrouter/custom")).toBe(false);
    expect(isValidProviderName("__proto__")).toBe(false);
    expect(isValidProviderName("constructor")).toBe(false);
  });

  test("backs up config when defaultProvider only exists on Object prototype", () => {
    writeConfig({
      port: 10100,
      providers: {},
      defaultProvider: "constructor",
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      expect(loaded).toEqual(getDefaultConfig());
      expect(backupNames()).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("defaultProvider must exist in providers"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("warns and backs up once per invalid config path", () => {
    writeConfig("{ invalid json");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(loadConfig()).toEqual(getDefaultConfig());
      expect(loadConfig()).toEqual(getDefaultConfig());

      expect(backupNames()).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("parses pid files", () => {
    expect(parsePidFile("12345")).toBe(12345);
    expect(parsePidFile("0")).toBeNull();
    expect(parsePidFile("12x")).toBeNull();
    expect(parsePidFile("not-json")).toBeNull();
  });

  test("recognizes opencodex start command lines", () => {
    expect(isOcxStartCommandLine('bun run src/cli.ts start')).toBe(true);
    expect(isOcxStartCommandLine('"C:/tools/bun/bin/bun.exe" "run" "src/cli.ts" "start"')).toBe(true);
    expect(isOcxStartCommandLine('bun C:/tools/bun/install/global/node_modules/@bitkyc08/opencodex/src/cli.ts start')).toBe(true);
    expect(isOcxStartCommandLine("opencodex start")).toBe(true);

    expect(isOcxStartCommandLine("bun run src/cli.ts status")).toBe(false);
    expect(isOcxStartCommandLine("bun test C:/work/opencodex/tests/config.test.ts")).toBe(false);
    expect(isOcxStartCommandLine("notepad.exe")).toBe(false);
  });

  test("writes pid file as a numeric pid", () => {
    writePid(process.pid);

    expect(readFileSync(getPidPath(), "utf-8")).toBe(String(process.pid));
  });

  test("removes pid file only when the expected pid still matches", () => {
    writeFileSync(getPidPath(), "111", "utf-8");
    removePid(222);
    expect(existsSync(getPidPath())).toBe(true);

    removePid(111);
    expect(existsSync(getPidPath())).toBe(false);
  });

  test("runtime port metadata round-trips and validates expected pid", () => {
    writeRuntimePort({ pid: 1234, port: 58195, hostname: "0.0.0.0" });

    expect(readRuntimePort()).toEqual({ pid: 1234, port: 58195, hostname: "0.0.0.0" });
    expect(readRuntimePort(1234)).toEqual({ pid: 1234, port: 58195, hostname: "0.0.0.0" });
    expect(readRuntimePort(9999)).toBeNull();
  });

  test("runtime port metadata removal preserves newer pid state", () => {
    writeRuntimePort({ pid: 1234, port: 58195 });

    removeRuntimePort(9999);
    expect(existsSync(getRuntimePortPath())).toBe(true);

    removeRuntimePort(1234);
    expect(existsSync(getRuntimePortPath())).toBe(false);
  });

  test("invalid runtime port metadata returns null", () => {
    writeFileSync(getRuntimePortPath(), JSON.stringify({ pid: 1234, port: 99999 }), "utf-8");

    expect(readRuntimePort()).toBeNull();
  });
});
