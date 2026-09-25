/**
 * Refuse a request whose features its path cannot carry (PF-06).
 *
 * LEAF MODULE (see `contract.ts`). The caller supplies the request path it computed for the
 * settled route (`path.ts`); this module only judges it. Only a declared `unsupported`
 * disposition refuses. A hop into `other` has no declared disposition and so never refuses by
 * itself, but a loss declared on an earlier known hop still does: an unknown adapter cannot
 * restore what the internal Responses body already dropped.
 */
import type { Protocol, ProtocolHop, ProtocolReasonCode } from "./contract";
import { featureEffectsForPath, unrepresentableFeatures, type ProtocolFeature } from "./features";

export type RepresentableVerdict =
  | { ok: true }
  | { ok: false; features: ProtocolFeature[]; reasonCodes: ProtocolReasonCode[] };

export function checkRepresentable(input: {
  inbound: Protocol;
  requestPath: readonly ProtocolHop[];
  features: Iterable<ProtocolFeature>;
  /** `UnrepresentablePolicy` from `settings.ts`, spelled out so this module stays a leaf. */
  policy: "legacy" | "reject";
}): RepresentableVerdict {
  if (input.policy !== "reject") return { ok: true };
  const { effects } = featureEffectsForPath(input.inbound, input.requestPath, input.features);
  const features = unrepresentableFeatures(effects);
  return features.length === 0 ? { ok: true } : { ok: false, features, reasonCodes: ["feature-unrepresentable"] };
}

/** Client-facing refusal text. Names feature keys only, never request content. */
export function unrepresentableMessage(features: readonly ProtocolFeature[]): string {
  return `The selected route cannot carry these request features: ${features.join(", ")}`;
}
