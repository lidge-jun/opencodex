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
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { connectCompletionReport } from "../../src/cli/connect";
import type { ClientCatalogReadiness } from "../../src/client/catalog-compatibility";

/** Codex CLI 0.135.0's ladder, verbatim from the parse error in the issue. */
const OLD_CLI = ["none", "minimal", "low", "medium", "high", "xhigh"];
const NEW_CLI = [...OLD_CLI, "max", "ultra"];

/** A hub catalog whose top rung the reporter's CLI rejects. */
const CATALOG_WITH_MAX = JSON.stringify({
  models: [{ slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }] }],
});

type ProbeResult = {
  lines: string[];
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
  preferred?: "valid" | "failed" | "missing";
  persisted?: boolean;
  fullDiagnostics?: boolean;
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
    writeFileSync(join(opencodexHome, "service-api-token"), `${token}\n`, { mode: 0o600 });
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
      const selectionPath = join(process.env.OPENCODEX_HOME, "codex-runtime.json");
      const selectionBefore = readOptional(selectionPath);
      const lifecycleLockDeps = { lockPath: process.env.OPENCODEX_HOME + "/lifecycle.sqlite" };
      const captured = [];
      const real = console.log;
      (async () => {
        console.log = (...parts) => captured.push(parts.join(" "));
        try {
          await handleConnectCommand(["status"], { lifecycleLockDeps, catalogProbeDeps });
        } finally {
          console.log = real;
        }
        const status = collectClientConnectionStatus(
          Date.parse("2026-08-28T00:00:10.000Z"),
          lifecycleLockDeps,
          catalogProbeDeps,
        );
        let runtime;
        if (ladder === "observed") {
          const dirs = JSON.parse(process.env.FIXTURE_RUNTIME_DIRS);
          const calls = () => Object.fromEntries(Object.entries(dirs).map(([key, dir]) =>
            [key, (readOptional(join(dir, "calls.log")) ?? "").split(/\\r?\\n/).map(line => line.trim()).filter(Boolean)]));
          const beforeDiagnostics = calls();
          let newerVersion;
          let diagnosticsCached = true;
          if (process.env.FIXTURE_FULL_DIAGNOSTICS === "1") {
            const { resolveCodexRuntime } = require("./src/codex/runtime");
            newerVersion = resolveCodexRuntime().newerAvailable?.version;
            const first = JSON.stringify(calls());
            resolveCodexRuntime();
            diagnosticsCached = first === JSON.stringify(calls());
          }
          runtime = { beforeDiagnostics, afterDiagnostics: calls(), diagnosticsCached, newerVersion,
            selectionUnchanged: selectionBefore === readOptional(selectionPath) };
        }
        console.log(JSON.stringify({ lines: captured, status, runtime }));
      })();
    `;

    const result = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot(),
      encoding: "utf8",
      // Bun's test timeout cannot interrupt spawnSync, so a child that wedged on a lock or an
      // unexpected probe would hang the worker rather than fail. Same budget the existing
      // client fixtures use.
      timeout: INTERNAL_DEADLINE_MS,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        OPENCODEX_HOME: opencodexHome,
        CODEX_HOME: codexHome,
        // Matches the existing client fixtures: no probe may reach the operator's real Claude
        // Desktop configuration, even transitively.
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(opencodexHome, "desktop"),
        FIXTURE_LADDER: JSON.stringify(options.ladder),
        ...runtimeEnv,
      },
    });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as ProbeResult;
  } finally {
    removeTreeWithRetry(opencodexHome);
    removeTreeWithRetry(codexHome);
  }
}

describe("#4207 connected-client readiness", () => {
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
  test("observes only the selected runtime and leaves full diagnostics available", () => {
    const probe = runStatusProbe({ connected: true, ladder: "observed", fullDiagnostics: true });

    expect(probe.status.readiness).toBe("ready");
    expect(probe.runtime?.beforeDiagnostics.lower).toEqual([]);
    expect(probe.runtime?.beforeDiagnostics.selected).toEqual([
      "--version", "debug models --bundled", "debug models --bundled",
    ]);
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
    expect(probe.runtime?.selectionUnchanged).toBe(true);
  }, SPAWN_BUDGET_MS);

  test("a missing preferred runtime falls back to the first valid PATH candidate", () => {
    const probe = runStatusProbe({ connected: true, ladder: "observed", preferred: "missing" });

    expect(probe.status.readiness).toBe("ready");
    expect(probe.runtime?.beforeDiagnostics.lower).toEqual([]);
    expect(probe.runtime?.beforeDiagnostics.selected).toEqual([
      "--version", "debug models --bundled", "debug models --bundled",
    ]);
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

  test("a Claude-only connection is told, but not failed, by an old Codex CLI", () => {
    // Nothing in this connection launches Codex, so a stale binary elsewhere on PATH is not a
    // reason to fail an operator's Claude Desktop setup.
    const report = connectCompletionReport(connection, ["claude"], incompatible);

    expect(report.failure).toBeNull();
    expect(report.lines.join(" ")).toContain("nothing here launches Codex");
    expect(report.lines[0]).toContain("Connected to");
  });
});
