import { spawn, spawnSync } from "node:child_process";

const TREE_POLL_INTERVAL_MS = 50;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_FORCE_WAIT_MS = 5_000;

/** Exit code used when the updater cannot prove that its installer tree is gone. */
export const INSTALLER_TREE_CLEANUP_FAILED_EXIT_CODE = 75;

function isNoSuchProcess(error) {
  return error && typeof error === "object" && "code" in error && error.code === "ESRCH";
}

function isProcessTreeAlive(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForProcessTreeExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessTreeAlive(pid)) return true;
    await sleep(TREE_POLL_INTERVAL_MS);
  }
  return !isProcessTreeAlive(pid);
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
  } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (!isProcessTreeAlive(pid)) return true;

  if (process.platform === "win32") {
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
    const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: terminationGraceMs + forceWaitMs,
      windowsHide: true,
    });
    if (result.status !== 0) return false;
    return waitForProcessTreeExit(pid, forceWaitMs);
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (isNoSuchProcess(error)) return true;
    return false;
  }
  if (await waitForProcessTreeExit(pid, terminationGraceMs)) return true;

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (isNoSuchProcess(error)) return true;
    return false;
  }
  return waitForProcessTreeExit(pid, forceWaitMs);
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
  } = {},
) {
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

  const outcome = new Promise(resolve => {
    let settled = false;
    child.once("error", error => {
      if (settled) return;
      settled = true;
      resolve({ status: null, signal: null, error });
    });
    child.once("exit", (status, signal) => {
      if (settled) return;
      settled = true;
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
    cleanupPromise = terminateInstallerProcessTree(child.pid, {
      terminationGraceMs,
      forceWaitMs,
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
    treeExited = await cleanupPromise;
  } else if (child.pid && isProcessTreeAlive(child.pid)) {
    treeExited = await terminateInstallerProcessTree(child.pid, {
      terminationGraceMs,
      forceWaitMs,
    });
  }
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);

  return {
    ...result,
    signal: interruptedSignal ?? result.signal,
    status: timedOut || interruptedSignal !== null ? null : result.status,
    interruptedSignal,
    timedOut,
    treeExited,
  };
}
