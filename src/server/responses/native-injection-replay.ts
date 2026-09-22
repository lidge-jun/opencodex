import { MAX_NATIVE_STEERING_REPLAY_BYTES, admitNativeControlReplayJournal, registerNativeControlReplayJournal, type NativeSteeringReplayObserver } from "./native-steering-replay";
import { injectionRecord as record, type InjectionFrame as Frame, type FunctionResult } from "./native-injection-protocol";

import { nativeResultFingerprint } from "./native-tool-results";
import { nativeResponseOutput } from "./native-response-output";

/** A bounded journal of accepted tool results, independent of user steering history. */
export class NativeInjectionReplay implements NativeSteeringReplayObserver {
  private prefix: unknown[];
  private bytes = 0;
  private current?: string;
  private output = new Map<number, Frame>();
  private accepted = new Map<string, FunctionResult>();
  private pending?: FunctionResult[];
  private pendingBytes = 0;
  private acceptedBatchBytes: number[] = [];
  private explicit: unknown[] = [];
  private previous: unknown[] = [];
  private unregisterAccounting?: () => void;

  get retainedBytes(): number { return this.bytes; }

  /** Capture a private initial prefix; existing persistence eligibility is checked by the caller. */
  constructor(input: unknown, private readonly remember: (input: unknown[], response: Frame) => void) {
    this.prefix = typeof input === "string"
      ? [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }]
      : Array.isArray(input) ? [...input] : [];
    this.reserve(this.prefix);
    this.unregisterAccounting = registerNativeControlReplayJournal(this);
  }
  /** Charge serialized bytes, refusing rather than truncating an over-budget transcript. */
  private reserve(value: unknown): number {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (this.bytes + bytes > MAX_NATIVE_STEERING_REPLAY_BYTES) throw new Error("Native injection replay exceeded its history budget.");
    this.bytes += bytes;
    try {
      admitNativeControlReplayJournal(this);
    } catch (error) {
      this.bytes -= bytes;
      throw error;
    }
    return bytes;
  }
  /** Journal before physical send, with rollback usable only for a known unsent frame. */
  submitted(frame: Frame): () => void {
    const input = Array.isArray(frame.input) ? structuredClone(frame.input) : [];
    const bytes = this.reserve(input);
    if (frame.type === "response.inject") { this.pending = input as FunctionResult[]; this.pendingBytes = bytes; }
    else this.explicit = input;
    return () => {
      if (frame.type === "response.inject") { this.pending = undefined; this.pendingBytes = 0; }
      else this.explicit = [];
      this.bytes -= bytes;
    };
  }
  /** Keep wire output order and insert each accepted result after its owning function call. */
  private completedOutput(response: Frame): unknown[] {
    const output = nativeResponseOutput(this.output, response.output);
    const echoed = new Set<string>();
    for (const item of output) {
      if (!record(item) || item.type !== "function_call_output" || typeof item.call_id !== "string") continue;
      const accepted = this.accepted.get(item.call_id);
      if (accepted) {
        if (echoed.has(item.call_id) || nativeResultFingerprint(item as FunctionResult) !== nativeResultFingerprint(accepted)) throw new Error("Native injection replay result mismatch.");
        echoed.add(item.call_id);
      }
    }
    const merged: unknown[] = [];
    const found = new Set(echoed);
    for (const item of output) {
      merged.push(item);
      if (!record(item) || item.type !== "function_call" || typeof item.call_id !== "string") continue;
      const accepted = this.accepted.get(item.call_id);
      if (accepted && !found.has(item.call_id)) { merged.push(accepted); found.add(item.call_id); }
    }
    if (found.size !== this.accepted.size) throw new Error("Native injection replay is missing an accepted result's call.");
    return merged;
  }
  /** Terminals are supplied by the owner only after all injection acknowledgements settle. */
  observe(frame: Frame): void {
    if (frame.type === "response.created") {
      if (this.current) {
        for (const item of this.previous) this.prefix.push(item);
        for (const item of this.explicit) this.prefix.push(item);
      }
      this.current = String(record(frame.response) ? frame.response.id : "");
      this.output.clear(); this.accepted.clear(); this.acceptedBatchBytes = []; this.explicit = []; this.previous = [];
    } else if (frame.type === "response.inject.created" || frame.type === "response.inject.failed") {
      if (!this.pending) throw new Error("Native injection replay acknowledgement has no pending input.");
      if (frame.type === "response.inject.created") {
        for (const item of this.pending) this.accepted.set(item.call_id, item);
        this.acceptedBatchBytes.push(this.pendingBytes);
      } else this.bytes -= this.pendingBytes;
      this.pending = undefined; this.pendingBytes = 0;
    } else if (frame.type === "response.output_item.done") {
      if (!Number.isSafeInteger(frame.output_index) || (frame.output_index as number) < 0
        || (frame.output_index as number) > 10_000 || !record(frame.item)) throw new Error("Native injection replay output identity is invalid.");
      const old = this.output.get(frame.output_index as number);
      if (old) this.bytes -= Buffer.byteLength(JSON.stringify(old));
      this.reserve(frame.item); this.output.set(frame.output_index as number, structuredClone(frame.item));
    } else if (record(frame.response) && ["response.completed", "response.failed", "response.incomplete"].includes(String(frame.type))) {
      if (this.pending) throw new Error("Native injection replay cannot commit an unacknowledged result.");
      const output = this.completedOutput(frame.response);
      for (const item of this.output.values()) this.bytes -= Buffer.byteLength(JSON.stringify(item));
      for (const bytes of this.acceptedBatchBytes) this.bytes -= bytes;
      this.reserve(output); this.output.clear(); this.accepted.clear(); this.acceptedBatchBytes = []; this.previous = output;
      if (frame.type === "response.completed") this.remember(this.prefix, { ...frame.response, output });
    }
  }
  /** Drop all retained bodies at cancellation, connection teardown or unknown delivery. */
  dispose(): void {
    this.unregisterAccounting?.();
    this.unregisterAccounting = undefined;
    this.prefix = []; this.output.clear(); this.accepted.clear(); this.pending = undefined; this.pendingBytes = 0; this.acceptedBatchBytes = [];
    this.explicit = []; this.previous = []; this.bytes = 0;
  }
}
