import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isConnectionRefused, isUncleanExitEvidence, proxyHealthFailureReason, resolveStatusPid, selectListenTarget } from "../src/cli/status";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

function runStatusJson(opencodexHome: string) {
  return spawnSync(process.execPath, [cliPath, "status", "--json"], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: opencodexHome },
    encoding: "utf8",
  });
}

describe("CLI status JSON", () => {
  test("status --json prints valid read-only diagnostics without secrets", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-json-"));
    try {
      const configPath = join(opencodexHome, "config.json");
      writeFileSync(configPath, JSON.stringify({
        port: 9,
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
            apiKey: "sk-test-secret",
          },
        },
        defaultProvider: "openai",
        codexAutoStart: false,
      }), "utf8");

      const beforeFiles = readdirSync(opencodexHome).sort();
      const result = runStatusJson(opencodexHome);
      const afterFiles = readdirSync(opencodexHome).sort();

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(afterFiles).toEqual(beforeFiles);
      expect(existsSync(join(opencodexHome, "ocx.pid"))).toBe(false);

      const parsed = JSON.parse(result.stdout) as {
        schemaVersion?: unknown;
        proxy?: { running?: unknown; pid?: unknown; health?: { ok?: unknown; url?: unknown; message?: unknown } };
        dashboard?: { url?: unknown };
        listen?: { port?: unknown; source?: unknown };
        paths?: { config?: unknown; pid?: unknown; runtime?: unknown };
        runtime?: { source?: unknown };
        codexAutostart?: unknown;
        startup?: {
          status?: unknown;
          rebootSafe?: unknown;
          routingInjected?: unknown;
          serviceInstalled?: unknown;
          shimInstalled?: unknown;
          shimHealthy?: unknown;
          shimCoverage?: unknown;
          serviceSupported?: unknown;
          commands?: unknown;
        };
        defaultProvider?: unknown;
        config?: { source?: unknown; error?: unknown };
        service?: { summary?: unknown };
        codexShim?: { summary?: unknown };
        codexRuntime?: {
          path?: unknown;
          version?: unknown;
          source?: unknown;
          warning?: unknown;
          newerAvailable?: unknown;
          catalogClamp?: { active?: unknown; removedEfforts?: unknown; runtimeVersion?: unknown };
        };
        codexHome?: {
          effectiveCodexHome?: unknown;
          appCodexHome?: unknown;
          mismatch?: unknown;
          warning?: unknown;
          action?: unknown;
        };
      };

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.proxy?.running).toBe(false);
      expect(parsed.proxy?.pid).toBeNull();
      expect(parsed.proxy?.health?.ok).toBe(false);
      expect(parsed.proxy?.health?.url).toBe("http://127.0.0.1:9/healthz");
      expect(typeof parsed.proxy?.health?.message).toBe("string");
      expect(parsed.dashboard?.url).toBe("http://localhost:9/");
      expect(parsed.listen?.port).toBe(9);
      expect(parsed.listen?.source).toBe("config");
      expect(parsed.paths?.config).toBe(configPath);
      expect(parsed.paths?.pid).toBe(join(opencodexHome, "ocx.pid"));
      expect(typeof parsed.paths?.runtime).toBe("string");
      expect(typeof parsed.runtime?.source).toBe("string");
      expect(parsed.codexAutostart).toBe(false);
      expect(["native", "protected", "at-risk"]).toContain(parsed.startup?.status);
      expect(typeof parsed.startup?.rebootSafe).toBe("boolean");
      expect(typeof parsed.startup?.routingInjected).toBe("boolean");
      expect(typeof parsed.startup?.serviceInstalled).toBe("boolean");
      expect(typeof parsed.startup?.shimInstalled).toBe("boolean");
      expect(typeof parsed.startup?.shimHealthy).toBe("boolean");
      expect(["full", "cli-only", "none"]).toContain(parsed.startup?.shimCoverage);
      expect(typeof parsed.startup?.serviceSupported).toBe("boolean");
      expect(typeof parsed.startup?.commands).toBe("object");
      expect(parsed.defaultProvider).toBe("openai");
      expect(parsed.config?.source).toBe("file");
      expect(parsed.config?.error).toBeNull();
      expect(typeof parsed.service?.summary).toBe("string");
      expect(typeof parsed.codexShim?.summary).toBe("string");
      expect(typeof parsed.codexRuntime?.path).toBe("string");
      expect(typeof parsed.codexRuntime?.source).toBe("string");
      expect(parsed.codexRuntime?.version === null || typeof parsed.codexRuntime?.version === "string").toBe(true);
      expect(parsed.codexRuntime?.warning === null || typeof parsed.codexRuntime?.warning === "string").toBe(true);
      expect(
        parsed.codexRuntime?.newerAvailable === null
        || (typeof parsed.codexRuntime?.newerAvailable === "object" && parsed.codexRuntime?.newerAvailable !== null),
      ).toBe(true);
      expect(parsed.codexRuntime?.catalogClamp?.active).toBe(false);
      expect(Array.isArray(parsed.codexRuntime?.catalogClamp?.removedEfforts)).toBe(true);
      expect(parsed.codexRuntime?.catalogClamp?.runtimeVersion).toBeNull();
      expect(typeof parsed.codexHome?.effectiveCodexHome).toBe("string");
      expect(typeof parsed.codexHome?.appCodexHome).toBe("string");
      expect(typeof parsed.codexHome?.mismatch).toBe("boolean");
      expect(parsed.codexHome?.warning === null || typeof parsed.codexHome?.warning === "string").toBe(true);

      const serialized = JSON.stringify(parsed).toLowerCase();
      for (const forbidden of ["apikey", "sk-test-secret", "token", "refreshtoken", "authorization", "email"]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
    }
  });

  test("status --json reports catalogClamp.runtimeVersion when clamp is active", async () => {
    const { chmodSync } = await import("node:fs");
    const { persistEffortClamp, resetCodexRuntimeResolveCacheForTests } = await import("../src/codex/runtime");
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-clamp-"));
    try {
      writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
        port: 9,
        providers: {},
        defaultProvider: "openai",
      }), "utf8");
      const fakeCodex = process.platform === "win32"
        ? join(opencodexHome, "bin", "codex.cmd")
        : join(opencodexHome, "bin", "codex");
      mkdirSync(join(opencodexHome, "bin"), { recursive: true });
      if (process.platform === "win32") {
        writeFileSync(fakeCodex, "@echo off\r\necho codex-cli 0.133.0\r\n", "utf8");
      } else {
        writeFileSync(fakeCodex, "#!/bin/sh\necho 'codex-cli 0.133.0'\n", "utf8");
        chmodSync(fakeCodex, 0o755);
      }
      persistEffortClamp({
        runtimePath: fakeCodex,
        runtimeVersion: "0.133.0",
        removedEfforts: ["max", "ultra"],
        affectedModels: ["gpt-5.6-sol"],
      }, { configDir: opencodexHome });
      resetCodexRuntimeResolveCacheForTests();

      const result = spawnSync(process.execPath, [cliPath, "status", "--json"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPENCODEX_HOME: opencodexHome,
          CODEX_CLI_PATH: fakeCodex,
          PATH: "",
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        codexRuntime?: {
          version?: string | null;
          catalogClamp?: { active?: boolean; removedEfforts?: string[]; runtimeVersion?: string | null };
        };
      };
      expect(parsed.codexRuntime?.version).toBe("0.133.0");
      expect(parsed.codexRuntime?.catalogClamp).toEqual({
        active: true,
        removedEfforts: ["max", "ultra"],
        runtimeVersion: "0.133.0",
      });
    } finally {
      resetCodexRuntimeResolveCacheForTests();
      rmSync(opencodexHome, { recursive: true, force: true });
    }
  });

  test("status rejects unknown flags instead of silently printing human text", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-json-"));
    try {
      writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
        port: 9,
        providers: {},
        defaultProvider: "openai",
      }), "utf8");

      const result = spawnSync(process.execPath, [cliPath, "status", "--yaml"], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: opencodexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: ocx status [--json]");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
    }
  });

  test("status --json rejects additional flags", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-json-"));
    try {
      writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
        port: 9,
        providers: {},
        defaultProvider: "openai",
      }), "utf8");

      const result = spawnSync(process.execPath, [cliPath, "status", "--json", "--yaml"], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: opencodexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: ocx status [--json]");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
    }
  });

  test("status --json on malformed config remains read-only and secret-safe", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-json-"));
    try {
      const configPath = join(opencodexHome, "config.json");
      writeFileSync(configPath, '{ "apiKey": "sk-status-secret", invalid json', "utf8");
      const beforeFiles = readdirSync(opencodexHome).sort();

      const result = runStatusJson(opencodexHome);
      const afterFiles = readdirSync(opencodexHome).sort();

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(afterFiles).toEqual(beforeFiles);
      expect(afterFiles.some(name => name.startsWith("config.json.invalid-"))).toBe(false);

      const parsed = JSON.parse(result.stdout) as {
        config?: { source?: unknown; error?: unknown };
        paths?: { config?: unknown };
      };
      expect(parsed.paths?.config).toBe(configPath);
      expect(parsed.config?.source).toBe("fallback");
      expect(parsed.config?.error).toBe("invalid_json");

      const serialized = JSON.stringify(parsed);
      expect(serialized).not.toContain("sk-status-secret");
      expect(serialized).not.toContain("apiKey");
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
    }
  });

  test("listen target prefers current runtime port metadata", () => {
    const target = selectListenTarget(
      { port: 10100, hostname: "0.0.0.0" },
      123,
      { pid: 123, port: 58195, hostname: "0.0.0.0" },
    );

    expect(target.source).toBe("runtime");
    expect(target.port).toBe(58195);
    expect(target.healthUrl).toBe("http://127.0.0.1:58195/healthz");
    expect(target.dashboardUrl).toBe("http://localhost:58195/");
  });

  test("resolveStatusPid preserves an authoritative null from live orphan checks", () => {
    expect(resolveStatusPid({ pid: null }, 4242)).toBeNull();
    expect(resolveStatusPid({ pid: 1111 }, 4242)).toBe(1111);
    expect(resolveStatusPid(null, 4242)).toBe(4242);
    expect(resolveStatusPid(null, null)).toBeNull();
  });

  test("classifies an aborted direct health probe as timed out", () => {
    const controller = new AbortController();
    controller.abort();
    expect(proxyHealthFailureReason(new Error("socket closed"), controller.signal)).toBe("timed out");
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    expect(proxyHealthFailureReason(abortError, new AbortController().signal)).toBe("timed out");
    expect(proxyHealthFailureReason(new Error("connection refused"), new AbortController().signal)).toBe("unreachable");
  });

  test("listen target brackets raw IPv6 hostnames in the health URL", () => {
    const target = selectListenTarget(
      { port: 10100, hostname: "::1" },
      123,
      { pid: 123, port: 58195, hostname: "::1" },
    );

    expect(target.healthUrl).toBe("http://[::1]:58195/healthz");
    expect(target.dashboardUrl).toBe("http://localhost:58195/");
  });

  test("listen target ignores stale runtime port metadata", () => {
    const target = selectListenTarget(
      { port: 10100, hostname: "127.0.0.1" },
      123,
      { pid: 999, port: 58195 },
    );

    expect(target.source).toBe("config");
    expect(target.port).toBe(10100);
    expect(target.healthUrl).toBe("http://127.0.0.1:10100/healthz");
    expect(target.dashboardUrl).toBe("http://localhost:10100/");
  });
});

