import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

/**
 * How to launch the dashboard update worker on POSIX.
 *
 * A worker spawned from the systemd user service stays in that service's cgroup even when
 * detached, and the generated unit keeps the default `KillMode=control-group`. The updater then
 * stops `opencodex-proxy.service` and systemd kills the worker with it, leaving the proxy offline
 * on the old package (#5750). `systemd-run --user --scope` moves the worker into its own
 * transient scope first; `--scope` execs the command in place, so the returned PID is still the
 * worker's. Outside a systemd-started process (`INVOCATION_ID` unset), or when `systemd-run` is
 * missing, the plain detached spawn is unchanged.
 */
export const SYSTEMD_SCOPE_ARGS = ["--user", "--scope", "--quiet", "--collect", "--"] as const;

export interface WorkerLaunchContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resolveSystemdRun?: () => string | undefined;
}

// Absolute install paths only — PATH is never consulted, so a caller-controlled entry cannot
// redirect the launch. `/usr/local/bin` is where systemd lands when built or stowed outside the
// distro layout, and `/run/current-system/sw/bin` is the NixOS layout, where the binary lives
// nowhere else even though the user bus works. A candidate only counts when the binary and its
// directory are root-owned and not group/world-writable, so a lower-trust local actor cannot
// plant the launcher the scope probe execs.
const TRUSTED_SYSTEMD_RUN_PATHS = [
  "/usr/bin/systemd-run", "/bin/systemd-run", "/usr/local/bin/systemd-run",
  "/run/current-system/sw/bin/systemd-run",
] as const;

export interface SystemdRunHooks {
  isExecutableFile: (path: string) => boolean;
  probeScope: (path: string) => boolean;
  /** Async variant of probeScope; resolveSystemdRunAsync prefers it when present. */
  probeScopeAsync?: (path: string) => Promise<boolean>;
}

const GROUP_OR_WORLD_WRITE = 0o022;

// stat (follow) rather than lstat: a root-owned symlink to a user-writable directory must fail
// on the target's mode, not pass on the symlink's (mirrors isTrustedSystemPath in
// src/codex/desktop-app/linux.ts).
export interface SystemdRunTrustDeps {
  /** Test seam: canonicalizes the candidate before its substitution chain is checked. */
  realpathSync?: (path: string) => string;
  /** Test seam: stats a resolved path for ownership and mode. */
  statSync?: (path: string) => { isFile(): boolean; uid: number; mode: number };
  /** Test seam: checks the candidate's executable bit. */
  accessSync?: (path: string, mode: number) => void;
}

function rootOnlyWritable(path: string, stat: SystemdRunTrustDeps["statSync"] = statSync): boolean {
  try {
    const st = stat!(path);
    return st.uid === 0 && (st.mode & GROUP_OR_WORLD_WRITE) === 0;
  } catch {
    return false;
  }
}

