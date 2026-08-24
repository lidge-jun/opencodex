import type { TranslatorBudget } from "../lib/translator-budget";
import type { ResponsesTerminalRepairPolicy } from "../providers/registry";
import { nextSseBlock, sseDataPayload } from "./sse-payload-rewrite";

export interface ResponsesTerminalRepairScheduler {
  nowMs(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const systemScheduler: ResponsesTerminalRepairScheduler = {
  nowMs: () => Date.now(),
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  cancel(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnframedTerminalLikeSuffix(block: string): boolean {
  const payload = sseDataPayload(block);
  if (payload === "[DONE]") return true;
  if (!payload) return false;
  try {
    const parsed = JSON.parse(payload);
    if (!isPlainRecord(parsed)) return false;
    return parsed.type === "response.completed"
      || parsed.type === "response.failed"
      || parsed.type === "response.incomplete"
      || parsed.type === "error";
  } catch {
    return false;
  }
}

function outputIndex(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}

function isCompleteItem(item: Record<string, unknown>): boolean {
  if (item.status !== "completed") return false;
  if (item.type === "reasoning") {
    return typeof item.id === "string" && item.id.length > 0
      && Array.isArray(item.content)
      && item.content.every(part => isPlainRecord(part)
        && part.type === "reasoning_text" && typeof part.text === "string");
  }
  if (item.type === "message") {
    return typeof item.id === "string" && item.id.length > 0
      && item.role === "assistant" && Array.isArray(item.content)
      && item.content.every(part => isPlainRecord(part)
        && part.type === "output_text" && typeof part.text === "string");
  }
  if (item.type === "function_call") {
    if (typeof item.id !== "string" || item.id.length === 0) return false;
    if (typeof item.call_id !== "string" || item.call_id.length === 0) return false;
    if (typeof item.name !== "string" || item.name.length === 0) return false;
    if (typeof item.arguments !== "string") return false;
    try {
      return isPlainRecord(JSON.parse(item.arguments));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Relay a native Responses SSE body while repairing the narrow DeepSeek shape where every
 * output item is complete but the protocol terminal is missing or indefinitely delayed.
 */
export function relayResponsesSseWithTerminalRepair(
  body: ReadableStream<Uint8Array>,
  upstream: AbortController,
  policy: ResponsesTerminalRepairPolicy,
  budget: TranslatorBudget,
  scheduler: ResponsesTerminalRepairScheduler = systemScheduler,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const added = new Map<number, { type?: unknown; id?: unknown }>();
  const completed = new Map<number, { item: Record<string, unknown>; bytes: number }>();
  let created: Record<string, unknown> | null = null;
  let createdBytes = 0;
  let maxSequence = -1;
  let buffer = "";
  let bufferBytes = 0;
  let timer: unknown;
  let timerGeneration = 0;
  let realTerminalSeen = false;
  let tainted = false;
  let disposed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let activeRead: Promise<void> | null = null;

  const onUpstreamAbort = (): void => {
    if (disposed) return;
    dispose();
    reader.cancel(upstream.signal.reason).catch(() => {});
    try { controllerRef?.close(); } catch { /* already closed */ }
  };

  const releaseRetainedState = (): void => {
    if (createdBytes > 0) budget.releaseRetained(createdBytes, { kind: "retained_collectors" });
    createdBytes = 0;
    for (const retained of completed.values()) {
      budget.releaseRetained(retained.bytes, { kind: "retained_collectors" });
    }
    completed.clear();
    created = null;
  };

  const releaseBuffer = (): void => {
    if (bufferBytes > 0) budget.releaseRetained(bufferBytes, { kind: "live_transient" });
    buffer = "";
    bufferBytes = 0;
  };

  const cancelTimer = (): void => {
    timerGeneration += 1;
    if (timer !== undefined) scheduler.cancel(timer);
    timer = undefined;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    upstream.signal.removeEventListener("abort", onUpstreamAbort);
    cancelTimer();
    releaseRetainedState();
    releaseBuffer();
  };

  const replaceBuffer = (next: string): void => {
    const nextBytes = encoder.encode(next).byteLength;
    const reservation = budget.reserveTransient(nextBytes, { kind: "live_transient" });
    reservation.commitRetained();
    if (bufferBytes > 0) budget.releaseRetained(bufferBytes, { kind: "live_transient" });
    buffer = next;
    bufferBytes = nextBytes;
  };

  const appendBuffer = (fragment: string): void => {
    if (!fragment) return;
    replaceBuffer(buffer + fragment);
  };

  const retainCreated = (response: Record<string, unknown>): void => {
    const bytes = encoder.encode(JSON.stringify(response)).byteLength;
    budget.chargeRetained(bytes, { kind: "retained_collectors" });
    if (createdBytes > 0) budget.releaseRetained(createdBytes, { kind: "retained_collectors" });
    created = response;
    createdBytes = bytes;
  };

  const retainCompleted = (index: number, item: Record<string, unknown>): void => {
    const bytes = encoder.encode(JSON.stringify(item)).byteLength;
    budget.chargeRetained(bytes, { kind: "retained_collectors" });
    const previous = completed.get(index);
    if (previous) budget.releaseRetained(previous.bytes, { kind: "retained_collectors" });
    completed.set(index, { item, bytes });
  };

  const completeCandidate = (): boolean => {
    if (realTerminalSeen || tainted || !created || completed.size === 0 || added.size !== completed.size) return false;
    for (const index of added.keys()) {
      const retained = completed.get(index);
      if (!retained || !isCompleteItem(retained.item)) return false;
    }
    for (const index of completed.keys()) if (!added.has(index)) return false;
    return true;
  };

  const syntheticTerminal = (kind: "completed" | "incomplete"): Uint8Array => {
    const output = [...completed.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, retained]) => retained.item);
    const response = {
      ...(created ?? {}),
      status: kind,
      completed_at: Math.floor(scheduler.nowMs() / 1_000),
      output,
      ...(kind === "incomplete"
        ? { incomplete_details: { reason: "missing_terminal_event" } }
        : {}),
    };
    const type = `response.${kind}`;
    return encoder.encode(`event: ${type}\ndata: ${JSON.stringify({
      type,
      response,
      sequence_number: maxSequence + 1,
    })}\n\n`);
  };

  const emitSynthetic = (
    kind: "completed" | "incomplete",
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean => {
    if (disposed || realTerminalSeen) return false;
    realTerminalSeen = true;
    cancelTimer();
    controller.enqueue(syntheticTerminal(kind));
    releaseRetainedState();
    return true;
  };

  const commitSynthetic = (generation: number): void => {
    if (disposed || realTerminalSeen || generation !== timerGeneration || !completeCandidate()) return;
    timer = undefined;
    try {
      if (controllerRef && emitSynthetic("completed", controllerRef)) controllerRef.close();
    } catch {
      /* downstream already closed */
    }
    reader.cancel("Responses terminal repaired after complete output").catch(() => {});
    dispose();
  };

  const maybeArmTimer = (): void => {
    if (!completeCandidate()) return;
    const generation = timerGeneration;
    timer = scheduler.schedule(() => commitSynthetic(generation), policy.graceMs);
  };

  const inspectPayload = (payload: string | null): "done" | "ordinary" => {
    if (payload === "[DONE]") return "done";
    if (!payload || realTerminalSeen) return "ordinary";
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      tainted = true;
      return "ordinary";
    }
    if (!isPlainRecord(parsed)) {
      tainted = true;
      return "ordinary";
    }
    if (Number.isInteger(parsed.sequence_number)) {
      maxSequence = Math.max(maxSequence, parsed.sequence_number as number);
    }
    const type = parsed.type;
    if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
      realTerminalSeen = true;
      cancelTimer();
      releaseRetainedState();
      return "ordinary";
    }

    cancelTimer();
    if (type === "response.created" && isPlainRecord(parsed.response)) {
      retainCreated(parsed.response);
    } else if (type === "response.output_item.added") {
      const index = outputIndex(parsed.output_index);
      if (index === null || !isPlainRecord(parsed.item) || added.has(index) || completed.has(index)) {
        tainted = true;
      } else {
        added.set(index, { type: parsed.item.type, id: parsed.item.id });
      }
    } else if (type === "response.output_item.done") {
      const index = outputIndex(parsed.output_index);
      if (index === null || !isPlainRecord(parsed.item) || !added.has(index) || completed.has(index)) {
        tainted = true;
      } else {
        const opened = added.get(index)!;
        if (opened.type !== parsed.item.type || opened.id !== parsed.item.id) tainted = true;
        retainCompleted(index, parsed.item);
      }
    }
    maybeArmTimer();
    return "ordinary";
  };

  const emitBlocks = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): { closed: boolean; emitted: boolean } => {
    let next: ReturnType<typeof nextSseBlock>;
    let emitted = false;
    while ((next = nextSseBlock(buffer))) {
      replaceBuffer(next.rest);
      const kind = inspectPayload(sseDataPayload(next.block));
      if (kind === "done" && !realTerminalSeen) {
        emitSynthetic(completeCandidate() ? "completed" : "incomplete", controller);
      }
      controller.enqueue(encoder.encode(next.block + next.delimiter));
      emitted = true;
      if (kind === "done") {
        reader.cancel("Responses stream ended with DONE").catch(() => {});
        dispose();
        controller.close();
        return { closed: true, emitted };
      }
    }
    return { closed: false, emitted };
  };

  const readOnce = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (disposed) return;
        if (done) {
          appendBuffer(decoder.decode());
          if (buffer.length > 0) {
            // A delimiter-less suffix is not a complete SSE event. Preserve an
            // ordinary suffix for passthrough compatibility, but never promote
            // a terminal-like suffix by adding the delimiter it did not receive
            // upstream. The latter must stay tainted and fail closed through the
            // synthetic incomplete terminal below.
            tainted = true;
            if (!isUnframedTerminalLikeSuffix(buffer)) {
              controller.enqueue(encoder.encode(buffer));
              controller.enqueue(encoder.encode(buffer.includes("\r\n") ? "\r\n\r\n" : "\n\n"));
            }
          }
          if (!realTerminalSeen) {
            emitSynthetic(completeCandidate() ? "completed" : "incomplete", controller);
          }
          releaseBuffer();
          dispose();
          controller.close();
          return;
        }
        appendBuffer(decoder.decode(value, { stream: true }));
        const result = emitBlocks(controller);
        if (result.closed || result.emitted) return;
      }
    } catch (error) {
      if (disposed) return;
      dispose();
      controller.error(error);
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (upstream.signal.aborted) {
        onUpstreamAbort();
        return;
      }
      upstream.signal.addEventListener("abort", onUpstreamAbort, { once: true });
    },
    pull(controller) {
      if (disposed) return;
      if (!activeRead) {
        activeRead = readOnce(controller).finally(() => { activeRead = null; });
      }
      return activeRead;
    },
    cancel(reason) {
      dispose();
      upstream.abort(reason);
      return reader.cancel(reason);
    },
  });
}
