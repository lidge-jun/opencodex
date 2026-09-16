import type { NativeSteeringReplayObserver } from "./native-steering-replay";
import { createHash } from "node:crypto";
import { CODEX_WS_ID_MAX_BYTES, CodexWsCorrelation } from "./codex-ws-correlation";
import { codexWsCreateFrameExceedsLimit } from "./codex-ws-wire";

export const MAX_NATIVE_STEERS = 32;
export const MAX_NATIVE_STEERING_RESPONSES = 128;
export const NATIVE_STEERING_WAIT_MS = 90_000;
export const NATIVE_STEERING_TOOL_WAIT_MS = 30 * 60_000;

type Frame = Record<string, unknown>;
type Send = (frame: Frame) => void;
const responses = new WeakSet<Response>();
export function markNativeSteeringResponse(response: Response): Response { responses.add(response); return response; }
export function isNativeSteeringResponse(response: Response): boolean { return responses.has(response); }

function record(value: unknown): value is Frame {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= CODEX_WS_ID_MAX_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function fingerprint(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }

/** Typed, content-free local protocol rejection. */
export class NativeSteeringError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "NativeSteeringError"; }
}

/** Validate the narrow public steer envelope, not the much wider create schema. */
export function validateSteeringFrame(frame: Frame): void {
  const fail = () => { throw new NativeSteeringError("invalid_input", "Steering requires user-only input and a previous_response_id; extra envelope fields are not supported."); };
  if (frame.type !== "response.steer" || !validId(frame.previous_response_id)
    || Object.keys(frame).some(key => !["type", "previous_response_id", "input"].includes(key))) fail();
  if (typeof frame.input === "string") return;
  if (!Array.isArray(frame.input) || !frame.input.length) { fail(); return; }
  for (const item of frame.input) {
    if (!record(item) || item.role !== "user" || (item.type !== undefined && item.type !== "message")
      || Object.keys(item).some(key => !["type", "role", "content"].includes(key))) { fail(); return; }
    if (typeof item.content === "string") continue;
    if (!Array.isArray(item.content) || !item.content.length) { fail(); return; }
    for (const part of item.content) {
      if (!record(part) || !["input_text", "input_image", "input_file"].includes(String(part.type))
        || (part.type === "input_text" && typeof part.text !== "string")) fail();
    }
  }
}

type Parent = { unacknowledged: number; accepted: Set<string>; ended: boolean };

/** Only client-owned results can use the early-continuation path. */
function outputRequirement(item: unknown): Frame | undefined {
  if (!record(item) || typeof item.type !== "string") return;
  if (item.type === "mcp_approval_request") {
    if (!validId(item.id)) throw new Error("Native steering approval identity is invalid");
    return { type: "mcp_approval_response", approval_request_id: item.id };
  }
  const types: Record<string, string> = {
    function_call: "function_call_output", custom_tool_call: "custom_tool_call_output",
    local_shell_call: "local_shell_call_output", shell_call: "shell_call_output",
    computer_call: "computer_call_output", apply_patch_call: "apply_patch_call_output",
  };
  const type = Object.hasOwn(types, item.type) ? types[item.type] : undefined;
  if (!type) return;
  if (!validId(item.call_id)) throw new Error("Native steering tool-call identity is invalid");
  return { type, call_id: item.call_id };
}

function matchesRequirement(item: Frame, stub: Frame): boolean {
  // The wire may label a required result with its tool name, but the ordinary
  // function/custom output schema identifies the result by call_id, not name.
  return Object.entries(stub).every(([key, value]) =>
    key === "name" && item[key] === undefined || stable(item[key]) === stable(value));
}

/**
 * One downstream turn owns one dedicated native upstream socket, including all
 * automatic successors and required-input continuations. Never registered by a
 * caller-supplied response ID in global state; never lent to another account.
 *
 * Opt-in single-lane implementation. Continuations may supply saved tool results and new user messages
 * but cannot change settings/routing. General new turns still use normal dispatch.
 */
export class NativeSteeringChannel {
  relayActive = false;
  replayFactory?: () => NativeSteeringReplayObserver;
  private replay?: NativeSteeringReplayObserver;
  private send?: Send;
  private onFailure?: (error: Error) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly parents = new Map<string, Parent>();
  private readonly settings = new Map<string, string>();
  private currentId?: string;
  private correlation?: CodexWsCorrelation;
  private pendingParent?: string;
  private continuationSent = false;
  private lane: unknown;
  private finished = false;
  private everAttached = false;
  private required: Frame[] = [];
  private readonly advertised = new Map<string, Frame>();
  private advertisedBytes = 0;

  constructor(initial: Frame, private readonly idleMs = 300_000) {
    this.lane = initial.stream_id;
    for (const [key, value] of Object.entries(initial)) {
      if (!["type", "input", "previous_response_id", "stream", "stream_id"].includes(key)) this.settings.set(key, fingerprint(value));
    }
  }
  get attached(): boolean { return this.everAttached; }
  get ended(): boolean { return this.finished; }
  get hasOutstanding(): boolean {
    return [...this.parents.values()].some(parent => parent.unacknowledged > 0 || parent.accepted.size > 0);
  }
  get awaitingContinuation(): boolean { return this.pendingParent !== undefined; }

