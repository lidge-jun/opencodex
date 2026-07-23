import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

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

  test("kept-user-base-url: reports routing NOT injected and leaves the user's override alone", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'openai_base_url = "https://my-own-gateway.example/v1"',
      'model = "gpt-5.5"',
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome);
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("routing NOT injected");
    expect(result.message).not.toContain("All models now route through opencodex proxy");

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('openai_base_url = "https://my-own-gateway.example/v1"');
    expect(config).not.toContain("# Auto-injected by opencodex\nopenai_base_url");
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

    const r = runInject(codexHome, ocxHome);
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("routing NOT injected");
    expect(result.message).toContain('external model_provider "custom"');
    expect(result.message).toContain("http://127.0.0.1:10100/v1");
    expect(result.message).toContain("Responses passthrough");

    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
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
