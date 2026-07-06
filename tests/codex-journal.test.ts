import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function runScript(codexHome: string, script: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: "utf8",
  });
  return { stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "", status: result.status ?? 1 };
}

describe("codex-journal", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ocx-journal-"));
    writeFileSync(join(testDir, "config.toml"), "# original config\nmodel_provider = \"openai\"\n", "utf8");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("writeJournal creates journal file", () => {
    const r = runScript(testDir, `
      const { writeJournal } = require("./src/codex/journal");
      writeJournal();
      const fs = require("fs");
      const path = require("path");
      const journalPath = path.join(process.env.CODEX_HOME, "opencodex-journal.json");
      const exists = fs.existsSync(journalPath);
      const data = exists ? JSON.parse(fs.readFileSync(journalPath, "utf-8")) : null;
      console.log(JSON.stringify({ exists, version: data?.version, hasPid: typeof data?.pid === "number" }));
    `);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.exists).toBe(true);
    expect(out.version).toBe(1);
    expect(out.hasPid).toBe(true);
  });

  test("reconcileJournal restores config when journaled PID is dead", () => {
    const journalPath = join(testDir, "opencodex-journal.json");
    const original = "# original config\nmodel_provider = \"openai\"\n";
    const modified = "# modified\nmodel_provider = \"opencodex\"\n";
    writeFileSync(join(testDir, "config.toml"), modified, "utf8");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from(original).toString("base64"),
      originalProfile: null,
      pid: 999999,
      timestamp: new Date().toISOString(),
    }), "utf8");

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      const result = reconcileJournal();
      console.log(JSON.stringify({ restored: result }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).restored).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("reconcileJournal handles corrupt JSON gracefully", () => {
    const journalPath = join(testDir, "opencodex-journal.json");
    writeFileSync(journalPath, "NOT VALID JSON{{{", "utf8");

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      const result = reconcileJournal();
      console.log(JSON.stringify({ restored: result }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).restored).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("reconcileJournal no-ops when no journal exists", () => {
    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      const result = reconcileJournal();
      console.log(JSON.stringify({ restored: result }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).restored).toBe(false);
  });

  test("reconcileJournal skips when journaled PID is alive", () => {
    const journalPath = join(testDir, "opencodex-journal.json");
    const modified = "# modified by opencodex\n";
    writeFileSync(join(testDir, "config.toml"), modified, "utf8");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from("# original\n").toString("base64"),
      originalProfile: null,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    }), "utf8");

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      const result = reconcileJournal();
      console.log(JSON.stringify({ restored: result }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).restored).toBe(false);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(modified);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("removeJournal cleans up", () => {
    const journalPath = join(testDir, "opencodex-journal.json");
    writeFileSync(journalPath, "{}", "utf8");

    const r = runScript(testDir, `
      const { removeJournal } = require("./src/codex/journal");
      removeJournal();
      const fs = require("fs");
      const path = require("path");
      console.log(JSON.stringify({ exists: fs.existsSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json")) }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).exists).toBe(false);
  });

  test("restoreNativeCodex uses journal snapshot for normal stop without losing custom defaults", () => {
    const originalConfig = [
      'model = "openrouter/foo"',
      'model_provider = "proxy"',
      "",
      "[model_providers.proxy]",
      'name = "Existing Proxy"',
      'base_url = "https://proxy.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    const originalProfile = [
      'model = "gpt-5.5"',
      'model_provider = "openai"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), originalConfig, "utf8");
    writeFileSync(join(testDir, "opencodex.config.toml"), originalProfile, "utf8");

    const r = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const { writeJournal } = require("./src/codex/journal");
      const { restoreNativeCodex } = require("./src/codex/inject");
      writeJournal();
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), [
        'model_provider = "opencodex"',
        'model = "opencode-go/glm-5.2"',
        '',
        '[model_providers.opencodex]',
        'name = "OpenCodex Proxy"',
        'base_url = "http://localhost:10100/v1"',
        ''
      ].join("\\n"), "utf8");
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "opencodex.config.toml"), 'model_provider = "opencodex"\\n', "utf8");
      const result = restoreNativeCodex();
      console.log(JSON.stringify({ success: result.success, message: result.message }));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(originalConfig);
    expect(readFileSync(join(testDir, "opencodex.config.toml"), "utf8")).toBe(originalProfile);
    expect(existsSync(join(testDir, "opencodex-journal.json"))).toBe(false);
  });

  test("injectCodexConfig creates a restorable journal for direct sync/init paths", () => {
    const originalConfig = [
      'model = "openrouter/foo"',
      'model_provider = "proxy"',
      "",
      "[model_providers.proxy]",
      'name = "Existing Proxy"',
      'base_url = "https://proxy.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), originalConfig, "utf8");

    const r = runScript(testDir, `
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      (async () => {
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        const result = restoreNativeCodex();
        console.log(JSON.stringify({ success: result.success }));
      })();
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(originalConfig);
  });

  test("restoreNativeCodex does not clobber user config edits made after injection", () => {
    const originalConfig = "# original config\nmodel_provider = \"openai\"\n";
    writeFileSync(join(testDir, "config.toml"), originalConfig, "utf8");

    const r = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      (async () => {
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        fs.appendFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "\\n[tools]\\nweb_search = true\\n", "utf8");
        const result = restoreNativeCodex();
        console.log(JSON.stringify({ success: result.success, message: result.message }));
      })();
    `);

    expect(r.status).toBe(0);
    const restored = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(restored).toContain("[tools]");
    expect(restored).toContain("web_search = true");
    expect(restored).not.toContain("[model_providers.opencodex]");
    expect(existsSync(join(testDir, "opencodex-journal.json"))).toBe(true);
  });

  test("restoreNativeCodex restores unchanged profile even when config was edited after injection", () => {
    const originalConfig = "# original config\nmodel_provider = \"openai\"\n";
    const originalProfile = "model_provider = \"openai\"\nmodel = \"gpt-5.5\"\n";
    writeFileSync(join(testDir, "config.toml"), originalConfig, "utf8");
    writeFileSync(join(testDir, "opencodex.config.toml"), originalProfile, "utf8");

    const r = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      (async () => {
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        fs.appendFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "\\n[tools]\\nweb_search = true\\n", "utf8");
        const result = restoreNativeCodex();
        console.log(JSON.stringify({ success: result.success, message: result.message }));
      })();
    `);

    expect(r.status).toBe(0);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toContain("[tools]");
    expect(readFileSync(join(testDir, "opencodex.config.toml"), "utf8")).toBe(originalProfile);
    expect(existsSync(join(testDir, "opencodex-journal.json"))).toBe(true);
  });

  test("full lifecycle: write → crash → reconcile restores", () => {
    const r = runScript(testDir, `
      const { writeJournal } = require("./src/codex/journal");
      writeJournal();
      console.log("written");
    `);
    expect(r.status).toBe(0);

    const journalPath = join(testDir, "opencodex-journal.json");
    expect(existsSync(journalPath)).toBe(true);
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));

    writeFileSync(join(testDir, "config.toml"), "# injected opencodex config\n", "utf8");

    const r2 = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      const result = reconcileJournal();
      console.log(JSON.stringify({ restored: result }));
    `);
    expect(r2.status).toBe(0);
    expect(JSON.parse(r2.stdout).restored).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toContain("original config");
    expect(existsSync(journalPath)).toBe(false);
  });
});
