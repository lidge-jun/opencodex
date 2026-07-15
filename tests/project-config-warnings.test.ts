import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  analyzeProjectCodexConfig,
  collectProjectCodexConfigWarnings,
  getCachedProjectConfigDiagnostics,
  isGlobalOpencodexRoutingActive,
  invalidateProjectConfigDiagnosticsCache,
  parseTrustedProjectPathsFromCodexConfig,
  relPath,
  resolveEffectiveProjectModelProvider,
} from "../src/codex/project-config-warnings";

describe("relPath home containment (devlog 260715_cross_platform_audit/030)", () => {
  let savedUserProfile: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedUserProfile = process.env.USERPROFILE;
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  });

  function setHome(value: string) {
    process.env.USERPROFILE = value;
    delete process.env.HOME;
  }

  test("win32: contained descendants render as ~/, exact home as ~", () => {
    setHome("C:\\Users\\bob");
    expect(relPath("C:\\Users\\bob\\proj\\.codex\\config.toml", win32)).toBe("~/proj/.codex/config.toml");
    expect(relPath("C:\\Users\\bob", win32)).toBe("~");
    // relative() case-folds on win32 (drive letters and components).
    expect(relPath("c:\\users\\bob\\x", win32)).toBe("~/x");
  });

  test("win32: sibling prefix (bob vs bob2) is NOT rendered as home", () => {
    setHome("C:\\Users\\bob");
    expect(relPath("C:\\Users\\bob2\\proj\\config.toml", win32)).toBe("C:\\Users\\bob2\\proj\\config.toml");
  });

  test("win32: parent and cross-drive paths stay absolute", () => {
    setHome("C:\\Users\\bob");
    expect(relPath("C:\\Users", win32)).toBe("C:\\Users");
    expect(relPath("D:\\work\\config.toml", win32)).toBe("D:\\work\\config.toml");
  });

  test("posix: comparison is case-sensitive (no false ~ for different-case home)", () => {
    setHome("/home/Bob");
    expect(relPath("/home/bob/x", posix)).toBe("/home/bob/x");
    expect(relPath("/home/Bob/x", posix)).toBe("~/x");
  });

  test("no home env leaves paths untouched", () => {
    delete process.env.USERPROFILE;
    delete process.env.HOME;
    expect(relPath("/anywhere/x", posix)).toBe("/anywhere/x");
  });
});

let testDir = "";
let previousHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  testDir = join(tmpdir(), `ocx-proj-warn-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  process.env.OPENCODEX_HOME = testDir;
  // Isolate from the real user config — resolveCodexConfigPath reads CODEX_HOME.
  process.env.CODEX_HOME = join(testDir, "codex-home");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  invalidateProjectConfigDiagnosticsCache();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  invalidateProjectConfigDiagnosticsCache();
  rmSync(testDir, { recursive: true, force: true });
});

function writeGlobalRoutingConfig(extra = ""): void {
  const codexHome = process.env.CODEX_HOME!;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), `
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
    const projectDir = join(testDir, "proj");
    const codexConfigPath = join(process.env.CODEX_HOME!, "config.toml");
    writeGlobalRoutingConfig(`
[projects.'${projectDir}']
trust_level = "trusted"
`);
    mkdirSync(join(projectDir, ".codex"), { recursive: true });
    writeFileSync(join(projectDir, ".codex", "config.toml"), `
model_provider = "anthropic"
[model_providers.anthropic]
name = "anthropic"
`);
    // Use collectProjectCodexConfigWarnings with explicit cwd to avoid real-CWD leakage
    const first = collectProjectCodexConfigWarnings({ cwd: testDir, codexConfigPath });
    expect(first.length).toBe(1);
    writeFileSync(join(projectDir, ".codex", "config.toml"), `model_provider = "openai"`);
    // Stale call still returns old result (no invalidation)
    const second = collectProjectCodexConfigWarnings({ cwd: testDir, codexConfigPath });
    expect(second.length).toBe(0);
  });
});
