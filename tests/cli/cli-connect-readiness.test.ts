/**
 * #4207: "ocx connect status" answered a different question from the one the operator asked.
 * It proved the hub answered and the credential worked, then printed "connected" over a catalog
 * the installed Codex CLI could not parse, so "codex exec" died on an unknown-variant error for
 * the reasoning level "max" before its first request.
 *
 * The write-time gate added in the first round cannot close this. It runs once, on bytes about
 * to be written, so it says nothing about a catalog that predates it, one written while the
 * runtime ladder was unverified, or a runtime swapped after the write. These tests drive the
 * status surface itself, in an isolated client home, with injected ladders or harmless fixture
 * launchers in place of the operator's Codex runtime.
 */
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { COLD_SPAWN_WARMUP_HOOK_BUDGET_MS, warmColdSpawn } from "../helpers/cold-spawn-warmup";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { connectCompletionReport } from "../../src/cli/connect";
import { dispatchCommand } from "../../src/cli/dispatch";
import type { CliDispatchDeps } from "../../src/cli/dispatch";
import { ClientCatalogIncompatibleError } from "../../src/client/catalog-compatibility";
import type { ClientCatalogReadiness } from "../../src/client/catalog-compatibility";
import type { RuntimeProbeFailure } from "../../src/codex/runtime";

/** Codex CLI 0.135.0's ladder, verbatim from the parse error in the issue. */
const OLD_CLI = ["none", "minimal", "low", "medium", "high", "xhigh"];
const NEW_CLI = [...OLD_CLI, "max", "ultra"];

/** A hub catalog whose top rung the reporter's CLI rejects. */
const CATALOG_WITH_MAX = JSON.stringify({
  models: [{ slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }] }],
});

type ProbeResult = {
  lines: string[];
  exitCode?: number;
  errors: string[];
  catalogUnchanged?: boolean;
  commandCode?: number;
  status: {
    state: string;
    catalog: string;
    readiness?: string;
    readinessReason?: string;
  };
  runtime?: {
    beforeDiagnostics: Record<string, string[]>;
    afterDiagnostics: Record<string, string[]>;
    diagnosticsCached: boolean;
    newerVersion?: string;
    selectionUnchanged: boolean;
    failures: RuntimeProbeFailure[];
  };
};

/** Harmless real launchers: the fixture PATH never includes the operator's Codex. */
function writeRuntimeFixture(dir: string, version: string, valid = true): string {
  mkdirSync(dir, { recursive: true });
  const command = join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
  const catalog = JSON.stringify({ models: [{
    slug: "gpt-5.6-sol",
    base_instructions: "fixture",
    supported_reasoning_levels: NEW_CLI.map(effort => ({ effort })),
  }] });
  writeFileSync(command, process.platform === "win32"
    ? [
      "@echo off",
      'echo %~1 %~2 %~3>>"%~dp0calls.log"',
      ...(valid ? [
        'if "%~1"=="--version" (',
        `  echo codex-cli ${version}`,
        "  exit /b 0",
        ")",
        `echo ${catalog}`,
        "exit /b 0",
      ] : ["exit /b 1"]),
    ].join("\r\n")
    : [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "${0%/*}/calls.log"',
      ...(valid ? [
        `if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli ${version}'; exit 0; fi`,
        `printf '%s\\n' '${catalog}'`,
      ] : ["exit 1"]),
    ].join("\n"), "utf8");
  if (process.platform !== "win32") chmodSync(command, 0o755);
  return command;
}

/**
 * Runs the real "ocx connect status" surface against a throwaway client home. The ladder is
 * injected by default; the observer cases use only the isolated fixture launchers below.
 */
