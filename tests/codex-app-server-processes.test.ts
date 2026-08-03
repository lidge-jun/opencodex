import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterCatalogWriteHandleAppServers,
  attachStaleAppServerHint,
  collectCodexAppServerCatalogState,
  formatStaleCodexAppServerWarning,
  isCodexAppServerCommandLine,
  isWindowsCodexCandidateCommandLine,
  listCodexAppServerProcesses,
  listWindowsSnapshots,
  restartCodexAppServers,
  STALE_CODEX_APP_SERVER_HINT,
  WINDOWS_CODEX_BASENAME_CANDIDATE_RE,
} from "../src/codex/app-server-processes";

describe("collectCodexAppServerCatalogState (#857)", () => {
  const APP_SERVER_CMD = "/usr/local/bin/codex app-server";

  test("not_running when no app-server process exists", () => {
    const status = collectCodexAppServerCatalogState({
      listSnapshots: () => [],
      catalogMtimeMs: () => 1_000,
    });
    expect(status.state).toBe("not_running");
    expect(status.processes).toEqual([]);
  });

  test("fresh when every app-server started after the catalog changed", () => {
    const status = collectCodexAppServerCatalogState({
      listSnapshots: () => [{ pid: 42, commandLine: APP_SERVER_CMD }],
      readStartMs: () => 2_000,
      catalogMtimeMs: () => 1_000,
    });
    expect(status.state).toBe("fresh");
  });

  test("stale when any app-server predates the catalog mtime", () => {
    const status = collectCodexAppServerCatalogState({
      listSnapshots: () => [
        { pid: 42, commandLine: APP_SERVER_CMD },
        { pid: 43, commandLine: APP_SERVER_CMD },
      ],
      readStartMs: pid => (pid === 42 ? 500 : 3_000),
      catalogMtimeMs: () => 1_000,
    });
    expect(status.state).toBe("stale");
    expect(status.processes).toEqual([
      { pid: 42, startedAtMs: 500 },
      { pid: 43, startedAtMs: 3_000 },
    ]);
  });

  test("unknown when a start time is unreadable, and when the catalog is unreadable", () => {
    const noStart = collectCodexAppServerCatalogState({
      listSnapshots: () => [{ pid: 42, commandLine: APP_SERVER_CMD }],
      readStartMs: () => null,
      catalogMtimeMs: () => 1_000,
    });
    expect(noStart.state).toBe("unknown");

    const noCatalog = collectCodexAppServerCatalogState({
      listSnapshots: () => [{ pid: 42, commandLine: APP_SERVER_CMD }],
      readStartMs: () => 500,
      catalogMtimeMs: () => null,
    });
    expect(noCatalog.state).toBe("unknown");
  });

  test("unrelated processes never enter the comparison", () => {
    const status = collectCodexAppServerCatalogState({
      listSnapshots: () => [
        { pid: 7, commandLine: "node worker.js codex app-server" },
        { pid: 8, commandLine: "/usr/bin/hermes-codex-bridge-mcp" },
      ],
      catalogMtimeMs: () => 1_000,
    });
    expect(status.state).toBe("not_running");
  });

  test("enumeration failure reports unknown, never not_running", () => {
    // On macOS the win32 enumeration path has no powershell.exe → it throws,
    // which must surface as unknown rather than "nothing is running".
    const status = collectCodexAppServerCatalogState({
      platform: process.platform === "win32" ? "linux" : "win32",
      catalogMtimeMs: () => 1_000,
    });
    if (process.platform === "win32") {
      // linux /proc is absent on Windows → same unknown outcome
      expect(status.state).toBe("unknown");
    } else {
      expect(status.state).toBe("unknown");
    }
  });

  test("equal start time and catalog mtime is conservatively stale", () => {
    const status = collectCodexAppServerCatalogState({
      listSnapshots: () => [{ pid: 42, commandLine: APP_SERVER_CMD }],
      readStartMs: () => 1_000,
      catalogMtimeMs: () => 1_000,
    });
    expect(status.state).toBe("stale");
  });
});

