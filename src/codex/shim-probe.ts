import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { CODEX_SHIM_REENTRY_EXIT_CODE, CODEX_SHIM_REENTRY_DIAGNOSTIC } from "./shim-templates";
import type { ShimFileState } from "./shim-state-file";

const CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS = 5_000;
const CODEX_SHIM_INSTALL_PROBE_EXIT_TIMEOUT_MS = 1_000;

const CODEX_SHIM_INSTALL_PROBE_SCRIPT = `
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const [markerPath, reentryPath, groupPath, stderrPath, launcherShellPath, wrapperPath, timeoutRaw, stderrLimitRaw, stderrDrainRaw, observationRaw] = process.argv.slice(1);
const timeoutMs = Number.parseInt(timeoutRaw, 10);
const stderrLimit = Number.parseInt(stderrLimitRaw, 10);
const stderrDrainMs = Number.parseInt(stderrDrainRaw, 10);
const observationMs = Number.parseInt(observationRaw, 10);
const probeStartedAt = Date.now();
const stderrChunks = [];
let stderrBytes = 0;
let launcher;
let probeLease;
let timer;
let stderrDrainTimer;
let observationTimer;
let reentryPollTimer;
let marker = "";
let finished = false;

function writeExclusive(path, value) {
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
}

function appendStderr(value) {
  if (stderrBytes >= stderrLimit) return;
  const bytes = Buffer.from(value);
  const retained = bytes.subarray(0, stderrLimit - stderrBytes);
  stderrChunks.push(retained);
  stderrBytes += retained.byteLength;
}

function groupAlive() {
  if (!launcher || !launcher.pid) return false;
  try {
    process.kill(-launcher.pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== "ESRCH";
  }
}

function killGroup() {
  if (!launcher || !launcher.pid) return;
  try { process.kill(-launcher.pid, "SIGKILL"); } catch (error) {
    if (!error || error.code !== "ESRCH") appendStderr(String(error));
  }
}

function setMarker(value) {
  if (marker) return;
  marker = value;
  try { writeExclusive(markerPath, value + "\\n"); } catch (error) { appendStderr(String(error)); }
}

function reentryDetected() {
  try { return readFileSync(reentryPath, "utf8").trim() === "recursive"; } catch { return false; }
}

function checkReentry() {
  if (finished || !reentryDetected()) return;
  setMarker("recursive");
  killGroup();
  finish(126);
}

function finish(status) {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  if (stderrDrainTimer) clearTimeout(stderrDrainTimer);
  if (observationTimer) clearTimeout(observationTimer);
  if (reentryPollTimer) clearInterval(reentryPollTimer);
  if (!marker && reentryDetected()) setMarker("recursive");
  if (!marker && groupAlive()) {
    setMarker("descendants");
    killGroup();
  }
  try { writeExclusive(stderrPath, Buffer.concat(stderrChunks)); } catch { /* parent fails closed */ }
  process.exit(marker === "timeout" ? 124 : marker === "descendants" ? 125 : marker === "recursive" ? 126 : status);
}

function finishAfterStderr(status) {
  if (finished) return;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (!launcher || !launcher.stderr || !probeLease) {
    finish(status);
    return;
  }
  let stderrEnded = launcher.stderr.readableEnded;
  let leaseEnded = probeLease.readableEnded;
  let observationElapsed = false;
  const finishWhenReady = () => {
    if (stderrEnded && leaseEnded && observationElapsed) finish(status);
  };
  launcher.stderr.once("end", () => {
    stderrEnded = true;
    finishWhenReady();
  });
  probeLease.once("end", () => {
    leaseEnded = true;
    finishWhenReady();
  });
  stderrDrainTimer = setTimeout(() => {
    stderrEnded = true;
    if (!marker && groupAlive()) {
      setMarker("descendants");
      killGroup();
      finish(125);
      return;
    }
    finishWhenReady();
  }, stderrDrainMs);
  const remainingObservationMs = Math.max(0, observationMs - (Date.now() - probeStartedAt));
  observationTimer = setTimeout(() => {
    observationElapsed = true;
    if (!leaseEnded) {
      setMarker(groupAlive() ? "descendants" : "timeout");
      killGroup();
      finish(marker === "descendants" ? 125 : 124);
      return;
    }
    finishWhenReady();
  }, remainingObservationMs);
  finishWhenReady();
}

try {
  launcher = spawn(launcherShellPath, [wrapperPath, "--version"], {
    detached: true,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  if (!launcher.pid) throw new Error("Codex shim probe launcher has no pid");
  probeLease = launcher.stdio[3];
  if (!probeLease) throw new Error("Codex shim probe launcher has no descendant lease pipe");
  writeExclusive(groupPath, String(launcher.pid) + "\\n");
  launcher.stderr.on("data", appendStderr);
  reentryPollTimer = setInterval(checkReentry, 10);
  launcher.once("error", error => {
    appendStderr(String(error));
    finishAfterStderr(127);
  });
  launcher.once("exit", code => finishAfterStderr(Number.isInteger(code) ? code : 127));
  timer = setTimeout(() => {
    setMarker("timeout");
    killGroup();
    finish(124);
  }, timeoutMs);
} catch (error) {
  appendStderr(String(error));
  killGroup();
  finish(127);
}
`;
const MAX_DIAGNOSTIC_VALUE_BYTES = 8 * 1024;

