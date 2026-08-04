import { create, fromBinary } from "@bufbuild/protobuf";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentClientMessageSchema,
  BackgroundShellSpawnArgsSchema,
  ExecServerMessageSchema,
  ShellArgsSchema,
  WriteShellStdinArgsSchema,
  type AgentClientMessage,
} from "../src/adapters/cursor/gen/agent_pb";
import {
  CURSOR_BACKGROUND_SHELL_ABSOLUTE_MS,
  CURSOR_BACKGROUND_SHELL_IDLE_MS,
  CURSOR_BACKGROUND_SHELL_MAX_LIVE,
  CURSOR_BACKGROUND_SHELL_TERM_GRACE_MS,
  backgroundShellAdmissionMetrics,
  backgroundShellLifecycleMetrics,
  backgroundShellSpawnExec,
  beginBackgroundShellShutdown,
  resetBackgroundShellStateForTests,
  setBackgroundShellRuntimeForTests,
  shellStreamExec,
  terminateAllBackgroundShells,
  terminateBackgroundShellsForSession,
  writeShellStdinExec,
} from "../src/adapters/cursor/native-exec-shell";

function decodeClient(bytes: Uint8Array): AgentClientMessage {
  return fromBinary(AgentClientMessageSchema, bytes);
}

function execMessage(message: Parameters<typeof create<typeof ExecServerMessageSchema>>[1]["message"]) {
  return create(ExecServerMessageSchema, { id: 1, execId: "background-test", message });
}

function decodedExec(bytes: Uint8Array) {
  const decoded = decodeClient(bytes);
  if (decoded.message.case !== "execClientMessage") throw new Error("missing exec reply");
  return decoded.message.value.message;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
}

class FakeClock {
  now = 0;
  private sequence = 0;
  private timers = new Map<object, { at: number; sequence: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const handle = { unref() {} };
    this.timers.set(handle, { at: this.now + delayMs, sequence: this.sequence++, callback });
    return handle as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimer = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(handle as unknown as object);
  };

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[1].sequence - b[1].sequence)[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.now = target;
    await Promise.resolve();
    await Promise.resolve();
  }
}

function spawnArgs(command = "background") {
  return execMessage({
    case: "backgroundShellSpawnArgs",
    value: create(BackgroundShellSpawnArgsSchema, { command, enableWriteShellStdinTool: true }),
  });
}

function installFakeShellRuntime(options: {
  spawnError?: Error;
  onKill?: (child: FakeChild, signal?: NodeJS.Signals) => boolean;
} = {}) {
  const clock = new FakeClock();
  const children: FakeChild[] = [];
  let spawnCalls = 0;
  const signals: Array<NodeJS.Signals | undefined> = [];
  setBackgroundShellRuntimeForTests({
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    spawn: ((..._args: unknown[]) => {
      spawnCalls++;
      if (options.spawnError) throw options.spawnError;
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    }) as typeof import("node:child_process").spawn,
    kill: (rawChild, signal) => {
      signals.push(signal);
      return options.onKill?.(rawChild as unknown as FakeChild, signal) ?? true;
    },
  });
  return { clock, children, signals, spawnCalls: () => spawnCalls };
}

function spawnSuccess(bytes: Uint8Array): number {
  const message = decodedExec(bytes);
  expect(message.case).toBe("backgroundShellSpawnResult");
  if (message.case !== "backgroundShellSpawnResult" || message.value.result.case !== "success") {
    throw new Error("expected background shell spawn success");
  }
  return message.value.result.value.shellId;
}

function spawnErrorText(bytes: Uint8Array): string {
  const message = decodedExec(bytes);
  expect(message.case).toBe("backgroundShellSpawnResult");
  if (message.case !== "backgroundShellSpawnResult" || message.value.result.case !== "error") {
    throw new Error("expected background shell spawn error");
  }
  return message.value.result.value.error;
}

afterEach(async () => {
  await resetBackgroundShellStateForTests();
});

