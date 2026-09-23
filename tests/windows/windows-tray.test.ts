import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { helperPath, repoPath, repoRoot } from "../helpers/repo-root";
import { join } from "node:path";
import {
  buildWindowsTrayLauncherScript,
  buildWindowsTrayPowerShellCommand,
  buildWindowsTrayRunCommand,
  launchInstalledWindowsTray,
  launchWindowsTrayHost,
  parseWindowsTrayRunValue,
  readWindowsTrayRunValueWithAsyncRunner,
  readWindowsTrayRunValueWithRunner,
  replaceWindowsTrayOwnedFile,
  windowsPowerShellPath,
  windowsTrayProcessArgs,
  windowsTrayRunValue,
  windowsTrayStatePathsOwned,
  windowsTrayRegistrationIsStale,
  windowsRegistryParentShowsRunKey,
  type WindowsTrayEntry,
} from "../../src/tray/windows";
import { decodeWindowsTextBytes } from "../../src/lib/windows-text";
import {
  hardenSecretPath,
  hardenedSecretPathCountForTests,
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../../src/lib/windows-secret-acl";
import { handleManagementAPI } from "../../src/server/management-api";
import { MEMORY_DRAIN_RESTART_MS, REPLACEMENT_READY_TIMEOUT_MS } from "../../src/server/management/system-restart";
import type { OcxConfig } from "../../src/types";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const entry: WindowsTrayEntry = {
  bun: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\bun.exe",
  bunRuntimeSource: "bundled",
  cli: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\src\\cli\\index.ts",
  script: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\src\\tray\\windows-tray.ps1",
  codexHome: "C:\\사용자 공간\\.codex",
  opencodexHome: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\.opencodex",
};

describe("Windows tray packaging and command safety", () => {
  test("owned-file temp cleanup forgets successful ACL memos and retains failed removals", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-tray-acl-"));
    const target = join(root, "tray-state.json");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    const write = (path: string, contents: string | Buffer): void => {
      writeFileSync(path, contents, { mode: 0o600 });
    };
    const harden = (path: string): void => {
      hardenSecretPath(path, { required: true });
    };
    try {
      replaceWindowsTrayOwnedFile(target, "success", {
        write,
        harden,
        rename: renameSync,
        unlink: unlinkSync,
      });
      expect(hardenedSecretPathCountForTests()).toBe(0);

      expect(() => replaceWindowsTrayOwnedFile(target, "failure", {
        write,
        harden,
        rename: () => { throw new Error("injected rename failure"); },
        unlink: () => { throw Object.assign(new Error("injected unlink failure"), { code: "EPERM" }); },
      })).toThrow("injected rename failure");
      expect(hardenedSecretPathCountForTests()).toBe(1);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      removeTreeWithRetry(root);
    }
  });

  test("uses fixed argv and leaves window suppression to the process launcher", () => {
    const args = windowsTrayProcessArgs(entry);
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    expect(args).toContain("-STA");
    expect(args).toContain(entry.script);
    expect(args).toContain(entry.bun);
    expect(args).toContain(entry.cli);
    expect(args).not.toContain("-Command");
    expect(args).not.toContain("-WindowStyle");
    expect(args).not.toContain("Hidden");
    expect(windowsTrayProcessArgs(entry, "Run", 4242)).toContain("4242");
  });

  test("passes the Bun provenance through to the tray host (#848)", () => {
    // The tray relaunches the proxy itself, so a tray-started service would otherwise
    // reach doctor with no provenance and get the legacy/unknown treatment.
    const args = windowsTrayProcessArgs(entry);
    expect(args).toContain("-BunRuntimeSource");
    expect(args[args.indexOf("-BunRuntimeSource") + 1]).toBe("bundled");

    const overrideCommand = buildWindowsTrayPowerShellCommand(
      { ...entry, bunRuntimeSource: "override" },
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(overrideCommand).toContain("-BunRuntimeSource override");
  });

  test("quotes metacharacter and Unicode paths without shell interpolation", () => {
    const powershellCommand = buildWindowsTrayPowerShellCommand(entry, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellCommand).toContain(`-File "${entry.script}"`);
    expect(powershellCommand).toContain(`-OpenCodexHome "${entry.opencodexHome}"`);
    expect(powershellCommand).not.toContain("cmd /c");
    expect(powershellCommand).not.toContain("-Command");
    expect(powershellCommand).not.toContain("-WindowStyle");
    const runCommand = buildWindowsTrayRunCommand({
      ...entry,
      launcherPath: `${entry.opencodexHome}\\opencodex-tray.vbs`,
    });
    expect(runCommand.toLowerCase()).toContain("wscript.exe");
    expect(runCommand.length).toBeLessThanOrEqual(260);
  });

  test("launches the installed tray through hidden wscript with bounded stdio", () => {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: { stdio: "ignore"; windowsHide: true; timeout: number };
    }> = [];
    const launcherPath = "C:\\Users\\Test\\.opencodex\\opencodex-tray.vbs";

    launchInstalledWindowsTray(launcherPath, {
      systemRoot: "C:\\Windows",
      run: (file, args, options) => { calls.push({ file, args, options }); },
    });

    expect(calls).toEqual([{
      file: "C:\\Windows\\System32\\wscript.exe",
      args: ["//B", "//NoLogo", launcherPath],
      options: {
        stdio: "ignore",
        windowsHide: true,
        timeout: 15_000,
      },
    }]);
  });

  test("keeps UNC backslashes literal in the VBS Run command", () => {
    const uncRoot = "\\\\server\\share";
    const uncEntry: WindowsTrayEntry = {
      bun: `${uncRoot}\\tools\\bun.exe`,
      cli: `${uncRoot}\\repo\\src\\cli\\index.ts`,
      script: `${uncRoot}\\repo\\src\\tray\\windows-tray.ps1`,
      codexHome: "C:\\Users\\Test\\.codex",
      opencodexHome: `${uncRoot}\\opencodex`,
    };
    const launcher = buildWindowsTrayLauncherScript(uncEntry);
    expect(launcher).toContain(`${uncRoot}\\tools\\bun.exe`);
    expect(launcher).not.toMatch(/\\\\\\\\server/);
  });


  test("preserves non-ASCII paths in the tray launcher script and UTF-16LE install encoding", () => {
    const launcher = buildWindowsTrayLauncherScript(entry);
    expect(launcher).toContain("사용자 공간");
    const encoded = Buffer.from("\uFEFF" + launcher, "utf16le");
    expect(encoded.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))).toBe(true);
    expect(encoded.toString("utf16le")).toContain("사용자 공간");
  });

  test("rejects quote and control-character path injection", () => {
    expect(() => windowsTrayProcessArgs({ ...entry, opencodexHome: 'C:\\bad" -Command whoami' })).toThrow();
    expect(() => windowsTrayProcessArgs({ ...entry, cli: "C:\\bad\r\nwhoami" })).toThrow();
  });

  test("never trusts state-selected executable or deletion paths", () => {
    const home = "C:\\Users\\Test\\.opencodex";
    expect(windowsTrayStatePathsOwned({
      opencodexHome: home,
      script: join(home, "opencodex-tray.ps1"),
      launcherPath: join(home, "opencodex-tray.vbs"),
    }, home)).toBe(true);
    expect(windowsTrayStatePathsOwned({
      opencodexHome: home,
      script: "C:\\attacker\\payload.ps1",
    }, home)).toBe(false);
    expect(windowsTrayStatePathsOwned({
      opencodexHome: home,
      script: join(home, "opencodex-tray.ps1"),
      launcherPath: "C:\\victim\\document.txt",
    }, home)).toBe(false);
  });

  test("treats a live unregistered tray as stale so uninstall cannot skip it", () => {
    expect(windowsTrayRegistrationIsStale({
      registered: false,
      registrationOwned: false,
      running: true,
      heartbeatFresh: true,
    })).toBe(true);
    expect(windowsTrayRegistrationIsStale({
      registered: false,
      registrationOwned: false,
      running: false,
      heartbeatFresh: false,
    })).toBe(false);
  });

  test("normalizes equivalent homes to one owned Run value", () => {
    expect(windowsTrayRunValue("C:\\Users\\Test\\.opencodex"))
      .toBe(windowsTrayRunValue("C:\\Users\\Test\\.opencodex\\."));
  });

  test("treats an unexpected registry type or unreadable value as foreign", () => {
    const value = "OpenCodexTray-test";
    const command = '"C:\\Windows\\powershell.exe" -File "C:\\tray.ps1"';
    expect(parseWindowsTrayRunValue(`    ${value}    REG_SZ    ${command}`, value)).toBe(command);
    expect(parseWindowsTrayRunValue(`    ${value}    REG_EXPAND_SZ    ${command}`, value)).not.toBe(command);
    expect(parseWindowsTrayRunValue("unexpected output", value)).not.toBeNull();
  });

  test("distinguishes a missing Run key from an unreadable existing key", () => {
    const parent = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    ].join("\r\n");
    expect(windowsRegistryParentShowsRunKey(parent)).toBe(true);
    expect(windowsRegistryParentShowsRunKey(parent.replace(/\\Run\r?\n?$/, ""))).toBe(false);
  });

  test("fails closed when registry absence cannot be proven", async () => {
    const value = "OpenCodexTray-test";
    const statusError = (status: number) => Object.assign(new Error(`reg exit ${status}`), { status });
    const codeError = (code: number) => Object.assign(new Error(`reg exit ${code}`), { code });

    expect(readWindowsTrayRunValueWithRunner(value, args => {
      if (args.includes("/v")) throw statusError(1);
      if (args[1]?.endsWith("\\Run")) return "readable";
      throw new Error("unexpected query");
    })).toBeNull();
    expect(() => readWindowsTrayRunValueWithRunner(value, () => { throw statusError(5); }))
      .toThrow("refusing to change persistence");
    expect(() => readWindowsTrayRunValueWithRunner(value, args => {
      if (args.includes("/v")) throw statusError(1);
      throw statusError(5);
    })).toThrow("refusing to change persistence");

    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      if (args.includes("/v")) throw codeError(1);
      if (args[1]?.endsWith("\\Run")) return "readable";
      throw new Error("unexpected query");
    })).resolves.toBeNull();
    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async () => { throw codeError(5); }))
      .rejects.toThrow("Unable to verify Windows tray registry status");
    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      if (args.includes("/v")) throw codeError(1);
      throw codeError(5);
    })).rejects.toThrow("Unable to verify Windows tray registry status");
  });

  test("proves a missing Run key only through the readable parent path", async () => {
    const value = "OpenCodexTray-test";
    const syncCalls: string[][] = [];
    const syncResult = readWindowsTrayRunValueWithRunner(value, args => {
      syncCalls.push(args);
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) {
        throw Object.assign(new Error("missing"), { status: 1 });
      }
      return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer";
    });
    expect(syncResult).toBeNull();
    expect(syncCalls).toEqual([
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", value, "/reg:64"],
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/reg:64"],
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion", "/reg:64"],
    ]);

    const asyncCalls: string[][] = [];
    const asyncResult = await readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      asyncCalls.push(args);
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) {
        throw Object.assign(new Error("missing"), { code: 1 });
      }
      return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer";
    });
    expect(asyncResult).toBeNull();
    expect(asyncCalls).toEqual(syncCalls);

    expect(() => readWindowsTrayRunValueWithRunner(value, args => {
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) {
        throw Object.assign(new Error("unreadable"), { status: 1 });
      }
      return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    })).toThrow("refusing to change persistence");

    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) {
        throw Object.assign(new Error("unreadable"), { code: 1 });
      }
      return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    })).rejects.toThrow("Unable to verify Windows tray registry status");

    const parentFailureSync = (args: string[]): string => {
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) throw Object.assign(new Error("missing"), { status: 1 });
      throw Object.assign(new Error("parent unreadable"), { status: 5 });
    };
    expect(() => readWindowsTrayRunValueWithRunner(value, parentFailureSync))
      .toThrow("refusing to change persistence");
    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) throw Object.assign(new Error("missing"), { code: 1 });
      throw Object.assign(new Error("parent unreadable"), { code: 5 });
    })).rejects.toThrow("Unable to verify Windows tray registry status");
  });

  test("PowerShell controller uses mutex/event shutdown and bans command evaluation", () => {
    const typescript = readFileSync(repoPath("src", "tray", "windows.ts"), "utf8");
    const source = readFileSync(repoPath("src", "tray", "windows-tray.ps1"), "utf8");
    const cli = readFileSync(repoPath("src", "cli", "index.ts"), "utf8");
    expect(typescript).not.toContain("\u0000");
    expect(typescript).toContain("OCX_TRAY_ENTRY_B64");
    expect(typescript).not.toContain("$startInfo.UseShellExecute = $true");
    expect(typescript).toContain("$startInfo.UseShellExecute = $false");
    expect(typescript).toContain("$startInfo.CreateNoWindow = $true");
    expect(typescript).toContain("$startInfo.EnvironmentVariables['OCX_TRAY_ENTRY_B64'] = $env:OCX_TRAY_ENTRY_B64");
    expect(source).toContain("System.Threading.Mutex");
    expect(source).toContain("System.Threading.EventWaitHandle");
    expect(source).toContain("[System.Windows.Forms.Application]::EnableVisualStyles()");
    expect(source.indexOf("[void]$stopEvent.Reset()")).toBeGreaterThan(source.indexOf("if (-not $createdNew)"));
    expect(source).toMatch(/\$timer\.add_Tick\(\{\s*try \{/);
    expect(source).toContain('Write-ActionLog "timer tick failed: $($_.Exception.GetType().Name)"');
    expect(source).toContain("GetFullPath");
    expect(source).toContain("GetPathRoot");
    expect(source).toContain("$heartbeat.hostPid = $HostPid");
    expect(source).toContain('Start-OcxCommand @("__tray-restart")');
    expect(source).toContain("-TrackExit");
    expect(source).toContain("$script:pendingProcess.HasExited");
    expect(source).toContain('if ($null -ne $script:pendingAction)');
    expect(source).toContain('$startItem.Enabled = $false');
    expect(source).toContain('ignored because $($script:pendingAction) is still pending');
    const startBudget = source.match(/Set-PendingAction "Start Proxy" (\d+)/);
    expect(startBudget).not.toBeNull();
    expect(Number(startBudget![1])).toBeGreaterThanOrEqual(75);
    const restartBudget = source.match(/Set-PendingAction "Restart Proxy" (\d+)/);
    expect(restartBudget).not.toBeNull();
    expect(Number(restartBudget![1]) * 1000).toBeGreaterThanOrEqual(
      MEMORY_DRAIN_RESTART_MS + REPLACEMENT_READY_TIMEOUT_MS + 30_000,
    );
    expect(cli).toContain("requestBoundSystemRestart(previous, deadlineAt)");
    expect(cli).toContain("Date.now() + PROXY_RESTART_OBSERVE_MS");
    expect(cli).toContain("discoverStableProxyForRestart");
    expect(cli).toContain("isProxyReplacement(previous, live)");
    expect(cli).toContain("process.exitCode = result.ok ? 0 : 1");
    expect(cli).toContain("waitForProxy(40_000)");
    expect(cli).toContain("await handleProxyRestart(() => handleTrayProxyStart(false))");
    expect(cli).toContain("function detachedStartEnvironment()");
    expect(cli).toContain("delete env.OCX_SERVICE");
    expect(cli).not.toContain("OCX_KEEP_ROUTING");
    expect(source).toContain('Load-TrayIcon "opencodex-tray-online.ico"');
    expect(source).toContain('Load-TrayIcon "opencodex-tray-warning.ico"');
    expect(source).toContain('Load-TrayIcon "opencodex-tray-offline.ico"');
    expect(source).toContain("$notify.Icon = $offlineIcon");
    expect(source).not.toContain("$menu.add_Opening({ Update-TrayState })");
    expect(source).not.toContain("Invoke-Expression");
    expect(source).not.toContain("taskkill");
    expect(source).not.toContain("Stop-Process");
  });

  test("tray reads restart safety through the CLI instead of the admin-gated /api endpoint", () => {
    const source = readFileSync(repoPath("src", "tray", "windows-tray.ps1"), "utf8");
    // The management API is admin-token gated, and the tray runs without that token,
    // so a plain GET /api/startup-health always 401s and leaves the tray stuck on the
    // yellow warning icon. The tray must collect the same local diagnostic through the
    // CLI's __startup-health internal command instead.
    expect(source).toContain('@($CliPath, "__startup-health")');
    expect(source).not.toContain('Read-JsonUrl "$origin/api/startup-health"');
    // The local diagnostic does not re-run the Windows service-manager probe on every
    // 3s tick, so its refresh cadence must stay throttled...
    expect(source).toContain("$script:startupRefreshMs");
    expect(source).toContain("$script:startupHealthCheckedAt -gt $script:startupRefreshMs");
    // ...and it must not block the Windows Forms UI thread. The probe is a detached
    // child whose stdout pipe is drained asynchronously; the 3s tick only touches the
    // completed read task, so a slow or hung diagnostic can never freeze the tray menu.
    expect(source).toContain("ReadToEndAsync()");
    expect(source).toContain("$script:startupProbeProcess");
    // A timed-out diagnostic must be terminated, not left to become an orphaned
    // Bun process on the next refresh.
    expect(source).toContain("startupProbeProcess.Kill()");
    // A launch failure or invalid result must not start a new probe on the very next
    // 3s tick: the refresh decides by the throttled attempt timestamp, never by a null
    // cached health, and records the attempt before spawning the child.
    expect(source).toContain("$script:startupHealthCheckedAt -eq 0 -or");
    expect(source).toContain("# Record the attempt so launch failures and invalid results remain throttled.");
    // A probe still in flight when the tray shuts down must not outlive it: the
    // finally block kills the active probe, waits briefly, then completes it.
    expect(source).toContain("terminating active startup-health probe on tray shutdown");
    expect(source).toContain("startupProbeProcess.WaitForExit(3000)");
    // Placement proof that runs on every platform: the behavioral test below is
    // win32-only and the Windows CI leg runs on dispatch rather than on PRs,
    // so merge-time coverage needs a lightweight check here too. The timeout
    // maintenance must sit BEFORE the online-only UI branch: moving it inside
    // flips the order and deleting it removes the anchor, and a plain
    // substring could not tell inside from outside. The branch anchor is a
    // line-anchored regex (not a substring) because the `$script:proxyPid`
    // assignment a few lines above contains the same `if ($script:online) {`
    // text inline.
    const timeoutAnchorIdx = source.search(
      /^\s*} elseif \(\$probeTimedOut\) \{$/m,
    );
    const onlineBranchIdx = source.search(/^\s*if \(\$script:online\) \{$/m);
    expect(timeoutAnchorIdx).toBeGreaterThanOrEqual(0);
    expect(onlineBranchIdx).toBeGreaterThanOrEqual(0);
    expect(timeoutAnchorIdx).toBeLessThan(onlineBranchIdx);
    // Hung-child termination itself is proven behaviorally by "terminates a hung
    // startup-health probe without stacking a replacement" below.
    // The malformed-payload guard requires a real boolean, matching the shared
    // server-side parser instead of accepting any non-null rebootSafe value.
    expect(source).toContain("($parsed.rebootSafe -is [bool])");
    // If the async pipe setup fails after the child started, the child must be
    // terminated, not merely disposed and lost. That catch block logs a
    // distinct string, which breaks if the branch is deleted.
    expect(source).toContain("startup-health probe launch cleanup failed");
  });

  // Behavioral proof for the probe lifecycle: the driver loads the REAL probe
  // functions out of windows-tray.ps1 (via the PowerShell AST, so comment and
  // whitespace edits cannot fake it), stages a REAL hung child through the
  // real Start-StartupHealthProbe, backdates its start past the real 30s
  // timeout (elapsed time is an input to the maintenance branch, not the logic
  // under test), then invokes the real Update-TrayState ticks and reports
  // observable process facts. Offline proves the maintenance branch runs
  // outside the online-only UI gate; Online proves the refresh throttle stacks
  // no replacement. Either scenario fails if the Kill() is deleted (the child
  // survives) or if maintenance moves inside the online branch (the offline
  // child survives).
  test("terminates a hung startup-health probe without stacking a replacement", async () => {
    if (process.platform !== "win32") return;
    const psExe = windowsPowerShellPath();
    const driver = helperPath("windows-tray-probe-lifecycle-driver.ps1");
    const trayScript = repoPath("src", "tray", "windows-tray.ps1");
    for (const scenario of ["Offline", "Online"] as const) {
      const directory = mkdtempSync(join(tmpdir(), "ocx-tray-probe-"));
      const codexHome = join(directory, "codex");
      const openCodexHome = join(directory, "ohome");
      mkdirSync(codexHome, { recursive: true });
      mkdirSync(openCodexHome, { recursive: true });
      // The fake CLI name stays simple ASCII on purpose: the child engine here
      // is powershell.exe (not bun), and its -Command parsing mangles paths
      // with spaces or `&` even when quoted.
      const hangChild = join(directory, "hangchild.ps1");
      writeFileSync(hangChild, [
        "$pidFile = $env:OCX_PROBE_TEST_PID_FILE",
        "if ($pidFile) { Add-Content -LiteralPath $pidFile -Value $PID }",
        "Start-Sleep -Seconds 120",
      ].join("\r\n"));
      const pidFile = join(directory, "pids.txt");
      const resultPath = join(directory, "verdict.json");
      let server: ReturnType<typeof Bun.serve> | undefined;
      try {
        if (scenario === "Online") {
          server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: request => {
              if (new URL(request.url).pathname === "/healthz") {
                return Response.json({ status: "ok", service: "opencodex", port: server!.port, pid: 424242 });
              }
              return new Response("not found", { status: 404 });
            },
          });
          writeFileSync(
            join(openCodexHome, "runtime-port.json"),
            JSON.stringify({ port: server.port, hostname: "127.0.0.1" }),
          );
        } else {
          // Port 1 refuses immediately, so the offline premise holds even on a
          // dev machine already running the proxy on 10100.
          writeFileSync(
            join(openCodexHome, "runtime-port.json"),
            JSON.stringify({ port: 1, hostname: "127.0.0.1" }),
          );
        }
        const child = Bun.spawn([psExe,
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", driver,
          "-TrayScriptPath", trayScript,
          "-ChildEnginePath", psExe,
          "-HangChildPath", hangChild,
          "-CodexHome", codexHome,
          "-OpenCodexHome", openCodexHome,
          "-ResultPath", resultPath,
          "-Scenario", scenario,
        ], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, OCX_PROBE_TEST_PID_FILE: pidFile },
        });
        const stdoutPromise = new Response(child.stdout).text();
        const stderrPromise = new Response(child.stderr).text();
        const finished = await Promise.race([
          Promise.all([stdoutPromise, stderrPromise, child.exited])
            .then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode })),
          Bun.sleep(30_000).then(() => null),
        ]);
        if (!finished) {
          try { child.kill(); } catch { /* already exited */ }
          await Bun.sleep(500);
          expect(false, `${scenario}: probe driver hung for 30s (a blocked tick would wait out the 120s sleeper)`).toBe(true);
          return;
        }
        const { stdout, stderr, exitCode } = finished;
        expect(exitCode, `${scenario}: driver exit=${exitCode} stdout=${stdout.slice(0, 500)} stderr=${stderr.slice(0, 500)}`).toBe(0);
        expect(existsSync(resultPath), `${scenario}: driver exited 0 without writing ${resultPath}`).toBe(true);
        const verdict = JSON.parse(readFileSync(resultPath, "utf8")) as {
          scenario: string;
          onlineObserved: boolean;
          maintenanceMs: number;
          totalMs: number;
          childPid: number;
          childTerminated: boolean;
          probeCleared: boolean;
          launches: number;
        };
        expect(verdict.scenario).toBe(scenario);
        expect(verdict.onlineObserved, `${scenario}: online=${verdict.onlineObserved}; the premise of this scenario did not hold`).toBe(scenario === "Online");
        expect(verdict.childTerminated, `${scenario}: hung probe child ${verdict.childPid} survived the timeout`).toBe(true);
        expect(verdict.probeCleared, `${scenario}: probe reference was not released after the kill`).toBe(true);
        expect(verdict.launches, `${scenario}: expected exactly 1 probe launch, saw ${verdict.launches}`).toBe(1);
        expect(verdict.totalMs, `${scenario}: two ticks took ${verdict.totalMs}ms; a UI-thread block would hang until the 120s sleeper exits`).toBeLessThan(20_000);
      } finally {
        try {
          if (existsSync(pidFile)) {
            for (const line of readFileSync(pidFile, "utf8").split(/\r?\n/)) {
              const pid = Number(line.trim());
              if (Number.isSafeInteger(pid) && pid > 0) {
                try { process.kill(pid); } catch { /* already reaped */ }
              }
            }
          }
        } catch { /* cleanup best-effort */ }
        if (server) await server.stop(true);
        removeTreeWithRetry(directory);
      }
    }
  }, { timeout: SPAWN_BUDGET_MS });

  // This test really does launch PowerShell, which really does launch a Bun child, and
  // then rebinds the port to prove the child did not inherit the listen socket. Those
  // processes ARE the assertion — there is no version of this proof that fakes them.
  //
  // So the budget has to cover work the test genuinely performs. Production allows
  // PowerShell 15s (`execFileSync` timeout in src/tray/windows.ts), while Bun's default
  // test budget is 5s; a contended windows-latest runner lands between the two and the
  // test fails at ~5.1s having done nothing wrong.
  //
  // Raising a budget is NOT the general answer to a flaky test. Earlier in this same
  // round the sidebar route tests were fixed by DELETING their real `gh` spawn, because
  // spawning a binary was incidental to what those tests claimed. The distinction is
  // whether the wait is intrinsic to the assertion. Here it is; there it was not.
  const PID_FILE_WAIT_MS = INTERNAL_DEADLINE_MS;
  const TRAY_LAUNCH_TIMEOUT_MS = SPAWN_BUDGET_MS;

  test("launches the detached tray host without retaining the proxy listen socket", async () => {
    if (process.platform !== "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "ocx-tray-inheritance-"));
    const pidPath = join(directory, "child.pid");
    const childPath = join(directory, "child & %TEMP% 테스트.ts");
    copyFileSync(helperPath("windows-tray-inheritance-child.ts"), childPath);
    const previousPidPath = process.env.OCX_TRAY_TEST_PID_FILE;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const port = server.port;
    let childPid = 0;
    let replacement: ReturnType<typeof Bun.serve> | undefined;

    try {
      process.env.OCX_TRAY_TEST_PID_FILE = pidPath;
      launchWindowsTrayHost({
        ...entry,
        bun: process.execPath,
        cli: childPath,
      });
      const pidDeadline = Date.now() + PID_FILE_WAIT_MS;
      while (!existsSync(pidPath) && Date.now() < pidDeadline) {
        await Bun.sleep(25);
      }
      // Name what actually went wrong. A bare `false` here means "the pid file is
      // missing" and nothing about whether PowerShell never started, the child died,
      // or the runner was simply slow — which is most of the work in diagnosing it.
      expect(
        existsSync(pidPath),
        `tray child never wrote ${pidPath} within ${PID_FILE_WAIT_MS}ms`,
      ).toBe(true);
      childPid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      expect(() => process.kill(childPid, 0)).not.toThrow();

      await server.stop(true);
      replacement = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: () => new Response("replacement"),
      });
      expect(replacement.port).toBe(port);
      expect(() => process.kill(childPid, 0)).not.toThrow();
    } finally {
      if (previousPidPath === undefined) delete process.env.OCX_TRAY_TEST_PID_FILE;
      else process.env.OCX_TRAY_TEST_PID_FILE = previousPidPath;
      if (replacement) await replacement.stop(true);
      await server.stop(true);
      if (childPid > 0) {
        try { process.kill(childPid); } catch { /* exact test child already exited */ }
      }
      removeTreeWithRetry(directory);
    }
  }, { timeout: TRAY_LAUNCH_TIMEOUT_MS });

  test("ships branded multi-size Windows tray icons", () => {
    const assets = repoPath("src", "tray", "assets");
    for (const name of ["online", "warning", "offline"]) {
      const path = join(assets, `opencodex-tray-${name}.ico`);
      expect(existsSync(path)).toBe(true);
      const bytes = readFileSync(path);
      expect(bytes.readUInt16LE(0)).toBe(0);
      expect(bytes.readUInt16LE(2)).toBe(1);
      expect(bytes.readUInt16LE(4)).toBeGreaterThanOrEqual(7);
    }
  });

  test("serves tray status without blocking the proxy event loop", async () => {
    if (process.platform !== "win32") return;
    const url = new URL("http://localhost/api/windows-tray");
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const responsePromise = handleManagementAPI(
      new Request(url),
      url,
      { port: 10100, providers: {}, defaultProvider: "openai" } as OcxConfig,
    );
    await Bun.sleep(50);
    expect(timerFired).toBe(true);
    clearTimeout(timer);
    const response = await responsePromise;
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.supported).toBe(true);
    expect(typeof body.installed).toBe("boolean");
    expect(typeof body.running).toBe("boolean");
  });

  test("copies the tray script into the hardened home and gates all update lanes", () => {
    const root = repoRoot();
    const tray = readFileSync(join(root, "src", "tray", "windows.ts"), "utf8");
    expect(tray).toContain('join(getConfigDir(), "opencodex-tray.ps1")');
    expect(tray).toContain('join(import.meta.dir, "assets", name)');
    expect(tray).toContain("installedTrayIconPaths()");
    expect(tray).toContain("const hardened = hardenSecretPath(target, { required: true, timeoutMemoKey: path })");
    expect(tray).toContain("if (!hardened.ok)");
    expect(tray).toContain("if (!hardenedDir.ok)");
    expect(tray).toContain("refusing to replace its persistent script");
    expect(tray).toContain("restorePreviousInstall");
    expect(tray).toContain("previousStateBytes");
    expect(tray).toContain("previousScriptBytes");
    expect(tray).toContain('windowsTrayProcessArgs(currentEntry(), "Stop")');
    expect(tray).not.toContain("spawnTray(state)");
    expect(tray).toContain("return readWindowsTrayRunValueWithRunner(runValue, runRegistry)");
    expect(tray).toContain("return readWindowsTrayRunValueWithAsyncRunner(runValue, runRegistryAsync)");

    // #1933: reg.exe writes the console ANSI code page, not UTF-8. Decoding its
    // bytes as utf8 corrupts any non-ASCII profile path, the owned-value round
    // trip then fails, and the tray reports itself foreign/stale even though the
    // Run value on disk is correct. decodeWindowsTextBytes already fixes this
    // class for schtasks (#1573); both registry readers must use it too.
    expect(tray).not.toContain('encoding: "utf8"');
    expect(tray).toContain("decodeWindowsTextBytes");

    const updateSources = [
      join(root, "src", "update", "index.ts"),
      join(root, "src", "update", "job.ts"),
      join(root, "bin", "ocx.mjs"),
    ].map(path => readFileSync(path, "utf8"));
    for (const source of updateSources) {
      expect(source).toContain("tray");
      expect(source).toContain("stop");
      expect(source).toContain("aborting before package replacement");
    }
  });

  test("a non-ASCII profile path round-trips through the registry reader (#1933)", () => {
    // reg.exe emits the console ANSI code page, not UTF-8. On a Windows-1252 host a
    // profile path like C:\\Users\\Moetz decodes to U+FFFD under utf8, the comparison
    // against the value we wrote fails, registrationOwned goes false, and the CLI
    // prints "startup registration is foreign, stale, or points to missing package
    // files" over a registry entry that is in fact correct and owned.
    const runValue = "OpenCodexTray-c856edd2e06f";
    const command = [
      String.raw`"C:\WINDOWS\System32\wscript.exe" //B //NoLogo `,
      String.raw`"C:\Users\M\u00f6tz\.opencodex\opencodex-tray.vbs"`,
    ].join("").replace("\\u00f6", "\u00f6");
    const rendered = [
      "",
      String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`,
      `    ${runValue}    REG_SZ    ${command}`,
      "",
    ].join("\r\n");

    // The bytes reg.exe actually hands back on that host: one byte per code point.
    const cp1252 = Uint8Array.from([...rendered].map(ch => ch.codePointAt(0) ?? 0x3f));

    // Decoded the way the service probe already decodes schtasks output, the owned
    // value parses back out intact.
    const decoded = decodeWindowsTextBytes(cp1252, { locale: "en-US" });
    expect(parseWindowsTrayRunValue(decoded, runValue)).toBe(command);

    // Decoded as utf8 — the pre-fix behavior — the path is corrupted, so the
    // round-trip comparison that drives registrationOwned cannot succeed.
    const asUtf8 = Buffer.from(cp1252).toString("utf8");
    expect(parseWindowsTrayRunValue(asUtf8, runValue)).not.toBe(command);
  });
});
import { ManagementRequest as Request } from "../helpers/management-auth";