describe("Codex app-server process matching (#476)", () => {
  test("matches Codex app-server and code-mode-host command lines", () => {
    expect(isCodexAppServerCommandLine("codex app-server --listen unix:///tmp/codex.sock")).toBe(true);
    expect(isCodexAppServerCommandLine("/usr/local/bin/codex app-server proxy")).toBe(true);
    expect(isCodexAppServerCommandLine("C:\\Users\\a\\AppData\\codex.exe app-server --listen pipe")).toBe(true);
    expect(isCodexAppServerCommandLine("\"C:\\Program Files\\nodejs\\codex.exe\" app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("\"C:\\Program Files\\nodejs\\codex.cmd\" app-server --listen pipe")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --verbose app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex-code-mode-host --session 1")).toBe(true);
    expect(isCodexAppServerCommandLine("node /opt/codex-code-mode-host --session 1")).toBe(true);
  });

  test("matches official platform-baked Codex target-triple basenames", () => {
    expect(isCodexAppServerCommandLine(
      "/opt/codex/codex-x86_64-unknown-linux-musl app-server --listen unix:///tmp/c.sock",
    )).toBe(true);
    expect(isCodexAppServerCommandLine(
      "/Applications/Codex.app/Contents/Resources/codex-aarch64-apple-darwin app-server",
    )).toBe(true);
    expect(isCodexAppServerCommandLine(
      "C:\\Users\\a\\.codex\\bin\\codex-x86_64-pc-windows-msvc.exe app-server --listen pipe",
    )).toBe(true);
    expect(isCodexAppServerCommandLine(
      "\"C:\\Program Files\\Codex\\codex-aarch64-pc-windows-msvc.exe\" app-server",
    )).toBe(true);
    expect(isCodexAppServerCommandLine(
      "codex-x86_64-apple-darwin --profile prod app-server",
    )).toBe(true);
  });

  test("matches app-server after value-taking Codex global options", () => {
    expect(isCodexAppServerCommandLine("codex --enable js_repl app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --enable=js_repl app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --disable multi_agent_v2 app-server --listen unix://x")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --config model=gpt-5.4 app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex -c model=gpt-5.4 app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --profile production app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex -p production app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex -a never app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --ask-for-approval on-request app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --oss --local-provider ollama app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --add-dir /tmp app-server")).toBe(true);
    expect(isCodexAppServerCommandLine(
      "codex --enable js_repl --profile prod -c model=gpt-5.4 app-server --listen stdio://",
    )).toBe(true);
  });

  test("rejects unrelated processes and app-server / code-mode-host only in later arguments", () => {
    expect(isCodexAppServerCommandLine("hermes-codex-bridge-mcp --port 9")).toBe(false);
    expect(isCodexAppServerCommandLine("hermes-codex-x86_64-unknown-linux-gnu app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("node ./opencodex/src/cli/index.ts start")).toBe(false);
    expect(isCodexAppServerCommandLine("opencodex app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("/usr/bin/opencodex app-server")).toBe(false);
    // Broad codex-* tools without a Rust target-triple shape must stay unmatched.
    expect(isCodexAppServerCommandLine("codex-bridge app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("codex-helper-tool app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("codex exec 'hello'")).toBe(false);
    expect(isCodexAppServerCommandLine("codex exec \"debug app-server behavior\"")).toBe(false);
    expect(isCodexAppServerCommandLine("codex exec debug app-server behavior")).toBe(false);
    expect(isCodexAppServerCommandLine("codex exec app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("node worker.js codex app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("something-app-server-without-codex-bin")).toBe(false);
    expect(isCodexAppServerCommandLine("node worker.js codex-code-mode-host")).toBe(false);
    expect(isCodexAppServerCommandLine("bash -c codex-code-mode-host")).toBe(false);
  });

  test("Windows candidate pre-filter matches quoted Install-path executables", () => {
    expect(isWindowsCodexCandidateCommandLine(
      "\"C:\\Program Files\\nodejs\\codex.exe\" app-server",
    )).toBe(true);
    expect(isWindowsCodexCandidateCommandLine(
      "\"C:\\Program Files\\nodejs\\codex.cmd\" app-server --listen pipe",
    )).toBe(true);
    // Closing quote immediately after the executable basename.
    expect(isWindowsCodexCandidateCommandLine("codex.exe\" app-server")).toBe(true);
    expect(isWindowsCodexCandidateCommandLine("codex.cmd' app-server")).toBe(true);
    expect(isWindowsCodexCandidateCommandLine("codex app-server")).toBe(true);
    expect(isWindowsCodexCandidateCommandLine(
      "\"C:\\Program Files\\Codex\\codex-x86_64-pc-windows-msvc.exe\" app-server",
    )).toBe(true);
    expect(isWindowsCodexCandidateCommandLine(
      "C:\\Users\\a\\.codex\\bin\\codex-aarch64-pc-windows-msvc.exe app-server",
    )).toBe(true);
    // Stay narrow: incidental "opencodex" paths must not pay GetOwner.
    expect(isWindowsCodexCandidateCommandLine(
      "node C:\\Users\\a\\opencodex\\src\\cli\\index.ts start",
    )).toBe(false);
    expect(isWindowsCodexCandidateCommandLine("opencodex app-server")).toBe(false);
    expect(isWindowsCodexCandidateCommandLine("hermes-codex-bridge-mcp")).toBe(false);
    expect(isWindowsCodexCandidateCommandLine("hermes-codex-x86_64-pc-windows-msvc.exe")).toBe(false);
    expect(isWindowsCodexCandidateCommandLine("codex-bridge app-server")).toBe(false);
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
        { pid: 66, commandLine: "node worker.js codex-code-mode-host" },
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

  test("restartCodexAppServers skips recycled PID that matches a different Codex process", () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = restartCodexAppServers(
      [{ pid: 42, commandLine: "codex app-server --listen unix://old" }],
      {
        // Same PID, still Codex-shaped, but a different process identity.
        listSnapshots: () => [{ pid: 42, commandLine: "codex-code-mode-host --session 9" }],
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

describe("CLI /api sync wiring for stale app-servers (#476)", () => {
  const cliSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");
  const configRoutesSource = readFileSync(
    join(import.meta.dir, "..", "src", "server", "management", "config-routes.ts"),
    "utf8",
  );

  test("ocx sync only handles app-servers after a catalog/cache write and forwards --restart-codex", () => {
    const syncCase = cliSource.slice(cliSource.indexOf('case "sync":'), cliSource.indexOf('case "v2":'));
    expect(syncCase).toContain('args.slice(1).includes("--restart-codex")');
    expect(syncCase).toContain("synced.catalogWritten || synced.cacheSynced");
    expect(syncCase).toContain("afterCatalogWriteHandleAppServers");
    expect(syncCase).toContain("restart: restartCodex");
    expect(syncCase.indexOf("catalogWritten || synced.cacheSynced"))
      .toBeLessThan(syncCase.indexOf("afterCatalogWriteHandleAppServers"));
    // No-write path must not call the handler outside the gate.
    const gatedBlock = syncCase.slice(syncCase.indexOf("if (synced.catalogWritten"));
    expect(gatedBlock).toContain("afterCatalogWriteHandleAppServers");
    expect(syncCase.replace(gatedBlock, "")).not.toContain("afterCatalogWriteHandleAppServers");
  });

  test("ocx sync-cache only handles app-servers after a successful models_cache write", () => {
    const syncCacheCase = cliSource.slice(
      cliSource.indexOf('case "sync-cache":'),
      cliSource.indexOf('case "gui":'),
    );
    expect(syncCacheCase).toContain("invalidateCodexModelsCache()");
    expect(syncCacheCase).toContain("if (invalidateCodexModelsCache())");
    expect(syncCacheCase).toContain("afterCatalogWriteHandleAppServers");
    expect(syncCacheCase.indexOf("if (invalidateCodexModelsCache())"))
      .toBeLessThan(syncCacheCase.indexOf("afterCatalogWriteHandleAppServers"));
    const gatedBlock = syncCacheCase.slice(syncCacheCase.indexOf("if (invalidateCodexModelsCache())"));
    expect(gatedBlock).toContain("afterCatalogWriteHandleAppServers");
    expect(syncCacheCase.replace(gatedBlock, "")).not.toContain("afterCatalogWriteHandleAppServers");
  });

  test("POST /api/sync attaches staleAppServerHint only after a write and never enumerates processes", () => {
    const syncHandler = configRoutesSource.slice(
      configRoutesSource.indexOf('url.pathname === "/api/sync"'),
      configRoutesSource.indexOf('url.pathname === "/api/update/check"'),
    );
    expect(syncHandler).toContain("attachStaleAppServerHint(result)");
    expect(syncHandler).not.toContain("listCodexAppServerProcesses");
    expect(syncHandler).not.toContain("afterCatalogWriteHandleAppServers");
    expect(STALE_CODEX_APP_SERVER_HINT).toContain("ocx sync --restart-codex");
  });

  test("no-write sync responses omit staleAppServerHint", () => {
    const omitted = attachStaleAppServerHint({
      ok: true,
      catalogWritten: false,
      cacheSynced: false,
      message: "noop",
    });
    expect(omitted).toEqual({
      ok: true,
      catalogWritten: false,
      cacheSynced: false,
      message: "noop",
    });
    expect("staleAppServerHint" in omitted).toBe(false);
  });

  test("successful catalog or cache writes include the shared staleAppServerHint", () => {
    expect(attachStaleAppServerHint({
      ok: true,
      catalogWritten: true,
      cacheSynced: false,
    }).staleAppServerHint).toBe(STALE_CODEX_APP_SERVER_HINT);

    expect(attachStaleAppServerHint({
      ok: true,
      catalogWritten: false,
      cacheSynced: true,
    }).staleAppServerHint).toBe(STALE_CODEX_APP_SERVER_HINT);

    expect(attachStaleAppServerHint({
      ok: true,
      catalogWritten: true,
      cacheSynced: true,
    }).staleAppServerHint).toBe(STALE_CODEX_APP_SERVER_HINT);
  });
});

describe("Windows Win32_Process owner enumeration (#476)", () => {
  const processSource = readFileSync(
    join(import.meta.dir, "..", "src", "codex", "app-server-processes.ts"),
    "utf8",
  );

  test("PowerShell uses Invoke-CimMethod GetOwner and fails closed on ReturnValue", () => {
    expect(processSource).toContain(
      "Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction Stop",
    );
    expect(processSource).toContain("$o.ReturnValue -ne 0");
    expect(processSource).toContain(".join(\"\\n\")");
    expect(processSource).not.toMatch(/\$o=\$_\.GetOwner\(\)/);
    // Shared candidate regex (optional closing quote after basename) drives -match.
    expect(processSource).toContain("WINDOWS_CODEX_BASENAME_CANDIDATE_RE.source");
    expect(processSource).toContain("powerShellSingleQuotedIgnoreCaseMatch");
    expect(WINDOWS_CODEX_BASENAME_CANDIDATE_RE.source).toContain("['\"]?");
  });

  test.skipIf(process.platform !== "win32")(
    "listWindowsSnapshots returns a current-user Codex-shaped process via real PowerShell enumeration",
    () => {
      // Keep a live process whose CommandLine contains a Codex basename token.
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden",
          "-Command",
          "Start-Sleep -Seconds 45 # codex app-server integration-probe",
        ],
        { stdio: "ignore", windowsHide: true },
      );
      try {
        expect(child.pid).toBeGreaterThan(1);
        // Brief settle so Win32_Process can observe the child. A loaded Windows
        // runner can also exhaust one CIM enumeration deadline, so tolerate one
        // transient empty result OR one thrown deadline (ETIMEDOUT propagates by
        // design) while keeping the production timeout unchanged.
        Bun.sleepSync(250);
        const enumerate = (): ReturnType<typeof listWindowsSnapshots> | undefined => {
          try {
            return listWindowsSnapshots();
          } catch {
            return undefined; // transient CIM deadline on a contended runner
          }
        };
        let snapshots = enumerate() ?? [];
        let match = snapshots.find(snapshot => snapshot.pid === child.pid);
        if (!match) {
          Bun.sleepSync(250);
          snapshots = enumerate() ?? [];
          match = snapshots.find(snapshot => snapshot.pid === child.pid);
        }
        if (!match) {
          Bun.sleepSync(1_000);
          snapshots = enumerate() ?? [];
          match = snapshots.find(snapshot => snapshot.pid === child.pid);
        }
        expect(match).toBeDefined();
        expect(match!.owner).toMatch(/\\/);
        expect(match!.commandLine.toLowerCase()).toContain("codex app-server");
        expect(snapshots.every(snapshot => (snapshot.owner?.trim().length ?? 0) > 0)).toBe(true);
      } finally {
        try {
          child.kill();
        } catch {
          /* already exited */
        }
      }
    },
    { timeout: 35_000 },
  );
});
