import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const TREE_POLL_INTERVAL_MS = 100;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_FORCE_WAIT_MS = 5_000;
export const MAX_CAPTURED_OUTPUT_CHARS = 4_000;

function appendBoundedOutput(current, chunk) {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  const next = current + text;
  return next.length > MAX_CAPTURED_OUTPUT_CHARS
    ? next.slice(-MAX_CAPTURED_OUTPUT_CHARS)
    : next;
}

/** Exit code used when the updater cannot prove that its installer tree is gone. */
export const INSTALLER_TREE_CLEANUP_FAILED_EXIT_CODE = 75;

function isNoSuchProcess(error) {
  return error && typeof error === "object" && "code" in error && error.code === "ESRCH";
}

function inspectLinuxProcessGroup(groupId) {
  try {
    let hasRunningMember = false;
    let hasRunningLeader = false;
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      let stat;
      try {
        stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
      } catch {
        continue;
      }
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd === -1) continue;
      const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
      const state = fields[0];
      const processGroup = Number.parseInt(fields[2] ?? "", 10);
      if (processGroup !== groupId || state === "Z" || state === "X") continue;
      hasRunningMember = true;
      if (Number.parseInt(entry.name, 10) === groupId) hasRunningLeader = true;
    }
    return { hasRunningMember, hasRunningLeader };
  } catch {
    return null;
  }
}

function inspectPsProcessGroup(groupId) {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,state="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  let hasRunningMember = false;
  let hasRunningLeader = false;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (!match || Number.parseInt(match[2], 10) !== groupId) continue;
    if (match[3].startsWith("Z") || match[3].startsWith("X")) continue;
    hasRunningMember = true;
    if (Number.parseInt(match[1], 10) === groupId) hasRunningLeader = true;
  }
  return { hasRunningMember, hasRunningLeader };
}

function inspectProcessGroup(groupId) {
  if (process.platform === "linux") return inspectLinuxProcessGroup(groupId);
  if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
    return inspectPsProcessGroup(groupId);
  }
  return null;
}

export function processGroupForceDecision(inspection, originalLeaderConfirmed) {
  if (!inspection) return "refuse";
  if (!inspection.hasRunningMember) return "exited";
  if (inspection.hasRunningLeader && !originalLeaderConfirmed) return "refuse";
  return "signal";
}

function processGroupTerminationDecision(inspection, originalLeaderConfirmed) {
  if (!inspection) return "refuse";
  if (!inspection.hasRunningMember) return "exited";
  // SIGTERM is sent only while the original root still anchors the group ID.
  // Leaderless groups are handled fail-closed after root exit.
  if (!inspection.hasRunningLeader || !originalLeaderConfirmed) return "refuse";
  return "signal";
}

function processGroupHasRunningMember(groupId, inspect = inspectProcessGroup) {
  return inspect(groupId)?.hasRunningMember ?? null;
}

function inspectProcessGroupAfterLeaderExit(groupId, inspect = inspectProcessGroup) {
  const inspection = inspect(groupId);
  if (!inspection) return "unknown";
  // A new group cannot reuse this ID without a live leader whose PID equals the
  // group ID. Never signal that group; it is unrelated to the completed child.
  if (inspection.hasRunningLeader) return "reused";
  return inspection.hasRunningMember ? "running" : "exited";
}

function isProcessTreeAlive(pid, inspect = inspectProcessGroup) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    if (process.platform === "win32") return true;
    // Zombies keep a process group addressable by signal 0 but cannot mutate the
    // package tree. Treat a zombie-only group as fully stopped.
    return processGroupHasRunningMember(pid, inspect) ?? true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForProcessTreeExit(pid, timeoutMs, inspect = inspectProcessGroup) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessTreeAlive(pid, inspect)) return true;
    await sleep(TREE_POLL_INTERVAL_MS);
  }
  return !isProcessTreeAlive(pid, inspect);
}

/**
 * Terminate a detached installer and every descendant before package recovery starts.
 * POSIX uses the installer's process group; Windows snapshots and kills the tree while
 * the root process is still alive via taskkill /T /F.
 */
export async function terminateInstallerProcessTree(
  pid,
  {
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    forceWaitMs = DEFAULT_FORCE_WAIT_MS,
    isOriginalLeader,
    inspectProcessGroup: inspectOverride,
  } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  const inspect = inspectOverride ?? inspectProcessGroup;

  if (process.platform === "win32") {
    // Once the root has exited, Node has no job-object handle with which to prove
    // that background descendants also exited. Fail closed instead of treating a
    // missing root PID as proof that the complete installer tree is gone.
    if (!isProcessTreeAlive(pid, inspect)) return false;
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
    const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: terminationGraceMs + forceWaitMs,
      windowsHide: true,
    });
    // A non-zero taskkill result cannot distinguish an already-gone root from a
    // partially-killed tree. Recovery must remain disabled in either case.
    if (result.status !== 0) return false;
    return waitForProcessTreeExit(pid, forceWaitMs, inspect);
  }

  // An unreaped child retains its PID. Revalidate that leader identity at the
  // signal boundary so a released or replacement-led group is never signaled.
  const signalInspection = inspect(pid);
  const signalLeaderConfirmed = signalInspection?.hasRunningLeader === true
    && isOriginalLeader?.() === true;
  const signalDecision = processGroupTerminationDecision(signalInspection, signalLeaderConfirmed);
  if (signalDecision === "exited") return true;
  if (signalDecision === "refuse") return false;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (isNoSuchProcess(error)) return true;
    return false;
  }
  if (await waitForProcessTreeExit(pid, terminationGraceMs, inspect)) return true;

  const forceInspection = inspect(pid);
  const originalLeaderConfirmed = forceInspection?.hasRunningLeader === true
    && isOriginalLeader?.() === true;
  const forceDecision = processGroupForceDecision(forceInspection, originalLeaderConfirmed);
  if (forceDecision === "exited") return true;
  if (forceDecision === "refuse") return false;

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (isNoSuchProcess(error)) return true;
    return false;
  }
  return waitForProcessTreeExit(pid, forceWaitMs, inspect);
}

