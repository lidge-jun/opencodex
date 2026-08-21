import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import {
  MANAGED_AGENTS_TABLE_MARKER,
  MANAGED_SUBAGENT_DEFAULT_MARKER,
} from "../src/codex/subagent-defaults";
import { SPAWN_BUDGET_MS } from "./helpers/test-budget";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

setDefaultTimeout(SPAWN_BUDGET_MS);

// Full injectCodexConfig runs in a subprocess with isolated CODEX_HOME/OPENCODEX_HOME so
// module-level path constants bind to the temp dirs (same pattern as codex-journal.test.ts).
function runInject(codexHome: string, ocxHome: string, configJson = "{}"): { stdout: string; status: number } {
  const script = `
    const { injectCodexConfig } = require("./src/codex/inject");
    injectCodexConfig(10100, JSON.parse(process.env.TEST_OCX_CONFIG)).then(r => {
      console.log(JSON.stringify(r));
    });
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, TEST_OCX_CONFIG: configJson },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  return { stdout: result.stdout?.trim() ?? "", status: result.status ?? 1 };
}

function runRestore(codexHome: string, ocxHome: string): { stdout: string; status: number } {
  const script = `
    const { restoreNativeCodex } = require("./src/codex/inject");
    console.log(JSON.stringify(restoreNativeCodex()));
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  return { stdout: result.stdout?.trim() ?? "", status: result.status ?? 1 };
}

