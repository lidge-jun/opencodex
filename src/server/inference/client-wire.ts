import type { Protocol } from "../../protocols/contract";

const clientWires = new WeakMap<Response, Protocol>();

/**
 * Record that `response` is already in `protocol`'s client wire, so an ingress can tell a body
 * it may pass through from a Responses body it still has to convert. Identity-keyed: a
 * rebuilt or cloned Response carries no mark. Returns the same response.
 */
export function markClientWire(response: Response, protocol: Protocol): Response {
  clientWires.set(response, protocol);
  return response;
}

/** The client wire `response` was marked with, or undefined for an unmarked response. */
export function clientWireOf(response: Response): Protocol | undefined {
  return clientWires.get(response);
}

/** What the request log of a client-wire response learns, in the order the stream learned it. */
export type ClientWireLogEvent =
  /** A Responses-vocabulary payload the legacy log tap would have inspected. */
  | { kind: "observe"; payload: Record<string, unknown> }
  | { kind: "terminal"; status: "completed" | "failed" | "incomplete"; payload: Record<string, unknown> }
  | { kind: "cancel" };

/**
 * A client-wire body cannot be tapped for the request log the way a Responses body is: its
 * frames are not Responses events. The producer records the facts the tap would have read, and
 * the deferred request log subscribes. Events recorded before the subscription are replayed to
 * it; the producer records at most a start payload, one terminal and one cancel.
 */
export interface ClientWireLog {
  record(event: ClientWireLogEvent): void;
  subscribe(listener: (event: ClientWireLogEvent) => void): void;
}

export function createClientWireLog(): ClientWireLog {
  let pending: ClientWireLogEvent[] | undefined = [];
  let listener: ((event: ClientWireLogEvent) => void) | undefined;
  const deliver = (event: ClientWireLogEvent) => {
    try { listener?.(event); } catch { /* logging never throws into the stream */ }
  };
  return {
    record(event) {
      if (pending) pending.push(event);
      else deliver(event);
    },
    subscribe(next) {
      if (listener) return;
      listener = next;
      const buffered = pending ?? [];
      pending = undefined;
      for (const event of buffered) deliver(event);
    },
  };
}

const clientWireLogs = new WeakMap<Response, ClientWireLog>();

/** Attach the log channel a client-wire response reports through. Returns the same response. */
export function attachClientWireLog(response: Response, log: ClientWireLog): Response {
  clientWireLogs.set(response, log);
  return response;
}

export function clientWireLogOf(response: Response): ClientWireLog | undefined {
  return clientWireLogs.get(response);
}
