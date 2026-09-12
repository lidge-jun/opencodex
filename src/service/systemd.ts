import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCE_ENV, durableBunRuntime, type DurableBunRuntime } from "../lib/bun-runtime";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { systemdProperty } from "../service-manager-probe";
import { writeServiceApiTokenFile, sh } from "./guards";
import { shellQuote, buildServiceShellCommand, buildServiceLauncherShellCommand, resolvedProxyEnv } from "./health";
import type { ServiceInstallCleanupOps } from "./orchestration";
import { SERVICE_MANAGED_ENV, TASK, cliEntry, stableLauncherEntry, logPath, serviceStatePath, currentCodexSqliteHomeAbsolute, writeServiceInstallState } from "./state";
import { writeServiceDefinitionFile } from "./windows-ops";

/** The `--port <n>` baked into the installed systemd user unit. Linux only. */
export function systemdListenPort(deps: { readUnit?: () => string } = {}): number | null {
  try {
    const text = (deps.readUnit ?? (() => readFileSync(unitPath(), "utf8")))();
    const last = [...text.matchAll(/start --port (\d{1,5})(?:\s|"|$)/gm)].at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

function systemdQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/%/g, "%%")
    .replace(/\n/g, "\\n")}"`;
}

function systemdEnvironmentAssignment(name: string, value: string | undefined): string | null {
  if (!value) return null;
  return `Environment=${systemdQuote(`${name}=${value}`)}`;
}

// ── Linux (systemd user unit) ──
function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

export function unitPath(): string {
  return join(unitDir(), `${TASK}.service`);
}

export function buildUnit(
  proxyEnv: { name: string; value: string }[] = resolvedProxyEnv(),
  deps: { launcher?: string | null; runtime?: DurableBunRuntime } = {},
): string {
  const runtime = deps.runtime ?? durableBunRuntime();
  const { bun, bunRuntimeSource, cli } = cliEntry(runtime);
  // Discovery belongs to installSystemd(), which resolves once and passes the same value to
  // both the unit and install state. Keeping this builder explicit makes tests and diagnostics
  // independent of the host PATH.
  const launcher = deps.launcher ?? null;
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const codexHome = systemdEnvironmentAssignment("CODEX_HOME", process.env.CODEX_HOME?.trim());
  const codexSqliteHome = systemdEnvironmentAssignment("CODEX_SQLITE_HOME", currentCodexSqliteHomeAbsolute());
  const opencodexHome = systemdEnvironmentAssignment("OPENCODEX_HOME", process.env.OPENCODEX_HOME?.trim());
  const envLines = [
    systemdEnvironmentAssignment("OCX_SERVICE", "1"),
    systemdEnvironmentAssignment(SERVICE_MANAGED_ENV, "1"),
    ...(launcher ? [] : [
      systemdEnvironmentAssignment(BUN_RUNTIME_SOURCE_ENV, bunRuntimeSource),
      systemdEnvironmentAssignment(BUN_RUNTIME_PATH_ENV, bun),
    ]),
    // A launcher normally resolves the current package's bundled Bun after every upgrade.
    // Preserve only a proof-bound shell override; otherwise writing a package-local path here
    // would recreate the version-manager pin that the launcher mode exists to remove.
    launcher && runtime.source === "override"
      ? systemdEnvironmentAssignment(runtime.overrideEnv, runtime.path)
      : null,
    systemdEnvironmentAssignment("PATH", path),
    codexHome,
    codexSqliteHome,
    opencodexHome,
    ...proxyEnv.map(({ name, value }) => systemdEnvironmentAssignment(name, value)),
  ].filter((line): line is string => Boolean(line)).join("\n");
  const command = `${launcher ? buildServiceLauncherShellCommand(launcher) : buildServiceShellCommand(bun, cli)} >> ${shellQuote(log)} 2>&1`;
  return `[Unit]
Description=OpenCodex Proxy Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote("/bin/sh")} -lc ${systemdQuote(command)}
Restart=on-failure
RestartSec=5
${envLines}

[Install]
WantedBy=default.target
`;
}

/** The per-user runtime dir systemd creates (holds the user-bus socket), or null. */
function userRuntimeDir(): string | null {
  const fromEnv = process.env.XDG_RUNTIME_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (typeof process.getuid === "function") {
    const candidate = `/run/user/${process.getuid()}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * SSH sessions frequently start without `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`, so
 * `systemctl --user` can't find the user bus even when systemd is running. Point `XDG_RUNTIME_DIR`
 * at the per-user runtime dir when it exists so the `--user` probe and install commands reach the
 * bus. No-op when already set or when no runtime dir exists (e.g. genuinely non-systemd hosts).
 */
function ensureUserBusEnv(): void {
  if (process.env.XDG_RUNTIME_DIR) return;
  const dir = userRuntimeDir();
  if (dir) process.env.XDG_RUNTIME_DIR = dir;
}

export function isSystemd(): boolean {
  try { execSync("systemctl --version", { stdio: "pipe" }); } catch { return false; }
  ensureUserBusEnv();
  // Prefer the user-bus probe; but an SSH session without a user D-Bus fails it even when systemd
  // is present (F9). Fall back to the per-user runtime dir existing — a strong signal the user
  // systemd instance is available — so a first-time `ocx service install` isn't wrongly refused.
  try { execSync("systemctl --user show-environment", { stdio: "pipe" }); return true; } catch { /* no user bus in this session */ }
  return userRuntimeDir() !== null;
}

export function installSystemd(): void {
  ensureUserBusEnv(); // reach the user bus over a bare SSH session (F9)
  const dir = unitDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  // Resolve ONCE and reuse: the unit and the install state must agree about what is
  // launched, or the staleness check would validate a path the unit does not run.
  const launcher = stableLauncherEntry();
  writeServiceDefinitionFile(unitPath(), buildUnit(resolvedProxyEnv(), { launcher }), "utf8");
  sh("systemctl --user daemon-reload");
  sh(`systemctl --user enable ${TASK}`);
  sh(`systemctl --user restart ${TASK}`);
  writeServiceInstallState("scheduler", launcher);
}

/**
 * Whether systemd's in-memory unit differs from the file on disk.
 *
 * The systemd analogue of launchd's stale-plist case: writing
 * `~/.config/systemd/user/<unit>` does not change the definition systemd has loaded
 * until `daemon-reload`, so a plain `systemctl start` would run the PREVIOUS
 * ExecStart. `NeedDaemonReload` is a per-unit property emitted as a bare
 * `NeedDaemonReload=yes|no` line; pass the unit name or `show` reports the manager's
 * own property instead, which answers a different question.
 *
 * Fail-open: if the query cannot run (no user bus, unit absent) we must not block a
 * start that would otherwise work.
 */
export function systemdNeedsDaemonReload(deps: { show?: () => string } = {}): boolean {
  try {
    const out = (deps.show ?? (() => sh(`systemctl --user show -p NeedDaemonReload ${TASK}`)))();
    return /NeedDaemonReload\s*=\s*yes/i.test(out);
  } catch {
    return false;
  }
}

export function startSystemd(): void {
  ensureUserBusEnv();
  if (!existsSync(unitPath())) {
    console.error(`opencodex service is not installed: ${unitPath()}`);
    console.error("Run `ocx service install` first to create and enable the systemd user unit.");
    process.exit(1);
  }
  // The unit on disk may be newer than what systemd loaded; starting now would run
  // the previous definition.
  //
  // `start` alone is not enough after a reload: it is a no-op on an already-active
  // unit, so the stale process would keep running the old ExecStart. NeedDaemonReload
  // compares disk against loaded, never loaded against running, so the only way to
  // make the running process match the file is to restart it.
  if (systemdNeedsDaemonReload()) {
    console.log("ℹ️  unit file changed on disk; reloading systemd and restarting the service.");
    sh("systemctl --user daemon-reload");
    sh(`systemctl --user restart ${TASK}`);
    return;
  }
  sh(`systemctl --user start ${TASK}`);
}

export function stopSystemd(): void { try { sh(`systemctl --user stop ${TASK}`); } catch { /* not running */ } }

export function statusSystemd(): string { try { return sh(`systemctl --user status ${TASK}`); } catch { return ""; } }

export function uninstallSystemd(deps: {
  run?: (command: string) => string;
  unitExists?: () => boolean;
  removeUnit?: () => void;
} = {}): void {
  const run = deps.run ?? sh;
  try { run(`systemctl --user stop ${TASK}`); } catch { /* not running */ }
  try { run(`systemctl --user disable ${TASK}`); } catch { /* absent */ }
  if ((deps.unitExists ?? (() => existsSync(unitPath())))()) {
    (deps.removeUnit ?? (() => unlinkSync(unitPath())))();
  }
  try { run("systemctl --user daemon-reload"); } catch { /* best-effort */ }
}

export function systemdServiceInstallCleanupOps(deps: {
  run?: (command: string) => string;
} = {}): ServiceInstallCleanupOps {
  const run = deps.run ?? sh;
  return {
    status: () => {
      const output = run(`systemctl --user show -p LoadState ${TASK}`);
      const loadState = systemdProperty(output, "LoadState")?.toLowerCase();
      if (!loadState) throw new Error("systemd service status could not be verified.");
      return loadState === "not-found" ? null : loadState;
    },
    stop: () => { run(`systemctl --user stop ${TASK}`); },
  };
}