/**
 * #1419: an unsupervised proxy died from a native trap and every later command said
 * only "not running". The persisted owner records are the one piece of evidence that
 * separates a crash from a proxy that was never started, and status used to discard
 * it. These cases pin the predicate, including the two false-positive shapes that a
 * naive implementation gets wrong.
 */
describe("unclean prior exit evidence", () => {
  const base = {
    live: false,
    healthOk: false,
    healthRefused: true,
    ownerPidAlive: false,
    pidRecordBefore: 4242,
    pidRecordAfter: 4242,
    runtimePidBefore: 4242,
    runtimePidAfter: 4242,
  };

  test("both records outliving a dead owner is an unclean exit", () => {
    expect(isUncleanExitEvidence(base)).toBe(true);
  });

  // Blocker 5 from the plan audit: a fixture that always writes BOTH records cannot
  // tell an AND from an OR, so each record must be sufficient on its own.
  test("a pid record alone is sufficient", () => {
    expect(isUncleanExitEvidence({
      ...base,
      runtimePidBefore: null,
      runtimePidAfter: null,
    })).toBe(true);
  });

  test("a runtime-port record alone is sufficient", () => {
    expect(isUncleanExitEvidence({
      ...base,
      pidRecordBefore: null,
      pidRecordAfter: null,
    })).toBe(true);
  });

  test("a clean home reports nothing", () => {
    expect(isUncleanExitEvidence({
      ...base,
      pidRecordBefore: null,
      pidRecordAfter: null,
      runtimePidBefore: null,
      runtimePidAfter: null,
    })).toBe(false);
  });

  test("a live proxy or a healthy probe reports nothing", () => {
    expect(isUncleanExitEvidence({ ...base, live: true })).toBe(false);
    expect(isUncleanExitEvidence({ ...base, healthOk: true })).toBe(false);
  });

  // Re-audit blocker 2: without this case the owner-alive clause is never exercised,
  // because every other fixture names a dead pid.
  test("a live owner pid is a start in progress, not a crash", () => {
    expect(isUncleanExitEvidence({ ...base, ownerPidAlive: true })).toBe(false);
  });

  // Re-audit blocker 1: `handleStart` binds the port before it publishes either
  // record, so a start caught in that window leaves both snapshots identical. Only a
  // refused connection proves nothing holds the port.
  test("a held port is not a crash even when the records look stale", () => {
    expect(isUncleanExitEvidence({ ...base, healthRefused: false })).toBe(false);
  });

  test("records published mid-probe suppress the report", () => {
    expect(isUncleanExitEvidence({ ...base, pidRecordBefore: null })).toBe(false);
    expect(isUncleanExitEvidence({ ...base, runtimePidAfter: 9999 })).toBe(false);
  });

  // Review blocker 2: `unreachable` covers every non-abort failure, including a socket
  // that is ACCEPTED and then reset — which is what an in-flight bind looks like. Only a
  // connect-phase refusal proves the port is free.
  test("only a connect-phase refusal counts as nothing listening", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
    expect(isConnectionRefused(refused)).toBe(true);

    const nested = new Error("fetch failed", { cause: refused });
    expect(isConnectionRefused(nested)).toBe(true);

    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isConnectionRefused(reset)).toBe(false);

    // A message that merely mentions refusal without the errno is not evidence.
    expect(isConnectionRefused(new Error("connection refused by policy"))).toBe(false);
    expect(isConnectionRefused(undefined)).toBe(false);
  });
});

