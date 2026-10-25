import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLazyCodex } from "../../src/clients/lazycodex";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ENABLED = '[plugins."omo@sisyphuslabs"]\nenabled = true\n';
let root = "";
let codexHome = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-lazycodex-detect-"));
  codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
});

afterEach(() => removeTreeWithRetry(root));

function install(version = "5.1.1"): void {
  const dir = join(codexHome, "plugins", "cache", "sisyphuslabs", "omo", version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lazycodex-install.json"), '{ "version": "5.1.1" }');
}

describe("detectLazyCodex", () => {
  test("needs the omo@sisyphuslabs Codex plugin both enabled and installed", () => {
    writeFileSync(join(codexHome, "config.toml"), ENABLED);
    install();
    expect(detectLazyCodex(codexHome)).toEqual({ detected: true, pluginEnabled: true, pluginInstalled: true });
  });

  test("an enabled entry without an installed copy, or a copy that is disabled, is not LazyCodex", () => {
    writeFileSync(join(codexHome, "config.toml"), ENABLED);
    expect(detectLazyCodex(codexHome)).toEqual({ detected: false, pluginEnabled: true, pluginInstalled: false });
    install();
    writeFileSync(join(codexHome, "config.toml"), '[plugins."omo@sisyphuslabs"]\nenabled = false\n');
    expect(detectLazyCodex(codexHome)).toEqual({ detected: false, pluginEnabled: false, pluginInstalled: true });
  });

  test("a marketplace-synced copy counts by its plugin manifest, without the npx receipt", () => {
    writeFileSync(join(codexHome, "config.toml"), ENABLED);
    const dir = join(codexHome, "plugins", "cache", "sisyphuslabs", "omo", "5.1.45");
    mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(join(dir, ".codex-plugin", "plugin.json"), '{ "name": "omo", "version": "5.1.45" }');
    mkdirSync(join(codexHome, "plugins", "cache", "sisyphuslabs", "omo", "5.1.44"), { recursive: true });
    expect(detectLazyCodex(codexHome)).toEqual({ detected: true, pluginEnabled: true, pluginInstalled: true });
  });

  test("a plugin directory with neither the manifest nor the receipt does not count", () => {
    writeFileSync(join(codexHome, "config.toml"), ENABLED);
    mkdirSync(join(codexHome, "plugins", "cache", "sisyphuslabs", "omo", "5.1.1"), { recursive: true });
    expect(detectLazyCodex(codexHome).detected).toBe(false);
  });

  test("Pi-based and OpenCode-based omo footprints alone are not LazyCodex", () => {
    const home = join(root, "home");
    mkdirSync(join(home, ".omo", "agent"), { recursive: true });
    writeFileSync(join(home, ".omo", "agent", "models.json"), "{}");
    writeFileSync(join(home, ".omo", "omo.jsonc"), '{ "codex": { "agents": {} } }');
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "oh-my-opencode.jsonc"), "{}");
    expect(detectLazyCodex(codexHome).detected).toBe(false);
    expect(detectLazyCodex(join(root, "missing")).detected).toBe(false);
  });

  test("an unparsable config.toml reads as not enabled", () => {
    writeFileSync(join(codexHome, "config.toml"), "[plugins\n");
    install();
    expect(detectLazyCodex(codexHome)).toEqual({ detected: false, pluginEnabled: false, pluginInstalled: true });
  });
});
