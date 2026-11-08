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
  /** The source body itself, uncharged, for checks that only read it; a rewrite takes `freshBody()`. */
  readBody(): Readonly<Record<string, unknown>>;
  /** A structured clone of the source body, charged to the translator budget. */
  freshBody(): Record<string, unknown>;
  /** Hand back the charge of a `freshBody()` copy no longer needed; later calls are no-ops. */
  releaseBody(copy: Record<string, unknown>): void;
}

export function createProtocolEnvelope(input: {
  inbound: Protocol;
  body: Record<string, unknown>;
  translatorBudget: TranslatorBudget;
}): ProtocolEnvelope {
  const { inbound, body, translatorBudget } = input;
  let features: ReadonlySet<ProtocolFeature> | undefined;
  // The copy's own size may change once its holder rewrites it, so the charge is remembered.
  const charged = new WeakMap<object, number>();
  return {
    inbound,
    features() {
      features ??= featuresFromBody(inbound, body);
      return features;
    },
    readBody() {
      return body;
    },
    freshBody() {
      // Charged before the copy exists, so an over-budget request fails without allocating it.
      const bytes = jsonUtf8Bytes(body);
      translatorBudget.chargeRetained(bytes, { kind: "request_copies" });
      const copy = structuredClone(body);
      charged.set(copy, bytes);
      return copy;
    },
    releaseBody(copy) {
      const bytes = charged.get(copy);
      if (bytes === undefined) return;
      charged.delete(copy);
      translatorBudget.releaseRetained(bytes, { kind: "request_copies" });
    },
  };
}