describe("shellStreamExec completion acknowledgement", () => {
  test("appends structured shellResult and streamClose after the exit event", async () => {
    const execMsg = create(ExecServerMessageSchema, {
      id: 42,
      execId: "7",
      message: { case: "shellStreamArgs", value: create(ShellArgsSchema, { command: "echo OCX_STREAM_OK" }) },
    });

    const replies = (await shellStreamExec(execMsg)).map(decodeClient);
    const execMessages = replies.filter(r => r.message.case === "execClientMessage");
    const cases = execMessages.map(r => (r.message.case === "execClientMessage" ? r.message.value.message.case : undefined));

    // Stream events precede the structured result: start ... stdout ... exit, then shellResult.
    expect(cases[0]).toBe("shellStream");
    expect(cases.at(-1)).toBe("shellResult");

    const shellResult = execMessages.at(-1);
    if (shellResult?.message.case !== "execClientMessage") throw new Error("missing exec client message");
    expect(shellResult.message.value.id).toBe(42);
    expect(shellResult.message.value.execId).toBe("7");
    const resultMsg = shellResult.message.value.message;
    if (resultMsg.case !== "shellResult") throw new Error("missing shellResult");
    expect(resultMsg.value.result.case).toBe("success");
    if (resultMsg.value.result.case === "success") {
      expect(resultMsg.value.result.value.stdout).toContain("OCX_STREAM_OK");
      expect(resultMsg.value.result.value.exitCode).toBe(0);
    }

    // The very last frame closes the exec stream (Cursor treats deltas/exit alone as still-pending).
    const last = replies.at(-1);
    expect(last?.message.case).toBe("execClientControlMessage");
    if (last?.message.case === "execClientControlMessage") {
      expect(last.message.value.message.case).toBe("streamClose");
      if (last.message.value.message.case === "streamClose") {
        expect(last.message.value.message.value.id).toBe(42);
      }
    }
  });

  test("failure path still sends shellResult failure and streamClose", async () => {
    const execMsg = create(ExecServerMessageSchema, {
      id: 9,
      execId: "3",
      message: { case: "shellStreamArgs", value: create(ShellArgsSchema, { command: "exit 3" }) },
    });
    const replies = (await shellStreamExec(execMsg)).map(decodeClient);
    const shellResult = replies.filter(r => r.message.case === "execClientMessage").at(-1);
    if (shellResult?.message.case !== "execClientMessage" || shellResult.message.value.message.case !== "shellResult") {
      throw new Error("missing shellResult");
    }
    expect(shellResult.message.value.message.value.result.case).toBe("failure");
    expect(replies.at(-1)?.message.case).toBe("execClientControlMessage");
  });
});

