/**
 * The source envelope of one inference request (PF-06).
 *
 * SERVER SIDE, not a leaf: it charges the request's translator budget. The envelope keeps the
 * body the ingress parsed, by reference, for the lifetime of the request and nothing longer —
 * it is a local of the ingress, never stored on a shared or long-lived object. Features are
 * scanned once, on first use, so a caller that never asks pays nothing. `freshBody()` hands out
 * an independent copy, charged under `request_copies`, so a consumer that rewrites its body in
 * place can never leak that rewrite into another consumer's input.
 */
import { jsonUtf8Bytes } from "../lib/json-byte-size";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { Protocol } from "./contract";
import { featuresFromBody, type ProtocolFeature } from "./features";

export interface ProtocolEnvelope {
  readonly inbound: Protocol;
  /** The request features, scanned from the source body on the first call and cached. */
  features(): ReadonlySet<ProtocolFeature>;
  /** A structured clone of the source body, charged to the translator budget. */
  freshBody(): Record<string, unknown>;
}

export function createProtocolEnvelope(input: {
  inbound: Protocol;
  body: Record<string, unknown>;
  translatorBudget: TranslatorBudget;
}): ProtocolEnvelope {
  const { inbound, body, translatorBudget } = input;
  let features: ReadonlySet<ProtocolFeature> | undefined;
  return {
    inbound,
    features() {
      features ??= featuresFromBody(inbound, body);
      return features;
    },
    freshBody() {
      // Charged before the copy exists, so an over-budget request fails without allocating it.
      translatorBudget.chargeRetained(jsonUtf8Bytes(body), { kind: "request_copies" });
      return structuredClone(body);
    },
  };
}
