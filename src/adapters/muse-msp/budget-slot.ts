import type { IncomingMeta } from "../base";
import { MuseMspError } from "./connection";
import { createMuseOpaqueBudgetFence } from "./opaque-budget";

/** Experimental request lifetime binding. A caller must authenticate and correlate each send. */
export class MuseBudgetSlot {
  private current: object | undefined;
  private closed = false;

  bind(incoming: IncomingMeta, targetKey: string): { admit: () => void; beginSend: () => () => void;
    beginDispatch: (requireProviderFetch?: boolean) => { finish: () => void; providerFetch?: typeof globalThis.fetch; signal?: AbortSignal }; close: () => void } {
    if (this.closed || this.current) throw new MuseMspError("budget_slot_unavailable");
    const identity = {};
    const requestIncoming = { ...incoming };
    // Validate before taking ownership, so invalid input cannot strand the slot.
    const validate = createMuseOpaqueBudgetFence(requestIncoming, targetKey);
    validate.close();
    this.current = identity;
    let released = false, ordinal = 0, active = 0;
    const releaseSlot = () => { if (released && active === 0 && this.current === identity) this.current = undefined; };
    const beginSend = () => {
      if (released || this.closed || this.current !== identity) throw new MuseMspError("budget_slot_unavailable");
      const fence = createMuseOpaqueBudgetFence(requestIncoming, targetKey, ordinal + 1);
      try { fence.admit(); ordinal++; } catch (error) { fence.close(); throw error; }
      active++;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        try { fence.close(); } finally { active--; releaseSlot(); }
      };
    };
    return {
      admit: () => { beginSend()(); },
      beginSend,
      beginDispatch: requireProviderFetch => {
        if (requireProviderFetch && !requestIncoming.providerFetch) throw new MuseMspError("provider_transport_unavailable");
        return { finish: beginSend(), providerFetch: requestIncoming.providerFetch, signal: requestIncoming.abortSignal };
      },
      close: () => {
        if (released) return;
        released = true;
        releaseSlot();
      },
    };
  }

  close(): void { this.closed = true; this.current = undefined; }
}

/** Experimental: scope the admitted send handle to one request's execution. */
export async function withMuseBudgetLease<T>(slot: MuseBudgetSlot, incoming: IncomingMeta, targetKey: string,
  run: (lease: ReturnType<MuseBudgetSlot["bind"]>) => Promise<T>): Promise<T> {
  const lease = slot.bind(incoming, targetKey);
  try { return await run(lease); } finally { lease.close(); }
}

/**
 * Experimental CLI-style segment accounting. One reservation covers one opaque
 * segment, not a verified physical-send count. Keep its producer alive until the
 * segment returns so observed terminal usage can still settle against it.
 */
export async function withMuseOpaqueSegment<T>(slot: MuseBudgetSlot, incoming: IncomingMeta, targetKey: string,
  run: () => Promise<T>): Promise<T> {
  return withMuseBudgetLease(slot, incoming, targetKey, async lease => {
    const finish = lease.beginSend();
    try { return await run(); } finally { finish(); }
  });
}
