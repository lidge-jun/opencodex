import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";

// Private child of the managed proxy, not another service or restart controller.
const MAX_LOG_BYTES = 2 * 1024 * 1024;
let path = "";
let pid = 0;
let heartbeatAt = Date.now();
let lastLogAt = 0;
let stalled = false;
let parentStoppingAt: number | null = null;
let stallMs = 5000;
let counters: Record<string, number | boolean | null> = {};
const operations = new Map<number, { at: number; sites: string[] }>();
const completedSlowOperationSequences = new Set<number>();
const completedSlowOperationSequenceOrder: number[] = [];
let completedSlowOperationOverflow = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function rememberCompletedSlowOperation(sequence: number): boolean {
  if (completedSlowOperationSequences.has(sequence)) return false;
  completedSlowOperationSequences.add(sequence);
  completedSlowOperationSequenceOrder.push(sequence);
  if (completedSlowOperationSequenceOrder.length > 16) {
    const oldest = completedSlowOperationSequenceOrder.shift();
    if (oldest !== undefined) completedSlowOperationSequences.delete(oldest);
  }
  return true;
}

function log(kind: string, extra: object = {}): void {
  try {
    if (existsSync(path) && statSync(path).size >= MAX_LOG_BYTES) {
      if (existsSync(path + ".1")) unlinkSync(path + ".1");
      renameSync(path, path + ".1");
    }
    appendFileSync(path, JSON.stringify({
      at: new Date().toISOString(),
      pid,
      recorderPid: process.pid,
      kind,
      ...extra,
    }) + "\n");
  } catch { /* disk/logging failures never signal the managed service */ }
}

process.on("message", (message: unknown) => {
  const m = message as { kind: string; path: string; pid: number; intervalMs: number;
    stallMs: number; logEveryMs: number; at: number; id: number; sites: string[];
    timerDelayMs: number; cpuUserDeltaMs: number; cpuSystemDeltaMs: number;
    counters: typeof counters; droppedMessages: number; syncOperationsDropped: boolean;
    completedSlowOperations?: Array<{ sequence: number; id: number; elapsedMs: number; sites: string[] }>;
    completedSlowOperationOverflow?: number };
  if (m.kind === "init" && !path) {
    path = m.path;
    pid = m.pid;
    stallMs = m.stallMs;
    heartbeatAt = Date.now();
    log("start");
    let lastTickAt = performance.now();
    timer = setInterval(() => {
      const tickAt = performance.now();
      const recorderDelayMs = Math.max(0, tickAt - lastTickAt - m.intervalMs);
      lastTickAt = tickAt;
      const now = Date.now();
      const gapMs = now - heartbeatAt;
      const isStalled = gapMs >= m.stallMs;
      if ((isStalled && !stalled) || now - lastLogAt >= m.logEveryMs) {
        log(isStalled ? "event-loop-stall" : "sample", {
          // Missing IPC alone is not proof that the parent's event loop stalled.
          // The parent reports its own monotonic timer delay on the next heartbeat.
          observation: isStalled ? "heartbeat-missing" : "heartbeat-current",
          heartbeatGapMs: gapMs, recorderDelayMs, counters, operations: [...operations.values()],
        });
        lastLogAt = now;
      }
      stalled = isStalled;
    }, m.intervalMs);
    process.send?.("ready");
  } else if (m.kind === "parent-stopping") {
    parentStoppingAt = Number.isFinite(m.at) ? m.at : Date.now();
    log("parent-stopping");
  } else if (m.kind === "heartbeat") {
    const timerDelayMs = Number.isFinite(m.timerDelayMs) ? m.timerDelayMs : null;
    const parentDelayConfirmed = timerDelayMs !== null && timerDelayMs >= stallMs;
    if (parentDelayConfirmed) log("event-loop-delay", {
      intervalMs: m.intervalMs, timerDelayMs,
      cpuUserDeltaMs: m.cpuUserDeltaMs, cpuSystemDeltaMs: m.cpuSystemDeltaMs,
      counters: m.counters, operations: [...operations.values()],
    });
    if (stalled) log("event-loop-recovered", {
      gapMs: m.at - heartbeatAt, parentDelayConfirmed, timerDelayMs,
    });
    heartbeatAt = m.at;
    counters = m.counters;
    stalled = false;
    if (Array.isArray(m.completedSlowOperations)) {
      for (const completed of m.completedSlowOperations) {
        if (!Number.isSafeInteger(completed.sequence) || !Number.isSafeInteger(completed.id)
          || !Number.isFinite(completed.elapsedMs) || completed.elapsedMs < 250
          || !Array.isArray(completed.sites) || !rememberCompletedSlowOperation(completed.sequence)) continue;
        operations.delete(completed.id);
        log("slow-sync-operation", {
          elapsedMs: completed.elapsedMs,
          sites: completed.sites.slice(0, 8),
        });
      }
    }
    const overflow = m.completedSlowOperationOverflow;
    if (typeof overflow === "number" && Number.isSafeInteger(overflow)
      && overflow > completedSlowOperationOverflow) {
      log("completed-slow-operation-overflow", {
        droppedCompletedSlowOperations: overflow - completedSlowOperationOverflow,
        completedSlowOperationOverflow: overflow,
      });
      completedSlowOperationOverflow = overflow;
    }
  } else if (m.kind === "sync-start") {
    if (operations.size >= 16) operations.delete(operations.keys().next().value!);
    operations.set(m.id, { at: m.at, sites: m.sites });
  } else if (m.kind === "sync-end") {
    const op = operations.get(m.id);
    if (op && m.at - op.at >= 250) log("slow-sync-operation", { elapsedMs: m.at - op.at, sites: op.sites });
    operations.delete(m.id);
  } else if (m.kind === "observability-gap") {
    const clearedOperations = operations.size;
    operations.clear();
    log("ipc-observability-gap", {
      droppedMessages: Number.isSafeInteger(m.droppedMessages) && m.droppedMessages > 0 ? m.droppedMessages : 0,
      syncOperationsDropped: m.syncOperationsDropped === true,
      clearedOperations,
    });
  }
});
process.on("disconnect", () => {
  if (timer) clearInterval(timer);
  if (path) log("parent-disconnected", {
    expected: parentStoppingAt !== null,
    parentStoppingAt,
    heartbeatGapMs: Date.now() - heartbeatAt,
    counters,
  });
  process.exit(0);
});