function runStatusProbe(options: {
  connected: boolean;
  ladder: string[] | null | "forbidden" | "observed";
  catalog?: string;
  connectRejectCatalog?: string;
  preferred?: "valid" | "failed" | "missing";
  persisted?: boolean;
  fullDiagnostics?: boolean;
  /** "connect" drives `ocx connect status`; "status" drives the general `ocx status` collector. */
  surface?: "connect" | "status";
  /**
   * Child deadline. Only the warm-up passes one: it takes the cold module-graph load and the cold
   * runtime-fixture spawns out of the measured window, so every assertion below keeps the
   * 15-second bound that reports a wedged child.
   */
  deadlineMs?: number;
}): ProbeResult {
  const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-readiness-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "ocx-readiness-codex-"));
  try {
    const token = `ocx_data_${"f".repeat(40)}`;
    const fingerprint = createHash("sha256").update(token).digest("hex");
    const catalog = options.catalog ?? CATALOG_WITH_MAX;
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify(options.connected
      ? {
        port: 10100,
        providers: {},
        defaultProvider: "openai",
        runtimeRole: "client",
        client: {
          serverUrl: "https://hub.example.test",
          managementUrl: "https://hub.example.test",
          managementTransport: "direct",
          selectedClients: ["codex"],
          tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
          apiKeyId: "client-key-1",
          tokenFingerprint: fingerprint,
          protocolVersion: 1,
          connectedAt: "2026-08-28T00:00:00.000Z",
          catalogFingerprint: createHash("sha256").update(catalog).digest("base64url"),
          catalogSyncedAt: "2026-08-28T00:00:00.000Z",
        },
      }
      : { port: 10100, providers: {}, defaultProvider: "openai" }), "utf8");
    if (!options.connectRejectCatalog) {
      writeFileSync(join(opencodexHome, "service-api-token"), `${token}\n`, { mode: 0o600 });
    }
    writeFileSync(join(codexHome, "opencodex-catalog.json"), catalog, "utf8");
    const runtimeEnv: NodeJS.ProcessEnv = {};
    if (options.ladder === "observed") {
      const selectedDir = join(opencodexHome, "selected");
      const lowerDir = join(opencodexHome, "lower");
      const rejectedDir = join(opencodexHome, "rejected");
      const selected = writeRuntimeFixture(selectedDir, "0.145.0");
      writeRuntimeFixture(lowerDir, "99.0.0");
      const preferred = options.preferred ?? "valid";
      runtimeEnv.CODEX_CLI_PATH = preferred === "valid" ? selected
        : preferred === "failed" ? writeRuntimeFixture(rejectedDir, "", false)
        : join(rejectedDir, process.platform === "win32" ? "codex.cmd" : "codex");
      runtimeEnv.PATH = [selectedDir, lowerDir].join(delimiter);
      runtimeEnv.HOME = opencodexHome;
      runtimeEnv.USERPROFILE = opencodexHome;
      runtimeEnv.FIXTURE_RUNTIME_DIRS = JSON.stringify({ selected: selectedDir, lower: lowerDir, rejected: rejectedDir });
      runtimeEnv.FIXTURE_FULL_DIAGNOSTICS = options.fullDiagnostics ? "1" : "0";
      if (options.persisted) writeFileSync(join(opencodexHome, "codex-runtime.json"), JSON.stringify({
        version: 1, command: selected, source: "configured", selectedVersion: "0.145.0",
        updatedAt: "2026-08-28T00:00:00.000Z",
      }));
    }

    const script = `
      const { collectClientConnectionStatus, handleConnectCommand } = require("./src/cli/connect");
      const { readFileSync } = require("node:fs");
      const { join } = require("node:path");
      const ladder = JSON.parse(process.env.FIXTURE_LADDER);
      const supportedEfforts = ladder === "forbidden"
        ? () => { throw new Error("the runtime was probed on a path that must not probe it"); }
        : ladder === null ? () => null : () => new Set(ladder);
      const catalogProbeDeps = ladder === "observed" ? {} : { supportedEfforts };
      const readOptional = path => { try { return readFileSync(path, "utf8"); } catch { return null; } };
      const dirs = process.env.FIXTURE_RUNTIME_DIRS ? JSON.parse(process.env.FIXTURE_RUNTIME_DIRS) : null;
      const calls = () => Object.fromEntries(Object.entries(dirs ?? {}).map(([key, dir]) =>
        [key, (readOptional(join(dir, "calls.log")) ?? "").split(/\\r?\\n/).map(line => line.trim()).filter(Boolean)]));
      const selectionPath = join(process.env.OPENCODEX_HOME, "codex-runtime.json");
      const selectionBefore = readOptional(selectionPath);
      const lifecycleLockDeps = { lockPath: process.env.OPENCODEX_HOME + "/lifecycle.sqlite" };
      const captured = [];
      const errors = [];
      const real = console.log;
      const realError = console.error;
      (async () => {
        let exitCode, catalogUnchanged, commandCode;
        if (process.env.FIXTURE_SURFACE === "status") {
          const { collectStatus } = require("./src/cli/status");
          const view = await collectStatus();
          const observed = calls();
          console.log(JSON.stringify({
            lines: [], commandCode: 0, status: view.json.connection,
            runtime: { beforeDiagnostics: observed, afterDiagnostics: observed, diagnosticsCached: true,
              selectionUnchanged: selectionBefore === readOptional(selectionPath), failures: [] },
            exitCode, errors, catalogUnchanged,
          }));
          return;
        }
        console.log = (...parts) => captured.push(parts.join(" "));
        console.error = (...parts) => errors.push(parts.join(" "));
        try {
          if (process.env.REJECT_CATALOG) {
            const fs = require("node:fs");
            const { Readable } = require("node:stream");
            const catalogPath = process.env.CODEX_HOME + "/opencodex-catalog.json";
            const before = fs.readFileSync(catalogPath, "utf8");
            const fetchImpl = async (input, init = {}) => {
              const url = String(input);
              if (url.endsWith("/readyz")) return Response.json({
                service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 443,
                status: "ready", protocol: 1, minimumClientProtocol: 1,
                managementUrl: "https://hub.example.test",
              });
              if (url.endsWith("/api/keys") && init.method === "POST") return Response.json({
                id: "fixture-key", name: "fixture", key: "ocx_data_" + "a".repeat(40),
                createdAt: "2026-09-13T00:00:00.000Z",
              }, { status: 201 });
              if (url.endsWith("/v1/catalog")) return new Response(process.env.REJECT_CATALOG, {
                headers: { "content-type": "application/json" },
              });
              if (init.method === "DELETE") return Response.json({ ok: true });
              throw new Error("unexpected fixture request");
            };
            exitCode = await handleConnectCommand(["https://hub.example.test", "--admin-token-stdin", "--clients", "codex"], {
              lifecycleLockDeps, catalogProbeDeps: { supportedEfforts },
              stdinImpl: Readable.from(["ocx_admin_fixture" + String.fromCharCode(10)]), fetchImpl,
            });
            catalogUnchanged = fs.readFileSync(catalogPath, "utf8") === before;
          } else {
            commandCode = await handleConnectCommand(["status"], { lifecycleLockDeps, catalogProbeDeps });
          }
        } finally {
          console.log = real;
          console.error = realError;
        }
        const status = collectClientConnectionStatus(
          Date.parse("2026-08-28T00:00:10.000Z"),
          lifecycleLockDeps,
          catalogProbeDeps,
        );
        let runtime;
        if (ladder === "observed") {
          const beforeDiagnostics = calls();
          const { resolveCodexRuntime } = require("./src/codex/runtime");
          // Same priority-only scope the status path resolved with, so this reads the memo that
          // path published instead of probing again, and reports the candidates it rejected.
          const failures = resolveCodexRuntime({ discoverAlternatives: false }).failures;
          let newerVersion;
          let diagnosticsCached = true;
          if (process.env.FIXTURE_FULL_DIAGNOSTICS === "1") {
            newerVersion = resolveCodexRuntime().newerAvailable?.version;
            const first = JSON.stringify(calls());
            resolveCodexRuntime();
            diagnosticsCached = first === JSON.stringify(calls());
          }
          runtime = { beforeDiagnostics, afterDiagnostics: calls(), diagnosticsCached, newerVersion,
            selectionUnchanged: selectionBefore === readOptional(selectionPath), failures };
        }
        console.log(JSON.stringify({ lines: captured, commandCode, status, runtime, exitCode, errors, catalogUnchanged }));
      })();
    `;

    const result = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot(),
      encoding: "utf8",
      // Bun's test timeout cannot interrupt spawnSync, so a child that wedged on a lock or an
      // unexpected probe would hang the worker rather than fail. Same budget the existing
      // client fixtures use.
      timeout: options.deadlineMs ?? INTERNAL_DEADLINE_MS,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        OPENCODEX_HOME: opencodexHome,
        CODEX_HOME: codexHome,
        REJECT_CATALOG: options.connectRejectCatalog ?? "",
        // Matches the existing client fixtures: no probe may reach the operator's real Claude
        // Desktop configuration, even transitively.
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(opencodexHome, "desktop"),
        FIXTURE_LADDER: JSON.stringify(options.ladder),
        FIXTURE_SURFACE: options.surface ?? "connect",
        ...runtimeEnv,
      },
    });
    expect(result.status).toBe(0);
    const probe = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as ProbeResult;
    // A status command that exited nonzero printed no verdict worth asserting on, so every
    // readiness expectation below would otherwise be checking a report that was never produced.
    if (!options.connectRejectCatalog) {
      expect(probe.commandCode).toBe(0);
    }
    return probe;
  } finally {
    removeTreeWithRetry(opencodexHome);
    removeTreeWithRetry(codexHome);
  }
}

