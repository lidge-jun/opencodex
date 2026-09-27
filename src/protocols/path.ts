/**
 * The request path a settled route takes, derived from the lane the ingress chose and the
 * upstream wire of the final adapter. The observed trace (PF-02) and the planner (PF-03) both
 * call this, so a preview and the log of the same request can never disagree on the rule.
 *
 * LEAF MODULE (see `contract.ts`).
 */
import { deliveryModeForPath, type DeliveryMode, type Protocol, type ProtocolHop, type UpstreamWire } from "./contract";

/**
 * `native`: the ingress sent its own wire to a same-wire upstream.
 * `bridge`: the ingress projected the request into the Responses pipeline.
 */
export type ProtocolLane = "native" | "bridge";

export function requestPathForLane(inbound: Protocol, lane: ProtocolLane, upstream: UpstreamWire): ProtocolHop[] {
  if (inbound === "responses") {
    return upstream === "responses" ? ["responses", "responses"] : ["responses", "ir", upstream];
  }
  if (lane === "native") return [inbound, inbound];
  if (upstream === "responses") return [inbound, "responses"];
  return [inbound, "responses-internal", "ir", upstream];
}

/** Upstream first, client last; the internal Responses hop is not replayed on the way back. */
export function responsePathForLane(inbound: Protocol, lane: ProtocolLane, upstream: UpstreamWire): ProtocolHop[] {
  if (inbound === "responses") return upstream === "responses" ? ["responses", "responses"] : [upstream, "ir", "responses"];
  if (lane === "native") return [inbound, inbound];
  if (upstream === "responses") return ["responses", inbound];
  return [upstream, "ir", "responses-internal", inbound];
}

export function deliveryModeForLane(
  inbound: Protocol,
  lane: ProtocolLane,
  upstream: UpstreamWire,
): Exclude<DeliveryMode, "blocked"> {
  return deliveryModeForPath(requestPathForLane(inbound, lane, upstream));
}