/**
 * Run a command in an isolated process tree. A timeout is not reported until the
 * entire tree has been terminated or cleanup failure has been made explicit.
 */
export async function runProcessTreeCommand(
  bin,
  args,
  {
    timeoutMs,
    stdio = "inherit",
    windowsHide = true,
    shell = false,
    env = process.env,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    forceWaitMs = DEFAULT_FORCE_WAIT_MS,
    inspectProcessGroup: inspectOverride,
  } = {},
) {
  const inspect = inspectOverride ?? inspectProcessGroup;
  let child;
  try {
    child = spawn(bin, args, {
      detached: process.platform !== "win32",
      env,
      shell,
      stdio,
      windowsHide,
    });
  } catch (error) {
    return {
      status: null,
      signal: null,
      error,
      interruptedSignal: null,
      timedOut: false,
      treeExited: true,
    };
  }

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding?.("utf8");
  child.stderr?.setEncoding?.("utf8");
  child.stdout?.on?.("data", chunk => { stdout = appendBoundedOutput(stdout, chunk); });
  child.stderr?.on?.("data", chunk => { stderr = appendBoundedOutput(stderr, chunk); });

  let posixTreeAfterRootExit = "unknown";
  let windowsFailedExitTreeUnknown = false;
  let spawnFailed = false;
  const outcome = new Promise(resolve => {
    let settled = false;
    child.once("error", error => {
      if (settled) return;
      settled = true;
      spawnFailed = true;
      resolve({ status: null, signal: null, error });
    });
    child.once("exit", (status, signal) => {
      if (settled) return;
      settled = true;
      if (process.platform === "win32") {
        // A successful package-manager exit is its completion contract. On a
        // failed exit, however, a background descendant cannot be ruled out once
        // the root PID is gone, so failed-install recovery stays fail-closed.
        windowsFailedExitTreeUnknown = status !== 0 || signal !== null;
      } else if (child.pid) {
        // Inspect group membership directly. A live process whose PID equals the
        // old group ID proves reuse, in which case cleanup must not signal it.
        posixTreeAfterRootExit = inspectProcessGroupAfterLeaderExit(child.pid, inspect);
      }
      resolve({ status, signal });
    });
  });

  let timedOut = false;
  let interruptedSignal = null;
  let cleanupPromise = null;
  let reportCleanupFailure;
  const cleanupFailure = new Promise(resolve => {
    reportCleanupFailure = resolve;
  });
  const startCleanup = () => {
    if (cleanupPromise) return;
    // If libuv already observed root exit, let the exit handler inspect the old
    // group with PID-reuse protection instead of signaling by a freed PID here.
    if (child.exitCode !== null || child.signalCode !== null) return;
    cleanupPromise = terminateInstallerProcessTree(child.pid, {
      terminationGraceMs,
      forceWaitMs,
      isOriginalLeader: () => child.exitCode === null && child.signalCode === null,
      inspectProcessGroup: inspect,
    });
    void cleanupPromise.then(treeExited => {
      if (treeExited) return;
      try { child.kill("SIGKILL"); } catch { /* best-effort root cleanup */ }
      reportCleanupFailure({ status: null, signal: null });
    });
  };
  const forwardedSignals = process.platform === "win32"
    ? ["SIGINT", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = forwardedSignals.map(signal => {
    const handler = () => {
      interruptedSignal ??= signal;
      startCleanup();
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      startCleanup();
    }, timeoutMs)
    : null;

  const result = await Promise.race([outcome, cleanupFailure]);
  if (timer !== null) clearTimeout(timer);

  let treeExited = true;
  if (cleanupPromise) {
    const knownGroupExited = await cleanupPromise;
    // taskkill /T is a retained Windows tree operation. A POSIX process group is
    // not containment: a lifecycle child can leave it with setsid/setpgid, so a
    // timeout/interruption can never prove complete descendant shutdown.
    treeExited = process.platform === "win32" && knownGroupExited;
  } else if (spawnFailed) {
    treeExited = true;
  } else if (process.platform === "win32") {
    treeExited = !windowsFailedExitTreeUnknown;
  } else {
    // A successful package-manager root exit is its completion contract unless
    // inspection positively finds a surviving member of the original group.
    // Failed/signaled roots remain unconfirmed even when the group looks empty.
    treeExited = result.status === 0
      && result.signal === null
      && posixTreeAfterRootExit !== "running";
  }
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);

  return {
    ...result,
    signal: interruptedSignal ?? result.signal,
    status: timedOut || interruptedSignal !== null ? null : result.status,
    interruptedSignal,
    timedOut,
    treeExited,
    stdout,
    stderr,
  };
}
