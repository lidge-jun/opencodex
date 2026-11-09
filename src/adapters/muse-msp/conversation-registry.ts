import type { OcxParsedRequest } from "../../types";
import { MuseMspError } from "./connection";
import { MuseConversationCheckpoint } from "./conversation-checkpoint";
import { museConversationDigest } from "./history";
import { museContinuationOwner } from "./owner";

type OwnedSession = {
  startTurn: (text: string, options: { timeoutMs: number; signal: AbortSignal }) => Promise<string>;
  close: () => Promise<void>;
  isValid: () => boolean;
  invalidated?: AbortSignal;
};
type Entry = { checkpoint: MuseConversationCheckpoint; session: OwnedSession; shutdown: AbortController;
  timer: ReturnType<typeof setTimeout>; busy: boolean; started: boolean; expected?: string; closing?: Promise<void>; onInvalidated?: () => void };

/**
 * Experimental owned-session retention. Callers must pass the exact rendered
 * client-visible completion and observe the MSP turn terminal before finish().
 */
export class MuseConversationRegistry {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(private readonly maxSessions = 16, private readonly ttlMs = 300_000) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 128 ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new MuseMspError("invalid_conversation_registry");
  }

  /** On success ownership transfers here; on failure it remains with the caller. */
  retain(completed: OcxParsedRequest, session: OwnedSession): void {
    const owner = museContinuationOwner(completed);
    if (!owner || this.closed || this.entries.has(owner) || this.entries.size >= this.maxSessions || !session.isValid()) throw new MuseMspError("unavailable_conversation");
    const checkpoint = new MuseConversationCheckpoint(completed), shutdown = new AbortController();
    const timer = setTimeout(() => { void this.release(owner).catch(() => {}); }, this.ttlMs);
    timer.unref?.();
    const entry: Entry = { checkpoint, session, shutdown, timer, busy: false, started: false };
    this.entries.set(owner, entry);
    if (session.invalidated) {
      entry.onInvalidated = () => { void this.release(owner, entry).catch(() => {}); };
      session.invalidated.addEventListener("abort", entry.onInvalidated, { once: true });
      if (session.invalidated.aborted) entry.onInvalidated();
    }
  }

  async resume(parsed: OcxParsedRequest, options: { timeoutMs: number; signal?: AbortSignal; beforeDispatch?: (userText: string) => void }): Promise<string> {
    const owner = museContinuationOwner(parsed), entry = owner && this.entries.get(owner);
    if (!owner || !entry || entry.busy || entry.closing || this.closed) throw new MuseMspError("unavailable_conversation");
    if (!entry.session.isValid()) { await this.release(owner, entry); throw new MuseMspError("unavailable_conversation"); }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000 || options.signal?.aborted) throw new MuseMspError("cancelled");
    const expected = museConversationDigest(parsed.context, parsed.options);
    const text = entry.checkpoint.next(parsed, options.beforeDispatch);
    entry.busy = true; entry.expected = expected;
    const signal = options.signal ? AbortSignal.any([options.signal, entry.shutdown.signal]) : entry.shutdown.signal;
    try {
      if (signal.aborted || this.closed || entry.closing || !entry.session.isValid()) throw new MuseMspError("unavailable_conversation");
      const turnId = await entry.session.startTurn(text, { timeoutMs: options.timeoutMs, signal });
      if (signal.aborted || entry.closing || !entry.session.isValid() || typeof turnId !== "string" || !turnId) throw new MuseMspError("unavailable_conversation");
      entry.started = true;
      return turnId;
    } catch (error) { await this.release(owner, entry); throw error; }
  }

  /** Called only inside the already-validated tool-result commit for the active turn. */
  advanceToolResult(parsed: OcxParsedRequest): void {
    const owner = museContinuationOwner(parsed), entry = owner && this.entries.get(owner);
    if (!owner || !entry || !entry.busy || !entry.started || entry.closing || !entry.expected || !entry.session.isValid()) {
      throw new MuseMspError("unavailable_conversation");
    }
    entry.expected = museConversationDigest(parsed.context, parsed.options);
  }

  /** A trusted caller invokes this only after observing the corresponding terminal event. */
  async finish(completed: OcxParsedRequest): Promise<void> {
    const owner = museContinuationOwner(completed), entry = owner && this.entries.get(owner);
    if (!owner || !entry || !entry.busy || !entry.started || entry.closing || !entry.expected) throw new MuseMspError("unavailable_conversation");
    if (!entry.session.isValid()) { await this.release(owner, entry); throw new MuseMspError("unavailable_conversation"); }
    try {
      const messages = completed.context.messages;
      if (museConversationDigest({ ...completed.context, messages: messages.slice(0, -1) }, completed.options) !== entry.expected) throw new MuseMspError("unavailable_conversation");
      entry.checkpoint = new MuseConversationCheckpoint(completed);
      entry.expected = undefined; entry.busy = false; entry.started = false;
    } catch (error) { await this.release(owner, entry); throw error; }
  }

  async close(): Promise<void> { this.closed = true; await Promise.all([...this.entries.keys()].map(owner => this.release(owner))); }

  async discard(parsed: OcxParsedRequest): Promise<void> {
    const owner = museContinuationOwner(parsed);
    if (owner) await this.release(owner);
  }

  private async release(owner: string, expected?: Entry): Promise<void> {
    const entry = this.entries.get(owner);
    if (!entry || (expected && entry !== expected)) return;
    if (!entry.closing) {
      clearTimeout(entry.timer); entry.shutdown.abort(); entry.expected = undefined;
      if (entry.onInvalidated) entry.session.invalidated?.removeEventListener("abort", entry.onInvalidated);
      entry.closing = Promise.resolve().then(() => entry.session.close()).finally(() => { if (this.entries.get(owner) === entry) this.entries.delete(owner); });
    }
    await entry.closing;
  }
}