describe("#4207 connected-client readiness", () => {
  // One child of this shape, before anything is measured. Windows 2/9 of run 35305115672 timed the
  // first one at 2893ms against a 553-594ms warm baseline; that gap is module load, and it belongs
  // in setup rather than inside the first assertion that happens to run.
  beforeAll(async () => {
    await warmColdSpawn("cli-connect-readiness/connect", deadlineMs => {
      runStatusProbe({ connected: true, ladder: OLD_CLI, deadlineMs });
    });
  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);

  test("first-time connect escapes a rejected hub catalog before stderr output", () => {
    const probe = runStatusProbe({
      connected: false,
      ladder: OLD_CLI,
      connectRejectCatalog: JSON.stringify({
        models: [{ slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "bad\nFORGED\x1b[2J" }] }],
      }),
    });
    expect(probe.exitCode).toBe(1);
    expect(probe.catalogUnchanged).toBe(true);
    expect(probe.status.state).toBe("disconnected");
    expect(probe.lines).toEqual([]);
    expect(probe.errors[0]).toContain("catalog_incompatible:");
    expect(probe.errors[0]).toContain("bad\\x0aFORGED\\x1b[2J");
    expect(probe.errors[0]).toContain("gpt-5.6-sol");
    expect(probe.errors.join(" ")).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
  }, SPAWN_BUDGET_MS);

  test("an installed catalog the local CLI rejects is not reported as ready", () => {
    const probe = runStatusProbe({ connected: true, ladder: OLD_CLI });

    expect(probe.status.state).toBe("connected");
    // The connection is real and the file is there. Both were true in the report, and both are
    // why "connected" plus "present" read as success.
    expect(probe.status.catalog).toBe("present");
    expect(probe.status.readiness).toBe("incompatible");
    expect(probe.status.readinessReason).toContain("max");
    // "Incompatible" alone is not actionable; the operator needs the way out.
    expect(probe.status.readinessReason).toContain("CODEX_CLI_PATH");
    // The refusal message belongs to the write-time gate, which kept a previous file. Nothing
    // was kept here: the unusable bytes are the ones Codex will read next.
    expect(probe.status.readinessReason).not.toContain("The previous catalog was kept");
  });

  test("the human status states the local verdict before the hub detail", () => {
    const probe = runStatusProbe({ connected: true, ladder: OLD_CLI });

    expect(probe.lines[0]).toBe("Connection: connected");
    // Second line, not buried under Hub/Protocol/Catalog: a reader who stops at "connected" is
    // exactly the failure this issue describes.
    expect(probe.lines[1]).toContain("Local Codex CLI: not ready");
    expect(probe.lines.find(line => line.startsWith("Hub:"))).toBeDefined();
  });

  test("terminal controls in catalog effort names remain data in status diagnostics", () => {
    const effort = "rogue\nFORGED\x1b]52;c;SGVsbG8=\x07\u2028after";
    const probe = runStatusProbe({
      connected: true,
      ladder: OLD_CLI,
      catalog: JSON.stringify({
        models: [{ slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "high" }, { effort }] }],
      }),
    });

    expect(probe.status.readinessReason).toContain(effort);
    expect(probe.lines[1]).toContain("rogue\\x0aFORGED\\x1b]52;c;SGVsbG8=\\x07\\u2028after");
    expect(probe.lines[1]).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
  });

  test("a catalog the local CLI accepts is ready, with nothing to explain", () => {
    const probe = runStatusProbe({ connected: true, ladder: NEW_CLI });

    expect(probe.status.readiness).toBe("ready");
    expect(probe.status.readinessReason).toBeUndefined();
    expect(probe.lines[1]).toBe("Local Codex CLI: ready");
  });

  test("an unobservable runtime is unverified, never incompatible", () => {
    // A client machine may legitimately have no Codex CLI to observe. Calling that an
    // incompatibility would condemn a working install on absent evidence, which is the same
    // line the write-time gate refuses to cross.
    const probe = runStatusProbe({ connected: true, ladder: null });

    expect(probe.status.readiness).toBe("unverified");
    expect(probe.status.readinessReason).toContain("did not report the reasoning levels");
  });

  test("an unreadable catalog is unverified rather than blamed on the runtime", () => {
    const probe = runStatusProbe({ connected: true, ladder: OLD_CLI, catalog: "not json" });

    expect(probe.status.readiness).toBe("unverified");
    // The write-time gate says "the downloaded catalog could not be read", which points the
    // operator at a download that is not the problem. These bytes are already installed.
    expect(probe.status.readinessReason)
      .toBe("the installed catalog is not readable JSON, so the local Codex CLI cannot parse it either");
  });

  test("a machine with no client connection never probes the runtime", () => {
    // Observing the ladder spawns a Codex process. A standalone or hub install has no client
    // catalog question to answer and must not pay for one on every status call, so the injected
    // probe throws if it is reached.
    const probe = runStatusProbe({ connected: false, ladder: "forbidden" });

    expect(probe.status.state).toBe("disconnected");
    expect(probe.status.readiness).toBeUndefined();
    expect(probe.status.readinessReason).toBeUndefined();
    expect(probe.lines[0]).toBe("Connection: disconnected");
  });
});

