import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeProjectCodexConfig,
  collectProjectCodexConfigWarnings,
  getCachedProjectConfigDiagnostics,
  isGlobalOpencodexRoutingActive,
  invalidateProjectConfigDiagnosticsCache,
  parseTrustedProjectPathsFromCodexConfig,
  resolveEffectiveProjectModelProvider,
} from "../src/codex/project-config-warnings";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = join(tmpdir(), `ocx-proj-warn-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  process.env.OPENCODEX_HOME = testDir;
  invalidateProjectConfigDiagnosticsCache();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  invalidateProjectConfigDiagnosticsCache();
  rmSync(testDir, { recursive: true, force: true });
});

function writeGlobalRoutingConfig(extra = ""): void {
  const codexDir = join(testDir, ".codex");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, "config.toml"), `
model_provider = "opencodex"
${extra}
`);
}

describe("isGlobalOpencodexRoutingActive", () => {
  test("detects injected openai_base_url marker", () => {
    const text = `
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"
model_provider = "opencodex"
`;
    expect(isGlobalOpencodexRoutingActive("unused", text)).toBe(true);
  });

  test("does not treat dormant model_providers.opencodex table as active routing", () => {
    const text = `
[model_providers.opencodex]
name = "opencodex"
base_url = "http://127.0.0.1:10100/v1"
`;
    expect(isGlobalOpencodexRoutingActive("unused", text)).toBe(false);
  });
});

describe("parseTrustedProjectPathsFromCodexConfig", () => {
  test("collects only trusted project paths", () => {
    const text = `
[projects.'C:\\repo-a']
trust_level = "trusted"

[projects.'C:\\repo-b']
trust_level = "untrusted"

[projects.'C:\\repo-c']
`;
    expect(parseTrustedProjectPathsFromCodexConfig(text)).toEqual(["C:\\repo-a"]);
  });
});

describe("resolveEffectiveProjectModelProvider", () => {
  test("resolves provider from selected profile", () => {
    const text = `
profile = "work"
model_provider = "openai"

[profiles.work]
model_provider = "anthropic"
`;
    expect(resolveEffectiveProjectModelProvider(text)).toEqual({
      provider: "anthropic",
      profileName: "work",
      via: "profile",
    });
  });

  test("root model_provider applies when profile has no model_provider", () => {
    const text = `
profile = "work"
model_provider = "anthropic"

[profiles.work]
approval_policy = "on-request"
`;
    expect(resolveEffectiveProjectModelProvider(text)).toEqual({
      provider: "anthropic",
      profileName: "work",
      via: "root",
    });
  });
});

describe("analyzeProjectCodexConfig", () => {
  test("ignores dormant provider tables", () => {
    const text = `
[model_providers.anthropic]
name = "anthropic"
base_url = "https://api.anthropic.com"
`;
    expect(analyzeProjectCodexConfig(text, "C:\\repo\\.codex\\config.toml")).toEqual([]);
  });

  test("ignores profile without model_provider override", () => {
    const text = `
profile = "work"

[profiles.work]
approval_policy = "on-request"
`;
    expect(analyzeProjectCodexConfig(text, "C:\\repo\\.codex\\config.toml")).toEqual([]);
  });

  test("warns when effective provider bypasses proxy", () => {
    const text = `
profile = "work"

[profiles.work]
model_provider = "anthropic"

[model_providers.anthropic]
name = "anthropic"
`;
    const warnings = analyzeProjectCodexConfig(text, "C:\\repo\\.codex\\config.toml");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("model_providers_table");
    expect(warnings[0]!.detail).toBe("anthropic");
    expect(warnings[0]!.profileName).toBe("work");
  });

  test("does not warn for openai provider under Design B", () => {
    const text = `
model_provider = "openai"
`;
    expect(analyzeProjectCodexConfig(text, "C:\\repo\\.codex\\config.toml")).toEqual([]);
  });
});

describe("collectProjectCodexConfigWarnings", () => {
  test("skips untrusted projects even when they define bypass config", () => {
    const escaped = testDir.replace(/\\/g, "\\\\");
    const projectDir = join(testDir, "proj");
    writeGlobalRoutingConfig(`
[projects.'${escaped}\\proj']
trust_level = "untrusted"
`);
    mkdirSync(join(projectDir, ".codex"), { recursive: true });
    writeFileSync(join(projectDir, ".codex", "config.toml"), `
model_provider = "anthropic"
[model_providers.anthropic]
name = "anthropic"
`);
    expect(collectProjectCodexConfigWarnings()).toEqual([]);
  });

  test("caches diagnostics for repeated API reads", () => {
    const escaped = testDir.replace(/\\/g, "\\\\");
    const projectDir = join(testDir, "proj");
    writeGlobalRoutingConfig(`
[projects.'${escaped}\\proj']
trust_level = "trusted"
`);
    mkdirSync(join(projectDir, ".codex"), { recursive: true });
    writeFileSync(join(projectDir, ".codex", "config.toml"), `
model_provider = "anthropic"
[model_providers.anthropic]
name = "anthropic"
`);
    const first = getCachedProjectConfigDiagnostics();
    expect(first.warnings.length).toBe(1);
    writeFileSync(join(projectDir, ".codex", "config.toml"), `model_provider = "openai"`);
    const second = getCachedProjectConfigDiagnostics();
    expect(second.warnings.length).toBe(1);
    invalidateProjectConfigDiagnosticsCache();
    const third = getCachedProjectConfigDiagnostics();
    expect(third.warnings).toEqual([]);
  });
});
