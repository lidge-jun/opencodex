import { nativeResponseOutput } from "./native-response-output";
import {
  admitAppOwnedPinnedBytes,
  appOwnedBytesSnapshot,
  type RetainedStoreSnapshot,
} from "../../lib/app-owned-memory";

/**
 * Connection-local replay journal. Only input committed by response.created enters
 * a successor's prefix. Uncommitted/rejected steering never enters the shared
 * continuation cache. Bodies are bounded and discarded at connection teardown.
 */
export const MAX_NATIVE_STEERING_REPLAY_BYTES = 32 * 1024 * 1024;
/**
 * Aggregate ceiling across every live steering and injection journal. The operator
 * budget is an eviction target that can be raised to 4 GiB; pinned control journals
 * keep their own finite admission cap so the documented pin-capable aggregate stays
 * below the process-owned 512 MiB worst case.
 */
export const MAX_NATIVE_CONTROL_REPLAY_TOTAL_BYTES = 128 * 1024 * 1024;
let aggregateCapBytes = MAX_NATIVE_CONTROL_REPLAY_TOTAL_BYTES;
const activeReplays = new Set<{ readonly retainedBytes: number }>();

/** Account active journals as pinned state: protocol safety forbids evicting pending input. */
export function nativeControlReplayRetainedStoreSnapshot(): RetainedStoreSnapshot {
  let bytes = 0;
  for (const replay of activeReplays) bytes += replay.retainedBytes;
  return { count: activeReplays.size, bytes, evictableBytes: 0, pinnedBytes: bytes, oldestAt: null };
}

/** Track one live control journal (steering or injection) and return its detach hook. */
export function registerNativeControlReplayJournal(journal: { readonly retainedBytes: number }): () => void {
  activeReplays.add(journal);
  return () => { activeReplays.delete(journal); };
}

/**
 * Shared pinned-memory admission for one journal's current retained bytes. Bytes the
 * retained-store registry already sees are measured in place; a journal still in its
 * constructor is priced as a new proposal. Reclaimable owners are demoted before
 * refusal, so cache occupancy alone never fails a journal.
 */
