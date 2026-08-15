import { describe, expect, test } from "bun:test";
import {
  cloneProviderOpaqueToolCallMetadata,
  providerMetadataFromResponsesFunctionCall,
  responsesExtraContentFromProviderMetadata,
} from "../src/responses/provider-opaque-metadata";
import type { OcxProviderOpaqueToolCallMetadata } from "../src/types";

const SIG_A = "sig-alpha-opaque-value";
const SIG_B = "sig-beta-opaque-value";

describe("provider-opaque tool-call metadata (#1735)", () => {
  test("round-trips a signature through the Responses wire shape unchanged", () => {
    const metadata: OcxProviderOpaqueToolCallMetadata = { google: { thoughtSignature: SIG_A } };
    const wire = responsesExtraContentFromProviderMetadata(metadata);
    expect(wire).toEqual({ extra_content: { google: { thought_signature: SIG_A } } });
    // The value is opaque: what comes back out must be byte-identical to what went in.
    expect(providerMetadataFromResponsesFunctionCall(wire)).toEqual(metadata);
  });

  test("parallel calls keep distinct signatures and never share one", () => {
    const a = cloneProviderOpaqueToolCallMetadata({ google: { thoughtSignature: SIG_A } });
    const b = cloneProviderOpaqueToolCallMetadata({ google: { thoughtSignature: SIG_B } });
    expect(a?.google?.thoughtSignature).toBe(SIG_A);
    expect(b?.google?.thoughtSignature).toBe(SIG_B);
    // Clones are independent objects, so mutating one rebuilt call cannot reach another.
    expect(a).not.toBe(b);
    a!.google!.thoughtSignature = "mutated";
    expect(b?.google?.thoughtSignature).toBe(SIG_B);
  });

  test("absent, malformed, and unknown payloads carry nothing", () => {
    expect(providerMetadataFromResponsesFunctionCall(undefined)).toBeUndefined();
    expect(providerMetadataFromResponsesFunctionCall({})).toBeUndefined();
    expect(providerMetadataFromResponsesFunctionCall({ extra_content: "nope" })).toBeUndefined();
    expect(providerMetadataFromResponsesFunctionCall({ extra_content: { google: "nope" } })).toBeUndefined();
    expect(providerMetadataFromResponsesFunctionCall({ extra_content: { google: { thought_signature: 42 } } })).toBeUndefined();
    expect(providerMetadataFromResponsesFunctionCall({ extra_content: { google: { thought_signature: "" } } })).toBeUndefined();
    // A sibling vendor key is not modeled, so it cannot ride through as passthrough state.
    expect(providerMetadataFromResponsesFunctionCall({ extra_content: { other: { secret: "x" } } })).toBeUndefined();
    expect(responsesExtraContentFromProviderMetadata(undefined)).toBeUndefined();
    expect(responsesExtraContentFromProviderMetadata({})).toBeUndefined();
  });

  test("an oversized signature is refused at every boundary", () => {
    // Matches the ceiling the Antigravity replay cache already enforces: a token this large is
    // not a real signature, and carrying it would push unbounded state through history replay.
    const oversized = "x".repeat(64 * 1024 + 1);
    const metadata = { google: { thoughtSignature: oversized } };
    expect(providerMetadataFromResponsesFunctionCall({ extra_content: { google: { thought_signature: oversized } } })).toBeUndefined();
    expect(responsesExtraContentFromProviderMetadata(metadata)).toBeUndefined();
    expect(cloneProviderOpaqueToolCallMetadata(metadata)).toBeUndefined();

    // The boundary itself still passes.
    const atLimit = "y".repeat(64 * 1024);
    expect(cloneProviderOpaqueToolCallMetadata({ google: { thoughtSignature: atLimit } })?.google?.thoughtSignature)
      .toHaveLength(64 * 1024);
  });
});
