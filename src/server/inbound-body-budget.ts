import { DEFAULT_CONCURRENT_INBOUND_BODY_BYTES, resolveConcurrentInboundBodyLimitBytes } from "../lib/inbound-body-policy";
export { DEFAULT_CONCURRENT_INBOUND_BODY_BYTES, MAX_CONCURRENT_INBOUND_BODY_BYTES } from "../lib/inbound-body-policy";
export const MAX_QUEUED_INBOUND_BODIES = 32;
export const INBOUND_BODY_QUEUE_TIMEOUT_MS = 120_000;

export interface InboundBodyLease {
  /** Return unused allowance after the bounded reader measures the accepted body. */
  shrink(bytes: number): void;
  /** Return the remaining charge exactly once when the HTTP owner settles. */
  release(): void;
}

/** FIFO admission whose bounded waiters neither read uploads nor own reservations. */
export function createInboundBodyBudget(capacity: number, maxQueued = MAX_QUEUED_INBOUND_BODIES) {
  if (!Number.isSafeInteger(capacity) || capacity <= 0
    || !Number.isSafeInteger(maxQueued) || maxQueued < 0) {
    throw new RangeError("Invalid inbound body budget");
  }
  let reservedBytes = 0;
  let activeLeases = 0;
  const pending: Array<{ bytes: number; admit(): void }> = [];
  /** Only the FIFO head may consume newly available capacity. */
  const drain = (): void => {
    while (pending.length && pending[0]!.bytes <= capacity - reservedBytes) pending[0]!.admit();
  };
  /** Charge an allowance and give its HTTP owner an idempotent release handle. */
  const grant = (bytes: number): InboundBodyLease => {
    let held = bytes;
    let released = false;
    reservedBytes += held;
    activeLeases++;
    return {
      /** Never increase a reservation or accept an invalid measurement. */
      shrink(measured) {
        if (released || !Number.isFinite(measured) || measured < 0) return;
        const next = Math.min(held, Math.max(1, Math.ceil(measured)));
        reservedBytes -= held - next;
        held = next;
        drain();
      },
      /** Free only this lease, including when EOF and cancellation race. */
      release() {
        if (released) return;
        released = true;
        reservedBytes -= held;
        activeLeases--;
        drain();
      },
    };
  };
  return {
    /** Report the current shared allowance without confusing it with measured charges. */
    capacity: () => capacity,
    /** Startup configuration changes the same owner; existing leases and FIFO waiters survive. */
    setCapacity(bytes: number): void {
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new RangeError("Invalid inbound body capacity");
      capacity = bytes;
      drain();
    },
    /** Observe counters without exposing request bodies or identities. */
    snapshot: () => ({ reservedBytes, activeLeases, queuedRequests: pending.length }),
    /** Wait for an entire upload allowance; null preserves the caller's overload response. */
    acquire(bytes: number, signal: AbortSignal, waitMs = INBOUND_BODY_QUEUE_TIMEOUT_MS): Promise<InboundBodyLease | null> {
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > capacity) {
        return Promise.reject(new RangeError("Invalid inbound body reservation"));
      }
      if (signal.aborted) return Promise.reject(signal.reason);
      if (!pending.length && bytes <= capacity - reservedBytes) return Promise.resolve(grant(bytes));
      if (pending.length >= maxQueued || !Number.isFinite(waitMs) || waitMs <= 0) return Promise.resolve(null);
      return new Promise<InboundBodyLease | null>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        /** Detach every waiter resource before admitting, timing out, or rejecting it. */
        const cleanup = (): void => {
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
        };
        /** A cancelled head must not strand a smaller eligible follower. */
        const onAbort = (): void => {
          if (settled) return;
          cleanup();
          reject(signal.reason);
          drain();
        };
        const entry = { bytes,
          /** Transfer a queued caller to a charged lease once, before resolving it. */
          admit() {
            if (settled) return;
            cleanup();
            resolve(grant(bytes));
          },
        };
        pending.push(entry);
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          if (settled) return;
          cleanup();
          resolve(null);
          drain();
        }, Math.min(waitMs, INBOUND_BODY_QUEUE_TIMEOUT_MS));
        if (signal.aborted) onAbort();
      });
    },
  };
}

export type InboundBodyBudget = ReturnType<typeof createInboundBodyBudget>;
export const inboundBodyBudget = createInboundBodyBudget(DEFAULT_CONCURRENT_INBOUND_BODY_BYTES);
const requestLeases = new WeakMap<Request, InboundBodyLease>();

/** Adopt one startup policy for every listener without resetting live accounting. */
export function configureInboundBodyBudget(configured?: number): void {
  inboundBodyBudget.setCapacity(resolveConcurrentInboundBodyLimitBytes(configured));
}

/** Connect only the admitted HTTP request to its bounded reader; internal reads own no lease. */
export function bindInboundBodyLease(req: Request, lease: InboundBodyLease): () => void {
  requestLeases.set(req, lease);
  return () => { if (requestLeases.get(req) === lease) requestLeases.delete(req); };
}

/** Only an accepted, measured body can replace an HTTP owner's upload allowance. */
export function updateInboundBodyReservation(req: Request, bytes: number): void {
  requestLeases.get(req)?.shrink(bytes);
}
