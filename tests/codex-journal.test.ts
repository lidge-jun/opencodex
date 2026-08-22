import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANAGED_AGENTS_TABLE_MARKER,
  MANAGED_SUBAGENT_DEFAULT_MARKER,
} from "../src/codex/subagent-defaults";
import { SPAWN_BUDGET_MS } from "./helpers/test-budget";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

setDefaultTimeout(SPAWN_BUDGET_MS);

function runScript(codexHome: string, script: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
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

  test("removeCodexConfig is a successful no-op when Codex is not installed", () => {
    writeFileSync(join(testDir, "opencodex.config.toml"), 'openai_base_url = "http://127.0.0.1:10100/v1"\n', "utf8");
    rmSync(join(testDir, "config.toml"));
    const r = runScript(testDir, `
      const { removeCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      console.log(JSON.stringify({ remove: removeCodexConfig(), restore: restoreNativeCodex() }));
    `);

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.remove.success).toBe(true);
    expect(result.remove.message).toContain("no native restore was needed");
    expect(result.restore.success).toBe(true);
    expect(existsSync(join(testDir, "opencodex.config.toml"))).toBe(false);
  });

  test("removeCodexConfig reports damaged managed-default cleanup and preserves the ambiguous value", () => {
    writeFileSync(join(testDir, "config.toml"), [
      "# Auto-injected by opencodex",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
      MANAGED_AGENTS_TABLE_MARKER,
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      "",
      'default_subagent_model = "gpt-5.6-sol"',
      "",
    ].join("\n"), "utf8");

    const r = runScript(testDir, `
      const { removeCodexConfig } = require("./src/codex/inject");
      console.log(JSON.stringify(removeCodexConfig()));
    `);

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(false);
    expect(result.message).toContain("could not be safely removed");
    expect(result.message).toContain("orphaned managed subagent default marker");
    const after = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(after).not.toContain("openai_base_url");
    expect(after).toContain("# Managed by opencodex: native subagent default");
    expect(after).toContain('default_subagent_model = "gpt-5.6-sol"');
  });

  test("removeCodexConfig ignores unsupported user-owned agents syntax when no managed marker exists", () => {
    const userAgents = 'agents = { default_subagent_model = "user/model" }';
    writeFileSync(join(testDir, "config.toml"), [
      "# Auto-injected by opencodex",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      userAgents,
      "",
    ].join("\n"), "utf8");

    const r = runScript(testDir, `
      const { removeCodexConfig } = require("./src/codex/inject");
      console.log(JSON.stringify(removeCodexConfig()));
    `);

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    const after = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(after).not.toContain("openai_base_url");
    expect(after).toContain(userAgents);
  });

  test("restoreNativeCodex restores an exact unchanged journal snapshot with managed defaults", () => {
    const original = '# original config\nmodel_provider = "openai"\n';
    writeFileSync(join(testDir, "config.toml"), original, "utf8");

    const r = runScript(testDir, `
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      (async () => {
        await injectCodexConfig(10100, {
          port: 10100,
          providers: {},
          defaultProvider: "openai",
          injectionModel: "gpt-5.6-sol",
          injectionEffort: "high",
          syncCodexSubagentDefaults: true,
        }, { catalogPath: null });
        console.log(JSON.stringify(restoreNativeCodex()));
      })();
    `);

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("restored from opencodex journal");
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(testDir, "opencodex-journal.json"))).toBe(false);
  });

  test("restoreNativeCodex reports damaged managed-default cleanup during fallback restore", () => {
    const original = '# original config\nmodel_provider = "openai"\n';
    writeFileSync(join(testDir, "config.toml"), original, "utf8");

    const r = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      (async () => {
        const configPath = path.join(process.env.CODEX_HOME, "config.toml");
        await injectCodexConfig(10100, {
          port: 10100,
          providers: {},
          defaultProvider: "openai",
          injectionModel: "gpt-5.6-sol",
          injectionEffort: "high",
          syncCodexSubagentDefaults: true,
        }, { catalogPath: null });
        const marker = ${JSON.stringify(MANAGED_SUBAGENT_DEFAULT_MARKER)};
        const injected = fs.readFileSync(configPath, "utf8");
        fs.writeFileSync(configPath, injected.replace(
          marker + '\\ndefault_subagent_model',
          marker + '\\n\\ndefault_subagent_model',
        ), "utf8");
        console.log(JSON.stringify(restoreNativeCodex()));
      })();
    `);

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(false);
    expect(result.message).toContain("could not be safely removed");
    expect(result.message).toContain("orphaned managed subagent default marker");
    const after = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(after).not.toContain("openai_base_url");
    expect(after).toContain("# Managed by opencodex: native subagent default");
    expect(after).toContain('default_subagent_model = "gpt-5.6-sol"');
    expect(existsSync(join(testDir, "opencodex-journal.json"))).toBe(true);
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
        await injectCodexConfig(10100, {
          port: 10100,
          providers: {},
          defaultProvider: "openai",
          injectionModel: "gpt-5.6-sol",
          injectionEffort: "high",
          syncCodexSubagentDefaults: true,
        }, { catalogPath: null });
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
    expect(restored).not.toContain("Managed by opencodex: native subagent");
    expect(restored).not.toContain("default_subagent_model");
    expect(restored).not.toContain("default_subagent_reasoning_effort");
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

  /**
   * Issue #477. `writeJournal` used to return early whenever a valid journal
   * existed, so the first snapshot a machine ever took was the only one it ever
   * had. A partial restore leaves the journal behind (see the two tests above),
   * so that state is ordinary — and days later an unclean shutdown would replay
   * the day-one config over plugins, model choice and trusted projects.
   */
  test("a stale journal is superseded once the config is native again (#477)", () => {
    const r = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      const configPath = path.join(process.env.CODEX_HOME, "config.toml");
      (async () => {
        // Day one: inject, then edit while routing is live so the stop leaves the journal.
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        fs.appendFileSync(configPath, '\\n[projects."/tmp/day-one"]\\ntrust_level = "trusted"\\n', "utf8");
        restoreNativeCodex();
        // Day four: the user installs a plugin while opencodex is not running.
        fs.appendFileSync(configPath, '\\n[plugins."browser@openai-bundled"]\\nenabled = true\\n', "utf8");
        const nativeBaseline = fs.readFileSync(configPath, "utf8");
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        console.log(JSON.stringify({ nativeBaseline }));
      })();
    `);
    expect(r.status).toBe(0);
    const { nativeBaseline } = JSON.parse(r.stdout) as { nativeBaseline: string };

    const journalPath = join(testDir, "opencodex-journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    expect(Buffer.from(journal.originalConfig, "base64").toString("utf8")).toBe(nativeBaseline);
    // A refreshed record is a new transaction: the day-one fingerprint is gone,
    // replaced by one for the injection that just ran.
    expect(typeof journal.injectedConfigHash).toBe("string");

    // And recovery works end to end: an unclean shutdown restores day four.
    const r2 = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const journalPath = path.join(process.env.CODEX_HOME, "opencodex-journal.json");
      const j = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      fs.writeFileSync(journalPath, JSON.stringify({ ...j, pid: 999999 }));
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify({ restored: reconcileJournal() }));
    `);
    expect(r2.status).toBe(0);
    expect(JSON.parse(r2.stdout).restored).toBe(true);
    const recovered = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(recovered).toContain("browser@openai-bundled");
    expect(recovered).not.toContain("[model_providers.opencodex]");
    expect(recovered).not.toContain("Auto-injected by opencodex");
  });

  /**
   * The guard the #477 fix must not break. Deleting the early return outright —
   * the fix the issue suggests — would let the second injection of a start
   * capture the ALREADY-INJECTED config as the user's original, and a later
   * restore would then replay opencodex routing as if the user had written it.
   */
  test("re-injecting over an injected config never captures it as the original (#477)", () => {
    const original = '# original config\nmodel_provider = "openai"\n';
    writeFileSync(join(testDir, "config.toml"), original, "utf8");

    const r = runScript(testDir, `
      const { injectCodexConfig } = require("./src/codex/inject");
      (async () => {
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        console.log("done");
      })();
    `);
    expect(r.status).toBe(0);
    const journal = JSON.parse(readFileSync(join(testDir, "opencodex-journal.json"), "utf8"));
    expect(Buffer.from(journal.originalConfig, "base64").toString("utf8")).toBe(original);
  });

  /**
   * The reachable case a "replace only when a journal exists" gate would miss:
   * an injected config with NO journal, which is exactly where the legacy upgrade
   * path in tests/codex-inject-integration.test.ts starts.
   */
  test("an injected config with no journal is never captured as the original (#477)", () => {
    const injected = [
      'model_provider = "opencodex"',
      "",
      "# Auto-injected by opencodex",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), injected, "utf8");

    const r = runScript(testDir, `
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      (async () => {
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        restoreNativeCodex();
        console.log("done");
      })();
    `);
    expect(r.status).toBe(0);

    const after = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(after).not.toContain("[model_providers.opencodex]");
    expect(after).not.toContain("Auto-injected by opencodex");
  });

  /**
   * Documents why no PID-based transaction guard is needed. `ocx sync` and the
   * `ocx ensure` parent legitimately inject in a process that did not write the
   * journal, and the only journal a marking process ever meets is hashless —
   * a refresh rebuilds the record, and a non-refresh means the previous
   * transaction already completed.
   */
  test("a hashless journal from another process can still be marked (#477)", () => {
    runScript(testDir, `require("./src/codex/journal").writeJournal(); console.log("journaled");`);
    const journalPath = join(testDir, "opencodex-journal.json");
    const first = JSON.parse(readFileSync(journalPath, "utf8"));
    expect(first.injectedConfigHash).toBeUndefined();

    const r = runScript(testDir, `
      const { markJournalInjectedState } = require("./src/codex/journal");
      markJournalInjectedState("# injected\\n", null, {
        injectedOpenaiBaseUrl: null,
        injectedCatalogPath: null,
      });
      console.log(String(process.pid));
    `);
    expect(r.status).toBe(0);
    expect(Number(r.stdout)).not.toBe(first.pid);

    const second = JSON.parse(readFileSync(journalPath, "utf8"));
    expect(second.pid).toBe(first.pid);              // still the first process's record
    expect(typeof second.injectedConfigHash).toBe("string"); // marked by the second
  });

  test("reinjection keeps the first config hash while refreshing owned route and catalog", () => {
    const r = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const { writeJournal, markJournalInjectedState } = require("./src/codex/journal");
      const journalPath = path.join(process.env.CODEX_HOME, "opencodex-journal.json");
      writeJournal();
      markJournalInjectedState("# first injection\\n", null, {
        injectedOpenaiBaseUrl: "http://127.0.0.1:10100/v1",
        injectedCatalogPath: "first-catalog.json",
      });
      const first = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      markJournalInjectedState("# second injection\\n", "# second profile\\n", {
        injectedOpenaiBaseUrl: "http://127.0.0.1:10200/v1",
        injectedCatalogPath: "second-catalog.json",
      });
      const second = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      console.log(JSON.stringify({ firstHash: first.injectedConfigHash, secondHash: second.injectedConfigHash }));
    `);
    expect(r.status).toBe(0);
    const hashes = JSON.parse(r.stdout) as { firstHash: string; secondHash: string };
    expect(typeof hashes.firstHash).toBe("string");
    expect(hashes.firstHash).toBe(createHash("sha256").update("# first injection\n").digest("hex"));
    expect(hashes.secondHash).toBe(hashes.firstHash);

    const journal = JSON.parse(readFileSync(join(testDir, "opencodex-journal.json"), "utf8"));
    expect(Buffer.from(journal.originalConfig, "base64").toString("utf8")).toContain("# original config");
    expect(journal.injectedOpenaiBaseUrl).toBe("http://127.0.0.1:10200/v1");
    expect(journal.injectedCatalogPath).toBe("second-catalog.json");
    expect(typeof journal.injectedProfileHash).toBe("string");
  });

  test("writeJournal() with no options still snapshots a native config", () => {
    const r = runScript(testDir, `require("./src/codex/journal").writeJournal(); console.log("written");`);
    expect(r.status).toBe(0);
    const journal = JSON.parse(readFileSync(join(testDir, "opencodex-journal.json"), "utf8"));
    expect(Buffer.from(journal.originalConfig, "base64").toString("utf8")).toContain("original config");
  });

  test("writeJournal() with no options refuses an injected config", () => {
    writeFileSync(join(testDir, "config.toml"), [
      'model_provider = "opencodex"',
      "",
      "# Auto-injected by opencodex",
      "[model_providers.opencodex]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n"), "utf8");
    runScript(testDir, `require("./src/codex/journal").writeJournal(); console.log("done");`);
    expect(existsSync(join(testDir, "opencodex-journal.json"))).toBe(false);
  });
});
