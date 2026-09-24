import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createBoundedRuntimeDiagnosticSender,
  createCompletedSlowOperationRingForTests,
  disconnectAfterRuntimeDiagnosticsStop,
  startRuntimeDiagnostics,
} from "../../src/lib/runtime-diagnostics";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { resolvedImportEdges } from "../helpers/import-graph";

test("independent recorder observes a blocked parent and stops with its owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-runtime-diagnostics-"));
  const path = join(dir, "runtime.jsonl");
  const recorder = startRuntimeDiagnostics(path, () => ({ activeTurns: 12 }), {
    intervalMs: 20, stallMs: 100, logEveryMs: 1000,
  });
  try {
    await Promise.race([recorder.ready, Bun.sleep(3000).then(() => { throw new Error("recorder did not start"); })]);
    await Bun.sleep(100);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    await Bun.sleep(100);
  } finally {
    recorder.stop();
    await recorder.closed;
  }
  try {
    const content = readFileSync(path, "utf8");
    const records = content.trim().split("\n").map(line => JSON.parse(line));
    expect(records.some(r => r.kind === "event-loop-stall" && r.heartbeatGapMs >= 100)).toBe(true);
    expect(records.some(r => r.kind === "event-loop-recovered")).toBe(true);
    const delay = records.find(r => r.kind === "event-loop-delay");
    expect(delay.timerDelayMs).toBeGreaterThanOrEqual(300);
    expect(delay.cpuUserDeltaMs).toBeGreaterThanOrEqual(0);
    expect(delay.cpuSystemDeltaMs).toBeGreaterThanOrEqual(0);
    expect(records.at(-1).kind).toBe("parent-disconnected");
    expect(content).not.toContain(dir);
  } finally { removeTreeWithRetry(dir); }
});

test("late IPC without a delayed parent timer is not confirmed as a parent stall", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-runtime-diagnostics-ipc-"));
  const path = join(dir, "runtime.jsonl");
  const child = fork(fileURLToPath(new URL("../../src/lib/runtime-diagnostics-child.ts", import.meta.url)), [], {
    execPath: process.execPath, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const ready = new Promise<void>(resolve => child.once("message", () => resolve()));
  try {
    child.send({ kind: "init", path, pid: process.pid, intervalMs: 20, stallMs: 100, logEveryMs: 1000 });
    await Promise.race([ready, Bun.sleep(3000).then(() => { throw new Error("recorder did not start"); })]);
    await Bun.sleep(250);
    child.send({ kind: "heartbeat", at: Date.now(), intervalMs: 20, timerDelayMs: 0,
      cpuUserDeltaMs: 1, cpuSystemDeltaMs: 0, counters: { activeTurns: 0 } });
    await Bun.sleep(50);
  } finally {
    if (child.connected) child.disconnect();
    await closed;
  }
  try {
    const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records.some(r => r.kind === "event-loop-stall" && r.observation === "heartbeat-missing")).toBe(true);
    expect(records.some(r => r.kind === "event-loop-delay")).toBe(false);
    expect(records.some(r => r.kind === "event-loop-recovered" && r.parentDelayConfirmed === false)).toBe(true);
    expect(records.at(-1)).toEqual(expect.objectContaining({ kind: "parent-disconnected", expected: false }));
  } finally { removeTreeWithRetry(dir); }
});

test("bounded sender drops congested diagnostics and reports a sync observability gap", () => {
  const messages: object[] = [];
  const callbacks: Array<(error: Error | null) => void> = [];
  const sender = createBoundedRuntimeDiagnosticSender({
    connected: true,
    send(message, callback) {
      messages.push(message);
      callbacks.push(callback);
      return true;
    },
  });

  for (let index = 0; index < 4; index += 1) expect(sender({ kind: "heartbeat", index })).toBe(true);
  expect(sender({ kind: "sync-start", id: 7 })).toBe(false);
  expect(messages).toHaveLength(4);
  for (const callback of callbacks.splice(0)) callback(null);

  expect(sender({ kind: "heartbeat" })).toBe(true);
  expect(messages).toHaveLength(6);
  expect(messages[4]).toEqual(expect.objectContaining({
    kind: "observability-gap",
    droppedMessages: 1,
    syncOperationsDropped: true,
  }));
});

test("bounded sender reports a failed sync callback as an observability gap", () => {
  const messages: object[] = [];
  let callback: ((error: Error | null) => void) | undefined;
  const sender = createBoundedRuntimeDiagnosticSender({
    connected: true,
    send(message, done) {
      messages.push(message);
      callback = done;
      return true;
    },
  });

  expect(sender({ kind: "sync-end", id: 7 })).toBe(true);
  callback?.(new Error("recorder disconnected"));
  expect(sender({ kind: "heartbeat" })).toBe(true);
  expect(messages[1]).toEqual(expect.objectContaining({
    kind: "observability-gap",
    droppedMessages: 1,
    syncOperationsDropped: true,
  }));
});