type UnixShimProbeCleanupPhase = "marker" | "reentry" | "group" | "stderr" | "group-id" | "termination" | "spawn" | "exception";
interface UnixShimProbeCleanup {
  kind: "cleanup";
  phase: UnixShimProbeCleanupPhase;
  code: string;
  status: number | null;
  signal: string;
}
type UnixShimProbeResult = UnixShimProbeCleanup | "descendants" | "failed" | "recursive" | "timeout" | null;

const SHIM_PROBE_ERROR_CODES = new Set([
  "EACCES", "EAGAIN", "EBADF", "ECANCELED", "EINTR", "EIO", "EMFILE", "ENFILE",
  "ENOENT", "ENOEXEC", "ENOMEM", "ENOSPC", "EPERM", "EPIPE", "ESRCH", "ETIMEDOUT", "ETXTBSY",
]);
const SHIM_PROBE_SIGNALS = new Set([
  "SIGABRT", "SIGBUS", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT",
  "SIGSEGV", "SIGTERM", "SIGTRAP", "SIGXCPU", "SIGXFSZ",
]);

/** Diagnostics cross a CLI boundary: never stringify arbitrary errors or metadata. */
function shimProbeCleanup(
  phase: UnixShimProbeCleanupPhase, error?: unknown, status?: unknown, signal?: unknown,
): UnixShimProbeCleanup {
  let code = error === undefined ? "none" : "unknown";
  if (error !== null && typeof error === "object") {
    try {
      const value = Object.getOwnPropertyDescriptor(error, "code")?.value;
      if (typeof value === "string" && SHIM_PROBE_ERROR_CODES.has(value)) code = value;
    } catch { /* hostile accessors/proxies cannot turn diagnostics into an exception */ }
  }
  return {
    kind: "cleanup", phase, code,
    status: typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 255 ? status : null,
    signal: typeof signal === "string" && SHIM_PROBE_SIGNALS.has(signal) ? signal : "none",
  };
}

let codexShimProbeHookForTests: (() => void) | null = null;
let codexShimProbeShellForTests: string | null = null;

let codexShimProbeObservationMs = CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS;

/** Narrow deterministic seam for transaction rollback tests. */
export function setCodexShimProbeHookForTests(hook: (() => void) | null): void {
  codexShimProbeHookForTests = hook;
}

/** Selects a POSIX shell only for cross-shell probe regression tests. */
export function setCodexShimProbeShellForTests(path: string | null): void {
  codexShimProbeShellForTests = path;
}

/** Shortens the successful-launcher observation window only for focused tests. */
export function setCodexShimProbeObservationMsForTests(value: number | null): void {
  codexShimProbeObservationMs = value ?? CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS;
}

