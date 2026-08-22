import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  BackgroundShellSpawnErrorSchema,
  BackgroundShellSpawnResultSchema,
  BackgroundShellSpawnSuccessSchema,
  ShellFailureSchema,
  ShellResultSchema,
  ShellStreamExitSchema,
  ShellStreamSchema,
  ShellStreamStartSchema,
  ShellStreamStderrSchema,
  ShellStreamStdoutSchema,
  ShellSuccessSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  WriteShellStdinSuccessSchema,
  type ExecServerMessage,
} from "./gen/agent_pb";
import { errorText, execBytes, execStreamCloseBytes } from "./native-exec-common";
import {
  createAdmissionGate,
  type AdmissionLease,
  type AdmissionMetrics,
} from "../../lib/admission";

export const CURSOR_BACKGROUND_SHELL_MAX_LIVE = 8;
export const CURSOR_BACKGROUND_SHELL_IDLE_MS = 5 * 60_000;
export const CURSOR_BACKGROUND_SHELL_ABSOLUTE_MS = 30 * 60_000;
export const CURSOR_BACKGROUND_SHELL_TERM_GRACE_MS = 2_000;

type BackgroundShellTerminationReason = "session_close" | "idle" | "absolute" | "shutdown";
type BackgroundShellTimer = ReturnType<typeof setTimeout>;

export interface BackgroundShellTerminationReport {
  attempted: number;
  closed: number;
  unresolved: number;
  killFailures: number;
}

export interface BackgroundShellRuntime {
  spawn: typeof spawn;
  now(): number;
  setTimer(callback: () => void, delayMs: number): BackgroundShellTimer;
  clearTimer(timer: BackgroundShellTimer): void;
  kill(child: ChildProcessWithoutNullStreams, signal?: NodeJS.Signals): boolean;
}

interface BackgroundShellEntry {
  shellId: number;
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  admissionLease: AdmissionLease;
  outputLength: number;
  startedAt: number;
  lastActivityAt: number;
  idleTimer?: BackgroundShellTimer;
  absoluteTimer?: BackgroundShellTimer;
  terminating: Promise<BackgroundShellTerminationReport> | null;
  closePromise: Promise<void>;
  confirmClose(): void;
}

const defaultBackgroundShellRuntime: BackgroundShellRuntime = {
  spawn,
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: timer => clearTimeout(timer),
  kill: (child, signal) => child.kill(signal),
};

let backgroundShellRuntime = defaultBackgroundShellRuntime;
let backgroundShellGate = createAdmissionGate("cursor_background_shells", CURSOR_BACKGROUND_SHELL_MAX_LIVE);
const backgroundShells = new Map<number, BackgroundShellEntry>();
let nextShellId = 1;
let backgroundShellShutdownStarted = false;
let idleTerminations = 0;
let absoluteTerminations = 0;
let unresolvedKills = 0;
let killFailures = 0;

/** Rejection text when Cursor-native shell is denied by policy (issue #604). */
export function nativeShellDisabledMessage(): string {
  // Do not insist on "the same command" — that steers models into replaying bash/CMD
  // idioms through the Codex bridge on Windows PowerShell 5.1 and looping (#604).
  // Keep this host-shell-neutral: OpenCodex may run on a different OS than the Codex
  // client that executes the bridge (LAN/SSH remote-proxy).
  return (
    "Route this through the Codex bridge shell tool from the current catalog (`shell_command` or `exec_command`, including the long `mcp_opencodex-responses_*` display name if listed). "
    + "Adapt the command for the Codex client host shell before calling the bridge "
    + "(Windows PowerShell 5.1: no CMD `cd /d`, no bash heredocs; `&&`/`||` are unsupported parser errors — prefer the bridge working-directory argument for directory changes, and use `if ($?) { ... }` for success-gated follow-up steps; do not treat `;` as a substitute for `&&`). "
    + "Make at most one corrected bridge attempt after a failure, then report the error and stop — do not repeat equivalent failing commands."
  );
}

function rejectedShellResult(command: string, cwd: string, started: number) {
  return create(ShellResultSchema, {
    result: {
      case: "failure",
      value: create(ShellFailureSchema, {
        command,
        workingDirectory: cwd,
        exitCode: 1,
        signal: "",
        stdout: "",
        stderr: nativeShellDisabledMessage(),
        executionTime: Date.now() - started,
        aborted: true,
      }),
    },
  });
}

