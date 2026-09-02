import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  analyzeProjectCodexConfig,
  collectProjectCodexConfigWarnings,
  discoverProjectCodexConfigPaths,
  explainProjectConfigBypass,
  isGlobalOpencodexRoutingActive,
  invalidateProjectConfigDiagnosticsCache,
  parseTomlDocument,
  parseTrustedProjectPathsFromCodexConfig,
  relPath,
  resolveEffectiveProjectModelProvider,
} from "../src/codex/project-config-warnings";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
  removeTreeWithRetry(testDir);
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

describe("parseTomlDocument", () => {
    test("malformed basic strings cannot wedge parsing and escaped strings still parse", () => {
      const malformed = parseTomlDocument('model_provider = "' + "\\".repeat(64));
      expect(typeof malformed.root.model_provider).toBe("string");

      const valid = parseTomlDocument('model_provider = "provider\\\\name"');
      expect(valid.root.model_provider).toBe("provider\\name");
    }, 2_000);
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
  test("does not discover the global config when walking through its parent directory", () => {
    const userHome = join(testDir, "user-home");
    const codexConfigPath = join(userHome, ".codex", "config.toml");
    const projectDir = join(userHome, "work", "project");
    const projectConfigPath = join(projectDir, ".codex", "config.toml");
    const nestedCwd = join(projectDir, "nested");
    mkdirSync(join(userHome, ".codex"), { recursive: true });
    mkdirSync(join(projectDir, ".codex"), { recursive: true });
    mkdirSync(nestedCwd, { recursive: true });
    writeFileSync(codexConfigPath, `model_provider = "opencodex-retry"`);
    writeFileSync(projectConfigPath, `model_provider = "anthropic"`);

    // Bound the walk to the fixture. On Windows the OS temp directory lives under
    // C:\Users\<user>, so an unbounded 12-parent walk climbs out of the fixture and
    // finds the developer's REAL ~/.codex/config.toml -- which the identity check
    // cannot exclude, because it is a genuinely different file from the fixture's
    // codexConfigPath. The assertion is about not rediscovering the global config
    // through a parent walk, not about how far the walk may travel.
    expect(discoverProjectCodexConfigPaths({ cwd: nestedCwd, codexConfigPath, maxWalkParents: 3 }))
      .toEqual([projectConfigPath]);
  });

  test("does not discover a project candidate that aliases the global config through a symlink", () => {
    if (process.platform === "win32") return;
    const userHome = join(testDir, "symlink-home");
    const candidatePath = join(userHome, ".codex", "config.toml");
    const globalAlias = join(testDir, "global-config-link.toml");
    const projectDir = join(userHome, "work", "project");
    mkdirSync(join(userHome, ".codex"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(candidatePath, `model_provider = "opencodex-retry"`);
    symlinkSync(candidatePath, globalAlias);

    expect(discoverProjectCodexConfigPaths({ cwd: projectDir, codexConfigPath: globalAlias }))
      .not.toContain(candidatePath);
  });

  test("skips untrusted projects even when they define bypass config", () => {
    const escaped = testDir.replace(/\\/g, "\\\\");
    const projectDir = join(testDir, "proj");
    const codexConfigPath = join(process.env.CODEX_HOME!, "config.toml");
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
    expect(collectProjectCodexConfigWarnings({ cwd: testDir, codexConfigPath })).toEqual([]);
  });

  test("uncached collection reflects project config changes", () => {
    const projectDir = join(testDir, "proj");
    const codexConfigPath = join(process.env.CODEX_HOME!, "config.toml");
    const projectConfigPath = join(projectDir, ".codex", "config.toml");
    writeGlobalRoutingConfig(`
[projects.'${projectDir}']
trust_level = "trusted"
`);
    mkdirSync(join(projectDir, ".codex"), { recursive: true });
    writeFileSync(projectConfigPath, `
model_provider = "anthropic"
[model_providers.anthropic]
name = "anthropic"
`);
    // Parent discovery may legitimately find a real user config above the OS temp
    // directory, so scope this assertion to the fixture project.
    const first = collectProjectCodexConfigWarnings({ cwd: testDir, codexConfigPath })
      .filter(warning => warning.path === projectConfigPath);
    expect(first.length).toBe(1);
    writeFileSync(projectConfigPath, `model_provider = "openai"`);
    // Direct collection bypasses the diagnostics cache and sees the new file.
    const second = collectProjectCodexConfigWarnings({ cwd: testDir, codexConfigPath })
      .filter(warning => warning.path === projectConfigPath);
    expect(second.length).toBe(0);
  });
});

describe("explainProjectConfigBypass", () => {
  const warningFor = (detail: string) => [{
    path: "/repo/.codex/config.toml",
    code: "model_provider_root" as const,
    detail,
    message: "fixture",
  }];

  test("humanizes OpenCode provider families only at an identifier boundary", () => {
    expect(explainProjectConfigBypass(warningFor("opencode"))).toContain("uses OpenCode ");
    expect(explainProjectConfigBypass(warningFor("opencode-go"))).toContain("uses OpenCode ");
    expect(explainProjectConfigBypass(warningFor("opencode_go"))).toContain("uses OpenCode Go ");
  });

  test("does not mislabel OpenCodex-prefixed provider ids as OpenCode", () => {
    expect(explainProjectConfigBypass(warningFor("opencodex"))).toContain("uses OpenCodex ");
    expect(explainProjectConfigBypass(warningFor("opencodex-retry")))
      .toContain("uses opencodex-retry ");
    expect(explainProjectConfigBypass(warningFor("opencodeish"))).toContain("uses opencodeish ");
  });
});
