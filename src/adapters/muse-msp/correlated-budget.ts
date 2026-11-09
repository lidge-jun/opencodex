import type { IncomingMeta } from "../base";
import { MuseMspError } from "./connection";
import { MuseBudgetSlot } from "./budget-slot";
import { matchesMuseContinuationSend } from "./continuation-send";
import type { MuseToolResult } from "./tool-result";
import { MuseModelInputCheckpoint } from "./user-turn-send";

/**
 * One experimental gate per owned Muse host. The caller must authenticate
 * requests, bind this instance to that host, and enforce its network path.
 * Correlation alone is not a substitute for those requirements.
 */
export class MuseCorrelatedBudget {
  private readonly slot = new MuseBudgetSlot();
  private active?: { continuation: boolean; expected?: Readonly<MuseToolResult>; user?: { checkpoint: MuseModelInputCheckpoint; answer: string; text?: string };
    beginSend: () => () => void; beginDispatch: ReturnType<MuseBudgetSlot["bind"]>["beginDispatch"] };
  private closed = false;
  private started = false;

  async run<T>(incoming: IncomingMeta, targetKey: string, continuation: boolean,
    execute: (hooks: { beforeResultCommit: (result: Readonly<MuseToolResult>) => void }) => Promise<T>): Promise<T> {
    if (this.closed || this.active || (continuation ? !this.started : this.started)) throw new MuseMspError("budget_slot_unavailable");
    const lease = this.slot.bind(incoming, targetKey);
    if (!continuation) this.started = true;
    const active: NonNullable<MuseCorrelatedBudget["active"]> = { continuation, beginSend: lease.beginSend, beginDispatch: lease.beginDispatch };
    this.active = active;
    try {
      return await execute({ beforeResultCommit: result => {
        if (this.closed || this.active !== active || !active.continuation || active.expected ||
            !result || typeof result.callId !== "string" || !result.callId || typeof result.output !== "string") {
          throw new MuseMspError("invalid_budget_correlation");
        }
        active.expected = Object.freeze({ callId: result.callId, output: result.output });
      } });
    } finally {
      active.expected = undefined;
      if (this.active === active) this.active = undefined;
      lease.close();
    }
  }

  /** The previous model input and answer must come from this host's verified completed turn. */
  async runUserTurn<T>(incoming: IncomingMeta, targetKey: string, checkpoint: MuseModelInputCheckpoint, answer: string,
    execute: (hooks: { beforeUserDispatch: (text: string) => void }) => Promise<T>): Promise<T> {
    if (this.closed || this.active || !this.started || !(checkpoint instanceof MuseModelInputCheckpoint) || typeof answer !== "string" || !answer || Buffer.byteLength(answer) > 4 * 1024 * 1024) {
      throw new MuseMspError("budget_slot_unavailable");
    }
    const lease = this.slot.bind(incoming, targetKey);
    const active: NonNullable<MuseCorrelatedBudget["active"]> = { continuation: true, beginSend: lease.beginSend, beginDispatch: lease.beginDispatch, user: { checkpoint, answer } };
    this.active = active;
    try {
      return await execute({ beforeUserDispatch: text => {
        if (this.closed || this.active !== active || !active.user || active.user.text !== undefined ||
            typeof text !== "string" || !text || Buffer.byteLength(text) > 4 * 1024 * 1024) throw new MuseMspError("invalid_budget_correlation");
        active.user.text = text;
      } });
    } finally {
      active.user = undefined;
      if (this.active === active) this.active = undefined;
      lease.close();
    }
  }

  /** This check does not reserve a send; beginSend always checks again. */
  assertCorrelated(body: unknown): void {
    const active = this.active;
    const matches = active?.user ? !!active.user.text && active.user.checkpoint.matches(body, active.user.answer, active.user.text)
      : !!active?.expected && matchesMuseContinuationSend(body, active.expected);
    if (this.closed || !active || (active.continuation && !matches)) {
      throw new MuseMspError("uncorrelated_model_send");
    }
  }

  /** Synchronous check and reservation; invoke only after authenticating the POST. */
  beginSend(body: unknown): () => void {
    this.assertCorrelated(body);
    return this.active!.beginSend();
  }

  /** Bind the physical transport and cancellation to the same request as the admitted send. */
  beginDispatch(body: unknown, requireProviderFetch = false): ReturnType<ReturnType<MuseBudgetSlot["bind"]>["beginDispatch"]> {
    this.assertCorrelated(body);
    return this.active!.beginDispatch(requireProviderFetch);
  }

  close(): void { this.closed = true; if (this.active) { this.active.expected = undefined; this.active.user = undefined; } this.active = undefined; this.slot.close(); }
}