/**
 * Command-level coverage. Review found the unit tests above were satisfiable by an
 * implementation that never reported anything: replacing the returned
 * `staleProcessState` with a constant `false` left every predicate test green. These
 * drive the real CLI, so the field has to travel from disk to output.
 */
describe("status reports stale process records end to end", () => {
  const seed = (home: string, opts: { pid?: number; runtime?: boolean; port: number }): void => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: opts.port, codexAutoStart: false }), "utf8");
    const pid = opts.pid ?? (process.pid === 4242 ? 4243 : 4242);
    if (opts.pid !== 0) writeFileSync(join(home, "ocx.pid"), String(pid), "utf8");
    if (opts.runtime) {
      writeFileSync(join(home, "runtime-port.json"), JSON.stringify({ pid, port: opts.port, hostname: "127.0.0.1" }), "utf8");
    }
  };

  /**
   * A port that is genuinely free: bind an ephemeral port, read it, release it. The
   * discard port 9 is conventionally unused but not guaranteed, and if anything answers
   * on it the probe is accepted rather than refused and these fixtures invert.
   */
  let freePort = 9;
  beforeAll(async () => {
    const probe = createServer();
    await new Promise<void>(resolve => { probe.listen(0, "127.0.0.1", () => resolve()); });
    freePort = (probe.address() as AddressInfo).port;
    await new Promise<void>(resolve => { probe.close(() => resolve()); });
  });

  test("a dead owner record surfaces in --json and in human output", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-stale-json-"));
    try {
      seed(home, { runtime: true, port: freePort });

      const json = runStatusJson(home);
      expect(json.status).toBe(0);
      const parsed = JSON.parse(json.stdout) as { proxy?: { staleProcessState?: unknown } };
      expect(parsed.proxy?.staleProcessState).toBe(true);

      const human = spawnSync(process.execPath, [cliPath, "status"], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: home },
        encoding: "utf8",
      });
      expect(human.stdout).toContain("may have exited unexpectedly");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a clean home reports false and says nothing about a previous run", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-stale-clean-"));
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: freePort, codexAutoStart: false }), "utf8");

      const json = runStatusJson(home);
      const parsed = JSON.parse(json.stdout) as { proxy?: { staleProcessState?: unknown } };
      expect(parsed.proxy?.staleProcessState).toBe(false);

      const human = spawnSync(process.execPath, [cliPath, "status"], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: home },
        encoding: "utf8",
      });
      expect(human.stdout).not.toContain("may have exited unexpectedly");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Review blocker 3: a recycled pid must suppress rather than assert. This process is
  // certainly alive, so recording it stands in for a reused pid.
  test("a record naming a live pid is never reported as a stale exit", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-stale-livepid-"));
    try {
      seed(home, { pid: process.pid, runtime: true, port: freePort });

      const parsed = JSON.parse(runStatusJson(home).stdout) as { proxy?: { staleProcessState?: unknown } };
      expect(parsed.proxy?.staleProcessState).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Review blocker 4: status and doctor disagreed when the recorded port differed from
  // the configured one. Both now probe the recorded port, so both must agree.
  //
  // The configured port must be OCCUPIED for this to discriminate: if both ports are
  // simply free, probing either one yields the same refusal and the test cannot tell the
  // two implementations apart. A listener that accepts and resets is what an in-flight
  // bind looks like, so a run that probed the configured port would suppress the report.
  test("a fallback-port record is judged on the recorded port, not the configured one", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-stale-fallback-"));
    const occupied = createServer(socket => { socket.destroy(); });
    await new Promise<void>(resolve => { occupied.listen(0, "127.0.0.1", () => resolve()); });
    const occupiedPort = (occupied.address() as AddressInfo).port;
    try {
      const pid = process.pid === 4242 ? 4243 : 4242;
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: occupiedPort, codexAutoStart: false }), "utf8");
      writeFileSync(join(home, "ocx.pid"), String(pid), "utf8");
      writeFileSync(join(home, "runtime-port.json"), JSON.stringify({ pid, port: freePort, hostname: "127.0.0.1" }), "utf8");

      const parsed = JSON.parse(runStatusJson(home).stdout) as { proxy?: { staleProcessState?: unknown } };
      expect(parsed.proxy?.staleProcessState).toBe(true);
    } finally {
      await new Promise<void>(resolve => { occupied.close(() => resolve()); });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
