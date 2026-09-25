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
