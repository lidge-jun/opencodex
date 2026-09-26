/**
 * Issue #422 companion. The Mirasim relay is the one non-OpenAI destination that
 * speaks Codex's private `compaction_trigger` contract, because the proxy owns
 * its signed transport end to end. The guard is bound to the provider id, the
 * canonical relay host and the adapter together, so a rename, a re-pointed base
 * URL or a swapped adapter all fall back to plain summarization.
 *
 * This case lives beside responses-compaction-routing.test.ts rather than in it:
 * that file sits at its committed file-size cap, which only ever moves down.
 */
import { describe, expect, test } from "bun:test";
import { supportsNativeResponsesCompactEndpoint } from "../../src/providers/openai-tiers";
import type { OcxProviderConfig } from "../../src/types";

describe("supportsNativeResponsesCompactEndpoint (Mirasim, #422)", () => {
  const mirasim = {
    adapter: "mirasim",
    baseUrl: "https://relay.mirasim.ai",
    authMode: "oauth",
  } as OcxProviderConfig;

  test("accepts only the canonical Mirasim relay for native signed compact", () => {
    expect(supportsNativeResponsesCompactEndpoint("mirasim", mirasim)).toBe(true);
    expect(supportsNativeResponsesCompactEndpoint("mirasim", {
      ...mirasim,
      baseUrl: "https://gateway.example",
    })).toBe(false);
    expect(supportsNativeResponsesCompactEndpoint("renamed-mirasim", mirasim)).toBe(false);
    expect(supportsNativeResponsesCompactEndpoint("mirasim", {
      ...mirasim,
      adapter: "openai-responses",
    })).toBe(false);
  });
});
