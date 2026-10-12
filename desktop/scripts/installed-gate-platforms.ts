/**
 * Platform adapters for the installed-artifact gate (D9, part two).
 *
 * Adapters turn platform actions into command specs the gate engine runs and records;
 * they never hardcode machine detail. Artifact paths, homes and ports arrive as
 * arguments. GUI automation the OS cannot reach (the in-page consent dialog, tray
 * clicks on some desktops) is supplied by the operator as pre-installed hook files,
 * never as dispatch-provided command text — a persistent self-hosted runner must not
 * become an arbitrary-execution surface.
 *
 * The external commands each adapter needs are declared in dependencies() so a runner
 * can be audited for readiness before an artifact is ever installed on it.
 */

export type GatePlatform = "macos" | "windows" | "linux";
export type GateFormat = "dmg" | "msi" | "deb" | "appimage";

import { join } from "node:path";

export interface CommandSpec {
  file: string;
  args: string[];
}

export interface ProcessEvidence {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface InstallResult {
  appBinary: string;
  packageName?: string;
  /** Path scope that identifies THIS install's processes (install dir or binary path). */
  scope: string;
  evidence: Record<string, unknown>;
}

export interface PlatformAdapter {
  platform: GatePlatform;
  /** Every external command this adapter shells out to; the engine preflights them. */
  dependencies(): string[];
  /** The staged npm ocx launcher inside an npm --prefix install. */
  npmLauncher(prefix: string): string;
  /** Registers and starts the staged npm runtime as a managed service. */
  serviceInstall(launcher: string): CommandSpec;
  serviceUninstall(launcher: string): CommandSpec;
  /**
   * Three-state registration answer: an existing registration is "present", a clean
   * not-found is "absent", and any probe failure that cannot be told apart is
   * "unknown" — the engine refuses to mutate on unknown.
   */
  registrationState(): Promise<"present" | "absent" | "unknown">;
  /**
   * On-disk registration files, relative to the runner account's home. A registration
   * that is unloaded, disabled or not yet loaded leaves these behind, and the manager
   * probes above miss exactly those states.
   */
  registrationFiles(): string[];
  /**
   * Read-only probe for a dormant installation (MSI registry entry, dpkg record) the
   * gate must refuse to overwrite. Null where installs land inside the work dir.
   */
  existingInstallation(format: GateFormat, packageName?: string): CommandSpec | null;
  /** Installs the real artifact; returns the app executable path. */
  installArtifact(artifact: string, workDir: string, format: GateFormat): Promise<InstallResult>;
  /** Drives the installed app's window-close gesture. */
  closeGesture(): CommandSpec;
  /** Drives the installed app's OS-quit gesture (Cmd+Q, Alt+F4). */
  quitGesture(): CommandSpec;
  /** Left-clicks the tray icon (the shell shows the dashboard window), or null. */
  trayClick(): CommandSpec | null;
  /** Opens the tray menu and chooses Quit (the drain-then-exit path), or null. */
  trayQuit(): CommandSpec | null;
  /** Chooses Check for Updates in the tray menu, or null. */
  trayCheck(): CommandSpec | null;
  /** Chooses the enabled Install update item in the tray menu, or null. */
  trayInstall(): CommandSpec | null;
  /** Exits zero only when the app currently has a visible window. */
  windowVisible(): CommandSpec;
  /** Installed package version probe, where the platform has one (deb), or null. */
  installedVersion(format: GateFormat, packageName?: string): CommandSpec | null;
  /** Dismisses exactly the authorization prompts the gate sighted, by pid, or null. */
  cancelElevation(pids: number[]): CommandSpec | null;
  /**
   * Lists pids of any elevation prompt surface — pkexec, and the zenity/kdialog
   * password dialogs the updater plugin falls back to after a pkexec cancel.
   * Null where the platform has no package-manager elevation (macOS, Windows).
   */
  elevationProbe(): CommandSpec | null;
  /** Lists pids whose executable lives under the given install scope. */
  appProcessProbe(scope: string): CommandSpec;
  /** Lists pids of ANY installed copy of the app — the preflight's broad probe. */
  appNameProbe(): CommandSpec;
  /** Lists direct child pids of the given process. */
  childPids(pid: number): CommandSpec;
  /** Removes what installArtifact placed on the machine. */
  uninstall(artifact: string, workDir: string, format: GateFormat, packageName?: string): CommandSpec[];
}

export interface AdapterRuntime {
  run(spec: CommandSpec): Promise<ProcessEvidence>;
  mkdir(path: string): void;
  fileExists(path: string): boolean;
  homeDir(): string;
}

function requireOk(step: string, result: ProcessEvidence): void {
  if (!result.ok) {
    throw new Error(`${step} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/** macOS: dmg install, AppleScript gestures scoped to the OpenCodex process, launchd. */
export function macosAdapter(runtime: AdapterRuntime): PlatformAdapter {
  const run = runtime.run.bind(runtime);
  return {
    platform: "macos",
    dependencies: () => ["hdiutil", "osascript", "pgrep", "launchctl", "cp", "rm", "/usr/libexec/PlistBuddy"],
    npmLauncher: prefix => `${prefix}/node_modules/.bin/ocx`,
    serviceInstall: launcher => ({ file: launcher, args: ["service", "install"] }),
    serviceUninstall: launcher => ({ file: launcher, args: ["service", "uninstall"] }),
    registrationState: async () => {
      if (runtime.fileExists(join(runtime.homeDir(), "Library/LaunchAgents/com.opencodex.proxy.plist"))) return "present";
      const probe = await run({ file: "launchctl", args: ["list", "com.opencodex.proxy"] });
      if (probe.ok) return "present";
      // "Could not find service" is a clean absence; anything else is unknowable here.
      return /could not find/i.test(probe.stderr) ? "absent" : "unknown";
    },
    registrationFiles: () => ["Library/LaunchAgents/com.opencodex.proxy.plist"],
    // A dmg install lands inside the gate's work dir; there is no system-level record.
    existingInstallation: () => null,
    async installArtifact(artifact, workDir) {
      const mount = `${workDir}/dmg-mount`;
      const apps = `${workDir}/Applications`;
      runtime.mkdir(mount);
      runtime.mkdir(apps);
      requireOk("dmg attach", await run({ file: "hdiutil", args: ["attach", artifact, "-mountpoint", mount, "-nobrowse", "-readonly"] }));
      try {
        requireOk("app copy", await run({ file: "cp", args: ["-R", `${mount}/OpenCodex.app`, `${apps}/`] }));
      } finally {
        await run({ file: "hdiutil", args: ["detach", mount] });
      }
      // The executable name is the bundle's own declaration, not a guess: a rename in
      // packaging lands here without a driver change (#5351 removed this hardcode once).
      const plist = await run({
        file: "/usr/libexec/PlistBuddy",
        args: ["-c", "Print :CFBundleExecutable", `${apps}/OpenCodex.app/Contents/Info.plist`],
      });
      requireOk("read CFBundleExecutable", plist);
      const executable = plist.stdout.trim();
      return {
        appBinary: `${apps}/OpenCodex.app/Contents/MacOS/${executable}`,
        scope: apps,
        evidence: { mounted: mount, copiedTo: apps, executable },
      };
    },
    closeGesture: () => appleScript(
      'tell application "OpenCodex" to activate',
      'tell application "System Events" to keystroke "w" using command down',
    ),
    quitGesture: () => appleScript(
      'tell application "OpenCodex" to activate',
      'tell application "System Events" to keystroke "q" using command down',
    ),
    // Menu bar items belong to their owning process; clicking by global index can hit an
    // unrelated tray, so every tray action is scoped to the OpenCodex process.
    trayClick: () => appleScript(
      'tell application "System Events" to tell process "OpenCodex" to click menu bar item 1 of menu bar 2',
    ),
    trayQuit: () => appleScript(
      'tell application "System Events" to tell process "OpenCodex" to click menu bar item 1 of menu bar 2',
      'tell application "System Events" to tell process "OpenCodex" to click menu item "Quit" of menu 1 of menu bar item 1 of menu bar 2',
    ),
    trayCheck: () => appleScript(
      'tell application "System Events" to tell process "OpenCodex" to click menu bar item 1 of menu bar 2',
      'tell application "System Events" to tell process "OpenCodex" to click menu item "Check for Updates…" of menu 1 of menu bar item 1 of menu bar 2',
    ),
    trayInstall: () => appleScript(
      'tell application "System Events" to tell process "OpenCodex" to click menu bar item 1 of menu bar 2',
      'tell application "System Events" to tell process "OpenCodex" to click (first menu item of menu 1 of menu bar item 1 of menu bar 2 whose name starts with "Install update")',
    ),
    windowVisible: () => appleScript('tell application "System Events" to count (windows of process "OpenCodex")'),
    installedVersion: () => null,
    cancelElevation: () => null,
    elevationProbe: () => null,
    appProcessProbe: scope => ({ file: "pgrep", args: ["-f", scope] }),
    appNameProbe: () => ({ file: "pgrep", args: ["-f", "OpenCodex.app/Contents/MacOS"] }),
    childPids: pid => ({ file: "pgrep", args: ["-P", String(pid)] }),
    uninstall: (_artifact, workDir) => [{ file: "rm", args: ["-rf", `${workDir}/Applications/OpenCodex.app`] }],
  };
}

/** Windows: msi install, PowerShell gestures, Task Scheduler registration. */
export function windowsAdapter(runtime: AdapterRuntime): PlatformAdapter {
  const run = runtime.run.bind(runtime);
  return {
    platform: "windows",
    dependencies: () => ["msiexec", "powershell", "schtasks", "sc"],
    npmLauncher: prefix => `${prefix}\\node_modules\\.bin\\ocx.cmd`,
    serviceInstall: launcher => ({ file: launcher, args: ["service", "install"] }),
    serviceUninstall: launcher => ({ file: launcher, args: ["service", "uninstall"] }),
    // Task Scheduler is the default backend; the native backend registers a WinSW
    // service instead, and both count as an existing registration.
    registrationState: async () => {
      const task = await run({ file: "schtasks", args: ["/Query", "/TN", "opencodex-proxy"] });
      if (task.ok) return "present";
      const taskAbsent = /cannot find|does not exist/i.test(task.stderr + task.stdout);
      const service = await run({ file: "sc.exe", args: ["query", "opencodex-proxy-native"] });
      if (service.ok) return "present";
      const serviceAbsent = /does not exist/i.test(service.stderr + service.stdout);
      if (taskAbsent && serviceAbsent) return "absent";
      return "unknown";
    },
    registrationFiles: () => [],
    // A dormant MSI install shows up in the uninstall registry before any process runs.
    existingInstallation: format =>
      format === "msi"
        ? {
            file: "powershell",
            args: [
              "-NoProfile",
              "-Command",
              "$key = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -eq 'OpenCodex' }; if ($key) { exit 0 } else { exit 1 }",
            ],
          }
        : null,
    async installArtifact(artifact, workDir) {
      requireOk(
        "msi install",
        await run({ file: "msiexec", args: ["/i", artifact, "/qn", "/norestart", "/l*v", `${workDir}\\msi-install.log`] }),
      );
      const locate = await run({
        file: "powershell",
        args: [
          "-NoProfile",
          "-Command",
          "$key = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -eq 'OpenCodex' } | Select-Object -First 1; " +
            "$dir = $key.InstallLocation; " +
            "@(\"opencodex-desktop.exe\", \"opencodex.exe\") | ForEach-Object { $p = Join-Path $dir $_; if (Test-Path $p) { Write-Output $dir; Write-Output $p; break } }",
        ],
      });
      const locateLines = locate.stdout.trim().split(/\r?\n/);
      const installDir = locateLines[0] ?? "";
      const appBinary = locateLines[1] ?? "";
      if (!appBinary) {
        // The MSI may already be installed; a discovery failure must not strand it.
        await run({ file: "msiexec", args: ["/x", artifact, "/qn", "/norestart"] });
        throw new Error("MSI installed but no OpenCodex executable was found under its InstallLocation");
      }
      return { appBinary, scope: installDir, evidence: { installLog: `${workDir}\\msi-install.log`, located: appBinary } };
    },
    closeGesture: () => ({
      file: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        "$p = Get-Process opencodex-desktop -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; " +
          "if (-not $p) { exit 1 }; " +
          "$sig = '[DllImport(\"user32.dll\")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; " +
          "Add-Type -MemberDefinition $sig -Name U32 -Namespace W; [W.U32]::PostMessage($p.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null",
      ],
    }),
    quitGesture: () => ({
      file: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        "$p = Get-Process opencodex-desktop -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; " +
          "if (-not $p) { exit 1 }; " +
          "$shell = New-Object -ComObject WScript.Shell; $shell.AppActivate($p.Id) | Out-Null; $shell.SendKeys('%{F4}')",
      ],
    }),
    // The Windows tray lives in the shell's notification area; a pre-installed runner
    // hook (UIA) drives it. See --hooks-dir in installed-gate.ts.
    trayClick: () => null,
    trayQuit: () => null,
    trayCheck: () => null,
    trayInstall: () => null,
    windowVisible: () => ({
      file: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        "$p = Get-Process opencodex-desktop -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }; if ($p) { exit 0 } else { exit 1 }",
      ],
    }),
    installedVersion: () => ({
      file: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -eq 'OpenCodex' } | Select-Object -First 1).DisplayVersion",
      ],
    }),
    cancelElevation: () => null,
    elevationProbe: () => null,
    appProcessProbe: scope => ({
      file: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ExecutablePath LIKE '${scope.replace(/%/g, "")}%'").ProcessId`,
      ],
    }),
    appNameProbe: () => ({
      file: "powershell",
      args: ["-NoProfile", "-Command", "(Get-Process opencodex-desktop -ErrorAction SilentlyContinue).Id"],
    }),
    childPids: pid => ({
      file: "powershell",
      args: ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId`],
    }),
    uninstall: artifact => [{ file: "msiexec", args: ["/x", artifact, "/qn", "/norestart"] }],
  };
}

/** Linux: deb and AppImage installs, xdotool gestures, systemd user registration. */
export function linuxAdapter(runtime: AdapterRuntime): PlatformAdapter {
  const run = runtime.run.bind(runtime);
  return {
    platform: "linux",
    dependencies: () => ["dpkg", "dpkg-deb", "dpkg-query", "xdotool", "pgrep", "systemctl", "sudo", "cp", "chmod", "kill", "rm"],
    npmLauncher: prefix => `${prefix}/node_modules/.bin/ocx`,
    serviceInstall: launcher => ({ file: launcher, args: ["service", "install"] }),
    serviceUninstall: launcher => ({ file: launcher, args: ["service", "uninstall"] }),
    registrationState: async () => {
      if (runtime.fileExists(join(runtime.homeDir(), ".config/systemd/user/opencodex-proxy.service"))) return "present";
      // is-enabled: "enabled"/"linked" exit 0; "disabled" exits 1 but still means the
      // unit file EXISTS. is-active: "active" exits 0; "inactive" exits 3 and also
      // means the unit is registered. Absence prints "could not be found".
      const enabled = await run({ file: "systemctl", args: ["--user", "is-enabled", "opencodex-proxy"] });
      const enabledOut = (enabled.stdout + enabled.stderr).trim();
      if (enabled.ok || /^\w*enabled$|^linked$/.test(enabled.stdout.trim()) || enabled.stdout.trim() === "disabled") return "present";
      if (!/could not be found|no such file|not found/i.test(enabledOut)) return "unknown";
      const active = await run({ file: "systemctl", args: ["--user", "is-active", "opencodex-proxy"] });
      const activeOut = (active.stdout + active.stderr).trim();
      if (active.ok || active.stdout.trim() === "inactive") return "present";
      if (/could not be found|no such file|not found/i.test(activeOut)) return "absent";
      return "unknown";
    },
    registrationFiles: () => [".config/systemd/user/opencodex-proxy.service"],
    existingInstallation: (format, packageName) =>
      format === "deb" && packageName
        ? { file: "dpkg-query", args: ["-W", "-f", "${Status}", packageName] }
        : null,
    async installArtifact(artifact, workDir, format) {
      if (format === "deb") {
        const packageName = (await run({ file: "dpkg-deb", args: ["-f", artifact, "Package"] })).stdout.trim();
        requireOk("dpkg install", await run({ file: "sudo", args: ["-n", "dpkg", "-i", artifact] }));
        try {
          const listing = await run({ file: "dpkg", args: ["-L", packageName] });
          const appBinary = listing.stdout.split(/\r?\n/).find(line => line.startsWith("/usr/bin/")) ?? "";
          if (!appBinary) throw new Error(`No /usr/bin executable found in package ${packageName}`);
          return { appBinary, packageName, scope: appBinary, evidence: { packageName } };
        } catch (error) {
          // The dpkg install already landed; a discovery failure must not strand it.
          await run({ file: "sudo", args: ["-n", "dpkg", "-r", packageName] });
          throw error;
        }
      }
      const appsDir = `${workDir}/apps`;
      runtime.mkdir(appsDir);
      const destination = `${appsDir}/OpenCodex.AppImage`;
      requireOk("AppImage copy", await run({ file: "cp", args: [artifact, destination] }));
      requireOk("AppImage chmod", await run({ file: "chmod", args: ["+x", destination] }));
      return { appBinary: destination, scope: appsDir, evidence: { staged: destination } };
    },
    closeGesture: () => ({ file: "xdotool", args: ["search", "--name", "OpenCodex", "windowclose"] }),
    quitGesture: () => ({
      file: "xdotool",
      args: ["search", "--name", "OpenCodex", "windowactivate", "--sync", "key", "alt+F4"],
    }),
    // A stock GNOME session has no tray; on a runner with a tray extension a
    // pre-installed hook drives it. The engine records which path was taken.
    trayClick: () => null,
    trayQuit: () => null,
    trayCheck: () => null,
    trayInstall: () => null,
    windowVisible: () => ({ file: "xdotool", args: ["search", "--name", "OpenCodex"] }),
    installedVersion: (format, packageName) =>
      format === "deb" && packageName
        ? { file: "dpkg-query", args: ["-W", "-f", "${Version}", packageName] }
        : null,
    // Scoped to the pids the elevation monitor sighted — never a blanket pkill.
    cancelElevation: pids =>
      pids.length > 0 ? { file: "kill", args: pids.map(String) } : null,
    // pkexec is the first elevation surface; the updater plugin then falls back to a
    // zenity or kdialog password dialog, and a cancel must produce NEITHER.
    // The updater's full elevation chain is pkexec -> zenity/kdialog -> terminal sudo.
    // The gate never invokes sudo during the monitored update windows, so any sighting
    // there is attributable to the updater.
    elevationProbe: () => ({ file: "pgrep", args: ["-x", "pkexec|zenity|kdialog|sudo"] }),
    appProcessProbe: scope => ({ file: "pgrep", args: ["-f", scope] }),
    appNameProbe: () => ({ file: "pgrep", args: ["-f", "opencodex-desktop"] }),
    childPids: pid => ({ file: "pgrep", args: ["-P", String(pid)] }),
    uninstall: (_artifact, workDir, format, packageName) =>
      format === "deb" && packageName
        ? [{ file: "sudo", args: ["-n", "dpkg", "-r", packageName] }]
        : [{ file: "rm", args: ["-f", `${workDir}/apps/OpenCodex.AppImage`] }],
  };
}

function appleScript(...lines: string[]): CommandSpec {
  return { file: "osascript", args: ["-e", lines.join(" ; ")] };
}
