import { CodexWsCorrelation } from "./codex-ws-correlation";
import type { NativeResponseControl } from "./native-response-control";
import type { NativeSteeringReplayObserver } from "./native-steering-replay";
import {
  injectionError, injectionFingerprint, injectionId, injectionRecord as record, injectionResults,
  isInjectionRequest, MAX_NATIVE_INJECTIONS, MAX_NATIVE_INJECTION_BYTES, MAX_NATIVE_INJECTION_CALLS,
  NATIVE_INJECTION_ACK_MS, NATIVE_INJECTION_TOOL_MS,
  type FunctionResult, type InjectionFrame as Frame,
} from "./native-injection-protocol";

import { nativeResultKey, nativeResultMatches, nativeResultFingerprint, nativeSavedResults, nativeToolRequirement,
  type NativeToolRequirement } from "./native-tool-results";

type Call = { requirement: NativeToolRequirement; state: "available" | "queued" | "accepted" | "failed"; result?: string; recoverable?: boolean };
type Submission = { frame: Frame; results: FunctionResult[]; bytes: number };
const ENVELOPE = new Set(["type", "input", "previous_response_id", "stream", "stream_id"]);

/**
 * Injection-only multi-agent owner. Exactly one injection is on the physical wire
 * at a time because created acknowledgements contain a response ID, not a request
 * ID. Queued submissions, terminal delivery and caller-owned recovery are distinct.
 */
export class NativeInjectionChannel implements NativeResponseControl {
  readonly kind = "injection" as const;
  relayActive = false;
  replayFactory?: () => NativeSteeringReplayObserver;
  private replay?: NativeSteeringReplayObserver;
  private send?: (frame: Frame) => void;
  private onFailure?: (error: Error) => void;
  private currentId?: string;
  private correlation?: CodexWsCorrelation;
  private terminal?: Frame;
  private terminalRecorded = false;
  private continuationSent = false;
  private finished = false;
  private everAttached = false;
  private readonly seen = new Set<string>();
  private readonly calls = new Map<string, Call>();
  private callBytes = 0;
  private readonly queue: Submission[] = [];
  private queueBytes = 0;
  private inFlight?: Submission;
  private lastAckSequence = -1;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly settings = new Map<string, string>();
  private readonly lane: unknown;

  /** Pin the original settings and lane; construction never opens a connection. */
  constructor(initial: Frame, private readonly idleMs = 300_000,
    private readonly deadlines = { ackMs: NATIVE_INJECTION_ACK_MS, toolMs: NATIVE_INJECTION_TOOL_MS }) {
    if (!isInjectionRequest(initial)) injectionError("injection_not_supported", "Native injection requires explicit multi_agent.enabled.");
    this.lane = initial.stream_id ?? undefined;
    for (const [key, value] of Object.entries(initial)) if (!ENVELOPE.has(key)) this.settings.set(key, injectionFingerprint(value));
  }
  /** Report that the real dispatch boundary has selected this owner. */
  get attached(): boolean { return this.everAttached; }
  /** A terminal is not final until submitted results have acknowledgements. */
  get ended(): boolean { return this.finished; }

