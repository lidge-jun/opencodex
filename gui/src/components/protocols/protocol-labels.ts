import type { DeliveryMode, ProtocolHop } from "../../../../src/protocols/contract";
import type { ProtocolTraceV1 } from "../../../../src/protocols/dto";
import type { FeatureDisposition } from "../../../../src/protocols/features";
import type { TFn, TKey } from "../../i18n/shared";

/**
 * Localized labels for the closed protocol vocabulary. The records are exhaustive over the
 * contract's unions, so a new mode, hop or disposition fails the dashboard typecheck instead of
 * rendering a raw identifier.
 */
export const PROTOCOL_MODE_KEYS: Record<DeliveryMode, TKey> = {
  native: "logs.protocol.mode.native",
  translated: "logs.protocol.mode.translated",
  "legacy-bridge": "logs.protocol.mode.legacyBridge",
  blocked: "logs.protocol.mode.blocked",
};

export const FEATURE_DISPOSITION_KEYS: Record<FeatureDisposition, TKey> = {
  passthrough: "logs.protocol.disposition.passthrough",
  translated: "logs.protocol.disposition.translated",
  degraded: "logs.protocol.disposition.degraded",
  unsupported: "logs.protocol.disposition.unsupported",
};

const HOP_KEYS: Record<ProtocolHop, TKey> = {
  responses: "logs.protocol.wire.responses",
  chat: "logs.protocol.wire.chat",
  messages: "logs.protocol.wire.messages",
  other: "logs.protocol.wire.other",
  ir: "logs.protocol.hop.ir",
  "responses-internal": "logs.protocol.hop.internal",
};

const ARROW = " → ";

export function protocolHopLabel(hop: ProtocolHop, t: TFn): string {
  return t(HOP_KEYS[hop]);
}

export function protocolPathLabel(path: readonly ProtocolHop[], t: TFn): string {
  return path.map(hop => protocolHopLabel(hop, t)).join(ARROW);
}

/**
 * The compact list label: the client wire and the upstream wire, without the intermediate
 * hops the detail panel spells out. A refusal has no upstream, so it shows the client wire only.
 */
export function protocolCompactLabel(trace: ProtocolTraceV1, t: TFn): string {
  const inbound = protocolHopLabel(trace.inbound, t);
  if (trace.mode === "blocked") return inbound;
  const upstream = trace.upstream ?? trace.requestPath[trace.requestPath.length - 1];
  return upstream ? `${inbound}${ARROW}${protocolHopLabel(upstream, t)}` : inbound;
}
