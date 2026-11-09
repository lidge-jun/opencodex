import type { AdapterEvent, OcxParsedRequest } from "../../types";
import { MuseMspError } from "./connection";
import { museContinuationOwner } from "./owner";
import type { MuseResponsesHandoff } from "./responses-handoff";
import type { MuseToolResult } from "./tool-result";
import type { MuseTurnSegments } from "./segment";

type SegmentRunner = Pick<MuseTurnSegments, "next">;
interface Turn {
  segments: SegmentRunner;
  handoff: MuseResponsesHandoff;
  shutdown: AbortController;
  close: () => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  busy: boolean;
  requestOptions: string;
  closing?: Promise<void>;
  removeInvalidation?: () => void;
  isValid?: () => boolean;
  onFinal?: (parsed: OcxParsedRequest) => void;
  onToolCommit?: (parsed: OcxParsedRequest) => void;
}

/** Bounded in-memory turn ownership; callers must supply trusted ingress and route context. */
export class MuseTurnRegistry {
  private readonly turns = new Map<string, Turn>();
  private closed = false;
  constructor(private readonly maxTurns = 16, private readonly ttlMs = 300_000) {
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 128 ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new MuseMspError("invalid_turn_registry");
  }

  /** Fail before launching a host when this owner is already active or at capacity. */
  assertAvailable(parsed: OcxParsedRequest): void {
    const owner = museContinuationOwner(parsed);
    if (!owner || this.closed || this.turns.has(owner) || this.turns.size >= this.maxTurns) throw new MuseMspError("unavailable_turn");
  }

  /** Opaque owner keys allow the runner to bound resources across lifecycle phases. */
  owners(): Iterable<string> { return this.turns.keys(); }

  /** Retire an invalidated owner's turn and all resources it owns. */
  async discard(parsed: OcxParsedRequest): Promise<void> {
    const owner = museContinuationOwner(parsed);
    if (owner) await this.release(owner);
  }

  /** Transfers resource ownership when registered; a rejected registration retains caller ownership. */
  async start(parsed: OcxParsedRequest, parts: { segments: SegmentRunner; handoff: MuseResponsesHandoff; close: () => Promise<void>; isValid?: () => boolean; invalidated?: AbortSignal; onFinal?: (parsed: OcxParsedRequest) => void; onToolCommit?: (parsed: OcxParsedRequest) => void },
    options: { timeoutMs: number; signal?: AbortSignal; onText?: (text: string) => void }): Promise<AdapterEvent[]> {
    const owner = museContinuationOwner(parsed);
    if (!owner || this.closed || this.turns.has(owner) || this.turns.size >= this.maxTurns) throw new MuseMspError("unavailable_turn");
    const shutdown = new AbortController();
    const timer = setTimeout(() => { void this.release(owner).catch(() => {}); }, this.ttlMs);
    timer.unref?.();
    const requestOptions = JSON.stringify(parsed.options);
    const turn: Turn = { ...parts, shutdown, timer, busy: true, requestOptions };
    this.turns.set(owner, turn);
    if (parts.invalidated) {
      const signal = parts.invalidated;
      const invalidated = () => { void this.release(owner, turn).catch(() => {}); };
      signal.addEventListener("abort", invalidated, { once: true });
      turn.removeInvalidation = () => signal.removeEventListener("abort", invalidated);
      if (signal.aborted) invalidated();
    }
    return this.run(owner, turn, parsed, options);
  }

  async continue(parsed: OcxParsedRequest, options: { timeoutMs: number; signal?: AbortSignal; beforeDispatch?: () => void; beforeResultCommit?: (result: Readonly<MuseToolResult>) => void; onText?: (text: string) => void }): Promise<AdapterEvent[]> {
    const owner = museContinuationOwner(parsed);
    const turn = owner && this.turns.get(owner);
    if (!owner || !turn || turn.busy || turn.closing || this.closed || JSON.stringify(parsed.options) !== turn.requestOptions) throw new MuseMspError("unavailable_turn");
    // Never deliver a client result after its request was already cancelled.
    if (options.signal?.aborted) throw new MuseMspError("cancelled");
    if (turn.isValid && !turn.isValid()) { await this.release(owner, turn); throw new MuseMspError("unavailable_turn"); }
    turn.busy = true;
    try { turn.handoff.submit(parsed, result => { options.beforeDispatch?.(); options.beforeResultCommit?.(result); turn.onToolCommit?.(parsed); }); }
    catch (error) { turn.busy = false; throw error; }
    return this.run(owner, turn, parsed, options);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.turns.keys()].map(owner => this.release(owner)));
  }

  private async run(owner: string, turn: Turn, parsed: OcxParsedRequest, options: { timeoutMs: number; signal?: AbortSignal; onText?: (text: string) => void }): Promise<AdapterEvent[]> {
    try {
      const onText = options.onText && ((text: string) => {
        if (options.signal?.aborted || turn.shutdown.signal.aborted || (turn.isValid && !turn.isValid())) throw new MuseMspError("turn_expired");
        options.onText!(text);
      });
      const events = await turn.segments.next(parsed, { timeoutMs: options.timeoutMs, requestSignal: options.signal, sessionSignal: turn.shutdown.signal, onText });
      if (turn.shutdown.signal.aborted || (turn.isValid && !turn.isValid())) throw new MuseMspError("turn_expired");
      if (!events.some(event => event.type === "tool_call_start")) {
        if (turn.onFinal) {
          turn.onFinal(parsed);
          turn.removeInvalidation?.();
          clearTimeout(turn.timer); turn.shutdown.abort();
          if (this.turns.get(owner) === turn) this.turns.delete(owner);
        } else await this.release(owner, turn);
      }
      return events;
    } catch (error) { await this.release(owner, turn); throw error; }
    finally { turn.busy = false; }
  }

  private async release(owner: string, expected?: Turn): Promise<void> {
    const turn = this.turns.get(owner);
    if (!turn || (expected && turn !== expected)) return;
    if (!turn.closing) {
      turn.removeInvalidation?.();
      clearTimeout(turn.timer); turn.shutdown.abort();
      // Keep the owner slot reserved until cleanup finishes so a replacement cannot
      // overlap resources from a previous turn. Share the same close with all callers.
      turn.closing = Promise.resolve().then(() => turn.close()).finally(() => {
        if (this.turns.get(owner) === turn) this.turns.delete(owner);
      });
    }
    await turn.closing;
  }
}
