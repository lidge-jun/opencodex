import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeProjectCodexConfig,
  collectProjectCodexConfigWarnings,
  dedupeRelatedProjectCodexWarnings,
  discoverProjectCodexConfigPaths,
  groupProjectCodexConfigWarningsByPath,
  isGlobalOpencodexRoutingActive,
  parseTrustedProjectPathsFromCodexConfig,
} from "../src/codex/project-config-warnings";

const TEST_DIR = join(import.meta.dir, ".tmp-project-config-warnings");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
const TEST_PROJECT = join(TEST_DIR, "streamer-content");

let prevCodexHome: string | undefined;

describe("project config warnings", () => {
  beforeEach(() => {
    prevCodexHome = process.env.CODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_PROJECT, ".codex"), { recursive: true });
    process.env.CODEX_HOME = TEST_CODEX_HOME;
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("detects model_providers tables in project config", () => {
    const content = [
      'profile = "opencode_go"',
      "",
      "[model_providers.opencode_go]",
      'name = "OpenCode Go"',
      'base_url = "https://opencode.ai/zen/go/v1"',
      "",
    ].join("\n");
    const warnings = analyzeProjectCodexConfig(content, "/repo/.codex/config.toml");
    expect(warnings.some(w => w.code === "model_providers_table" && w.detail === "opencode_go")).toBe(true);
    expect(warnings.some(w => w.code === "profile_selector")).toBe(false);
  });

  test("keeps profile warning when no matching provider table exists", () => {
    const warnings = analyzeProjectCodexConfig('profile = "opencode_go"\n', "/repo/.codex/config.toml");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("profile_selector");
  });

  test("ignores opencodex provider table in project config", () => {
    const warnings = analyzeProjectCodexConfig("[model_providers.opencodex]\n", "/repo/.codex/config.toml");
    expect(warnings).toHaveLength(0);
  });

  test("parses trusted project paths from global config", () => {
    const content = [
      "[projects.'c:/users/jk/repo']",
      "trust_level = \"trusted\"",
      "",
    ].join("\n");
    expect(parseTrustedProjectPathsFromCodexConfig(content)).toEqual(["c:/users/jk/repo"]);
  });

  test("collects warnings only when global opencodex routing is active", () => {
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    writeFileSync(join(TEST_CODEX_HOME, "config.toml"), [
      "# Auto-injected by opencodex",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
      `[projects.'${TEST_PROJECT.replace(/\\/g, "\\\\")}']`,
      'trust_level = "trusted"',
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(TEST_PROJECT, ".codex", "config.toml"), [
      "[model_providers.opencode_go]",
      'name = "OpenCode Go"',
      "",
    ].join("\n"), "utf8");

    const active = isGlobalOpencodexRoutingActive(join(TEST_CODEX_HOME, "config.toml"));
    expect(active).toBe(true);

    const warnings = collectProjectCodexConfigWarnings({
      cwd: TEST_PROJECT,
      codexConfigPath: join(TEST_CODEX_HOME, "config.toml"),
    });
    expect(warnings.some(w => w.code === "model_providers_table")).toBe(true);
  });

  test("returns no warnings when global routing is inactive", () => {
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    writeFileSync(join(TEST_CODEX_HOME, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    writeFileSync(join(TEST_PROJECT, ".codex", "config.toml"), "[model_providers.opencode_go]\n", "utf8");

    const warnings = collectProjectCodexConfigWarnings({
      cwd: TEST_PROJECT,
      codexConfigPath: join(TEST_CODEX_HOME, "config.toml"),
    });
    expect(warnings).toHaveLength(0);
  });

  test("discovers project config from cwd walk", () => {
    writeFileSync(join(TEST_PROJECT, ".codex", "config.toml"), "model = \"gpt-5.5\"\n", "utf8");
    const nested = join(TEST_PROJECT, "src", "app");
    mkdirSync(nested, { recursive: true });
    const paths = discoverProjectCodexConfigPaths({
      cwd: nested,
      codexConfigPath: join(TEST_CODEX_HOME, "config.toml"),
    });
    expect(paths).toContain(join(TEST_PROJECT, ".codex", "config.toml"));
  });

  test("groups warnings by project path for compact output", () => {
    const warnings = analyzeProjectCodexConfig([
      'profile = "opencode_go"',
      "",
      "[model_providers.opencode_go]",
      'name = "OpenCode Go"',
      "",
    ].join("\n"), "/repo/.codex/config.toml");
    const grouped = groupProjectCodexConfigWarningsByPath(warnings);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.issues).toEqual(["[model_providers.opencode_go]"]);
    expect(grouped[0]?.bypass).toContain("OpenCode Go");
    expect(grouped[0]?.bypass).toContain("Overrides OpenCodex");
  });
});
