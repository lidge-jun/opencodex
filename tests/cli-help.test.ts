import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { EXPORT_CLIENT_IDS } from "../src/clients/config-export";
import { SPAWN_BUDGET_MS } from "./helpers/test-budget";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const binPath = join(repoRoot, "bin", "ocx.mjs");

// Every case below spawns the real CLI. A hung child without a spawnSync timeout can
// pin the whole shard for the full 15-minute CI budget (observed on Linux test 3/4
// after an unrelated Bun epoll_ctl load fault). Keep the child deadline under the
// test budget so a stuck help/status process fails fast instead of cancelling CI.
setDefaultTimeout(SPAWN_BUDGET_MS);
const SPAWN_TIMEOUT_MS = SPAWN_BUDGET_MS - 5_000;

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
}

function expectSpawnFinished(result: ReturnType<typeof spawnSync>, label: string) {
  expect(result.error, `${label} should not hang: ${result.error?.message ?? "unknown spawn error"}`).toBeUndefined();
  expect(result.signal, `${label} should not be killed by signal ${result.signal}`).toBeNull();
}

describe("CLI subcommand help", () => {
  test("version commands print a single script-friendly line", () => {
    for (const args of [["--version"], ["-v"], ["version"]]) {
      const result = runCli(args);
      expectSpawnFinished(result, `ocx ${args.join(" ")}`);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toMatch(/^opencodex \d+\.\d+\.\d+/);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    }

    const binResult = spawnSync(process.execPath, [binPath, "--version"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });
    expectSpawnFinished(binResult, "bin/ocx.mjs --version");
    expect(binResult.status).toBe(0);
    expect(binResult.stdout.trim()).toMatch(/^opencodex \d+\.\d+\.\d+/);
    expect(binResult.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("help command routes to subcommand help", () => {
    const result = runCli(["help", "start"]);
    expectSpawnFinished(result, "ocx help start");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: ocx start [--port <port>] [--socks5 [host:port] | --socks5-off]");
    expect(result.stdout).toContain("Start the proxy server and sync models to Codex.");
  });

  test("top-level help counts every export client and export help names them", () => {
    const topLevel = runCli([]);
    expectSpawnFinished(topLevel, "ocx help");
    expect(topLevel.status).toBe(0);
    // Derived, not frozen: a hard-coded literal here agreed with a stale
    // literal in help.ts, so the pair stayed self-consistent and wrong
    // while the registry grew. help.ts keeps its literal on purpose —
    // importing the export registry there would load node:os/node:path
    // machinery on the `ocx --help` path — so this assertion is what
    // holds the two in lockstep.
    expect(topLevel.stdout).toContain(`(${EXPORT_CLIENT_IDS.length} clients)`);

    const exportHelp = runCli(["help", "export"]);
    expectSpawnFinished(exportHelp, "ocx help export");
    expect(exportHelp.status).toBe(0);
    expect(exportHelp.stdout).toContain("opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh");
    expect(exportHelp.stdout).toContain("DeepSeek Harness");
  });

  test("top-level help forms exit before Codex shim auto-restore can mutate launchers", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-help-shim-home-"));
    const binDir = mkdtempSync(join(tmpdir(), "ocx-help-shim-bin-"));
    try {
      const wrapper = join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
      const backup = join(binDir, process.platform === "win32" ? "codex.opencodex-real.cmd" : "codex.opencodex-real");
      const statePath = join(opencodexHome, "codex-shim.json");
      const replacement = "replacement that help must not promote\n";
      writeFileSync(wrapper, replacement, "utf8");
      writeFileSync(backup, "known-good prior launcher\n", "utf8");
      if (process.platform !== "win32") chmodSync(wrapper, 0o755);
      writeFileSync(statePath, `${JSON.stringify({
        platform: process.platform,
        wrapperPath: wrapper,
        originalPath: wrapper,
        backupPath: backup,
      }, null, 2)}\n`, "utf8");
      const stateBefore = readFileSync(statePath);
      const backupBefore = readFileSync(backup);
      Bun.sleepSync(120);

      for (const args of [[], ["help"], ["--help"], ["-h"]]) {
        const result = runCli(args, { OPENCODEX_HOME: opencodexHome, PATH: binDir });
        expectSpawnFinished(result, `ocx ${args.join(" ") || "(no args)"}`);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("opencodex (ocx)");
        expect(readFileSync(wrapper, "utf8")).toBe(replacement);
        expect(readFileSync(backup)).toEqual(backupBefore);
        expect(readFileSync(statePath)).toEqual(stateBefore);
      }
    } finally {
      removeTreeWithRetry(opencodexHome);
      removeTreeWithRetry(binDir);
    }
  });

  test("tray help documents the install-only no-start flag", () => {
    const result = runCli(["help", "tray"]);
    expectSpawnFinished(result, "ocx help tray");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--no-start");
  });

  test("GUI help documents explicit-origin pairing without making a live request", () => {
    const result = runCli(["help", "gui"]);
    expectSpawnFinished(result, "ocx help gui");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: ocx gui [pair --origin <browser-origin> [--json]]");
    expect(result.stdout).toContain("single-use");
    expect(result.stdout).toContain("must not be persisted");
  });

  test("connect help exposes stdin-only credentials and offline disconnect", () => {
    const connect = runCli(["help", "connect"]);
    expectSpawnFinished(connect, "ocx help connect");
    expect(connect.status).toBe(0);
    expect(connect.stdout).toContain("--pairing-code-stdin");
    expect(connect.stdout).toContain("--admin-token-stdin");
    expect(connect.stdout).not.toContain("--admin-token <");

    const disconnect = runCli(["help", "disconnect"]);
    expectSpawnFinished(disconnect, "ocx help disconnect");
    expect(disconnect.status).toBe(0);
    expect(disconnect.stdout).toContain("--keep-catalog");
  });

  test("unknown command with help flag remains an error", () => {
    const result = runCli(["foobar", "--help"]);
    expectSpawnFinished(result, "ocx foobar --help");
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
        timeout: SPAWN_TIMEOUT_MS,
      });

      expectSpawnFinished(result, "ocx status");
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
      // #2411: status must name the routing kind it already computes. The
      // proxy is down in this fixture, so the unused-proxy warning must stay
      // quiet — that warning is for a LIVE proxy nothing routes through.
      expect(result.stdout).toContain("routing=");
      expect(result.stdout).not.toContain("the running proxy is unused");
    } finally {
      removeTreeWithRetry(opencodexHome);
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
        timeout: SPAWN_TIMEOUT_MS,
      });

      expectSpawnFinished(result, "ocx restore --help");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: ocx restore");
      expect(result.stdout).not.toContain("Plain `codex` now runs natively");
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      removeTreeWithRetry(codexHome);
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
        expectSpawnFinished(result, `ocx ${testCase.args.join(" ")}`);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(testCase.expected);
        expect(readFileSync(configPath, "utf8")).toBe(before);
        expect(readFileSync(markerPath, "utf8")).toBe('{"installed":true}');
      }
    } finally {
      removeTreeWithRetry(opencodexHome);
      removeTreeWithRetry(codexHome);
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
        timeout: SPAWN_TIMEOUT_MS,
      });

      expectSpawnFinished(result, "ocx recover-history --help");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: ocx recover-history --legacy-openai --yes");
      expect(result.stdout).toContain("Force all user-message opencodex rows to OpenAI");
      expect(result.stdout).not.toContain("Recovered");
      expect(result.stderr).toBe("");
      expect(existsSync(statePath)).toBe(false);
    } finally {
      removeTreeWithRetry(codexHome);
    }
  });

  test("recover-history requires exact confirmation before mutating history", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-recover-confirm-"));
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-recover-confirm-state-"));
    try {
      const rollout = join(codexHome, "rollout.jsonl");
      writeFileSync(rollout, `${JSON.stringify({
        type: "session_meta",
        payload: { id: "thread-1", model_provider: "opencodex", source: "exec" },
      })}\n`);
      const statePath = join(codexHome, "state_5.sqlite");
      const db = new Database(statePath, { create: true });
      db.exec(`CREATE TABLE threads (
        id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT,
        source TEXT, has_user_event INTEGER, first_user_message TEXT
      )`);
      db.run("INSERT INTO threads VALUES ('thread-1', ?, 'opencodex', 'exec', 1, 'legacy')", [rollout]);
      db.close();
      const databaseBefore = readFileSync(statePath);
      const rolloutBefore = readFileSync(rollout);
      const env = { CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome };

      for (const command of [
        ["recover-history", "--legacy-openai"],
        ["recover-history", "--legacy-openai", "--yes", "--extra"],
      ]) {
        const refused = runCli(command, env);
        expectSpawnFinished(refused, `ocx ${command.join(" ")}`);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("--legacy-openai --yes");
        expect(readFileSync(statePath).equals(databaseBefore)).toBe(true);
        expect(readFileSync(rollout).equals(rolloutBefore)).toBe(true);
      }

      const confirmed = runCli(["recover-history", "--legacy-openai", "--yes"], env);
      expectSpawnFinished(confirmed, "ocx recover-history --legacy-openai --yes");
      expect(confirmed.status).toBe(0);
      expect(confirmed.stdout).toContain("Recovered 1 legacy thread(s)");
      const restored = new Database(statePath, { readonly: true });
      expect(restored.query("SELECT model_provider, source FROM threads WHERE id = 'thread-1'").get())
        .toEqual({ model_provider: "openai", source: "cli" });
      restored.close();
    } finally {
      removeTreeWithRetry(opencodexHome);
      removeTreeWithRetry(codexHome);
    }
  });

  test("start rejects unknown and partially numeric port arguments", () => {
    const cases = [
      { args: ["start", "--port", "123abc"], expected: "Invalid port number" },
      { args: ["start", "--bad"], expected: "Usage: ocx start [--port <port>] [--socks5 [host:port] | --socks5-off]" },
      { args: ["start", "--port", "1234", "--extra"], expected: "Usage: ocx start [--port <port>] [--socks5 [host:port] | --socks5-off]" },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      expectSpawnFinished(result, `ocx ${testCase.args.join(" ")}`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
      expect(result.stdout).not.toContain("Plain `codex`");
    }
  });

  test("start help wins before port validation", () => {
    const result = runCli(["start", "--port", "123abc", "--help"]);
    expectSpawnFinished(result, "ocx start --port 123abc --help");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: ocx start [--port <port>] [--socks5 [host:port] | --socks5-off]");
  });

  test("invalid service and codex-shim usage include remove alias", () => {
    const cases = [
      { args: ["service", "nope"], expected: "Usage: ocx service [install|repair|restart|start|stop|status|uninstall|remove]" },
      { args: ["codex-shim", "nope"], expected: "Usage: ocx codex-shim <install|status|uninstall|remove>" },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      expectSpawnFinished(result, `ocx ${testCase.args.join(" ")}`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
      expect(result.stdout).toBe("");
    }
  });
});