test("completed slow-operation evidence stays bounded until a callback acknowledges its heartbeat", () => {
  const ring = createCompletedSlowOperationRingForTests();
  for (let sequence = 1; sequence <= 10; sequence += 1) {
    ring.enqueue({ sequence, id: sequence, elapsedMs: 300, sites: ["src/lib/example.ts:1:1"] });
  }
  const beforeAck = ring.snapshot();
  expect(beforeAck.map(operation => operation.sequence)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  expect(ring.overflow).toBe(2);

  let callback: ((error: Error | null) => void) | undefined;
  let acknowledged = 0;
  const sender = createBoundedRuntimeDiagnosticSender({
    connected: true,
    send(_message, done) {
      callback = done;
      return false;
    },
  });
  expect(sender({ kind: "heartbeat" }, () => {
    ring.acknowledge(beforeAck);
    acknowledged += 1;
  })).toBe(true);
  ring.enqueue({ sequence: 11, id: 11, elapsedMs: 300, sites: ["src/lib/new.ts:1:1"] });
  callback?.(new Error("recorder callback failure"));
  expect(acknowledged).toBe(0);
  expect(ring.snapshot().map(operation => operation.sequence)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);

  ring.acknowledge(beforeAck);
  expect(ring.snapshot().map(operation => operation.sequence)).toEqual([11]);

  const delivered = ring.snapshot();
  let successfulCallback: ((error: Error | null) => void) | undefined;
  const queued = createBoundedRuntimeDiagnosticSender({
    connected: true,
    send(_message, done) {
      successfulCallback = done;
      return false;
    },
  });
  expect(queued({ kind: "heartbeat" }, () => ring.acknowledge(delivered))).toBe(true);
  successfulCallback?.(null);
  expect(ring.snapshot()).toEqual([]);
});

test("a throwing or suppressed diagnostic send never invokes a delivery acknowledgement", () => {
  let acknowledgements = 0;
  const throwing = createBoundedRuntimeDiagnosticSender({
    connected: true,
    send() { throw new Error("IPC unavailable"); },
  });
  expect(throwing({ kind: "heartbeat" }, () => { acknowledgements += 1; })).toBe(false);

  const suppressed = createBoundedRuntimeDiagnosticSender({
    connected: false,
    send() { throw new Error("unreachable"); },
  });
  expect(suppressed({ kind: "heartbeat" }, () => { acknowledgements += 1; })).toBe(false);
  expect(acknowledgements).toBe(0);
});

test("stop keeps a backpressured parent-stopping marker queued until its callback", async () => {
  let callback: ((error: Error | null) => void) | undefined;
  let disconnects = 0;
  const target = {
    connected: true,
    send(message: object, done: (error: Error | null) => void) {
      expect(message).toEqual(expect.objectContaining({ kind: "parent-stopping" }));
      callback = done;
      return false;
    },
    disconnect() { disconnects += 1; },
  };

  disconnectAfterRuntimeDiagnosticsStop(target, Date.now(), 100);
  await Bun.sleep(20);
  expect(disconnects).toBe(0);
  callback?.(null);
  expect(disconnects).toBe(1);
  await Bun.sleep(120);
  expect(disconnects).toBe(1);
});

test("observability gap clears unmatched sync operations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-runtime-diagnostics-gap-"));
  const path = join(dir, "runtime.jsonl");
  const child = fork(fileURLToPath(new URL("../../src/lib/runtime-diagnostics-child.ts", import.meta.url)), [], {
    execPath: process.execPath, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const ready = new Promise<void>(resolve => child.once("message", () => resolve()));
  try {
    child.send({ kind: "init", path, pid: process.pid, intervalMs: 1000, stallMs: 5000, logEveryMs: 1000 });
    await Promise.race([ready, Bun.sleep(3000).then(() => { throw new Error("recorder did not start"); })]);
    const at = Date.now();
    child.send({ kind: "sync-start", at, id: 7, sites: ["src/lib/example.ts:1:1"] });
    child.send({ kind: "observability-gap", at: at + 1, droppedMessages: 1, syncOperationsDropped: true });
    child.send({ kind: "sync-end", at: at + 1000, id: 7 });
    await Bun.sleep(25);
  } finally {
    if (child.connected) child.disconnect();
    await closed;
  }
  try {
    const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records.some(r => r.kind === "ipc-observability-gap" && r.syncOperationsDropped === true)).toBe(true);
    expect(records.some(r => r.kind === "slow-sync-operation")).toBe(false);
  } finally { removeTreeWithRetry(dir); }
});