// "Executable" here includes trust: the binary and its directory must be root-owned and not
// group/world-writable. /usr/local/bin is group-writable on some systems, and a planted or
// replaced systemd-run there would be exec'd by the scope probe under the service account;
// the fallback is the plain detached spawn, so nothing breaks when it is skipped.
// Exported for unit tests.
export function isTrustedSystemdRunFile(path: string, deps: SystemdRunTrustDeps = {}): boolean {
  try {
    if (!isAbsolute(path)) return false;
    (deps.accessSync ?? accessSync)(path, constants.X_OK);
    // The lexical path may be a symlink. Checking the link's own parent only proves
    // the *entry* is pinned; the file it resolves to — and every ancestor able to
    // substitute that resolved file — is what the scope probe will actually exec.
    const realpath = deps.realpathSync ?? realpathSync;
    const resolved = realpath(path);
    const stat = deps.statSync ?? statSync;
    const st = stat(resolved);
    if (!(st.isFile() && st.uid === 0 && (st.mode & GROUP_OR_WORLD_WRITE) === 0)) {
      return false;
    }
    for (const start of [dirname(path), dirname(resolved)]) {
      for (let dir = start, previous = ""; dir !== previous; previous = dir, dir = dirname(dir)) {
        if (!rootOnlyWritable(dir, stat)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Scope discovery gets only user-bus identity, never inherited management credentials. */
function scopeProbeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const name of ["HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

const systemdRunHooks: SystemdRunHooks = {
  isExecutableFile: isTrustedSystemdRunFile,
  // Run a real scope with the same absolute binary as its harmless version payload.
  // Probing only the outer --version would not verify the user bus.
  probeScope: path => {
    const probe = spawnSync(path, [...SYSTEMD_SCOPE_ARGS, path, "--version"], { stdio: "ignore", timeout: 5_000, env: scopeProbeEnvironment() });
    return !probe.error && probe.status === 0;
  },
  probeScopeAsync: path => new Promise<boolean>(resolve => {
    const probe = spawn(path, [...SYSTEMD_SCOPE_ARGS, path, "--version"], { stdio: "ignore", env: scopeProbeEnvironment() });
    probe.unref();
    const timer = setTimeout(() => {
      try { probe.kill("SIGKILL"); } catch { /* failed termination is not a successful probe */ }
      resolve(false);
    }, 5_000);
    timer.unref();
    probe.once("error", () => { clearTimeout(timer); resolve(false); });
    probe.once("close", code => { clearTimeout(timer); resolve(code === 0); });
  }),
};

let systemdRunProbe: string | null | undefined;
let systemdRunProbePending: Promise<string | null> | undefined;

export function resolveSystemdRun(hooks: SystemdRunHooks = systemdRunHooks): string | undefined {
  if (systemdRunProbe === undefined) {
    systemdRunProbe = null;
    for (const command of TRUSTED_SYSTEMD_RUN_PATHS) {
      if (!hooks.isExecutableFile(command)) continue;
      if (hooks.probeScope(command)) {
        systemdRunProbe = command;
        break;
      }
    }
  }
  return systemdRunProbe ?? undefined;
}

/**
 * Management-request path variant. The synchronous resolver blocks the shared
 * event loop for up to four sequential five-second scope probes on first use;
 * the dashboard update route awaits this instead, so probing overlaps other
 * requests. Concurrent first callers share one probe pass.
 */
export async function resolveSystemdRunAsync(hooks: SystemdRunHooks = systemdRunHooks): Promise<string | undefined> {
  if (systemdRunProbe !== undefined) return systemdRunProbe ?? undefined;
  if (!systemdRunProbePending) {
    systemdRunProbePending = (async () => {
      const probeScope = hooks.probeScopeAsync ?? (async (path: string) => hooks.probeScope(path));
      for (const command of TRUSTED_SYSTEMD_RUN_PATHS) {
        if (!hooks.isExecutableFile(command)) continue;
        if (await probeScope(command)) {
          return command;
        }
      }
      return null;
    })();
  }
  const found = await systemdRunProbePending;
  // Honor a cache the sync resolver may have filled while the probe ran — the
  // older observation wins so every caller converges on one launcher.
  if (systemdRunProbe === undefined) systemdRunProbe = found;
  return systemdRunProbe ?? undefined;
}

export function resetSystemdRunProbeForTests(): void {
  systemdRunProbe = undefined;
  systemdRunProbePending = undefined;
}

export function guiUpdateWorkerCommand(
  execPath: string,
  args: readonly string[],
  context: WorkerLaunchContext = {},
): { command: string; argv: string[] } {
  const platform = context.platform ?? process.platform;
  const env = context.env ?? process.env;
  const underSystemd = platform === "linux" && Boolean(env.INVOCATION_ID);
  const systemdRun = underSystemd ? (context.resolveSystemdRun ?? resolveSystemdRun)() : undefined;
  if (systemdRun) {
    return { command: systemdRun, argv: [...SYSTEMD_SCOPE_ARGS, execPath, ...args] };
  }
  return { command: execPath, argv: [...args] };
}
