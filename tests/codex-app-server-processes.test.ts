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
    expect(isCodexAppServerCommandLine("codex-code-mode-host --session 1")).toBe(true);
  });

  test("rejects unrelated processes that merely contain codex", () => {
    expect(isCodexAppServerCommandLine("hermes-codex-bridge-mcp --port 9")).toBe(false);
    expect(isCodexAppServerCommandLine("node ./opencodex/src/cli/index.ts start")).toBe(false);
    expect(isCodexAppServerCommandLine("codex exec 'hello'")).toBe(false);
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
      ],
    });
    expect(matched.map(process => process.pid)).toEqual([22, 33]);
  });

  test("restartCodexAppServers sends SIGTERM and reports survivors without SIGKILL", () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const alive = new Set([100, 200]);
    const result = restartCodexAppServers(
      [
        { pid: 100, commandLine: "codex app-server" },
        { pid: 200, commandLine: "codex-code-mode-host" },
      ],
      {
        kill: (pid, signal) => {
          signals.push({ pid, signal });
          if (pid === 100) alive.delete(100);
        },
        isAlive: pid => alive.has(pid),
        waitExit: pid => !alive.has(pid),
      },
    );
    expect(signals).toEqual([
      { pid: 100, signal: "SIGTERM" },
      { pid: 200, signal: "SIGTERM" },
    ]);
    expect(result.stopped).toEqual([100]);
    expect(result.surviving).toEqual([200]);
    expect(result.failed).toEqual([]);
  });

  test("afterCatalogWriteHandleAppServers warns by default and restarts when requested", () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const io = {
      listSnapshots: () => [{ pid: 7, commandLine: "codex app-server --listen unix://x" }],
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