export function rejectShellExecForPolicy(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "shellArgs") throw new Error("invalid shell exec");
  const args = execMsg.message.value;
  return execBytes(execMsg, "shellResult", rejectedShellResult(args.command, resolve(args.workingDirectory || process.cwd()), Date.now()));
}

export function shellExec(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "shellArgs") throw new Error("invalid shell exec");
  const args = execMsg.message.value;
  const cwd = resolve(args.workingDirectory || process.cwd());
  const started = Date.now();
  const result = spawnSync(args.command, { cwd, shell: true, encoding: "utf8", timeout: args.hardTimeout || 120_000 });
  const elapsed = Date.now() - started;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const code = typeof result.status === "number" ? result.status : 1;
  if (code === 0) {
    return execBytes(execMsg, "shellResult", create(ShellResultSchema, {
      result: {
        case: "success",
        value: create(ShellSuccessSchema, { command: args.command, workingDirectory: cwd, exitCode: code, signal: "", stdout, stderr, executionTime: elapsed }),
      },
    }));
  }
  return execBytes(execMsg, "shellResult", create(ShellResultSchema, {
    result: {
      case: "failure",
      value: create(ShellFailureSchema, {
        command: args.command,
        workingDirectory: cwd,
        exitCode: code,
        signal: String(result.signal ?? ""),
        stdout,
        stderr,
        executionTime: elapsed,
        aborted: !!result.error,
      }),
    },
  }));
}

export function rejectShellStreamExecForPolicy(execMsg: ExecServerMessage): Uint8Array[] {
  if (execMsg.message.case !== "shellStreamArgs") throw new Error("invalid shell stream exec");
  const args = execMsg.message.value;
  const cwd = resolve(args.workingDirectory || process.cwd());
  const started = Date.now();
  return [
    execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "start", value: create(ShellStreamStartSchema, { sandboxPolicy: args.requestedSandboxPolicy }) },
    })),
    execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "stderr", value: create(ShellStreamStderrSchema, { data: nativeShellDisabledMessage() }) },
    })),
    execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "exit", value: create(ShellStreamExitSchema, { code: 1, cwd, aborted: true }) },
    })),
    execBytes(execMsg, "shellResult", rejectedShellResult(args.command, cwd, started)),
    execStreamCloseBytes(execMsg),
  ];
}

export async function shellStreamExec(execMsg: ExecServerMessage): Promise<Uint8Array[]> {
  if (execMsg.message.case !== "shellStreamArgs") throw new Error("invalid shell stream exec");
  const args = execMsg.message.value;
  const cwd = resolve(args.workingDirectory || process.cwd());
  const started = Date.now();
  const replies = [
    execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "start", value: create(ShellStreamStartSchema, { sandboxPolicy: args.requestedSandboxPolicy }) },
    })),
  ];
  const result = await new Promise<{ stdout: string; stderr: string; code: number; aborted: boolean }>(resolvePromise => {
    const child = spawn(args.command, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    const timeout = setTimeout(() => {
      aborted = true;
      child.kill();
    }, args.hardTimeout || 120_000);
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    child.on("close", code => {
      clearTimeout(timeout);
      resolvePromise({ stdout, stderr, code: code ?? 1, aborted });
    });
    child.on("error", err => {
      clearTimeout(timeout);
      resolvePromise({ stdout, stderr: stderr + errorText(err), code: 1, aborted });
    });
  });
  if (result.stdout) {
    replies.push(execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "stdout", value: create(ShellStreamStdoutSchema, { data: result.stdout }) },
    })));
  }
  if (result.stderr) {
    replies.push(execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "stderr", value: create(ShellStreamStderrSchema, { data: result.stderr }) },
    })));
  }
  replies.push(execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
    event: { case: "exit", value: create(ShellStreamExitSchema, { code: result.code, cwd, aborted: result.aborted }) },
  })));
  // Cursor keeps the turn pending when it receives only stream deltas/exit: it requires the final
  // structured shellResult as completion acknowledgement, followed by an exec stream close. Without
  // these two frames the server-side agent waits forever (heartbeat-only stall → watchdog
  // upstream_stall_timeout → upstream 502). Mirrors jawcode handleShellStreamArgs.
  const shellResult = result.code === 0 && !result.aborted
    ? create(ShellResultSchema, {
        result: {
          case: "success",
          value: create(ShellSuccessSchema, {
            command: args.command,
            workingDirectory: cwd,
            exitCode: result.code,
            signal: "",
            stdout: result.stdout,
            stderr: result.stderr,
            executionTime: Date.now() - started,
          }),
        },
      })
    : create(ShellResultSchema, {
        result: {
          case: "failure",
          value: create(ShellFailureSchema, {
            command: args.command,
            workingDirectory: cwd,
            exitCode: result.code,
            signal: "",
            stdout: result.stdout,
            stderr: result.stderr,
            executionTime: Date.now() - started,
            aborted: result.aborted,
          }),
        },
      });
  replies.push(execBytes(execMsg, "shellResult", shellResult));
  replies.push(execStreamCloseBytes(execMsg));
  return replies;
}