describe("Cursor background shell lifecycle", () => {
  test("eight leases are admitted and the ninth returns BackgroundShellSpawnError before spawn", () => {
    const fake = installFakeShellRuntime();
    for (let i = 0; i < CURSOR_BACKGROUND_SHELL_MAX_LIVE; i++) {
      spawnSuccess(backgroundShellSpawnExec(spawnArgs(`shell-${i}`), "session-a"));
    }
    expect(spawnErrorText(backgroundShellSpawnExec(spawnArgs("ninth"), "session-a"))).toBe("background shell limit reached");
    expect(fake.spawnCalls()).toBe(CURSOR_BACKGROUND_SHELL_MAX_LIVE);
    expect(backgroundShellAdmissionMetrics()).toMatchObject({ active: 8, admitted: 8, rejected: 1 });
    for (const child of fake.children) child.emit("close", 0, null);
  });

  test("spawn throw releases the pre-spawn lease and serializes BackgroundShellSpawnError", () => {
    const fake = installFakeShellRuntime({ spawnError: new Error("spawn fixture failed") });
    expect(spawnErrorText(backgroundShellSpawnExec(spawnArgs(), "session-a"))).toContain("spawn fixture failed");
    expect(fake.spawnCalls()).toBe(1);
    expect(backgroundShellAdmissionMetrics().active).toBe(0);
  });

  test("close releases the exact child and lease only after output pipes drain", () => {
    const fake = installFakeShellRuntime();
    spawnSuccess(backgroundShellSpawnExec(spawnArgs(), "session-a"));
    fake.children[0]!.stdout.write("bytes");
    expect(backgroundShellAdmissionMetrics().active).toBe(1);
    fake.children[0]!.emit("close", 0, null);
    expect(backgroundShellAdmissionMetrics().active).toBe(0);
  });

  test("termination resumes both output pipes and late output never re-arms the idle timer", async () => {
    // Kill fails and close never arrives: the entry is quarantined. Late pipe
    // output must update accounting only — a re-armed idle timer would fire a
    // second kill attempt against a shell termination already owns.
    const fake = installFakeShellRuntime({ onKill() { return false; } });
    spawnSuccess(backgroundShellSpawnExec(spawnArgs(), "session-a"));
    const child = fake.children[0]!;
    let stdoutResumed = 0;
    let stderrResumed = 0;
    const originalStdoutResume = child.stdout.resume.bind(child.stdout);
    const originalStderrResume = child.stderr.resume.bind(child.stderr);
    child.stdout.resume = () => { stdoutResumed += 1; return originalStdoutResume(); };
    child.stderr.resume = () => { stderrResumed += 1; return originalStderrResume(); };

    await fake.clock.advance(CURSOR_BACKGROUND_SHELL_IDLE_MS); // idle fires -> termination begins
    expect(stdoutResumed).toBeGreaterThan(0);
    expect(stderrResumed).toBeGreaterThan(0);

    // Let the bounded kill-wait exhaust so the shell lands in quarantine.
    await fake.clock.advance(CURSOR_BACKGROUND_SHELL_TERM_GRACE_MS);
    const killsBefore = fake.signals.length;

    // Late output during/after termination: no new idle timer may be armed.
    child.stdout.write("late bytes");
    await fake.clock.advance(CURSOR_BACKGROUND_SHELL_IDLE_MS + 1);
    expect(fake.signals.length).toBe(killsBefore);
    expect(backgroundShellAdmissionMetrics().active).toBe(1); // quarantined, lease retained

    child.emit("close", 0, null); // eventual close still releases exactly once
    expect(backgroundShellAdmissionMetrics().active).toBe(0);
  });

  test("idle lifetime terminates after five minutes and stdin activity rearms idle", async () => {
    const fake = installFakeShellRuntime({ onKill(child) { queueMicrotask(() => child.emit("close", 0, null)); return true; } });
    const shellId = spawnSuccess(backgroundShellSpawnExec(spawnArgs(), "session-a"));
    await fake.clock.advance(CURSOR_BACKGROUND_SHELL_IDLE_MS - 1);
    expect(fake.signals).toEqual([]);
    const stdin = decodedExec(writeShellStdinExec(execMessage({
      case: "writeShellStdinArgs",
      value: create(WriteShellStdinArgsSchema, { shellId, chars: "hello" }),
    }), "session-a"));
    expect(stdin.case).toBe("writeShellStdinResult");
    await fake.clock.advance(CURSOR_BACKGROUND_SHELL_IDLE_MS - 1);
    expect(fake.signals).toEqual([]);
    await fake.clock.advance(1);
    expect(fake.signals).toEqual([undefined]);
    expect(backgroundShellLifecycleMetrics().idleTerminations).toBe(1);
  });

  test("absolute lifetime terminates after thirty minutes despite activity", async () => {
    const fake = installFakeShellRuntime({ onKill(child) { queueMicrotask(() => child.emit("close", 0, null)); return true; } });
    const shellId = spawnSuccess(backgroundShellSpawnExec(spawnArgs(), "session-a"));
    for (let elapsed = 0; elapsed < CURSOR_BACKGROUND_SHELL_ABSOLUTE_MS; elapsed += CURSOR_BACKGROUND_SHELL_IDLE_MS - 1) {
      const step = Math.min(CURSOR_BACKGROUND_SHELL_IDLE_MS - 1, CURSOR_BACKGROUND_SHELL_ABSOLUTE_MS - fake.clock.now);
      await fake.clock.advance(step);
      if (fake.clock.now < CURSOR_BACKGROUND_SHELL_ABSOLUTE_MS) {
        writeShellStdinExec(execMessage({
          case: "writeShellStdinArgs",
          value: create(WriteShellStdinArgsSchema, { shellId, chars: "." }),
        }), "session-a");
      }
    }
    expect(fake.signals).toEqual([undefined]);
    expect(backgroundShellLifecycleMetrics().absoluteTerminations).toBe(1);
  });

  test("controlled termination sends graceful kill before forced kill", async () => {
    const fake = installFakeShellRuntime({
      onKill(child, signal) {
        if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        return true;
      },
    });
    spawnSuccess(backgroundShellSpawnExec(spawnArgs(), "session-a"));
    const cleanup = terminateBackgroundShellsForSession("session-a");
    await fake.clock.advance(CURSOR_BACKGROUND_SHELL_TERM_GRACE_MS);
    expect(fake.signals).toEqual([undefined, "SIGKILL"]);
    await expect(cleanup).resolves.toMatchObject({ attempted: 1, closed: 1, unresolved: 0 });
  });

  test("kill failure without close retains registry ownership and admission lease", async () => {
    const fake = installFakeShellRuntime({ onKill: () => false });
    spawnSuccess(backgroundShellSpawnExec(spawnArgs(), "session-a"));
    const cleanup = terminateBackgroundShellsForSession("session-a");
    await fake.clock.advance(CURSOR_BACKGROUND_SHELL_TERM_GRACE_MS * 2);
    await expect(cleanup).resolves.toMatchObject({ unresolved: 1, killFailures: 2 });
    expect(backgroundShellAdmissionMetrics().active).toBe(1);
    fake.children[0]!.emit("close", 0, null);
  });

  test("bounded wait exhaustion without close retains ownership and increments scalar unresolvedKills", async () => {
    const fake = installFakeShellRuntime();
    spawnSuccess(backgroundShellSpawnExec(spawnArgs(), "session-a"));
    const cleanup = terminateBackgroundShellsForSession("session-a");
    await fake.clock.advance(CURSOR_BACKGROUND_SHELL_TERM_GRACE_MS * 2);
    await expect(cleanup).resolves.toMatchObject({ unresolved: 1, killFailures: 0 });
    expect(backgroundShellLifecycleMetrics().unresolvedKills).toBe(1);
    expect(backgroundShellAdmissionMetrics().active).toBe(1);
    fake.children[0]!.emit("close", 0, null);
  });

  test("later confirmed close releases the lease after an unresolved termination", async () => {
    const fake = installFakeShellRuntime();
    spawnSuccess(backgroundShellSpawnExec(spawnArgs(), "session-a"));
    const cleanup = terminateBackgroundShellsForSession("session-a");
    await fake.clock.advance(CURSOR_BACKGROUND_SHELL_TERM_GRACE_MS * 2);
    await cleanup;
    expect(backgroundShellAdmissionMetrics().active).toBe(1);
    fake.children[0]!.emit("close", 0, null);
    expect(backgroundShellAdmissionMetrics().active).toBe(0);
  });

  test("session cleanup terminates only shells owned by that session", async () => {
    const fake = installFakeShellRuntime({ onKill(child) { queueMicrotask(() => child.emit("close", 0, null)); return true; } });
    spawnSuccess(backgroundShellSpawnExec(spawnArgs("a"), "session-a"));
    spawnSuccess(backgroundShellSpawnExec(spawnArgs("b"), "session-b"));
    await expect(terminateBackgroundShellsForSession("session-a")).resolves.toMatchObject({ attempted: 1, closed: 1 });
    expect(backgroundShellAdmissionMetrics().active).toBe(1);
    expect(fake.signals).toEqual([undefined]);
    fake.children[1]!.emit("close", 0, null);
  });

  test("global shutdown drain awaits all confirmed shell closes", async () => {
    const fake = installFakeShellRuntime();
    spawnSuccess(backgroundShellSpawnExec(spawnArgs("a"), "session-a"));
    spawnSuccess(backgroundShellSpawnExec(spawnArgs("b"), "session-b"));
    let settled = false;
    const cleanup = terminateAllBackgroundShells().then(report => { settled = true; return report; });
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.children[0]!.emit("close", 0, null);
    expect(settled).toBe(false);
    fake.children[1]!.emit("close", 0, null);
    await expect(cleanup).resolves.toMatchObject({ attempted: 2, closed: 2 });
  });

  test("shutdown fence rejects a queued post-fence spawn with the protobuf typed error before gate acquisition", () => {
    const fake = installFakeShellRuntime();
    beginBackgroundShellShutdown();
    expect(spawnErrorText(backgroundShellSpawnExec(spawnArgs(), "session-a"))).toBe("background shell shutdown in progress");
    expect(fake.spawnCalls()).toBe(0);
    expect(backgroundShellAdmissionMetrics()).toMatchObject({ active: 0, admitted: 0, rejected: 0 });
  });

  test("cross-session stdin write is rejected without revealing owner identity", () => {
    const fake = installFakeShellRuntime();
    const shellId = spawnSuccess(backgroundShellSpawnExec(spawnArgs(), "owner-secret"));
    const result = decodedExec(writeShellStdinExec(execMessage({
      case: "writeShellStdinArgs",
      value: create(WriteShellStdinArgsSchema, { shellId, chars: "steal" }),
    }), "other-session"));
    expect(result.case).toBe("writeShellStdinResult");
    if (result.case === "writeShellStdinResult" && result.value.result.case === "error") {
      expect(result.value.result.value.error).toBe("shell belongs to another session");
      expect(result.value.result.value.error).not.toContain("owner-secret");
    }
    fake.children[0]!.emit("close", 0, null);
  });

  test("error event alone never deletes or releases; close/error races affect only the exact map owner", () => {
    const fake = installFakeShellRuntime();
    spawnSuccess(backgroundShellSpawnExec(spawnArgs(), "session-a"));
    fake.children[0]!.emit("error", new Error("fixture error"));
    expect(backgroundShellAdmissionMetrics().active).toBe(1);
    fake.children[0]!.emit("close", 1, null);
    fake.children[0]!.emit("error", new Error("late fixture error"));
    fake.children[0]!.emit("close", 1, null);
    expect(backgroundShellAdmissionMetrics().active).toBe(0);
  });

  test("metrics contain scalar counts only and reset deterministically", async () => {
    const fake = installFakeShellRuntime();
    spawnSuccess(backgroundShellSpawnExec(spawnArgs(), "session-a"));
    fake.children[0]!.emit("close", 0, null);
    const metrics = { admission: backgroundShellAdmissionMetrics(), lifecycle: backgroundShellLifecycleMetrics() };
    expect(Object.values(metrics.admission).every(value => typeof value === "number")).toBe(true);
    expect(Object.values(metrics.lifecycle).every(value => typeof value === "number")).toBe(true);
    expect(JSON.stringify(metrics)).not.toContain("session-a");
    await resetBackgroundShellStateForTests();
    expect(backgroundShellAdmissionMetrics()).toEqual({ active: 0, peak: 0, admitted: 0, rejected: 0, releaseMisses: 0 });
    expect(backgroundShellLifecycleMetrics()).toEqual({ idleTerminations: 0, absoluteTerminations: 0, unresolvedKills: 0, killFailures: 0 });
  });
});