test("completed slow-operation heartbeat evidence is retained without a delivered start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-runtime-diagnostics-completed-"));
  const path = join(dir, "runtime.jsonl");
  const child = fork(fileURLToPath(new URL("../../src/lib/runtime-diagnostics-child.ts", import.meta.url)), [], {
    execPath: process.execPath, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const ready = new Promise<void>(resolve => child.once("message", () => resolve()));
  const completed = { sequence: 77, id: 41, elapsedMs: 360, sites: ["src/lib/runtime-diagnostics.ts:process.memoryUsage"] };
  try {
    child.send({ kind: "init", path, pid: process.pid, intervalMs: 20, stallMs: 100, logEveryMs: 1000 });
    await Promise.race([ready, Bun.sleep(3000).then(() => { throw new Error("recorder did not start"); })]);
    child.send({ kind: "heartbeat", at: Date.now(), intervalMs: 20, timerDelayMs: 0,
      cpuUserDeltaMs: 0, cpuSystemDeltaMs: 0, counters: {}, completedSlowOperations: [completed],
      completedSlowOperationOverflow: 2 });
    // A retained snapshot can be retransmitted before the parent sees its IPC
    // callback. The child must keep that bounded retry from double-logging it.
    child.send({ kind: "heartbeat", at: Date.now(), intervalMs: 20, timerDelayMs: 0,
      cpuUserDeltaMs: 0, cpuSystemDeltaMs: 0, counters: {}, completedSlowOperations: [completed],
      completedSlowOperationOverflow: 2 });
    await Bun.sleep(50);
  } finally {
    if (child.connected) child.disconnect();
    await closed;
  }
  try {
    const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const slow = records.filter(record => record.kind === "slow-sync-operation");
    expect(slow).toHaveLength(1);
    expect(slow[0]).toEqual(expect.objectContaining({ elapsedMs: 360, sites: completed.sites }));
    expect(records).toContainEqual(expect.objectContaining({
      kind: "completed-slow-operation-overflow",
      droppedCompletedSlowOperations: 2,
    }));
  } finally { removeTreeWithRetry(dir); }
});

test("sampling failures retain a bounded base heartbeat and do not manufacture a timer delay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-runtime-diagnostics-sample-"));
  const path = join(dir, "runtime.jsonl");
  let samples = 0;
  const recorder = startRuntimeDiagnostics(path, () => {
    samples += 1;
    if (samples === 1) throw new Error("test sample failure");
    return { activeTurns: 0 };
  }, { intervalMs: 20, stallMs: 100, logEveryMs: 20 });
  try {
    await Promise.race([recorder.ready, Bun.sleep(3000).then(() => { throw new Error("recorder did not start"); })]);
    await Bun.sleep(100);
  } finally {
    recorder.stop();
    await recorder.closed;
  }
  try {
    const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records.some(r => r.kind === "sample" && r.counters?.diagnosticsSampleFailures >= 1)).toBe(true);
    expect(records.some(r => r.kind === "event-loop-delay")).toBe(false);
  } finally { removeTreeWithRetry(dir); }
});

test("a slow native memory sample has a fixed diagnostic phase", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-runtime-diagnostics-memory-phase-"));
  const path = join(dir, "runtime.jsonl");
  const originalMemoryUsage = process.memoryUsage;
  let calls = 0;
  Object.defineProperty(process, "memoryUsage", {
    configurable: true,
    value: () => {
      calls += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      return originalMemoryUsage();
    },
  });
  const recorder = startRuntimeDiagnostics(path, () => ({ activeTurns: 0 }), {
    intervalMs: 250, stallMs: 100, logEveryMs: 20,
  });
  try {
    await Promise.race([recorder.ready, Bun.sleep(3000).then(() => { throw new Error("recorder did not start"); })]);
    await Bun.sleep(700);
  } finally {
    Object.defineProperty(process, "memoryUsage", { configurable: true, value: originalMemoryUsage });
    recorder.stop();
    await recorder.closed;
  }
  try {
    expect(calls).toBeGreaterThan(0);
    const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records.some(record => record.kind === "slow-sync-operation"
      && record.sites?.includes("src/lib/runtime-diagnostics.ts:process.memoryUsage"))).toBe(true);
  } finally { removeTreeWithRetry(dir); }
});