export function rejectBackgroundShellSpawnExecForPolicy(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "backgroundShellSpawnArgs") throw new Error("invalid background shell exec");
  const args = execMsg.message.value;
  const cwd = resolve(args.workingDirectory || process.cwd());
  return execBytes(execMsg, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, {
    result: { case: "error", value: create(BackgroundShellSpawnErrorSchema, { command: args.command, workingDirectory: cwd, error: nativeShellDisabledMessage() }) },
  }));
}

function backgroundShellSpawnError(
  execMsg: ExecServerMessage,
  command: string,
  workingDirectory: string,
  error: string,
): Uint8Array {
  return execBytes(execMsg, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, {
    result: {
      case: "error",
      value: create(BackgroundShellSpawnErrorSchema, { command, workingDirectory, error }),
    },
  }));
}

function clearBackgroundShellTimers(entry: BackgroundShellEntry): void {
  if (entry.idleTimer) backgroundShellRuntime.clearTimer(entry.idleTimer);
  if (entry.absoluteTimer) backgroundShellRuntime.clearTimer(entry.absoluteTimer);
  entry.idleTimer = undefined;
  entry.absoluteTimer = undefined;
}

function confirmBackgroundShellClose(entry: BackgroundShellEntry): void {
  if (backgroundShells.get(entry.shellId) !== entry) return;
  clearBackgroundShellTimers(entry);
  backgroundShells.delete(entry.shellId);
  entry.admissionLease.release();
  entry.confirmClose();
}

function unrefTimer(timer: BackgroundShellTimer): void {
  timer.unref?.();
}

function armBackgroundShellIdleTimer(entry: BackgroundShellEntry): void {
  if (entry.idleTimer) backgroundShellRuntime.clearTimer(entry.idleTimer);
  entry.idleTimer = backgroundShellRuntime.setTimer(() => {
    entry.idleTimer = undefined;
    void terminateBackgroundShell(entry, "idle");
  }, CURSOR_BACKGROUND_SHELL_IDLE_MS);
  unrefTimer(entry.idleTimer);
}

function armBackgroundShellAbsoluteTimer(entry: BackgroundShellEntry): void {
  entry.absoluteTimer = backgroundShellRuntime.setTimer(() => {
    entry.absoluteTimer = undefined;
    void terminateBackgroundShell(entry, "absolute");
  }, CURSOR_BACKGROUND_SHELL_ABSOLUTE_MS);
  unrefTimer(entry.absoluteTimer);
}

function noteBackgroundShellActivity(entry: BackgroundShellEntry, bytes = 0): void {
  if (backgroundShells.get(entry.shellId) !== entry) return;
  entry.outputLength += bytes;
  entry.lastActivityAt = backgroundShellRuntime.now();
  // Once termination has begun the lifecycle timers are cleared for good:
  // late pipe output must update byte accounting only, never re-arm idle,
  // or a quarantined shell gets a fresh five-minute timer that can fire a
  // second kill attempt and distort the lifecycle counters.
  if (!entry.terminating) armBackgroundShellIdleTimer(entry);
}

