import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexConfigDrift } from "../../src/codex/config-drift-heal";
import { externalCodexModelProvider } from "../../src/codex/inject";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * The 26.924 Codex desktop update reserializes config.toml on its own schedule and the
 * rewrite strips opencodex's injected root keys (`openai_base_url`, the realtime sideband)
 * while writing its own base-url-less `model_provider = "custom"` placeholder. Two defects
 * compounded: the ownership guard counted that placeholder as an EXTERNAL gateway and made
 * every re-injection refuse (deleting the journal on that path), and nothing polled for the
 * drift, so the model list stayed gone until the next `ocx start`.
 *
 * The guard contract lives with the other guard tests (codex-admission); here we pin the
 * drift predicate and the full heal cycle end to end: inject, rewrite like the app does,
 * detect the missing keys, and re-inject through the same entry the tick's heal calls.
 */

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

const JOURNAL_URLS = {
  injectedOpenaiBaseUrl: "http://127.0.0.1:10100/backend-api/codex",
  injectedRealtimeWsBaseUrl: "http://127.0.0.1:10100/v1",
};

/** Inject, strip the injected root keys the way the 26.924 rewrite did, report the journal and drift. */
const INJECT_REWRITE_AND_REPORT_DRIFT = [
  'const fs = require("fs");',
  'const path = require("path");',
  'const { injectCodexConfig } = require("./src/codex/inject");',
  'const { codexConfigDrift } = require("./src/codex/config-drift-heal");',
  "(async () => {",
  "  const config = {",
  "    port: 10100,",
  "    providers: {},",
  '    defaultProvider: "openai",',
  '    injectionModel: "gpt-5.6-sol",',
  '    injectionEffort: "high",',
  "  };",
  "  await injectCodexConfig(10100, config, { catalogPath: null });",
  '  const configPath = path.join(process.env.CODEX_HOME, "config.toml");',
  "  // What the 26.924 rewrite produced on a live machine: our marker comments AND the",
  "  // injected root keys gone, replaced by the app's own base-url-less placeholder.",
  "  const rewritten = fs.readFileSync(configPath, \"utf8\")",
  "    .split(String.fromCharCode(10))",
  '    .filter(line => !line.trim().startsWith("#")',
  '      && !/^\\s*openai_base_url\\s*=/.test(line)',
  '      && !/^\\s*experimental_realtime_ws_base_url\\s*=/.test(line)',
  '      && !/^\\s*model_catalog_json\\s*=/.test(line))',
  "    .join(String.fromCharCode(10));",
  '  fs.writeFileSync(configPath, rewritten + String.fromCharCode(10) + \'model_provider = "custom"\' + String.fromCharCode(10) + "[model_providers.custom]" + String.fromCharCode(10) + \'name = "OpenAI"\' + String.fromCharCode(10), "utf8");',
  '  const journal = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"), "utf8"));',
  "  const drifted = codexConfigDrift(() => ({",
  "    injectedOpenaiBaseUrl: journal.injectedOpenaiBaseUrl,",
  "    injectedRealtimeWsBaseUrl: journal.injectedRealtimeWsBaseUrl,",
  "  }));",
  "  // The heal: re-run the standard injection against the rewritten bytes. This is the",
  "  // call the tick's healCodexConfigDrift makes after a positive drift check.",
  "  const healed = await injectCodexConfig(10100, config, { catalogPath: null });",
  '  const healedJournal = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"), "utf8"));',
  "  const after = codexConfigDrift(() => ({",
  "    injectedOpenaiBaseUrl: healedJournal.injectedOpenaiBaseUrl,",
  "    injectedRealtimeWsBaseUrl: healedJournal.injectedRealtimeWsBaseUrl,",
  "  }));",
  '  console.log(JSON.stringify({ drifted, healed: { success: healed.success, message: healed.message }, after, journalUrl: healedJournal.injectedOpenaiBaseUrl }));',
  "})();",
].join(String.fromCharCode(10));

/** Inject against a config carrying the 26.924 placeholder, report refusal status. */
const INJECT_ONTO_PLACEHOLDER = [
  'const { injectCodexConfig } = require("./src/codex/inject");',
  "(async () => {",
  "  const result = await injectCodexConfig(10100, {",
  "    port: 10100,",
  "    providers: {},",
  '    defaultProvider: "openai",',
  '    injectionModel: "gpt-5.6-sol",',
  '    injectionEffort: "high",',
  "  }, { catalogPath: null });",
  '  const fs = require("fs");',
  '  const path = require("path");',
  '  const injected = fs.existsSync(path.join(process.env.CODEX_HOME, "config.toml")) ? fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8") : null;',
  '  const journaled = fs.existsSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"));',
  '  console.log(JSON.stringify({ success: result.success, configApplied: result.configApplied, injected, journaled }));',
  "})();",
].join(String.fromCharCode(10));

function runChild(codexHome: string, script: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    status: result.status ?? 1,
  };
}