  /** Attach once, after routing/auth/admission, retaining no global response-ID lookup. */
  attach(send: (frame: Frame) => void, fail: (error: Error) => void): () => void {
    if (this.everAttached) throw new Error("Native injection transport is already owned.");
    this.replay = this.replayFactory?.();
    this.send = send; this.onFailure = fail; this.everAttached = true;
    return () => {
      if (this.send !== send) return;
      this.send = undefined; this.onFailure = undefined; this.finished = true;
      clearTimeout(this.ackTimer); clearTimeout(this.idleTimer);
      this.correlation?.finish(); this.calls.clear(); this.seen.clear(); this.queue.length = 0;
      this.inFlight = undefined; this.queueBytes = 0; this.callBytes = 0; this.terminal = undefined;
      this.replay?.dispose(); this.replay = undefined;
    };
  }
  /** Never reinterpret user steering as a function result, or silently mix beta modes. */
  steer(_frame: Frame): never {
    return injectionError("native_control_mode_mismatch", "This multi-agent turn owns an injection-only channel; start a separate turn for steering.");
  }
  /** Abort unknown-delivery state without HTTP fallback, resends or invented acceptance. */
  private fail(): void {
    this.finished = true;
    clearTimeout(this.ackTimer); clearTimeout(this.idleTimer);
    this.onFailure?.(new Error("Native injection transport failed or timed out; delivery is unknown. Do not automatically resend or rerun tools."));
  }
  /** Require the same live owner; an unbound or detached channel cannot authorize a send. */
  private live(): void {
    if (!this.send || this.finished) injectionError("injection_not_supported", "No live native injection transport is available on this route.");
  }
  /** Advertise client-owned function/custom calls and approvals, never hosted execution. */
  private advertise(item: unknown): void {
    const requirement = nativeToolRequirement(item);
    if (!requirement) return;
    const old = this.calls.get(requirement.key);
    if (old) {
      if (old.requirement.identity !== requirement.identity) throw new Error("Native result call identity was reused.");
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(requirement));
    if (this.calls.size >= MAX_NATIVE_INJECTION_CALLS || this.callBytes + bytes > 256 * 1024) throw new Error("Native injection call budget exceeded.");
    this.calls.set(requirement.key, { requirement, state: "available" }); this.callBytes += bytes;
  }
  /** Queue validated saved results; reserve each call before any possibly synchronous send. */
  inject(frame: Frame): void {
    this.live();
    if (frame.type !== "response.inject" || !injectionId(frame.response_id)
      || Object.keys(frame).some(key => !["type", "response_id", "input", "stream_id"].includes(key))) {
      injectionError("invalid_injection", "Invalid native injection envelope.");
    }
    if (frame.response_id !== this.currentId || (frame.stream_id ?? undefined) !== this.lane || this.continuationSent) {
      injectionError("injection_response_mismatch", "Injection must target the current response and lane on this connection.");
    }
    const results = injectionResults(frame.input);
    for (const item of results) {
      const call = this.calls.get(nativeResultKey(item));
      if (!call || !nativeResultMatches(item, call.requirement)) injectionError("injection_call_not_found", "The result does not match a completed function call on this connection.");
      if (call.state !== "available") injectionError("duplicate_injection", "This function result was already submitted; do not replay it.");
    }
    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(text);
    if (this.queue.length >= MAX_NATIVE_INJECTIONS || bytes + this.queueBytes > MAX_NATIVE_INJECTION_BYTES) {
      injectionError("injection_queue_full", "Native injection queue count or byte limit reached; no result was sent.");
    }
    // Detach from caller-owned objects before keeping data across asynchronous callbacks.
    const copy = JSON.parse(text) as Frame;
    const submission = { frame: copy, results: copy.input as FunctionResult[], bytes };
    for (const item of results) this.calls.get(nativeResultKey(item))!.state = "queued";
    this.queue.push(submission); this.queueBytes += bytes;
    this.pump();
  }
  /** Dispatch one queued frame; unrelated output cannot reset its acknowledgement deadline. */
  private pump(): void {
    if (this.inFlight || !this.queue.length || this.finished) return;
    this.live();
    const submission = this.queue[0];
    this.inFlight = submission;
    this.ackTimer = setTimeout(() => this.fail(), this.deadlines.ackMs);
    this.ackTimer.unref?.();
    try {
      this.replay?.submitted(submission.frame);
      this.send!(submission.frame);
    } catch {
      this.fail();
      injectionError("injection_delivery_unknown", "Injection dispatch failed; do not automatically resend or rerun tools.");
    }
  }
  /** Match an acknowledgement to the sole in-flight frame, before releasing the next send. */
  private acknowledge(event: Frame): void {
    const pending = this.inFlight;
    if (!pending || event.response_id !== this.currentId || !Number.isSafeInteger(event.sequence_number)
      || (event.sequence_number as number) <= this.lastAckSequence) throw new Error("Native injection acknowledgement identity mismatch.");
    const failed = event.type === "response.inject.failed";
    if (failed && (!record(event.error) || typeof event.error.code !== "string"
      || injectionFingerprint(event.input) !== injectionFingerprint(pending.results))) throw new Error("Native injection rejection does not match submitted results.");
    this.replay?.observe(event);
    this.lastAckSequence = event.sequence_number as number;
    for (const item of pending.results) {
      const call = this.calls.get(nativeResultKey(item))!;
      call.state = failed ? "failed" : "accepted";
      // Retain a digest, not another result body, for an explicitly rejected continuation.
      call.recoverable = failed && record(event.error) && event.error.code === "response_already_completed";
      if (call.recoverable) call.result = nativeResultFingerprint(item);
    }
    clearTimeout(this.ackTimer); this.ackTimer = undefined;
    this.inFlight = undefined; this.queue.shift(); this.queueBytes -= pending.bytes;
    // Do not let a synchronous fake peer publish the next ack before this event is relayed.
    if (this.queue.length) queueMicrotask(() => { try { this.pump(); } catch { this.fail(); } });
  }
  /** Commit terminal replay only when no submitted injection can change its accepted inputs. */
  private recordTerminal(): void {
    if (this.terminal && !this.terminalRecorded) { this.replay?.observe(this.terminal); this.terminalRecorded = true; }
  }
  /** Recover saved, explicitly rejected results on the same socket only when the client asks. */
  continue(frame: Frame): boolean {
    if (!this.send || this.finished) return false;
    if (this.queue.length || this.continuationSent) injectionError("injection_pending", "Wait for every injection acknowledgement before creating another response.");
    if (!this.terminal && frame.previous_response_id === this.currentId) {
      injectionError("injection_pending", "Wait for the response terminal before sending saved-result continuations.");
    }
    if (!this.terminal || frame.previous_response_id !== this.currentId) return false;
    if (this.terminal.type !== "response.completed") injectionError("injection_response_failed", "The parent response did not complete successfully.");
    if ((frame.stream_id ?? undefined) !== this.lane || frame.generate === false) injectionError("invalid_injection", "Use the same lane for an injection continuation.");
    for (const [key, value] of Object.entries(frame)) {
      if (!ENVELOPE.has(key) && this.settings.get(key) !== injectionFingerprint(value)) injectionError("injection_settings_changed", "A native injection continuation cannot change the pinned model or settings.");
    }
    for (const key of this.settings.keys()) {
      if (!Object.hasOwn(frame, key)) injectionError("injection_settings_changed", "A native injection continuation cannot change the pinned model or settings.");
    }
    const results = nativeSavedResults(frame.input);
    const required = [...this.calls.entries()].filter(([, call]) => call.state !== "accepted");
    if (!required.length || results.length !== required.length) injectionError("invalid_injection", "Supply every outstanding saved tool result exactly once.");
    for (const item of results) {
      const call = this.calls.get(nativeResultKey(item));
      if (!call || !nativeResultMatches(item, call.requirement) || call.state === "accepted" || call.state === "queued"
        || (call.state === "failed" && (!call.recoverable || call.result !== nativeResultFingerprint(item)))) {
        injectionError("invalid_injection", "Continuation input must match unsent or explicitly completion-rejected tool results.");
      }
    }
    if (Buffer.byteLength(JSON.stringify(frame)) > MAX_NATIVE_INJECTION_BYTES) injectionError("invalid_injection", "Native injection continuation exceeds its byte limit.");
    this.continuationSent = true;
    try { this.recordTerminal(); const copy = JSON.parse(JSON.stringify(frame)) as Frame; this.replay?.submitted(copy); this.send(copy); }
    catch { this.fail(); injectionError("injection_delivery_unknown", "Continuation delivery is unknown; do not automatically resend results."); }
    if (!this.finished) this.armIdle(this.deadlines.ackMs);
    return true;
  }
  /** Manage response/tool liveness independently of the non-resettable acknowledgement timer. */
  private armIdle(ms: number): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fail(), ms); this.idleTimer.unref?.();
  }
  /** Validate ordered upstream events while allowing acknowledgements after a response terminal. */
  observe(event: Frame): boolean {
    if ((event.stream_id ?? undefined) !== this.lane && !(event.type === "error" && event.stream_id == null)) throw new Error("Native injection lane mismatch.");
    const type = event.type;
    if (type === "error") { this.finished = true; return true; }
    if (type === "response.inject.created" || type === "response.inject.failed") this.acknowledge(event);
    else {
      if (typeof type === "string" && (type.startsWith("response.inject.") || type.startsWith("response.steer."))) throw new Error("Unsupported native injection control event.");
      const response = record(event.response) ? event.response : undefined;
      if (type === "response.created") {
        if (!injectionId(response?.id) || this.seen.has(response.id) || this.seen.size >= 128) throw new Error("Native injection response identity or chain limit violated.");
        if (this.currentId && (!this.continuationSent || !this.terminal || this.queue.length
          || (response.previous_response_id != null && response.previous_response_id !== this.currentId))) throw new Error("Unexpected native injection successor.");
        this.currentId = response.id; this.seen.add(response.id); this.calls.clear(); this.callBytes = 0;
        this.terminal = undefined; this.terminalRecorded = false; this.continuationSent = false; this.lastAckSequence = -1;
        this.correlation?.finish(); this.correlation = new CodexWsCorrelation(true, () => false);
      } else if (!this.currentId || this.terminal) throw new Error("Unexpected native injection event outside an active response.");
      this.correlation?.accept({ ...event, stream_id: undefined });
      if (type === "response.output_item.done") this.advertise(event.item);
      if (["response.completed", "response.failed", "response.incomplete"].includes(String(type))) {
        if (!this.currentId || response?.id !== this.currentId) throw new Error("Native injection terminal identity mismatch.");
        this.terminal = event;
        if (Array.isArray(response.output)) for (const item of response.output) this.advertise(item);
      } else this.replay?.observe(event);
    }
    const unresolved = [...this.calls.values()].some(call => call.state !== "accepted");
    this.finished = Boolean(this.terminal && !this.queue.length && !this.continuationSent
      && (this.terminal.type !== "response.completed" || !unresolved));
    if (this.finished) { this.recordTerminal(); clearTimeout(this.idleTimer); }
    else this.armIdle(this.continuationSent ? this.deadlines.ackMs : unresolved ? this.deadlines.toolMs : this.idleMs);
    return this.finished;
  }
}