describe("connected-client runtime probe scope", () => {
  // The second cold start in this file, and the one that actually failed. The observed ladder loads
  // `src/codex/runtime` on top of the connect graph and spawns the generated runtime fixtures, so it
  // is cold even after the describe above has run: on Windows 2/9 of run 35305115672 its first child
  // was killed at 15339ms while its siblings took 2037-2376ms. Warming the connect graph alone would
  // not have prevented that, which is why the warm-up is per graph rather than per file or per
  // process. The replay runs the same `runStatusProbe` the tests run, so there is no second copy of
  // the invocation to drift away from what is measured.
  beforeAll(async () => {
    await warmColdSpawn("cli-connect-readiness/observed", deadlineMs => {
      runStatusProbe({ connected: true, ladder: "observed", deadlineMs });
    });
  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);

  test("observes only the selected runtime and leaves full diagnostics available", () => {
    const probe = runStatusProbe({ connected: true, ladder: "observed", fullDiagnostics: true });

    expect(probe.status.readiness).toBe("ready");
    expect(probe.runtime?.beforeDiagnostics.lower).toEqual([]);
    expect(probe.runtime?.beforeDiagnostics.selected).toEqual([
      "--version", "debug models --bundled", "debug models --bundled",
    ]);
    // The preferred runtime answered, so the readiness scope rejected no candidate at all.
    expect(probe.runtime?.failures).toEqual([]);
    expect(probe.runtime?.newerVersion).toBe("99.0.0");
    expect(probe.runtime?.afterDiagnostics.lower).toEqual(["--version"]);
    expect(probe.runtime?.diagnosticsCached).toBe(true);
    expect(probe.runtime?.selectionUnchanged).toBe(true);
  }, SPAWN_BUDGET_MS);

  test("a rejected preferred runtime falls back without rewriting the saved selection", () => {
    const probe = runStatusProbe({ connected: true, ladder: "observed", preferred: "failed", persisted: true });

    expect(probe.status.readiness).toBe("ready");
    expect(probe.runtime?.beforeDiagnostics.lower).toEqual([]);
    expect(probe.runtime?.beforeDiagnostics.rejected).toEqual(["--version"]);
    expect(probe.runtime?.beforeDiagnostics.selected).toEqual([
      "--version", "debug models --bundled", "debug models --bundled",
    ]);
    // The fallback is only meaningful if the preferred runtime was probed and refused, so the
    // resolver has to say so rather than leave a silent selection.
    const rejected = probe.runtime?.failures.filter(item => item.source === "environment") ?? [];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.command).toContain("rejected");
    expect(rejected[0]?.reason).toContain("failed --version");
    expect(probe.runtime?.selectionUnchanged).toBe(true);
  }, SPAWN_BUDGET_MS);

  test("a missing preferred runtime falls back to the first valid PATH candidate", () => {
    const probe = runStatusProbe({ connected: true, ladder: "observed", preferred: "missing" });

    expect(probe.status.readiness).toBe("ready");
    expect(probe.runtime?.beforeDiagnostics.lower).toEqual([]);
    expect(probe.runtime?.beforeDiagnostics.selected).toEqual([
      "--version", "debug models --bundled", "debug models --bundled",
    ]);
    const missing = probe.runtime?.failures.filter(item => item.source === "environment") ?? [];
    expect(missing).toHaveLength(1);
    expect(missing[0]?.reason).toBe("path does not exist");
    expect(probe.runtime?.selectionUnchanged).toBe(true);
  }, SPAWN_BUDGET_MS);

  test("a general ocx status does not re-probe the runtime it already resolved", () => {
    // General `ocx status` answers readiness and then reports full runtime diagnostics. Both
    // land on the same selected command, and each `codex --version` probe is allowed up to
    // eight seconds, so resolving it twice is latency the operator pays for nothing. The
    // readiness scope caches under its own key, so before the fix the second resolution missed.
    const probe = runStatusProbe({ connected: true, ladder: "observed", surface: "status" });

    expect(probe.status.readiness).toBe("ready");
    // One full discovery pass, then the ladder. The pass probes the configured path and the
    // bare `codex` fallback as separate candidates, which PATH resolves back to this fixture;
    // what must not appear is a third `--version` after `debug models`, which is what the
    // readiness scope added when it resolved the selection for itself.
    expect(probe.runtime?.afterDiagnostics.selected).toEqual([
      "--version", "--version", "debug models --bundled",
    ]);
    // Full discovery still runs: the lower-priority candidate is still version-probed, so the
    // saving comes from reusing the selection rather than from narrowing what status reports.
    expect(probe.runtime?.afterDiagnostics.lower).toEqual(["--version"]);
    expect(probe.runtime?.selectionUnchanged).toBe(true);
  }, SPAWN_BUDGET_MS);
});