describe("codex config drift detection", () => {
  test("journaled keys absent from disk is drift", () => {
    const drift = codexConfigDrift(
      () => JOURNAL_URLS,
      "/unused/config.toml",
      () => 'model = "gpt-5.5"\n',
      () => true,
    );
    expect(drift.drifted).toBe(true);
    expect(drift.missingKeys).toEqual(["openai_base_url", "experimental_realtime_ws_base_url"]);
  });

  test("present keys are not drift even when the values differ", () => {
    // A different value is not provably ours to rewrite (#1798's rule, mirrored here):
    // the heal that a missing key triggers defers to the injector's user-ownership rules,
    // so the predicate only reports ABSENCE.
    const drift = codexConfigDrift(
      () => JOURNAL_URLS,
      "/unused/config.toml",
      () => 'openai_base_url = "https://my-own-gateway.example/v1"\n[features]\ncontext_management = true\n',
    );
    expect(drift.drifted).toBe(false);
    expect(drift.missingKeys).toEqual([]);
  });

  test("matching journaled values are not drift", () => {
    const drift = codexConfigDrift(
      () => JOURNAL_URLS,
      "/unused/config.toml",
      () => 'openai_base_url = "http://127.0.0.1:10100/backend-api/codex"\n',
    );
    expect(drift.drifted).toBe(false);
  });

  test("a journal without recorded URLs is not drift", () => {
    expect(codexConfigDrift(() => null, "/unused/config.toml", () => "").drifted).toBe(false);
    expect(codexConfigDrift(() => ({ injectedOpenaiBaseUrl: null, injectedRealtimeWsBaseUrl: null }), "/unused/config.toml", () => "").drifted).toBe(false);
  });

  test("a missing or unreadable config file is not drift", () => {
    expect(codexConfigDrift(() => JOURNAL_URLS, "/unused/config.toml", () => { throw new Error("EACCES"); }, () => false).drifted).toBe(false);
    expect(codexConfigDrift(() => JOURNAL_URLS, "/unused/config.toml", () => { throw new Error("EACCES"); }, () => true).drifted).toBe(false);
  });

  test("a key nested under a table does not satisfy a journaled root key", () => {
    // rootTomlString stops at the first table header, and the journal records ROOT values.
    // A profile-scoped namesake is not the injected surface.
    const drift = codexConfigDrift(
      () => JOURNAL_URLS,
      "/unused/config.toml",
      () => '[profile]\nopenai_base_url = "http://127.0.0.1:10100/backend-api/codex"\n',
      () => true,
    );
    expect(drift.drifted).toBe(true);
  });
});

describe("the 26.924 placeholder is not an external gateway", () => {
  test("a base-url-less provider table resolves to no external owner", () => {
    const content = [
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      'name = "OpenAI"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    expect(externalCodexModelProvider(content)).toBeNull();
  });

  test("a provider table with a base_url is still an external owner", () => {
    const content = [
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      'name = "My Gateway"',
      'base_url = "https://gateway.example/v1"',
      "",
    ].join("\n");
    expect(externalCodexModelProvider(content)).toBe("custom");
  });

  test("injection succeeds against the placeholder shape and rewrites the routing keys", () => {
    const testDir = mkdtempSync(join(tmpdir(), "ocx-drift-placeholder-"));
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "config.toml"), [
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      'name = "OpenAI"',
      'wire_api = "responses"',
      "",
      "[features]",
      "context_management = true",
      "",
    ].join("\n"), "utf8");

    try {
      const r = runChild(testDir, INJECT_ONTO_PLACEHOLDER);
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);

      const out = JSON.parse(r.stdout) as { success: boolean; configApplied?: false; injected: string | null; journaled: boolean };
      // The old guard refused here and deleted the journal, so an app update removed
      // proxy routing and the model list with no recovery path.
      expect(out.success).toBe(true);
      expect(out.configApplied).not.toBe(false);
      expect(out.journaled).toBe(true);
      expect(out.injected).toContain("openai_base_url");
      expect(out.injected).toContain("http://127.0.0.1:10100");
      expect(out.injected).not.toContain('model_provider = "custom"');
      // The user's own context experiment survives injection (its activation switches the
      // written form from /v1 to the /backend-api/codex prefix).
      expect(out.injected).toContain("context_management = true");
      expect(out.injected).toContain("backend-api/codex");
    } finally {
      removeTreeWithRetry(testDir);
    }
  }, 2 * SPAWN_BUDGET_MS);

  test("drift detection and the heal re-injection converge on the rewritten config", () => {
    const testDir = mkdtempSync(join(tmpdir(), "ocx-drift-heal-"));
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    try {
      const r = runChild(testDir, INJECT_REWRITE_AND_REPORT_DRIFT);
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);

      const out = JSON.parse(r.stdout) as {
        drifted: { drifted: boolean; missingKeys: readonly string[] };
        healed: { success: boolean; message: string };
        after: { drifted: boolean };
        journalUrl: string | null;
      };
      expect(out.drifted.drifted).toBe(true);
      expect(out.drifted.missingKeys).toContain("openai_base_url");
      expect(out.healed.success).toBe(true);
      expect(out.after.drifted).toBe(false);
      expect(out.journalUrl).toContain("http://127.0.0.1:10100");
      const healed = readFileSync(join(testDir, "config.toml"), "utf8");
      expect(healed).toContain("openai_base_url");
      expect(healed).toContain("experimental_realtime_ws_base_url");
    } finally {
      removeTreeWithRetry(testDir);
    }
  }, 2 * SPAWN_BUDGET_MS);
});