test("a throwing native memory sample is counted and leaves no stale phase", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-runtime-diagnostics-memory-throw-"));
  const path = join(dir, "runtime.jsonl");
  const originalMemoryUsage = process.memoryUsage;
  let calls = 0;
  Object.defineProperty(process, "memoryUsage", {
    configurable: true,
    value: () => {
      calls += 1;
      throw new Error("memory fixture failure");
    },
  });
  const recorder = startRuntimeDiagnostics(path, () => ({ activeTurns: 0 }), {
    intervalMs: 250, stallMs: 100, logEveryMs: 20,
  });
  try {
    await Promise.race([recorder.ready, Bun.sleep(3000).then(() => { throw new Error("recorder did not start"); })]);
    await Bun.sleep(300);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
    await Bun.sleep(75);
  } finally {
    Object.defineProperty(process, "memoryUsage", { configurable: true, value: originalMemoryUsage });
    recorder.stop();
    await recorder.closed;
  }
  try {
    expect(calls).toBeGreaterThan(0);
    const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records.some(record => record.counters?.diagnosticsMemoryUsageFailures >= 1)).toBe(true);
    const stall = records.find(record => record.kind === "event-loop-stall");
    expect(stall?.operations).toEqual([]);
  } finally { removeTreeWithRetry(dir); }
});

test("recorder distinguishes an intentional parent shutdown from an unexpected disconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-runtime-diagnostics-shutdown-"));
  const path = join(dir, "runtime.jsonl");
  const recorder = startRuntimeDiagnostics(path, () => ({ activeTurns: 0 }), {
    intervalMs: 20, stallMs: 100, logEveryMs: 1000,
  });
  try {
    await Promise.race([recorder.ready, Bun.sleep(3000).then(() => { throw new Error("recorder did not start"); })]);
  } finally {
    recorder.stop();
    await recorder.closed;
  }
  try {
    const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const started = records.find(r => r.kind === "start");
    expect(started.recorderPid).toEqual(expect.any(Number));
    expect(records.some(r => r.kind === "parent-stopping")).toBe(true);
    expect(records.at(-1)).toEqual(expect.objectContaining({
      kind: "parent-disconnected",
      expected: true,
    }));
  } finally { removeTreeWithRetry(dir); }
});

test.if(process.platform === "win32")("Windows detached recorder survives a parent exit long enough to record its IPC disconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-runtime-diagnostics-detached-"));
  const path = join(dir, "runtime.jsonl");
  const probe = Bun.spawn([process.execPath, "-e", `
    import { startRuntimeDiagnostics } from "./src/lib/runtime-diagnostics.ts";
    const recorder = startRuntimeDiagnostics(process.env.OCX_RUNTIME_DIAGNOSTICS_PATH, () => ({ activeTurns: 0 }), {
      intervalMs: 20,
      stallMs: 100,
      logEveryMs: 1000,
    });
    await recorder.ready;
    process.exit(0);
  `], {
    cwd: process.cwd(),
    env: { ...process.env, OPENCODEX_HOME: join(dir, "home"), OCX_RUNTIME_DIAGNOSTICS_PATH: path },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await Promise.race([probe.exited, Bun.sleep(3000).then(() => { throw new Error("detached parent probe did not exit"); })]);
    let content = "";
    for (let index = 0; index < 40; index += 1) {
      if (existsSync(path)) {
        content = readFileSync(path, "utf8");
        if (content.includes("parent-disconnected")) break;
      }
      await Bun.sleep(25);
    }
    const records = content.trim().split("\n").map(line => JSON.parse(line));
    expect(records.at(-1)).toEqual(expect.objectContaining({
      kind: "parent-disconnected",
      expected: false,
    }));
  } finally {
    if (probe.exitCode === null) probe.kill();
    removeTreeWithRetry(dir);
  }
});

test("stopping before child initialization rejects ready and closes without an orphan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-runtime-diagnostics-early-stop-"));
  const recorder = startRuntimeDiagnostics(join(dir, "runtime.jsonl"), () => ({ activeTurns: 0 }));
  const ready = recorder.ready;
  try {
    recorder.stop();
    await Promise.race([recorder.closed, Bun.sleep(3000).then(() => { throw new Error("recorder did not close"); })]);
    await expect(ready).rejects.toThrow("runtime diagnostics recorder closed before ready");
  } finally { removeTreeWithRetry(dir); }
});

test("the server module reaches the recorder only through its opt-in gate", () => {
  // The recorder stays behind the env gate: only the desktop launcher opts in, so a static
  // edge would have loaded this module on every install's server start for a branch that
  // most installs never take.
  const edges = resolvedImportEdges("src/server/background-lifecycle.ts")
    .filter(edge => edge.spec.includes("runtime-diagnostics"));
  expect(edges.map(edge => ({ spec: edge.spec, dynamic: edge.dynamic })))
    .toEqual([{ spec: "../lib/runtime-diagnostics", dynamic: true }]);
});