function readProbeMetadata(path: string, maxBytes: number): string | null {
  try {
    if (!existsSync(path)) return "";
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function probeUnixShimInstall(wrapperPath: string): UnixShimProbeResult {
  if (process.platform === "win32") return null;
  const probeDir = mkdtempSync(join(tmpdir(), "opencodex-shim-probe-"));
  const markerPath = join(probeDir, "result");
  const reentryPath = join(probeDir, "reentry");
  const groupPath = join(probeDir, "group");
  const stderrPath = join(probeDir, "stderr");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OCX_SHIM_BYPASS: "1",
    OCX_SHIM_PROBE: "1",
    OCX_SHIM_PROBE_REENTRY_PATH: reentryPath,
  };
  delete env.OCX_SHIM_ACTIVE_PID;
  delete env.OCX_SHIM_ACTIVE_DEPTH;
  delete env.OCX_SHIM_PROBE_ACTIVE;
  let groupId = 0;
  let probeStatus: unknown;
  let probeSignal: unknown;
  try {
    chmodSync(probeDir, 0o700);
    const result = spawnSync(process.execPath, [
      "-e",
      CODEX_SHIM_INSTALL_PROBE_SCRIPT,
      markerPath,
      reentryPath,
      groupPath,
      stderrPath,
      codexShimProbeShellForTests ?? "/bin/sh",
      wrapperPath,
      String(CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS),
      String(MAX_DIAGNOSTIC_VALUE_BYTES),
      String(CODEX_SHIM_INSTALL_PROBE_EXIT_TIMEOUT_MS),
      String(codexShimProbeObservationMs),
    ], {
      encoding: "utf8",
      env,
      timeout: CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS + CODEX_SHIM_INSTALL_PROBE_EXIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    probeStatus = result.status;
    probeSignal = result.signal;
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const marker = readProbeMetadata(markerPath, 64);
    const reentryMarker = readProbeMetadata(reentryPath, 64);
    const groupText = readProbeMetadata(groupPath, 64);
    const launcherStderr = readProbeMetadata(stderrPath, MAX_DIAGNOSTIC_VALUE_BYTES);
    groupId = groupText === null ? 0 : Number.parseInt(groupText, 10);
    if (marker === null) return shimProbeCleanup("marker", result.error, probeStatus, probeSignal);
    if (reentryMarker === null) return shimProbeCleanup("reentry", result.error, probeStatus, probeSignal);
    if (groupText === null) return shimProbeCleanup("group", result.error, probeStatus, probeSignal);
    if (launcherStderr === null) return shimProbeCleanup("stderr", result.error, probeStatus, probeSignal);
    if (!Number.isInteger(groupId) || groupId <= 0) return shimProbeCleanup("group-id", result.error, probeStatus, probeSignal);
    const groupSurvived = unixProcessGroupAlive(groupId);
    if (timedOut || marker || reentryMarker || groupSurvived) {
      try {
        terminateUnixProcessGroup(groupId);
      } catch (error) {
        return shimProbeCleanup("termination", error, probeStatus, probeSignal);
      }
    }
    if (result.error && !timedOut) return shimProbeCleanup("spawn", result.error, probeStatus, probeSignal);
    if (timedOut || marker === "timeout") return "timeout";
    if (marker === "recursive" || reentryMarker === "recursive") return "recursive";
    if (reentryMarker !== "") return shimProbeCleanup("reentry", undefined, probeStatus, probeSignal);
    if (marker === "descendants") return "descendants";
    if (groupSurvived) return "descendants";
    if (result.status === CODEX_SHIM_REENTRY_EXIT_CODE && launcherStderr.includes(CODEX_SHIM_REENTRY_DIAGNOSTIC)) {
      return "recursive";
    }
    if (result.status !== 0) return "failed";
    return null;
  } catch (error) {
    if (Number.isInteger(groupId) && groupId > 0) {
      try { terminateUnixProcessGroup(groupId); } catch { /* cleanup classification below */ }
    }
    return shimProbeCleanup("exception", error, probeStatus, probeSignal);
  } finally {
    try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

function probeUnixShimFiles(files: readonly ShimFileState[]): UnixShimProbeResult {
  if (process.platform === "win32") return null;
  codexShimProbeHookForTests?.();
  return files
    .filter(file => !file.preserveOnly)
    .map(file => probeUnixShimInstall(file.wrapperPath))
    .find(result => result !== null) ?? null;
}

function unixProcessGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function terminateUnixProcessGroup(groupId: number): void {
  let permissionError: unknown;
  try {
    process.kill(-groupId, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") permissionError = error;
    else if (code !== "ESRCH") throw error;
  }
  // A concurrently exiting group can briefly reject a second signal. Only
  // observed disappearance clears that uncertainty; never send another signal.
  const deadline = Date.now() + CODEX_SHIM_INSTALL_PROBE_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline && unixProcessGroupAlive(groupId)) Bun.sleepSync(10);
  if (unixProcessGroupAlive(groupId)) {
    if (permissionError) throw permissionError;
    throw new Error(`Codex shim install probe process group ${groupId} did not terminate`);
  }
}

export { CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS, MAX_DIAGNOSTIC_VALUE_BYTES };
export type { UnixShimProbeResult };
export { probeUnixShimFiles };
