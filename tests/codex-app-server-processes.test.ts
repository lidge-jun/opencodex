import { describe, expect, test } from "bun:test";
import {
  afterCatalogWriteHandleAppServers,
  formatStaleCodexAppServerWarning,
  isCodexAppServerCommandLine,
  listCodexAppServerProcesses,
  restartCodexAppServers,
} from "../src/codex/app-server-processes";

describe("Codex app-server process matching (#476)", () => {
  test("matches Codex app-server and code-mode-host command lines", () => {
    expect(isCodexAppServerCommandLine("codex app-server --listen unix:///tmp/codex.sock")).toBe(true);
    expect(isCodexAppServerCommandLine("/usr/local/bin/codex app-server proxy")).toBe(true);
    expect(isCodexAppServerCommandLine("C:\\Users\\a\\AppData\\codex.exe app-server --listen pipe")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --verbose app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex-code-mode-host --session 1")).toBe(true);
  });

  test("rejects unrelated processes and app-server only in later arguments", () => {
    expect(isCodexAppServerCommandLine("hermes-codex-bridge-mcp --port 9")).toBe(false);
    expect(isCodexAppServerCommandLine("node ./opencodex/src/cli/index.ts start")).toBe(false);
    expect(isCodexAppServerCommandLine("codex exec 'hello'")).toBe(false);
    expect(isCodexAppServerCommandLine("codex exec \"debug app-server behavior\"")).toBe(false);
    expect(isCodexAppServerCommandLine("codex exec debug app-server behavior")).toBe(false);
    expect(isCodexAppServerCommandLine("something-app-server-without-codex-bin")).toBe(false);
  });

  test("listCodexAppServerProcesses filters injected snapshots", () => {
    const matched = listCodexAppServerProcesses({
      listSnapshots: () => [
        { pid: 11, commandLine: "hermes-codex-bridge-mcp" },
        { pid: 22, commandLine: "codex app-server --listen unix://x" },
        { pid: 22, commandLine: "codex app-server --listen unix://x" },
        { pid: 33, commandLine: "codex-code-mode-host" },
        { pid: 44, commandLine: "codex exec hi" },
        { pid: 55, commandLine: "codex exec \"debug app-server behavior\"" },
      ],
    });
    expect(matched.map(process => process.pid)).toEqual([22, 33]);
  });

  test("restartCodexAppServers signals all first, shared wait deadline, no SIGKILL", () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const waits: number[] = [];
    const alive = new Set([100, 200]);
    const snapshots = [
      { pid: 100, commandLine: "codex app-server" },
      { pid: 200, commandLine: "codex-code-mode-host" },
    ];
    let now = 1_000;
    const result = restartCodexAppServers(
      snapshots,
      {
        listSnapshots: () => snapshots,
        kill: (pid, signal) => {
          signals.push({ pid, signal });
          if (pid === 100) alive.delete(100);
        },
        isAlive: pid => alive.has(pid),
        waitExit: (pid, timeoutMs) => {
          waits.push(timeoutMs);
          now += 500;
          return !alive.has(pid);
        },
        now: () => now,
      },
    );
    expect(signals).toEqual([
      { pid: 100, signal: "SIGTERM" },
      { pid: 200, signal: "SIGTERM" },
    ]);
    // Shared deadline: second wait gets the remaining budget, not another full 2s.
    expect(waits).toEqual([2_000, 1_500]);
    expect(result.stopped).toEqual([100]);
    expect(result.surviving).toEqual([200]);
    expect(result.failed).toEqual([]);
  });

  test("restartCodexAppServers treats kill-throw on already-dead pid as stopped", () => {
    const result = restartCodexAppServers(
      [{ pid: 9, commandLine: "codex app-server" }],
      {
        listSnapshots: () => [{ pid: 9, commandLine: "codex app-server" }],
        kill: () => {
          throw new Error("ESRCH");
        },
        isAlive: () => false,
        waitExit: () => true,
      },
    );
    expect(result.stopped).toEqual([9]);
    expect(result.failed).toEqual([]);
    expect(result.surviving).toEqual([]);
  });

  test("restartCodexAppServers skips PIDs whose identity changed before signal", () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = restartCodexAppServers(
      [{ pid: 42, commandLine: "codex app-server" }],
      {
        listSnapshots: () => [{ pid: 42, commandLine: "vim README.md" }],
        kill: (pid, signal) => {
          signals.push({ pid, signal });
        },
        isAlive: () => true,
        waitExit: () => false,
      },
    );
    expect(signals).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(result.surviving).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("afterCatalogWriteHandleAppServers warns by default and restarts when requested", () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const snapshots = [{ pid: 7, commandLine: "codex app-server --listen unix://x" }];
    const io = {
      listSnapshots: () => snapshots,
      kill: () => {},
      isAlive: () => false,
      waitExit: () => true,
    };

    const warned = afterCatalogWriteHandleAppServers({
      restart: false,
      log: { log: line => logs.push(String(line)), error: line => errors.push(String(line)) },
      io,
    });
    expect(warned.warned).toBe(true);
    expect(errors[0]).toContain(formatStaleCodexAppServerWarning(warned.processes));
    expect(errors[0]).toContain("ocx sync --restart-codex");

    const restarted = afterCatalogWriteHandleAppServers({
      restart: true,
      log: { log: line => logs.push(String(line)), error: line => errors.push(String(line)) },
      io,
    });
    expect(restarted.warned).toBe(false);
    expect(restarted.restart?.stopped).toEqual([7]);
    expect(logs.some(line => line.includes("Stopping Codex app-server"))).toBe(true);
  });
});