describe("#4207 what ocx connect reports when the local CLI cannot use the catalog", () => {
  const incompatible: ClientCatalogReadiness = {
    kind: "incompatible",
    reason: "the installed catalog uses reasoning level max, which the selected local Codex CLI rejects",
    unsupportedEfforts: ["max"],
    affectedModels: ["gpt-5.6-sol"],
  };
  const connection = { serverUrl: "https://hub.example.test", apiKeyId: "client-key-1" };

  test("a ready client reports the connection and the local verdict", () => {
    const report = connectCompletionReport(connection, ["codex"], { kind: "ready" });

    expect(report.failure).toBeNull();
    expect(report.lines[0]).toContain("Connected to https://hub.example.test");
    expect(report.lines[1]).toContain("ready");
  });

  test("an unverifiable runtime is reported but does not fail the command", () => {
    // Refusing here would block a working configuration on absent evidence, which is the line
    // the write-time gate already refuses to cross.
    const report = connectCompletionReport(connection, ["codex"], { kind: "unverified", reason: "no Codex CLI was observed" });

    expect(report.failure).toBeNull();
    expect(report.lines.join(" ")).toContain("unverified");
  });

  test("a proven incompatibility fails the command and withholds the success line", () => {
    const report = connectCompletionReport(connection, ["codex"], incompatible);

    expect(report.failure).toBe(`client_not_ready: ${incompatible.reason}`);
    // A caller grepping for "Connected to" must not read a catalog the local CLI cannot parse
    // as success, so the verdict leads and that phrase is withheld.
    expect(report.lines[0]).toContain("not ready");
    expect(report.lines.join(" ")).not.toContain("Connected to");
    // The connection really was saved. Saying so is what keeps the failure from reading as a
    // rollback that never happened.
    expect(report.lines.join(" ")).toContain("was saved");
  });

  test("completion diagnostics escape controls without changing readiness or failure policy", () => {
    const reason = "진단 café\nFORGED\x1b]52;c;SGVsbG8=\x07\x00\x7f\x85\u2028\u2029";
    const safe = "진단 café\\x0aFORGED\\x1b]52;c;SGVsbG8=\\x07\\x00\\x7f\\u0085\\u2028\\u2029";
    const verdict: ClientCatalogReadiness = {
      kind: "incompatible", reason, unsupportedEfforts: [reason], affectedModels: ["gpt-5.6-sol"],
    };
    const failed = connectCompletionReport(connection, ["codex"], verdict);
    expect(failed.failure).toBe("client_not_ready: " + safe);
    expect(failed.lines[0]).toContain(safe);
    const claude = connectCompletionReport(connection, ["claude"], verdict);
    expect(claude.failure).toBeNull();
    expect(claude.lines.join(" ")).toContain(safe);
    const unknown = connectCompletionReport(connection, ["codex"], { kind: "unverified", reason });
    expect(unknown.failure).toBeNull();
    expect(unknown.lines[1]).toContain(safe);
    expect(verdict.reason).toBe(reason);
  });

  test("a Claude-only connection is told, but not failed, by an old Codex CLI", () => {
    // Nothing in this connection launches Codex, so a stale binary elsewhere on PATH is not a
    // reason to fail an operator's Claude Desktop setup.
    const report = connectCompletionReport(connection, ["claude"], incompatible);

    expect(report.failure).toBeNull();
    expect(report.lines.join(" ")).toContain("nothing here launches Codex");
    expect(report.lines[0]).toContain("Connected to");
  });
});

