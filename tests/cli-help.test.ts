import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const binPath = join(repoRoot, "bin", "ocx.mjs");

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("CLI subcommand help", () => {
  test("version commands print a single script-friendly line", () => {
    for (const args of [["--version"], ["-v"], ["version"]]) {
      const result = runCli(args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toMatch(/^opencodex \d+\.\d+\.\d+/);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    }

    const binResult = spawnSync(process.execPath, [binPath, "--version"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    });
    expect(binResult.status).toBe(0);
    expect(binResult.stdout.trim()).toMatch(/^opencodex \d+\.\d+\.\d+/);
    expect(binResult.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("help command routes to subcommand help", () => {
    const result = runCli(["help", "start"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: ocx start [--port <port>]");
    expect(result.stdout).toContain("Start the proxy server and sync models to Codex.");
  });

  test("tray help documents the install-only no-start flag", () => {
    const result = runCli(["help", "tray"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--no-start");
  });

  test("unknown command with help flag remains an error", () => {
    const result = runCli(["foobar", "--help"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: foobar");
    expect(result.stdout).toContain("opencodex (ocx)");
  });

  test("status prints diagnostics without starting the proxy", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-"));
    try {
      const configPath = join(opencodexHome, "config.json");
      writeFileSync(configPath, JSON.stringify({
        port: 9,
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
          },
        },
        defaultProvider: "openai",
        codexAutoStart: false,
      }), "utf8");

      const result = spawnSync(process.execPath, [cliPath, "status"], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: opencodexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Proxy:");
      expect(result.stdout).toContain("Health: http://127.0.0.1:9/healthz");
      expect(result.stdout).toContain("Dashboard: http://localhost:9/");
      expect(result.stdout).toContain(`Config: ${configPath}`);
      expect(result.stdout).toContain(`PID file: ${join(opencodexHome, "ocx.pid")}`);
      expect(result.stdout).toContain("Runtime:");
      expect(result.stdout).toContain("Runtime source:");
      expect(result.stdout).toContain("Default provider: openai");
      expect(result.stdout).toContain("Codex autostart: disabled");
      expect(result.stdout).toContain("Service:");
      expect(result.stdout).toContain(join(opencodexHome, "service.log"));
      expect(result.stdout).toContain("Codex autostart shim");
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
    }
  });

  test("restore --help prints usage without mutating Codex config", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-help-"));
    try {
      const configPath = join(codexHome, "config.toml");
      const before = [
        'model_provider = "opencodex"',
        "",
        "[model_providers.opencodex]",
        'base_url = "http://localhost:10100/v1"',
        'wire_api = "responses"',
        "",
      ].join("\n");
      writeFileSync(configPath, before, "utf8");

      const result = spawnSync(process.execPath, [cliPath, "restore", "--help"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: ocx restore");
      expect(result.stdout).not.toContain("Plain `codex` now runs natively");
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("mutating command help exits before local state changes", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-help-state-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-help-codex-"));
    try {
      const configPath = join(codexHome, "config.toml");
      const markerPath = join(opencodexHome, "service-state.json");
      const before = 'model_provider = "opencodex"\n';
      writeFileSync(configPath, before, "utf8");
      writeFileSync(markerPath, '{"installed":true}', "utf8");

      const cases = [
        { args: ["stop", "--help"], expected: "Usage: ocx stop" },
        { args: ["uninstall", "--help"], expected: "Usage: ocx uninstall" },
        { args: ["service", "uninstall", "--help"], expected: "Usage: ocx service" },
        { args: ["codex-shim", "uninstall", "--help"], expected: "Usage: ocx codex-shim" },
      ];

      for (const testCase of cases) {
        const result = runCli(testCase.args, {
          CODEX_HOME: codexHome,
          OPENCODEX_HOME: opencodexHome,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(testCase.expected);
        expect(readFileSync(configPath, "utf8")).toBe(before);
        expect(readFileSync(markerPath, "utf8")).toBe('{"installed":true}');
      }
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("recover-history --help prints usage without opening history database", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-help-"));
    try {
      const statePath = join(codexHome, "state_5.sqlite");

      const result = spawnSync(process.execPath, [cliPath, "recover-history", "--help"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: ocx recover-history --legacy-openai");
      expect(result.stdout).toContain("Explicitly recover pre-backup syncResumeHistory rows.");
      expect(result.stdout).not.toContain("Recovered");
      expect(result.stderr).toBe("");
      expect(existsSync(statePath)).toBe(false);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("start rejects unknown and partially numeric port arguments", () => {
    const cases = [
      { args: ["start", "--port", "123abc"], expected: "Invalid port number" },
      { args: ["start", "--bad"], expected: "Usage: ocx start [--port <port>]" },
      { args: ["start", "--port", "1234", "--extra"], expected: "Usage: ocx start [--port <port>]" },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
      expect(result.stdout).not.toContain("Plain `codex`");
    }
  });

  test("start help wins before port validation", () => {
    const result = runCli(["start", "--port", "123abc", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: ocx start [--port <port>]");
  });

  test("invalid service and codex-shim usage include remove alias", () => {
    const cases = [
      { args: ["service", "nope"], expected: "Usage: ocx service [install|start|stop|status|uninstall|remove]" },
      { args: ["codex-shim", "nope"], expected: "Usage: ocx codex-shim <install|status|uninstall|remove>" },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
      expect(result.stdout).toBe("");
    }
  });
});