  /** Bind only after native credentials have been selected and admission passed. */
  attach(send: Send, onFailure: (error: Error) => void): () => void {
    if (this.send || this.currentId) throw new Error("native steering transport already owned");
    this.replay = this.replayFactory?.();
    this.everAttached = true;
    this.finished = false;
    this.send = send;
    this.onFailure = onFailure;
    return () => {
      if (this.send !== send) return;
      this.send = undefined;
      this.onFailure = undefined;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.correlation?.finish();
      this.correlation = undefined;
      this.parents.clear();
      this.required = [];
      this.advertised.clear();
      this.advertisedBytes = 0;
      this.replay?.dispose();
      this.replay = undefined;
    };
  }

  private wait(ms = NATIVE_STEERING_WAIT_MS): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.onFailure?.(new Error("Native steering continuation timed out; queued-input delivery is unknown. Do not automatically replay tools or steering input."));
    }, ms);
    this.timer.unref?.();
  }
  private liveSend(frame: Frame): void {
    if (!this.send || this.finished) throw new NativeSteeringError("steering_not_supported", "No active native WebSocket steering transport; this route may be disabled or using HTTP fallback.");
    if (codexWsCreateFrameExceedsLimit(JSON.stringify(frame))) throw new NativeSteeringError("invalid_input", "Native steering frame exceeds the upstream byte limit.");
    const rollback = this.replay?.submitted(frame);
    try { this.send(frame); } catch (error) { rollback?.(); throw error; }
  }

  steer(frame: Frame): void {
    validateSteeringFrame(frame);
    if (!this.send || this.finished) { this.liveSend(frame); return; }
    const target = this.parents.get(frame.previous_response_id as string);
    if (!target || frame.previous_response_id !== this.currentId || target.ended) {
      throw new NativeSteeringError("response_not_active", "The target response is not active on this connection.");
    }
    if ([...this.parents.values()].reduce((n, p) => n + p.unacknowledged + p.accepted.size, 0) >= MAX_NATIVE_STEERS) {
      throw new NativeSteeringError("too_many_pending_steers", "The native steering pending-submission limit was reached.");
    }
    // Count before send: fake transports, and some runtimes, deliver synchronously.
    target.unacknowledged += 1;
    this.wait();
    try { this.liveSend(frame); } catch (error) {
      target.unacknowledged -= 1;
      if (!this.hasOutstanding) { clearTimeout(this.timer); this.timer = undefined; }
      throw error;
    }
  }

  private advertise(item: unknown): void {
    const stub = outputRequirement(item);
    if (!stub) return;
    const key = JSON.stringify(stub);
    if (this.advertised.has(key)) return;
    const bytes = Buffer.byteLength(key);
    if (this.advertised.size >= 1024 || this.advertisedBytes + bytes > 256 * 1024) {
      throw new Error("Native steering advertised-input budget exceeded");
    }
    this.advertised.set(key, stub);
    this.advertisedBytes += bytes;
  }

  /** Returns false only when an ordinary create may use normal dispatch. */
  continue(frame: Frame): boolean {
    if (this.finished || !this.send) return false;
    const parent = this.currentId ? this.parents.get(this.currentId) : undefined;
    if (!parent?.ended || !this.currentId || frame.previous_response_id !== this.currentId) {
      if (this.hasOutstanding || this.continuationSent) throw new NativeSteeringError("steering_continuation_required", "Queued steering owns this connection; wait for the successor or send the required-input continuation, or explicitly stop the turn.");
      return false;
    }
    if (this.continuationSent) throw new NativeSteeringError("duplicate_continuation", "A required-input continuation was already sent for this parent.");
    // The client is allowed to return saved results before response.steer.pending.
    // In that case only calls actually advertised by this response authorize it.
    const required = this.pendingParent ? this.required : [...this.advertised.values()];
    if (!required.length) throw new NativeSteeringError("steering_continuation_required", "Wait for the automatic successor or server-identified required input.");
    if (frame.stream_id !== this.lane || frame.generate === false) throw new NativeSteeringError("invalid_input", "The continuation must use the same WebSocket lane and generate a response.");
    for (const [key, value] of Object.entries(frame)) {
      if (["type", "input", "previous_response_id", "stream", "stream_id"].includes(key)) continue;
      if (this.settings.get(key) !== fingerprint(value)) throw new NativeSteeringError("steering_settings_changed", "The experimental native steering continuation cannot change model or request settings; start a separate turn instead.");
    }
    const input = frame.input;
    if (!Array.isArray(input) || !input.length) throw new NativeSteeringError("invalid_input", "Supply the saved results for the required_input stubs exactly once; do not resend steering text.");
    const used = new Set<number>();
    for (const item of input) {
      // An explicit continuation may carry new user input after its saved results.
      // Reuse the narrow user-only validator so privileged roles cannot bypass routing.
      if (record(item) && item.role === "user") {
        validateSteeringFrame({ type: "response.steer", previous_response_id: this.currentId, input: [item] });
        continue;
      }
      const match = record(item) ? required.findIndex((stub, i) => !used.has(i) && matchesRequirement(item, stub)) : -1;
      if (match < 0) throw new NativeSteeringError("invalid_input", "Continuation input must match the pending tool-output or approval stubs.");
      used.add(match);
    }
    if (used.size !== required.length) throw new NativeSteeringError("invalid_input", "Every required tool output or approval must be supplied exactly once.");
    this.continuationSent = true;
    this.wait();
    try { this.liveSend(frame); } catch (error) { this.continuationSent = false; throw error; }
    return true;
  }

  /** Called on the ordered upstream wire, BEFORE the event is published to SSE. */
  observe(event: Frame): boolean {
    const type = event.type;
    if (!(type === "error" && event.stream_id == null) && (event.stream_id ?? undefined) !== (this.lane ?? undefined)) throw new Error("native steering WebSocket lane mismatch");
    const response = record(event.response) ? event.response : undefined;
    if (type === "response.created") {
      const id = response?.id;
      if (!validId(id) || this.parents.has(id) || this.parents.size >= MAX_NATIVE_STEERING_RESPONSES) throw new Error("native steering response identity or chain limit violated");
      if (this.currentId) {
        const parent = this.parents.get(this.currentId)!;
        if (!parent.ended || (!parent.accepted.size && !this.continuationSent)) throw new Error("unexpected native steering successor");
        if (response?.previous_response_id != null && response.previous_response_id !== this.currentId) throw new Error("native steering successor parent mismatch");
        parent.accepted.clear(); // response.created, not accepted, is the commit point.
      }
      this.currentId = id;
      this.parents.set(id, { unacknowledged: 0, accepted: new Set(), ended: false });
      this.pendingParent = undefined;
      this.required = [];
      this.advertised.clear();
      this.advertisedBytes = 0;
      this.continuationSent = false;
      this.correlation?.finish();
      this.correlation = new CodexWsCorrelation(true, () => false);
    }
    if (typeof type === "string" && type.startsWith("response.steer.")) {
      const steer = record(event.steer) ? event.steer : undefined;
      const parent = typeof steer?.previous_response_id === "string" ? this.parents.get(steer.previous_response_id) : undefined;
      if (!parent) throw new Error("native steering acknowledgement has an unknown parent");
      if (type === "response.steer.accepted") {
        if (!validId(steer?.id) || parent.unacknowledged < 1 || parent.accepted.has(steer.id)) throw new Error("unexpected native steering acceptance");
        parent.unacknowledged -= 1;
        parent.accepted.add(steer.id);
      } else if (type === "response.steer.failed") {
        if (steer?.id !== undefined) {
          if (!validId(steer.id) || !parent.accepted.delete(steer.id)) throw new Error("unexpected native steering failure");
        } else {
          if (parent.unacknowledged < 1) throw new Error("unexpected native steering rejection");
          parent.unacknowledged -= 1;
        }
      } else if (type === "response.steer.pending") {
        if (!validId(steer?.id) || !parent.accepted.has(steer.id) || !parent.ended
          || steer.previous_response_id !== this.currentId) throw new Error("unexpected native steering pending event");
        if (event.reason === "waiting_for_required_input") {
          if (!Array.isArray(event.required_input) || !event.required_input.length || event.required_input.length > 1024
            || event.required_input.some(item => !record(item) || typeof item.type !== "string" || item.type === "message")
            || Buffer.byteLength(JSON.stringify(event.required_input)) > 256 * 1024) throw new Error("native steering required-input budget or schema violated");
          if (this.pendingParent && stable(this.required) !== stable(event.required_input)) throw new Error("native steering required-input stubs changed");
          this.pendingParent = this.currentId;
          this.required = event.required_input as Frame[];
        }
        // Unknown reasons are preserved, not converted into a create or success.
      } else throw new Error("unsupported native steering control event");
    } else {
      this.correlation?.accept({ ...event, stream_id: undefined });
      if (type === "response.output_item.done") this.advertise(event.item);
      if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
        if (!this.currentId || response?.id !== this.currentId) throw new Error("native steering terminal identity mismatch");
        this.parents.get(this.currentId)!.ended = true;
        if (Array.isArray(response.output)) for (const item of response.output) this.advertise(item);
      }
    }
    if (type === "error") this.finished = true;
    else this.finished = this.currentId !== undefined && this.parents.get(this.currentId)!.ended && !this.hasOutstanding && !this.continuationSent;
    if (this.finished) { clearTimeout(this.timer); this.timer = undefined; }
    else if (this.hasOutstanding || this.continuationSent) this.wait(this.pendingParent && !this.continuationSent ? NATIVE_STEERING_TOOL_WAIT_MS : NATIVE_STEERING_WAIT_MS);
    else if (this.currentId) this.wait(this.idleMs);
    this.replay?.observe(event);
    return this.finished;
  }
}