describe("injectCodexConfig integration (Design B)", () => {
  let codexHome: string;
  let ocxHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "ocx-inject-codex-"));
    ocxHome = mkdtempSync(join(tmpdir(), "ocx-inject-home-"));
  });

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(ocxHome, { recursive: true, force: true });
  });

  test("upgrade path: a legacy-injected config converts to the Design B form in one inject", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "opencodex"',
      'model = "gpt-5.5"',
      "",
      "[features]",
      "fast_mode = true",
      "",
      "# Auto-injected by opencodex",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');
    expect(config).toContain("# Auto-injected by opencodex");
    expect(config).not.toContain("[model_providers.opencodex]");
    expect(config).not.toContain('model_provider = "opencodex"');
    expect(config).toContain('model = "gpt-5.5"');
    // Exactly one marker survives (the Design B one) — no duplicate accumulation.
    expect(config.match(/Auto-injected by opencodex/g)?.length).toBe(1);
  });

  test("upgrade path: a non-loopback legacy env_http_headers config converts to env_key (#2073)", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "opencodex"',
      "",
      "# Auto-injected by opencodex",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://192.168.1.50:10100/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      'env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }',
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ hostname: "192.168.1.50" }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('env_key = "OPENCODEX_API_AUTH_TOKEN"');
    expect(config).not.toContain("env_http_headers");
    // Still exactly one provider block, no duplicate accumulation.
    expect(config.match(/\[model_providers\.opencodex]/g)?.length).toBe(1);
  });

  test("re-inject over a Design B config is idempotent", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const first = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const second = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(second.match(/openai_base_url/g)?.length).toBe(1);
    expect(second.match(/Auto-injected by opencodex/g)?.length).toBe(1);
    expect(second).toBe(first);
  });

  test.each([
    'model_catalog_json = "custom-catalog.json" # user catalog',
    '"model_catalog_json" = "custom-catalog.json" # user catalog',
  ])(
    "preserves a commented user catalog assignment without duplicating it: %s",
    (assignment) => {
      writeFileSync(join(codexHome, "config.toml"), [
        assignment,
        "",
        "[features]",
        "fast_mode = true",
        "",
      ].join("\n"), "utf8");

      const result = runInject(codexHome, ocxHome);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).success).toBe(true);

      const config = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(
        config.match(/^(?:model_catalog_json|"model_catalog_json"|'model_catalog_json')\s*=/gm)?.length,
      ).toBe(1);
      expect(config).toContain(assignment);
      expect(() => Bun.TOML.parse(config)).not.toThrow();

      const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
      expect(profile).toContain('model_catalog_json = "custom-catalog.json"');
    },
  );

  test("repairs an owned duplicate without replacing a commented user catalog", () => {
    const userAssignment = 'model_catalog_json = "custom-catalog.json" # user catalog';
    writeFileSync(join(codexHome, "config.toml"), [
      userAssignment,
      'model_catalog_json = "opencodex-catalog.json"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"), "utf8");

    const result = runInject(codexHome, ocxHome);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config.match(/^model_catalog_json\s*=/gm)?.length).toBe(1);
    expect(config).toContain(userAssignment);
    expect(config).not.toContain('model_catalog_json = "opencodex-catalog.json"');
    expect(() => Bun.TOML.parse(config)).not.toThrow();

    const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
    expect(profile).toContain('model_catalog_json = "custom-catalog.json"');
  });

  test("removes a stale OpenCodex catalog assignment with a trailing comment", () => {
    writeFileSync(
      join(codexHome, "config.toml"),
      'model_catalog_json = "opencodex-catalog.json" # stale catalog\n',
      "utf8",
    );

    const result = runInject(codexHome, ocxHome);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).not.toContain("model_catalog_json");
    expect(() => Bun.TOML.parse(config)).not.toThrow();
  });

  test("does not strip a catalog-shaped assignment from a user table", () => {
    const nestedAssignment = '"model_catalog_json" = "opencodex-catalog.json" # user table value';
    writeFileSync(join(codexHome, "config.toml"), [
      "[user_metadata]",
      nestedAssignment,
      "",
    ].join("\n"), "utf8");

    const result = runInject(codexHome, ocxHome);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain(nestedAssignment);
    expect(() => Bun.TOML.parse(config)).not.toThrow();
  });

  test("fastMode=false forces fast_mode=false in both config and profile", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ fastMode: false }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("[features]");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");

    const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
    expect(profile).toContain("fast_mode = false");
    expect(profile).not.toContain("fast_mode = true");
  });

  test("fastMode=true adds fast_mode=true to a config without a [features] table", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ fastMode: true }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("[features]");
    expect(config).toContain("fast_mode = true");

    const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
    expect(profile).toContain("fast_mode = true");
  });

  test("fastMode unset preserves the user's existing fast_mode setting", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n\n[features]\nfast_mode = false\n', "utf8");

    const r = runInject(codexHome, ocxHome);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");

    const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
    expect(profile).not.toContain("fast_mode");
  });

  test("fastMode unset does not add a [features] table to a config that lacks one", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ocxHome);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).not.toContain("[features]");
    expect(config).not.toContain("fast_mode");

    const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
    expect(profile).not.toContain("fast_mode");
  });

  test("fastMode=false updates a commented [features] header without duplicating the table", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.5"',
      "",
      "[features] # user comment",
      "fast_mode = true",
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ fastMode: false }));
    expect(r.status).toBe(0);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");
    expect(() => Bun.TOML.parse(config)).not.toThrow();
    expect(Bun.TOML.parse(config).features.fast_mode).toBe(false);
  });

  test("fastMode=false updates a quoted [\"features\"] header without duplicating the table", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.5"',
      "",
      '["features"]',
      "fast_mode = true",
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ fastMode: false }));
    expect(r.status).toBe(0);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");
    expect(() => Bun.TOML.parse(config)).not.toThrow();
    expect(Bun.TOML.parse(config).features.fast_mode).toBe(false);
  });

  test("fastMode=false updates a quoted \"fast_mode\" key", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.5"',
      "",
      "[features]",
      '"fast_mode" = true',
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ fastMode: false }));
    expect(r.status).toBe(0);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");
    expect(() => Bun.TOML.parse(config)).not.toThrow();
    expect(Bun.TOML.parse(config).features.fast_mode).toBe(false);
  });

  test("opt-in injects native subagent defaults, removes them when disabled, and restores the native config", () => {
    const original = [
      'model = "gpt-5.5"',
      "",
      "[notice]",
      "hide = true",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");
    const enabled = JSON.stringify({
      syncCodexSubagentDefaults: true,
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "high",
    });

    expect(runInject(codexHome, ocxHome, enabled).status).toBe(0);
    const injected = readFileSync(join(codexHome, "config.toml"), "utf8");
    const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
    expect(injected).toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(injected).toContain('default_subagent_model = "gpt-5.6-sol"');
    expect(injected).toContain('default_subagent_reasoning_effort = "high"');
    expect(injected).toContain(MANAGED_AGENTS_TABLE_MARKER);
    expect(profile).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(profile).not.toContain("default_subagent_model");

    expect(runInject(codexHome, ocxHome, "{}").status).toBe(0);
    const disabled = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(disabled).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(disabled).not.toContain("default_subagent_model");
    expect(disabled).not.toContain("default_subagent_reasoning_effort");
    expect(disabled).toContain("[notice]\nhide = true");

    expect(runInject(codexHome, ocxHome, enabled).status).toBe(0);
    expect(runRestore(codexHome, ocxHome).status).toBe(0);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  });

  test("opt-in preserves a user-owned native default pair and reports the conflict", () => {
    const original = [
      'model = "gpt-5.5"',
      "",
      "[agents]",
      'default_subagent_model = "user/model" # owned by user',
      'default_subagent_reasoning_effort = "medium"',
      "max_threads = 6",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const result = runInject(codexHome, ocxHome, JSON.stringify({
      syncCodexSubagentDefaults: true,
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "high",
    }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).message).toContain("user-owned agents.default_subagent_model");

    const injected = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(injected).toContain('default_subagent_model = "user/model" # owned by user');
    expect(injected).toContain('default_subagent_reasoning_effort = "medium"');
    expect(injected).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(injected).not.toContain('default_subagent_model = "gpt-5.6-sol"');
  });

  test("sync-disabled injection cleans managed-default residue before journaling and restore", () => {
    const residue = [
      MANAGED_AGENTS_TABLE_MARKER,
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_model = "stale/routed-model"',
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_reasoning_effort = "high"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), residue, "utf8");

    const injectedResult = runInject(codexHome, ocxHome, "{}");
    expect(injectedResult.status).toBe(0);
    expect(JSON.parse(injectedResult.stdout).success).toBe(true);
    const injected = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(injected).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(injected).not.toContain("default_subagent_model");
    expect(() => Bun.TOML.parse(injected)).not.toThrow();

    const restoredResult = runRestore(codexHome, ocxHome);
    expect(restoredResult.status).toBe(0);
    expect(JSON.parse(restoredResult.stdout).success).toBe(true);
    const restored = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(restored).not.toContain(MANAGED_AGENTS_TABLE_MARKER);
    expect(restored).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(restored).not.toContain("default_subagent_model");
    expect(restored).toContain("[features]\nfast_mode = true");
  });

  test("ambiguous managed-default residue refuses injection without changing files", () => {
    const ambiguous = [
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      "",
      'default_subagent_model = "stale/routed-model"',
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), ambiguous, "utf8");

    const result = runInject(codexHome, ocxHome, "{}");
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(false);
    expect(payload.message).toContain("injection refused");
    expect(payload.message).toContain("orphaned managed subagent default marker");
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(ambiguous);
    expect(existsSync(join(codexHome, "opencodex.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "opencodex-journal.json"))).toBe(false);
  });

  test("kept-user-base-url: reports routing NOT injected and leaves the user's override alone", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'openai_base_url = "https://my-own-gateway.example/v1"',
      'model = "gpt-5.5"',
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({
      syncCodexSubagentDefaults: true,
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "high",
    }));
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("routing NOT injected");
    expect(result.message).not.toContain("All models now route through opencodex proxy");
    expect(result.nativeSubagentDefaultsWarning).toContain("user-owned root openai_base_url");

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('openai_base_url = "https://my-own-gateway.example/v1"');
    expect(config).not.toContain("# Auto-injected by opencodex\nopenai_base_url");
    expect(config).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(config).not.toContain("default_subagent_model");
  });

  test("external model provider stays byte-for-byte unchanged so its session history remains visible", () => {
    const original = [
      'model_provider = "custom"',
      'model = "third-party-model"',
      "",
      "[model_providers.custom]",
      'name = "Provider Manager"',
      'base_url = "https://gateway.example/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir);
    const profilePath = join(codexHome, "opencodex.config.toml");
    const profile = "sentinel profile\n";
    writeFileSync(profilePath, profile, "utf8");
    const rolloutPath = join(sessionsDir, "rollout-custom.jsonl");
    const rollout = JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-custom", model_provider: "custom", source: "cli", cwd: codexHome },
    }) + "\n";
    writeFileSync(rolloutPath, rollout, "utf8");
    const dbPath = join(codexHome, "state_5.sqlite");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL,
      source TEXT NOT NULL, first_user_message TEXT NOT NULL, has_user_event INTEGER NOT NULL
    )`);
    db.run(`INSERT INTO threads VALUES ('thread-custom', ?, 'custom', 'cli', 'hello', 1)`, rolloutPath);
    db.close();
    const dbBefore = readFileSync(dbPath);
    const journalPath = join(codexHome, "opencodex-journal.json");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model_provider = "openai"\n').toString("base64"),
      originalProfile: null,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    }), "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({
      syncCodexSubagentDefaults: true,
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "high",
    }));
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("routing NOT injected");
    expect(result.message).toContain('external model_provider "custom"');
    expect(result.message).toContain("http://127.0.0.1:10100/v1");
    expect(result.message).toContain("Responses passthrough");
    expect(result.nativeSubagentDefaultsWarning).toContain("external model_provider");

    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
    expect(readFileSync(profilePath, "utf8")).toBe(profile);
   expect(readFileSync(dbPath).equals(dbBefore)).toBe(true);
   expect(readFileSync(rolloutPath, "utf8")).toBe(rollout);
   expect(existsSync(journalPath)).toBe(false);
 });

  // Regression for #1090: the reporter's Windows shape — CRLF line endings, an external
  // root model_provider, a coexisting [model_providers.opencodex] table, and a [windows]
  // section — must survive injectCodexConfig byte-for-byte. The external-provider guard
  // runs on raw (pre-EOL-normalized) content, so CRLF parsing is part of what this proves.
  test("#1090: CRLF Windows config with external deepseek provider and opencodex table stays byte-for-byte unchanged", () => {
    const original = [
      'model = "deepseek-v4-flash"',
      'model_provider = "deepseek"',
      "",
      "[model_providers.opencodex]",
      'name = "opencodex"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      'env_key = "CODEX_DEEPSEEK_API_KEY"',
      "",
      "[windows]",
      'sandbox = "unelevated"',
      "",
    ].join("\r\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const r = runInject(codexHome, ocxHome);
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("routing NOT injected");
    expect(result.message).toContain('external model_provider "deepseek"');

    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  });

  test("restoreNativeCodex removes a stale journal without changing external provider state", () => {
    const configPath = join(codexHome, "config.toml");
    const config = 'model_provider = "custom"\nmodel = "third-party-model"\n';
    writeFileSync(configPath, config, "utf8");
    const profilePath = join(codexHome, "opencodex.config.toml");
    const profile = 'model_provider = "custom"\n';
    writeFileSync(profilePath, profile, "utf8");

    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir);
    const rolloutPath = join(sessionsDir, "rollout-custom.jsonl");
    const rollout = JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-custom", model_provider: "custom", source: "cli", cwd: codexHome },
    }) + "\n";
    writeFileSync(rolloutPath, rollout, "utf8");
    const dbPath = join(codexHome, "state_5.sqlite");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL,
      source TEXT NOT NULL, first_user_message TEXT NOT NULL, has_user_event INTEGER NOT NULL
    )`);
    db.run(`INSERT INTO threads VALUES ('thread-custom', ?, 'custom', 'cli', 'hello', 1)`, rolloutPath);
    db.close();
    const dbBefore = readFileSync(dbPath);

    const journalPath = join(codexHome, "opencodex-journal.json");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model_provider = "openai"\n').toString("base64"),
      originalProfile: null,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    }), "utf8");

    const r = runRestore(codexHome, ocxHome);
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain('External Codex provider "custom" preserved');
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(readFileSync(profilePath, "utf8")).toBe(profile);
    expect(readFileSync(dbPath).equals(dbBefore)).toBe(true);
    expect(readFileSync(rolloutPath, "utf8")).toBe(rollout);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("provider selected through a legacy root profile is also preserved", () => {
    const original = [
      'profile = "work"',
      'model_provider = "openai"',
      "",
      "[profiles.work]",
      'model_provider = "custom"',
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const r = runInject(codexHome, ocxHome);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).message).toContain('external model_provider "custom"');
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  });

  test("external provider guidance includes the admission header for non-loopback binds", () => {
    const original = 'model_provider = "custom"\n';
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ hostname: "192.168.1.20" }));
    expect(r.status).toBe(0);
    const message = JSON.parse(r.stdout).message;
    expect(message).toContain("http://192.168.1.20:10100/v1");
    expect(message).toContain("x-opencodex-api-key from OPENCODEX_API_AUTH_TOKEN");
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  });

  test("non-loopback hostname still uses the legacy provider-table injection", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ hostname: "192.168.1.20" }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model_provider = "opencodex"');
    expect(config).toContain("[model_providers.opencodex]");
    expect(config).toContain('base_url = "http://192.168.1.20:10100/v1"');
    expect(config).not.toContain("openai_base_url");
  });

  test("CRLF config (Windows-edited) stays uniformly CRLF after injection", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\r\n\r\n[features]\r\nfast_mode = true\r\n', "utf8");

    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(config).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');
    // Every newline is CRLF — no mixed-EOL file on Windows.
    expect(config.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(config).toContain("\r\n");

    // Idempotent re-inject keeps the CRLF form stable.
    expect(runInject(codexHome, ocxHome).status).toBe(0);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(config);
  });

  test("LF config gains no carriage returns from injection", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(config).toContain("openai_base_url");
    expect(config).not.toContain("\r");
  });

  test("inject does not turn on multi_agent_v2; fresh installs stay on Codex's default v1 surface until the user opts in", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(config).not.toContain("[features.multi_agent_v2]");
    expect(config).not.toContain("multi_agent_v2 = true");
    expect(config).not.toContain("multi_agent_v2 = {");
  });
});