export function admitNativeControlReplayJournal(journal: { readonly retainedBytes: number }): void {
  const replayBytes = nativeControlReplayRetainedStoreSnapshot().bytes
    + (activeReplays.has(journal) ? 0 : journal.retainedBytes);
  if (replayBytes > aggregateCapBytes) {
    throw new Error("Native control replay exceeded the pinned journal ceiling.");
  }
  const registeredBytes = appOwnedBytesSnapshot().stores.native_control_replay?.bytes ?? 0;
  if (!admitAppOwnedPinnedBytes(replayBytes - registeredBytes)) {
    throw new Error("Native control replay exceeded the application-owned memory budget.");
  }
}
type Frame = Record<string, unknown>;
/** Accept JSON object envelopes without treating arrays as records. */
function record(value: unknown): value is Frame {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Normalize string input to one user message while preserving array order. */
function inputItems(input: unknown): unknown[] {
  if (typeof input === "string") return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  return Array.isArray(input) ? input : [];
}
export interface NativeSteeringReplayObserver {
  submitted(frame: Frame): () => void;
  observe(frame: Frame): void;
  dispose(): void;
}

/** Keep bounded, connection-local input until a validated successor commits it. */
export class NativeSteeringReplay implements NativeSteeringReplayObserver {
  private prefix: unknown[];
  private bytes: number;
  private current?: string;
  private previousOutput: unknown[] = [];
  private outputItems = new Map<number, Frame>();
  private submissions: Array<{ parent: string; input: unknown[]; id?: string; bytes: number }> = [];
  private explicitInput: unknown[] = [];
  private explicitBytes = 0;
  private disposed = false;
  private unregisterAccounting?: () => void;

  get retainedBytes(): number { return this.bytes; }

  /** Capture the initial prefix and reject over-budget history before dispatch. */
  constructor(input: unknown, private readonly remember: (input: unknown[], response: Frame) => void) {
    this.prefix = [...inputItems(input)];
    this.bytes = Buffer.byteLength(JSON.stringify(this.prefix));
    this.check();
    this.unregisterAccounting = registerNativeControlReplayJournal(this);
  }
  /** Reject overflow rather than silently truncating retained conversation input. */
  private check(): void {
    if (this.bytes > MAX_NATIVE_STEERING_REPLAY_BYTES) throw new Error("Native steering replay exceeded its bounded history budget; input was not silently truncated.");
    admitNativeControlReplayJournal(this);
  }
  /** Reserve replay bytes before send and return a rollback for synchronous failure. */
  submitted(frame: Frame): () => void {
    const input = inputItems(frame.input);
    const bytes = Buffer.byteLength(JSON.stringify(input));
    this.bytes += bytes;
    try { this.check(); } catch (error) { this.bytes -= bytes; throw error; }
    if (frame.type === "response.steer") {
      const submission = { parent: String(frame.previous_response_id), input, bytes };
      this.submissions.push(submission);
      return () => {
        const index = this.submissions.indexOf(submission);
        if (index >= 0) { this.submissions.splice(index, 1); this.bytes -= bytes; }
      };
    }
    this.explicitInput = input;
    this.explicitBytes = bytes;
    return () => { this.explicitInput = []; this.bytes -= this.explicitBytes; this.explicitBytes = 0; };
  }
  /** Apply ordered upstream events; only created successors commit queued input. */
  observe(frame: Frame): void {
    const response = record(frame.response) ? frame.response : undefined;
    const steer = record(frame.steer) ? frame.steer : undefined;
    if (frame.type === "response.steer.accepted") {
      const first = this.submissions.find(item => item.parent === steer?.previous_response_id && item.id === undefined);
      if (!first || typeof steer?.id !== "string") throw new Error("Native steering replay acceptance does not match submitted input");
      first.id = steer.id;
    } else if (frame.type === "response.steer.failed") {
      const index = this.submissions.findIndex(item => steer?.id !== undefined
        ? item.id === steer.id
        : item.parent === steer?.previous_response_id && item.id === undefined);
      if (index >= 0) {
        const [failed] = this.submissions.splice(index, 1);
        this.bytes -= failed.bytes;
      }
    } else if (frame.type === "response.created") {
      if (this.current) {
        const committed = this.submissions.filter(item => item.parent === this.current && item.id !== undefined);
        // Byte-valid histories may exceed the runtime's positional-argument limit.
        for (const item of this.previousOutput) this.prefix.push(item);
        for (const submission of committed) {
          for (const item of submission.input) this.prefix.push(item);
        }
        for (const item of this.explicitInput) this.prefix.push(item);
        this.submissions = this.submissions.filter(item => !committed.includes(item));
      }
      this.explicitInput = [];
      this.explicitBytes = 0;
      this.previousOutput = [];
      this.outputItems.clear();
      this.current = String(response?.id);
    } else if (frame.type === "response.output_item.done") {
      const index = frame.output_index as number;
      if (!Number.isSafeInteger(index) || index < 0 || index > 10_000 || !record(frame.item)) throw new Error("Native steering replay output identity is invalid");
      const previous = this.outputItems.get(index);
      if (previous !== undefined) this.bytes -= Buffer.byteLength(JSON.stringify(previous));
      this.bytes += Buffer.byteLength(JSON.stringify(frame.item));
      this.check();
      this.outputItems.set(index, frame.item);
    } else if (response && ["response.completed", "response.incomplete", "response.failed"].includes(String(frame.type))) {
      const doneItems = [...this.outputItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
      const output = nativeResponseOutput(this.outputItems, response.output);
      for (const item of doneItems) this.bytes -= Buffer.byteLength(JSON.stringify(item));
      this.bytes += Buffer.byteLength(JSON.stringify(output));
      this.check();
      this.outputItems.clear();
      this.previousOutput = output;
      // Failed and steered parents are never presented to shared state as completed.
      // Their output is used only when a validated successor commits that prefix.
      if (frame.type === "response.completed") this.remember(this.prefix, { ...response, output });
    }
  }
  /** Release retained input, output and queued submissions when the owner detaches. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregisterAccounting?.();
    this.unregisterAccounting = undefined;
    this.prefix = [];
    this.previousOutput = [];
    this.submissions = [];
    this.explicitInput = [];
    this.outputItems.clear();
    this.bytes = 0;
  }
}

/** Test-only: shrink the aggregate pinned-journal ceiling (null restores the documented cap). */
export function setNativeControlReplayTotalCapForTests(capBytes: number | null): void {
  aggregateCapBytes = capBytes ?? MAX_NATIVE_CONTROL_REPLAY_TOTAL_BYTES;
}