function waitForBackgroundShellClose(entry: BackgroundShellEntry): Promise<boolean> {
  if (backgroundShells.get(entry.shellId) !== entry) return Promise.resolve(true);
  return new Promise(resolveWait => {
    let settled = false;
    // Deliberately REF'D: this is the bounded kill-grace wait that shutdown
    // drain awaits. Bun on Windows / under `bun test --isolate` can starve
    // unref'd timers when a pending promise is the only other work, which
    // would leave drainAndShutdown waiting forever (same class as oauth
    // serializeMutation wait timers). The timer self-clears within the
    // 2-second grace window (or earlier on close), so a ref cannot keep the
    // process alive beyond that bound.
    const timer = backgroundShellRuntime.setTimer(() => {
      if (settled) return;
      settled = true;
      resolveWait(false);
    }, CURSOR_BACKGROUND_SHELL_TERM_GRACE_MS);
    void entry.closePromise.then(() => {
      if (settled) return;
      settled = true;
      backgroundShellRuntime.clearTimer(timer);
      resolveWait(true);
    });
  });
}

function tryKillBackgroundShell(entry: BackgroundShellEntry, signal?: NodeJS.Signals): boolean {
  try {
    return backgroundShellRuntime.kill(entry.child, signal);
  } catch {
    return false;
  }
}

async function terminateBackgroundShell(
  entry: BackgroundShellEntry,
  reason: BackgroundShellTerminationReason,
): Promise<BackgroundShellTerminationReport> {
  if (entry.terminating) return entry.terminating;
  if (backgroundShells.get(entry.shellId) !== entry) {
    return { attempted: 0, closed: 0, unresolved: 0, killFailures: 0 };
  }
  if (reason === "idle") idleTerminations += 1;
  if (reason === "absolute") absoluteTerminations += 1;
  entry.terminating = (async () => {
    clearBackgroundShellTimers(entry);
    try { entry.child.stdin.end(); } catch { /* best-effort direct-child shutdown */ }
    try { entry.child.stdout.resume(); } catch { /* keep draining when supported */ }
    try { entry.child.stderr.resume(); } catch { /* keep draining when supported */ }

    let attemptKillFailures = 0;
    if (!tryKillBackgroundShell(entry)) attemptKillFailures += 1;
    let closed = await waitForBackgroundShellClose(entry);
    if (!closed && backgroundShells.get(entry.shellId) !== entry) closed = true;
    if (!closed) {
      if (!tryKillBackgroundShell(entry, "SIGKILL")) attemptKillFailures += 1;
      closed = await waitForBackgroundShellClose(entry);
      if (!closed && backgroundShells.get(entry.shellId) !== entry) closed = true;
    }
    killFailures += attemptKillFailures;
    if (!closed) unresolvedKills += 1;
    return {
      attempted: 1,
      closed: closed ? 1 : 0,
      unresolved: closed ? 0 : 1,
      killFailures: attemptKillFailures,
    };
  })();
  try {
    return await entry.terminating;
  } finally {
    if (backgroundShells.get(entry.shellId) === entry) entry.terminating = null;
  }
}

function sumTerminationReports(reports: readonly BackgroundShellTerminationReport[]): BackgroundShellTerminationReport {
  return reports.reduce((total, report) => ({
    attempted: total.attempted + report.attempted,
    closed: total.closed + report.closed,
    unresolved: total.unresolved + report.unresolved,
    killFailures: total.killFailures + report.killFailures,
  }), { attempted: 0, closed: 0, unresolved: 0, killFailures: 0 });
}

export function beginBackgroundShellShutdown(): void {
  backgroundShellShutdownStarted = true;
}

export function backgroundShellAdmissionMetrics(): Readonly<AdmissionMetrics> {
  return backgroundShellGate.metrics();
}

export function backgroundShellLifecycleMetrics(): {
  idleTerminations: number;
  absoluteTerminations: number;
  unresolvedKills: number;
  killFailures: number;
} {
  return { idleTerminations, absoluteTerminations, unresolvedKills, killFailures };
}

export async function terminateBackgroundShellsForSession(
  sessionId: string,
): Promise<BackgroundShellTerminationReport> {
  const owned = [...backgroundShells.values()].filter(entry => entry.sessionId === sessionId);
  return sumTerminationReports(await Promise.all(owned.map(entry => terminateBackgroundShell(entry, "session_close"))));
}

export async function terminateAllBackgroundShells(): Promise<BackgroundShellTerminationReport> {
  const entries = [...backgroundShells.values()];
  return sumTerminationReports(await Promise.all(entries.map(entry => terminateBackgroundShell(entry, "shutdown"))));
}

export function setBackgroundShellRuntimeForTests(runtime: Partial<BackgroundShellRuntime>): void {
  backgroundShellRuntime = { ...defaultBackgroundShellRuntime, ...runtime };
}

