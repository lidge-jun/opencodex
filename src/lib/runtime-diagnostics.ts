import { fork, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

// Opt-in, scalar-only diagnostics. A separate process keeps writing even when the
// server's event loop is blocked in a synchronous native call. No request data crosses IPC.
export type RuntimeCounters = Record<string, number | boolean | null>;
type DiagnosticDeliveryCallback = () => void;
type RuntimeDiagnosticSender = (message: object, onDelivered?: DiagnosticDeliveryCallback) => boolean;
let sequence = 0;

const MAX_DIAGNOSTIC_IPC_IN_FLIGHT = 4;
const STOP_DELIVERY_TIMEOUT_MS = 250;
const STATIC_SAMPLE_MIN_INTERVAL_MS = 250;
const SLOW_SYNC_OPERATION_MS = 250;
const COMPLETED_SLOW_OPERATION_CAPACITY = 8;

type CompletedSlowOperation = {
  readonly sequence: number;
  readonly id: number;
  readonly elapsedMs: number;
  readonly sites: readonly string[];
};

type CompletedSlowOperationRing = {
  enqueue(operation: CompletedSlowOperation): void;
  snapshot(): readonly CompletedSlowOperation[];
  acknowledge(delivered: readonly CompletedSlowOperation[]): void;
  readonly overflow: number;
};

/**
 * A recorder may be briefly IPC-backpressured exactly while the parent event loop
 * recovers. Retain completed slow operations until a later heartbeat callback
 * confirms delivery, rather than treating `send() === false` as a lost message.
 */
export function createCompletedSlowOperationRingForTests(
  capacity = COMPLETED_SLOW_OPERATION_CAPACITY,
): CompletedSlowOperationRing {
  const boundedCapacity = Number.isFinite(capacity)
    ? Math.max(1, Math.floor(capacity))
    : COMPLETED_SLOW_OPERATION_CAPACITY;
  const operations: CompletedSlowOperation[] = [];
  let overflow = 0;
  return {
    enqueue(operation) {
      if (operations.length >= boundedCapacity) {
        operations.shift();
        overflow += 1;
      }
      operations.push(operation);
    },
    snapshot: () => [...operations],
    acknowledge(delivered) {
      const deliveredSequences = new Set(delivered.map(operation => operation.sequence));
      for (let index = operations.length - 1; index >= 0; index -= 1) {
        if (deliveredSequences.has(operations[index]!.sequence)) operations.splice(index, 1);
      }
    },
    get overflow() { return overflow; },
  };
}

type DiagnosticIpcTarget = {
  readonly connected: boolean;
  send(message: object, callback: (error: Error | null) => void): boolean;
};

type RuntimeDiagnosticStopTarget = DiagnosticIpcTarget & {
  disconnect(): void;
};

/**
 * `ChildProcess.send()` returning false reports IPC backpressure, not a failed
 * enqueue. Preserve a queued shutdown marker until its callback, while still
 * bounding shutdown if a broken channel never invokes that callback.
 */
export function disconnectAfterRuntimeDiagnosticsStop(
  target: RuntimeDiagnosticStopTarget,
  at = Date.now(),
  timeoutMs = STOP_DELIVERY_TIMEOUT_MS,
): void {
  let disconnected = false;
  const disconnect = () => {
    if (disconnected || !target.connected) return;
    disconnected = true;
    target.disconnect();
  };
  const fallback = setTimeout(disconnect, timeoutMs);
  fallback.unref();
  try {
    target.send({ kind: "parent-stopping", at }, () => {
      clearTimeout(fallback);
      disconnect();
    });
  } catch {
    clearTimeout(fallback);
    disconnect();
  }
}

/**
 * Diagnostics must never let a blocked recorder turn into retained parent memory.
 * A later gap notification tells the child to discard any unmatched sync operation
 * rather than attributing an arbitrary duration to it.
 */
export function createBoundedRuntimeDiagnosticSender(target: DiagnosticIpcTarget): RuntimeDiagnosticSender {
  let inFlight = 0;
  let backpressured = false;
  let droppedMessages = 0;
  let droppedSyncOperations = false;

  const recordDrop = (message: object): false => {
    droppedMessages += 1;
    const kind = (message as { kind?: unknown }).kind;
    if (kind === "sync-start" || kind === "sync-end") droppedSyncOperations = true;
    return false;
  };
  const sendOne = (message: object, onDelivered?: DiagnosticDeliveryCallback): boolean => {
    if (!target.connected || backpressured || inFlight >= MAX_DIAGNOSTIC_IPC_IN_FLIGHT) return recordDrop(message);
    inFlight += 1;
    try {
      const accepted = target.send(message, error => {
        inFlight = Math.max(0, inFlight - 1);
        // A callback error means the recorder missed this message. Preserve that
        // fact until a later delivered gap clears any partial operation state.
        if (error) recordDrop(message);
        else onDelivered?.();
        if (inFlight === 0) backpressured = false;
      });
      if (!accepted) backpressured = true;
      return true;
    } catch {
      inFlight = Math.max(0, inFlight - 1);
      return recordDrop(message);
    }
  };

  return (message, onDelivered) => {
    if (droppedMessages > 0) {
      const gap = {
        kind: "observability-gap",
        at: Date.now(),
        droppedMessages,
        syncOperationsDropped: droppedSyncOperations,
      };
      if (!sendOne(gap)) return recordDrop(message);
      droppedMessages = 0;
      droppedSyncOperations = false;
      // The gap clears the recorder's incomplete operations before this ordinary
      // message is processed; the normal in-flight bound still applies below.
      return sendOne(message, onDelivered);
    }
    return sendOne(message, onDelivered);
  };
}

export function startRuntimeDiagnostics(
  path: string,
  sample: () => RuntimeCounters,
  timing = { intervalMs: 1000, stallMs: 5000, logEveryMs: 30_000 },
): { ready: Promise<void>; closed: Promise<void>; stop(): void } {
  const launchOptions: ForkOptions & { windowsHide: boolean } = {
    execPath: process.execPath,
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
    // A Windows detached recorder can observe the ordinary parent-exit IPC
    // boundary. It still cannot escape a launcher Job Object or taskkill /T.
    detached: process.platform === "win32",
  };
  const target = fork(fileURLToPath(new URL("./runtime-diagnostics-child.ts", import.meta.url)), [], launchOptions);
  const send = createBoundedRuntimeDiagnosticSender(target);
  const completedSlowOperations = createCompletedSlowOperationRingForTests();
  let lastSampleAt = performance.now();
  let lastCpu = process.cpuUsage();
  let sampleFailures = 0;
  let memoryUsageFailures = 0;
  let samplerActive = false;
  let sampling = false;
  const beginStaticSampleOperation = (phase: string): (() => void) => {
    // Keep the sampler's own operation static and scalar-only: collecting a
    // stack here would add work exactly where a native runtime call may stall.
    // Before recorder readiness, avoid queuing a startup operation that cannot
    // describe a real sample.
    // A begin/end pair adds two bounded IPC messages. Keep the normal 1s
    // diagnostic cadence attributable without turning deliberately rapid test
    // or debug cadences into their own recorder backpressure source.
    if (!samplerActive || timing.intervalMs < STATIC_SAMPLE_MIN_INTERVAL_MS || !target.connected) return () => {};
    const id = ++sequence;
    const startedAt = performance.now();
    const started = send({ kind: "sync-start", at: Date.now(), id, sites: [phase] });
    return () => {
      const elapsedMs = Math.max(0, performance.now() - startedAt);
      if (elapsedMs >= SLOW_SYNC_OPERATION_MS) {
        completedSlowOperations.enqueue({ sequence: ++sequence, id, elapsedMs, sites: [phase] });
      } else if (started) {
        send({ kind: "sync-end", at: Date.now(), id });
      }
    };
  };
  const sampleCounters = (cpu: NodeJS.CpuUsage): RuntimeCounters => {
    let usage: ReturnType<typeof process.memoryUsage> | null = null;
    const finishMemoryUsage = beginStaticSampleOperation("src/lib/runtime-diagnostics.ts:process.memoryUsage");
    try {
      usage = process.memoryUsage();
    } catch {
      // Native-call failures stay distinguishable from the supplied business
      // counters below, without retaining an error object or its message.
      memoryUsageFailures += 1;
    } finally {
      finishMemoryUsage();
    }
    let sampled: RuntimeCounters = {};
    try { sampled = sample(); } catch { sampleFailures += 1; }
    return {
      ...sampled,
      uptime: process.uptime(),
      rss: usage?.rss ?? null,
      heapUsed: usage?.heapUsed ?? null,
      external: usage?.external ?? null,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      diagnosticsSampleFailures: sampleFailures,
      diagnosticsMemoryUsageFailures: memoryUsageFailures,
    };
  };
  const sendHeartbeat = (heartbeat: object): void => {
    const completed = completedSlowOperations.snapshot();
    send({
      ...heartbeat,
      completedSlowOperations: completed,
      completedSlowOperationOverflow: completedSlowOperations.overflow,
    }, () => {
      completedSlowOperations.acknowledge(completed);
    });
  };
  let stopRequested = false;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      if (readySettled) return;
      readySettled = true;
      resolve();
    };
    rejectReady = () => {
      if (readySettled) return;
      readySettled = true;
      reject(new Error("runtime diagnostics recorder closed before ready"));
    };
  });
  // Callers can still observe rejection; this prevents an optional recorder
  // startup failure from becoming an unhandled-rejection process failure.
  void ready.catch(() => {});
  let timer: ReturnType<typeof setInterval> | undefined;
  let closedSettled = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const settleClosed = () => {
    if (closedSettled) return;
    closedSettled = true;
    if (timer) clearInterval(timer);
    rejectReady();
    resolveClosed();
  };
  target.once("close", settleClosed);
  target.once("exit", settleClosed);
  const logRecorderEvent = (kind: "recorder-error" | "recorder-exit", extra: object = {}) => {
    if (!stopRequested) console.warn("[runtime-diagnostics] recorder-event", JSON.stringify({
      kind,
      recorderPid: target.pid ?? null,
      ...extra,
    }));
  };
  target.on("error", () => {
    logRecorderEvent("recorder-error");
    rejectReady();
    const failureCloseTimer = setTimeout(() => {
      if (target.exitCode === null) target.kill();
      settleClosed();
    }, 2000);
    failureCloseTimer.unref();
    void closed.then(() => clearTimeout(failureCloseTimer));
  });
  target.once("exit", (exitCode, signalCode) => logRecorderEvent("recorder-exit", {
    exitCode: exitCode ?? null,
    signalCode: signalCode ?? null,
  }));
  target.on("message", message => {
    if (message !== "ready") return;
    // The first heartbeat begins from readiness, not recorder process launch.
    // This keeps startup IPC/bootstrap time out of the timer-delay baseline.
    lastSampleAt = performance.now();
    lastCpu = process.cpuUsage();
    samplerActive = true;
    resolveReady();
  });
  send({ kind: "init", path, pid: process.pid, ...timing });
  timer = setInterval(() => {
    // setInterval callbacks normally serialize on one event loop, but retain a
    // guard so a future re-entrant sample seam cannot nest sync operations.
    if (!samplerActive || sampling) return;
    sampling = true;
    try {
    const now = performance.now();
    const intervalMs = now - lastSampleAt;
    const cpu = process.cpuUsage();
    const cpuUserDeltaMs = (cpu.user - lastCpu.user) / 1000;
    const cpuSystemDeltaMs = (cpu.system - lastCpu.system) / 1000;
    const counters = sampleCounters(cpu);
    // Advance the baseline regardless of a business-counter failure. Otherwise a
    // failed sample manufactures a parent timer delay on the next good sample.
    lastSampleAt = now;
    lastCpu = cpu;
    sendHeartbeat({ kind: "heartbeat", at: Date.now(),
      intervalMs, timerDelayMs: Math.max(0, intervalMs - timing.intervalMs),
      cpuUserDeltaMs,
      cpuSystemDeltaMs,
      counters,
    });
    } finally {
      sampling = false;
    }
  }, timing.intervalMs);
  timer.unref();
  target.unref();
  target.channel?.unref?.();
  return { ready, closed, stop() {
    stopRequested = true;
    clearInterval(timer);
    if (target.connected) {
      // Do not extend shutdown, but make one final bounded attempt to carry a
      // completed slow operation that ended between ordinary heartbeats.
      if (completedSlowOperations.snapshot().length > 0) {
        sendHeartbeat({ kind: "heartbeat", at: Date.now(), intervalMs: timing.intervalMs,
          timerDelayMs: 0, cpuUserDeltaMs: 0, cpuSystemDeltaMs: 0, counters: {} });
      }
      // A requested stop is a lifecycle fact, not a recurring diagnostic. Let
      // the recorder receive it before its IPC channel closes where possible.
      disconnectAfterRuntimeDiagnosticsStop(target);
    }
    const killTimer = setTimeout(() => { if (target.exitCode === null) target.kill(); }, 2000);
    killTimer.unref();
    void closed.then(() => clearTimeout(killTimer));
  } };
}
