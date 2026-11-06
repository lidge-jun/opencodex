import { guardedRun, guardedSpawnSync, UpdateMutationRefusedError } from "./mutation-guard.mjs";

/**
 * Manager-mediated runtime recovery after an update (#7043).
 *
 * When the service refresh after an update fails or leaves a non-viable manager, both update
 * lanes used to fall straight back to a detached `ocx start`. That proxy answers, but launchd
 * or systemd no longer owns it: a crash is not restarted, and the next `launchctl kickstart`
 * races the detached process for the port. Before that fallback, the lanes now ask the manager
 * to restart the job it already holds, and count it as recovered only when the serving proxy is
 * provably the manager's process: the runtime record's PID is the manager's main PID, or that
 * PID's direct child (the job execs the Node launcher, which runs the Bun proxy as its child).
 *
 * Plain synchronous ESM because `bin/ocx.mjs` runs under Node, cannot import TypeScript, and
 * keeps straight-line control flow; `src/update/index.ts` composes the same pieces with its own
 * asynchronous identity wait.
 */

/** Must match `LABEL` / `TASK` in src/service/state.ts; a test pins the pairing. */
export const LAUNCHD_SERVICE_LABEL = "com.opencodex.proxy";
export const SYSTEMD_SERVICE_UNIT = "opencodex-proxy";

function positivePid(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const pid = Number(value.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function defaultRun(file, args, authorizeMutation = () => true) {
  // An armed test process must never reach the developer's real launchd or systemd job;
  // same refusal as `assertLiveServiceManagerAllowed` for the TypeScript service layer.
  if (process.env.OCX_TEST_HOME_GUARD === "1") {
    return { ok: false, stdout: "", stderr: `refusing to run ${file} from an armed test process` };
  }
  // A bare SSH session has no user-bus address; systemd's user manager still lives at the
  // conventional runtime directory (same fallback as the service layer's ensureUserBusEnv).
  const env = file === "systemctl" && !process.env.XDG_RUNTIME_DIR && typeof process.getuid === "function"
    ? { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` }
    : process.env;
  const result = guardedSpawnSync(authorizeMutation, "service", file, args, { encoding: "utf8", timeout: 20_000, windowsHide: true, env });
  if (result.error) {
    // A timeout kills only the waiting client; the manager's queued job keeps running.
    const timedOut = result.error.code === "ETIMEDOUT";
    return { ok: false, stdout: "", stderr: String(result.error.message ?? ""), ...(timedOut ? { timedOut } : {}) };
  }
  return { ok: result.status === 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "").trim() };
}

function launchdTarget(uid) {
  return `gui/${uid}/${LAUNCHD_SERVICE_LABEL}`;
}

/** `launchctl print` reports a running job as a `pid = <n>` line. */
export function parseLaunchdJobPid(printOutput) {
  const match = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(String(printOutput ?? ""));
  return positivePid(match?.[1]);
}

/** `systemctl show -p MainPID` prints `MainPID=<n>`; 0 means not running. */
export function parseSystemdMainPid(showOutput) {
  const match = /^MainPID=(\d+)\s*$/m.exec(String(showOutput ?? ""));
  return positivePid(match?.[1]);
}

function resolve(deps) {
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  return { platform, uid, run: deps.run ?? defaultRun };
}

/** Whether this platform has a manager this module can ask (launchd or systemd). */
export function hasRestartableServiceManager(deps = {}) {
  const { platform } = resolve(deps);
  return platform === "darwin" || platform === "linux";
}

/**
 * Ask the manager to restart the job in place. Never throws. `unsettled` means the client gave up
 * waiting while the manager may still complete the restart: callers must not start a competing
 * proxy on that answer.
 */
export function restartServiceManagerJob(deps = {}, authorizeMutation = () => false) {
  try {
  const { platform, uid } = resolve(deps);
  const run = deps.run ?? ((file, args) => defaultRun(file, args, authorizeMutation));
  const result = platform === "darwin"
    ? guardedRun(authorizeMutation, "service", run, ["/bin/launchctl", ["kickstart", "-k", launchdTarget(uid)]])
    : platform === "linux"
      ? guardedRun(authorizeMutation, "service", run, ["systemctl", ["--user", "restart", SYSTEMD_SERVICE_UNIT]])
      : null;
  if (result === null) return { ok: false, reason: "no launchd or systemd manager on this platform" };
  if (result.timedOut) return { ok: false, unsettled: true, reason: "the service manager did not finish the restart in time" };
  if (!result.ok) return { ok: false, reason: result.stderr.split("\n")[0] || "the service manager refused the restart" };
  return { ok: true };
  } catch (error) {
    return error instanceof UpdateMutationRefusedError
      ? { ok: false, refused: true, reason: "Automatic service restart refused; check 'ocx service status'." }
      : { ok: false, reason: "the service manager restart failed" };
  }
}

/** The manager's main PID for the job, or null when it reports none. Never throws. */
export function readServiceManagerPid(deps = {}) {
  const { platform, uid, run } = resolve(deps);
  if (platform === "darwin") {
    const printed = run("/bin/launchctl", ["print", launchdTarget(uid)]);
    return printed.ok ? parseLaunchdJobPid(printed.stdout) : null;
  }
  if (platform === "linux") {
    const shown = run("systemctl", ["--user", "show", "-p", "MainPID", SYSTEMD_SERVICE_UNIT]);
    return shown.ok ? parseSystemdMainPid(shown.stdout) : null;
  }
  return null;
}

/** Parent PID of a process, or null when it cannot be read. Never throws. */
export function readParentPid(pid, deps = {}) {
  const { run } = resolve(deps);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = run("ps", ["-o", "ppid=", "-p", String(pid)]);
  return result.ok ? positivePid(result.stdout) : null;
}

/**
 * Whether the serving proxy is the manager's job. `parentPid` is consulted only when the
 * serving PID is not the manager's own.
 */
export function supervisionVerdict({ servingPid, managerPid, parentPid }) {
  if (!Number.isSafeInteger(servingPid) || servingPid <= 0) {
    return { kind: "failed", reason: "the manager restarted the job but no proxy answered" };
  }
  if (!Number.isSafeInteger(managerPid) || managerPid <= 0) {
    return { kind: "failed", reason: "the manager reports no running process for the job" };
  }
  if (servingPid === managerPid || parentPid(servingPid) === managerPid) {
    return { kind: "supervised", managerPid, servingPid };
  }
  return { kind: "failed", reason: `the serving proxy (pid ${servingPid}) is not the manager's job (pid ${managerPid})` };
}

/**
 * The serving PID to judge after a restart: a record still naming the pre-restart process is not
 * evidence about the restarted one.
 */
export function freshServingPid(recordPid, staleRecordPid) {
  return Number.isSafeInteger(recordPid) && recordPid > 0 && recordPid !== staleRecordPid ? recordPid : null;
}

/** The warning printed when an update had to leave a proxy the manager does not own. */
export function unsupervisedRuntimeWarning(port) {
  return [
    `⚠️  The proxy on port ${port} is running UNSUPERVISED: the background service manager did not take it back after the update.`,
    "   A crash will not be restarted, and a later service start can race it for the port.",
    "   Run 'ocx service repair' to hand it back to the background service.",
  ].join("\n");
}

/** The warning printed when the manager may still be restarting; no second proxy is started. */
export function unsettledManagerWarning(port) {
  return [
    `⚠️  The service manager is still restarting the proxy on port ${port}; no second proxy was started.`,
    "   Check it with 'ocx service status', and run 'ocx service repair' if it does not come back.",
  ].join("\n");
}