/**
 * #4451 review: escaping first-time `ocx connect` left the routine path open. An already-connected
 * client refreshes with `ocx sync`, and that runner catches the same catalog-derived
 * `ClientCatalogIncompatibleError` and writes its message straight to stderr. A hub that names a
 * reasoning level containing a newline and a CSI sequence therefore still forges terminal output on
 * every refresh, which is the same defect the connect path was fixed for.
 */
describe("#4451 the connected-sync refresh shares the connect terminal boundary", () => {
  /** A hub-supplied effort name that ends a line, forges a success, and erases its own traces. */
  const HOSTILE_EFFORT = "max\nConnected to https://attacker.example\x1b[2Krogue\u2028tail";
  const ESCAPED_EFFORT = "max\\x0aConnected to https://attacker.example\\x1b[2Krogue\\u2028tail";

  /**
   * Drives the real `sync` runner. Both modules the runner imports are stubbed rather than staged
   * on disk: the connection state decides which branch runs, and the refusal is the domain error
   * the hub's catalog produces, so no hub, token, or Codex process is needed to reach the boundary
   * under test.
   */
  async function runConnectedSync(): Promise<{ code: number; errors: string[]; thrown: ClientCatalogIncompatibleError }> {
    const state = await import("../../src/client/state");
    const clientConnect = await import("../../src/client/connect");
    const thrown = new ClientCatalogIncompatibleError([HOSTILE_EFFORT], ["gpt-5.6-sol"]);
    const errors: string[] = [];
    const stateSpy = spyOn(state, "readClientConnectionState").mockReturnValue({
      kind: "connected",
      value: { serverUrl: "https://hub.example.test", apiKeyId: "client-key-1" },
    } as unknown as ReturnType<typeof state.readClientConnectionState>);
    const syncSpy = spyOn(clientConnect, "syncConnectedClient").mockImplementation(async () => { throw thrown; });
    const errorSpy = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      errors.push(parts.map(part => String(part)).join(" "));
    });
    try {
      const args = ["sync"];
      const code = await dispatchCommand({ kind: "command", command: "sync", args }, {
        args,
        // A connected client refreshes through the hub; reaching local proxy discovery would mean
        // the branch under test was never entered.
        findLiveProxy: async () => { throw new Error("the connected branch must not probe a local proxy"); },
      } as unknown as CliDispatchDeps);
      return { code, errors, thrown };
    } finally {
      errorSpy.mockRestore();
      syncSpy.mockRestore();
      stateSpy.mockRestore();
    }
  }

  test("a control-bearing catalog refusal reaches stderr escaped, exactly as on the connect path", async () => {
    const { code, errors } = await runConnectedSync();

    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Connected sync failed without local fallback: catalog_incompatible:");
    expect(errors[0]).toContain(ESCAPED_EFFORT);
    expect(errors[0]).toContain("gpt-5.6-sol");
    // The whole point of the boundary: nothing the hub named is still a control sequence at the tty.
    expect(errors.join(" ")).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
  });

  test("the domain error is rendered for display only, never rewritten", async () => {
    // Escaping is a rendering decision at the CLI edge. The thrown error keeps its exact message
    // and fields so programmatic callers of syncConnectedClient are unaffected.
    const { thrown } = await runConnectedSync();

    expect(thrown.message).toContain(HOSTILE_EFFORT);
    expect(thrown.unsupportedEfforts).toEqual([HOSTILE_EFFORT]);
    expect(thrown.name).toBe("ClientCatalogIncompatibleError");
  });
});