export async function resetBackgroundShellStateForTests(): Promise<void> {
  const report = await terminateAllBackgroundShells();
  if (report.unresolved !== 0 || backgroundShells.size !== 0 || backgroundShellGate.metrics().active !== 0) {
    throw new Error("cannot reset background shell state before every direct child confirms close");
  }
  backgroundShellRuntime = defaultBackgroundShellRuntime;
  backgroundShellGate = createAdmissionGate("cursor_background_shells", CURSOR_BACKGROUND_SHELL_MAX_LIVE);
  nextShellId = 1;
  backgroundShellShutdownStarted = false;
  idleTerminations = 0;
  absoluteTerminations = 0;
  unresolvedKills = 0;
  killFailures = 0;
}

export function backgroundShellSpawnExec(execMsg: ExecServerMessage, sessionId: string): Uint8Array {
  if (execMsg.message.case !== "backgroundShellSpawnArgs") throw new Error("invalid background shell exec");
  const args = execMsg.message.value;
  const cwd = resolve(args.workingDirectory || process.cwd());
  if (!sessionId) return backgroundShellSpawnError(execMsg, args.command, cwd, "background shell session owner required");
  if (backgroundShellShutdownStarted) return backgroundShellSpawnError(execMsg, args.command, cwd, "background shell shutdown in progress");
  const admissionLease = backgroundShellGate.tryAcquire();
  if (!admissionLease) return backgroundShellSpawnError(execMsg, args.command, cwd, "background shell limit reached");
  let child: ChildProcessWithoutNullStreams;
  try {
    child = backgroundShellRuntime.spawn(args.command, { cwd, shell: true });
  } catch (err) {
    admissionLease.release();
    return backgroundShellSpawnError(execMsg, args.command, cwd, errorText(err));
  }

  const shellId = nextShellId++;
  let confirmClose!: () => void;
  const closePromise = new Promise<void>(resolveClose => { confirmClose = resolveClose; });
  const now = backgroundShellRuntime.now();
  const entry: BackgroundShellEntry = {
    shellId,
    sessionId,
    child,
    admissionLease,
    outputLength: 0,
    startedAt: now,
    lastActivityAt: now,
    terminating: null,
    closePromise,
    confirmClose,
  };
  try {
    child.on("close", () => confirmBackgroundShellClose(entry));
    child.on("error", () => { /* error alone never confirms direct-child termination */ });
    backgroundShells.set(shellId, entry);
    child.stdout.on("data", chunk => {
      noteBackgroundShellActivity(entry, Buffer.byteLength(String(chunk)));
    });
    child.stderr.on("data", chunk => {
      noteBackgroundShellActivity(entry, Buffer.byteLength(String(chunk)));
    });
    armBackgroundShellIdleTimer(entry);
    armBackgroundShellAbsoluteTimer(entry);
    return execBytes(execMsg, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, {
      result: {
        case: "success",
        value: create(BackgroundShellSpawnSuccessSchema, { shellId, command: args.command, workingDirectory: cwd, pid: child.pid }),
      },
    }));
  } catch (err) {
    void terminateBackgroundShell(entry, "session_close");
    return backgroundShellSpawnError(execMsg, args.command, cwd, errorText(err));
  }
}

export function rejectWriteShellStdinExecForPolicy(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "writeShellStdinArgs") throw new Error("invalid shell stdin exec");
  return execBytes(execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, {
    result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: nativeShellDisabledMessage() }) },
  }));
}

export function writeShellStdinExec(execMsg: ExecServerMessage, sessionId: string): Uint8Array {
  if (execMsg.message.case !== "writeShellStdinArgs") throw new Error("invalid shell stdin exec");
  const args = execMsg.message.value;
  const shell = backgroundShells.get(args.shellId);
  if (!shell) {
    return execBytes(execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, {
      result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: `Unknown shell id ${args.shellId}` }) },
    }));
  }
  if (shell.sessionId !== sessionId) {
    return execBytes(execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, {
      result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: "shell belongs to another session" }) },
    }));
  }
  const before = shell.outputLength;
  shell.child.stdin.write(args.chars);
  noteBackgroundShellActivity(shell);
  return execBytes(execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, {
    result: { case: "success", value: create(WriteShellStdinSuccessSchema, { shellId: args.shellId, terminalFileLengthBeforeInputWritten: before }) },
  }));
}
