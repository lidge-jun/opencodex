import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnoseCodexBundledPlugins, locateCurrentBundledMarketplace } from "../src/codex/plugins-doctor";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

function makeConfig(body: string): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "ocx-codex-home-"));
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, body, "utf8");
  return { dir, configPath };
}

describe("diagnoseCodexBundledPlugins (direct, platform-injected)", () => {
  test("non-Windows is reported as not applicable", () => {
    const result = diagnoseCodexBundledPlugins({ platform: "darwin" });
    expect(result.applicable).toBe(false);
    if (!result.applicable) expect(result.reason).toBe("not_windows");
  });

  test("missing config.toml is not applicable on Windows", () => {
    const result = diagnoseCodexBundledPlugins({
      platform: "win32",
      configPath: join(tmpdir(), "definitely-missing-codex-config-xyz.toml"),
    });
    expect(result.applicable).toBe(false);
    if (!result.applicable) expect(result.reason).toBe("config_unreadable");
  });

  test("stale: local source that does not resolve to a manifest is flagged", () => {
    const stalePath = join(tmpdir(), "Codex_1.0.0", "plugins", "openai-bundled");
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = ${JSON.stringify(stalePath)}\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.stale).toBe(true);
        expect(result.marketplace.present).toBe(true);
        expect(result.marketplace.resolvesToManifest).toBe(false);
        expect(result.suggestedRepair).not.toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("healthy: local source with a supported manifest resolves", () => {
    const marketRoot = mkdtempSync(join(tmpdir(), "ocx-bundled-root-"));
    mkdirSync(join(marketRoot, ".agents", "plugins"), { recursive: true });
    writeFileSync(join(marketRoot, ".agents", "plugins", "marketplace.json"), "{}", "utf8");
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = ${JSON.stringify(marketRoot)}\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.stale).toBe(false);
        expect(result.marketplace.resolvesToManifest).toBe(true);
        expect(result.suggestedRepair).toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(marketRoot, { recursive: true, force: true });
    }
  });

  test("absent marketplace entry is present:false and not stale", () => {
    const { dir, configPath } = makeConfig(`model = "gpt-5"\n`);
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.present).toBe(false);
        expect(result.stale).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("registered source path is username-masked in output", () => {
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = "C:\\\\Users\\\\alice\\\\AppData\\\\Codex_1.2.3\\\\openai-bundled"\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.source).toContain("[USER]");
        expect(result.marketplace.source).not.toContain("alice");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects configured bundled plugin tables", () => {
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = "X:\\\\gone"\n\n[plugins."computer-use@openai-bundled"]\nenabled = true\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        const cu = result.bundledPlugins.find(p => p.id === "computer-use");
        expect(cu?.configured).toBe(true);
        const chrome = result.bundledPlugins.find(p => p.id === "chrome");
        expect(chrome?.configured).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parses a table header with a trailing inline comment", () => {
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled] # bundled\nsource_type = "local"\nsource = "X:\\\\gone"\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.present).toBe(true);
        expect(result.marketplace.sourceType).toBe("local");
        expect(result.stale).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CRLF config with a header inline comment still parses (Windows native)", () => {
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]  # x\r\nsource_type = "local"\r\nsource = "X:\\\\gone"\r\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.present).toBe(true);
        expect(result.marketplace.sourceType).toBe("local");
        expect(result.stale).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CRLF config with key/value inline comments does not false-report healthy", () => {
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\r\nsource_type = "local"  # t\r\nsource = "X:\\\\gone"  # p\r\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.sourceType).toBe("local");
        expect(result.marketplace.source).not.toBeNull();
        expect(result.stale).toBe(true); // must NOT collapse to "ok"
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sensitive path segments are masked so no forbidden substring leaks", () => {
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = "C:\\\\Users\\\\bob\\\\token\\\\my-email\\\\openai-bundled"\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        const src = (result.marketplace.source ?? "").toLowerCase();
        for (const forbidden of ["token", "email", "apikey", "secret", "password"]) {
          expect(src).not.toContain(forbidden);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("present-but-not-local entry is not reported as healthy", () => {
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\nsource_type = "git"\nsource = "https://example.com/repo"\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.present).toBe(true);
        expect(result.marketplace.resolvesToManifest).toBe(false);
        expect(result.summary).not.toContain("ok:");
        expect(result.summary.toLowerCase()).toContain("not a usable local source");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("locateCurrentBundledMarketplace (injected fs)", () => {
  test("finds a versioned app dir whose bundled marketplace has a manifest", () => {
    const base = join("BASE");
    const env = { LOCALAPPDATA: base } as NodeJS.ProcessEnv;
    const appRoot = join(base, "Programs", "@openai", "codex");
    const versioned = join(appRoot, "app-2.0.6", "plugins", "bundled-marketplaces", "openai-bundled");
    const found = locateCurrentBundledMarketplace({
      env,
      listDir: (dir: string) => (dir === appRoot ? ["app-2.0.5", "app-2.0.6"] : []),
      isManifestRoot: (dir: string) => dir === versioned,
      mtimeOf: () => 1,
    });
    expect(found).toBe(versioned);
  });

  test("returns null when no candidate has a manifest", () => {
    const found = locateCurrentBundledMarketplace({
      env: { LOCALAPPDATA: "C:\\x" } as NodeJS.ProcessEnv,
      listDir: () => ["v1"],
      isManifestRoot: () => false,
      mtimeOf: () => 0,
    });
    expect(found).toBeNull();
  });
});

describe("diagnose path-mismatch (current vs registered)", () => {
  test("registered path differing from the live app path is flagged stale", () => {
    // The registered source must actually resolve to a manifest so we isolate
    // the path-mismatch signal (not the "no longer resolves" branch).
    const registered = mkdtempSync(join(tmpdir(), "ocx-registered-"));
    mkdirSync(join(registered, ".agents", "plugins"), { recursive: true });
    writeFileSync(join(registered, ".agents", "plugins", "marketplace.json"), "{}", "utf8");
    const live = "C:\\Users\\bob\\AppData\\Local\\Programs\\@openai\\codex\\app-2.0.6\\plugins\\bundled-marketplaces\\openai-bundled";
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = ${JSON.stringify(registered)}\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({
        platform: "win32",
        configPath,
        locateCurrent: () => live,
      });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.resolvesToManifest).toBe(true);
        expect(result.marketplace.pathMismatch).toBe(true);
        expect(result.stale).toBe(true);
        expect(result.marketplace.currentBundledPath).toContain("[USER]");
        expect(result.summary.toLowerCase()).toContain("differs");
        expect(result.suggestedRepair).not.toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(registered, { recursive: true, force: true });
    }
  });

  test("matching live and registered path is healthy (no mismatch)", () => {
    const shared = mkdtempSync(join(tmpdir(), "ocx-shared-"));
    mkdirSync(join(shared, ".claude-plugin"), { recursive: true });
    writeFileSync(join(shared, ".claude-plugin", "marketplace.json"), "{}", "utf8");
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = ${JSON.stringify(shared)}\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({
        platform: "win32",
        configPath,
        locateCurrent: () => shared,
      });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.pathMismatch).toBe(false);
        expect(result.stale).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(shared, { recursive: true, force: true });
    }
  });
});

describe("ocx status --json codexPlugins (spawned, read-only)", () => {
  test("status --json includes a codexPlugins block and never writes CODEX_HOME", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-home-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-codex-home-"));
    writeFileSync(join(codexHome, "config.toml"), `model = "gpt-5"\n`, "utf8");
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
      port: 9, providers: {}, defaultProvider: "openai", codexAutoStart: false,
    }), "utf8");
    try {
      const before = readdirSync(codexHome).sort();
      const result = spawnSync(process.execPath, [cliPath, "status", "--json"], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: opencodexHome, CODEX_HOME: codexHome },
        encoding: "utf8",
      });
      const after = readdirSync(codexHome).sort();

      expect(result.status).toBe(0);
      expect(after).toEqual(before); // read-only: no files added to CODEX_HOME

      const parsed = JSON.parse(result.stdout) as {
        codexPlugins?: { applicable?: unknown };
      };
      expect(parsed.codexPlugins).toBeDefined();
      expect(typeof parsed.codexPlugins?.applicable).toBe("boolean");
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
