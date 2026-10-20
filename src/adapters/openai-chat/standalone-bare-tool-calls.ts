import { TRANSLATOR_MAX_CALL_ARGUMENT_BYTES, type TranslatorBudget } from "../../lib/translator-budget";
import { jsonUtf8Bytes } from "../../lib/json-byte-size";
import type { AdapterEvent } from "../../types";
import {
  hasNestedSerializedToolCallHeader, MAX_STANDALONE_CANDIDATES, recoverStandaloneBareBlocks, reconcileSerializedToolCallEvents, scanSerializedToolCalls, SerializedToolCallContentBuffer,
  type FreeformToolIdentity, type StructuredToolCallReference,
} from "./serialized-tool-call-content";

const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;
type BareCall = Pick<ReturnType<typeof recoverStandaloneBareBlocks>[number], "name" | "input">;
const isMiMo = (model: string | undefined) => /(?:^|[/-])mimo-v2(?:\.|$)/i.test(model ?? "");
const argumentsFor = (call: BareCall) => JSON.stringify({ input: call.input });
function* callEvents(call: BareCall, id: string, restore: (name: string) => string): Generator<AdapterEvent> {
  yield { type: "tool_call_start", id, name: restore(call.name) };
  yield { type: "tool_call_delta", arguments: argumentsFor(call) };
  yield { type: "tool_call_end" };
}

/** An explicitly separate policy for bare blocks with NO structured calls, never identified wrappers. */
export class StandaloneBareToolCallBuffer extends SerializedToolCallContentBuffer {
  private candidates: BareCall[] = [];
  private candidateBytes = 0;
  private disabled = false;
  private readonly eligible: boolean;

  constructor(
    private readonly recoveryBudget: TranslatorBudget,
    model: string | undefined,
    private readonly freeformTools: ReadonlyMap<string, FreeformToolIdentity>,
  ) {
    super(recoveryBudget, isMiMo(model) && freeformTools.size > 0);
    this.eligible = isMiMo(model) && freeformTools.size > 0;
  }

  /** Retain candidate inputs only, with aggregate and per-call limits; overflow disables the batch. */
  private remember(calls: BareCall[]): void {
    if (this.disabled || calls.length === 0) return;
    const sizes = calls.map(call => jsonUtf8Bytes({ name: call.name, input: call.input }));
    const bytes = sizes.reduce((sum, size) => sum + size, 0);
    if (sizes.some(size => size > TRANSLATOR_MAX_CALL_ARGUMENT_BYTES)
        || this.candidateBytes + bytes > MAX_CANDIDATE_BYTES || this.candidates.length + calls.length > MAX_STANDALONE_CANDIDATES) {
      this.clearCandidates();
      this.disabled = true;
      return;
    }
    const retained = this.recoveryBudget.reserveTransient(bytes, { kind: "live_transient" });
    try {
      const temporary = this.recoveryBudget.reserveTransient(bytes, { kind: "live_transient" });
      try {
        // Detach small inputs from a large released answer's backing string.
        const copies = calls.map(({ name, input }) => JSON.parse(JSON.stringify({ name, input })) as BareCall);
        this.candidates.push(...copies);
        this.candidateBytes += bytes;
        retained.commitRetained();
      } finally { temporary.release(); }
    } catch (error) {
      retained.release();
      throw error;
    }
  }

  protected override releaseBounded(): AdapterEvent[] {
    if (!this.eligible || this.disabled) return super.releaseBounded();
    const text = this.current();
    const scan = scanSerializedToolCalls(text, this.context, true);
    if (scan.overflow || scan.incomplete || scan.calls.some(call => hasNestedSerializedToolCallHeader(call.body))) {
      // We cannot safely recognize a later inner block after losing its unresolved outer body.
      this.clearCandidates();
      this.disabled = true;
      return super.releaseBounded();
    }
    this.remember(recoverStandaloneBareBlocks(text, this.freeformTools, this.context));
    return super.releaseBounded();
  }

  *recoverStandalone(noStructuredCalls: boolean, nextId: () => string, restore: (name: string) => string): Generator<AdapterEvent> {
    if (!noStructuredCalls) {
      this.clearCandidates();
      this.disabled = true;
      return;
    }
    if (!this.eligible || this.disabled) return;
    if (scanSerializedToolCalls(this.current(), this.context, true).overflow) {
      this.clearCandidates();
      this.disabled = true;
      return;
    }
    const held = recoverStandaloneBareBlocks(this.current(), this.freeformTools, this.context);
    this.remember(held);
    // The first terminal flush is the only recovery decision; content after it cannot authorize a call.
    if (this.disabled || this.candidates.length === 0) { this.disabled = true; return; }
    yield* this.drainRanges(held);
    for (const call of this.candidates) yield* callEvents(call, nextId(), restore);
    this.clearCandidates();
    this.disabled = true;
  }

  private clearCandidates(): void {
    this.recoveryBudget.releaseRetained(this.candidateBytes, { kind: "live_transient" });
    this.candidateBytes = 0;
    this.candidates = [];
  }

  override dispose(): void {
    this.clearCandidates();
    super.dispose();
  }
}

/** Buffered counterpart; the existing structured-call/identified-wrapper reconciler owns its path. */
export function reconcileStandaloneBareToolCallEvents(
  events: AdapterEvent[], start: number, end: number,
  structuredCalls: readonly StructuredToolCallReference[], budget: TranslatorBudget,
  model: string | undefined, freeformTools: ReadonlyMap<string, FreeformToolIdentity>, restore: (name: string) => string,
): void {
  if (structuredCalls.length > 0 || !isMiMo(model) || freeformTools.size === 0) {
    reconcileSerializedToolCallEvents(events, start, end, structuredCalls, budget);
    return;
  }
  const buffer = new StandaloneBareToolCallBuffer(budget, model, freeformTools);
  const reconciled: AdapterEvent[] = [];
  try {
    for (const event of events.slice(start, end)) {
      if (event.type !== "text_delta") reconciled.push(...buffer.hold(event).filter(held => held.type !== "heartbeat"));
      else {
        const text = buffer.ingest(event.text);
        if (text) reconciled.push({ type: "text_delta", text });
      }
    }
    let sequence = 0;
    reconciled.push(...buffer.recoverStandalone(true, () => `call_${++sequence}`, restore), ...buffer.drain([]));
  } finally {
    buffer.dispose();
  }
  events.splice(start, end - start, ...reconciled);
}
