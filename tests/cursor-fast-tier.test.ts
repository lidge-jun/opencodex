import { describe, expect, test } from "bun:test";
import { cursorFastCapableBases, upgradeToFast } from "../src/adapters/cursor/catalog";
import { createCursorRequest, cursorRequestEmitsFastVariant } from "../src/adapters/cursor/request-builder";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { decideTier } from "../src/providers/fastwire";
import { fastPolicyForModel, serviceTierSupportFromPolicy } from "../src/providers/service-tier";
import type { OcxParsedRequest, TierDecision } from "../src/types";

const FAST_DECISION: TierDecision = { kind: "set", value: "fast" };

function parsedFor(modelId: string, reasoning?: string, decision?: TierDecision): OcxParsedRequest {
  return {
    modelId,
    context: { systemPrompt: [], messages: [{ role: "user", content: "hi" }] },
    options: {
      ...(reasoning ? { reasoning } : {}),
      ...(decision ? { tierDecision: decision } : {}),
    },
  } as OcxParsedRequest;
}

const cursorConfig = () => providerConfigSeed(getProviderRegistryEntry("cursor")!);

/**
 * Codex's Fast toggle is OpenAI's `service_tier`, and Cursor has no tier field — its fast
 * product is a different model variant. Before this, `service_tier` on a Cursor route was
 * silently dropped and no Cursor row could advertise the toggle at all
 * (devlog 260902_cursor_unified_identity/020).
 *
 * These drive each new conditional path and assert the observable effect, rather than
 * asserting that a table contains a value.
 */
describe("Codex Fast reaches Cursor's fast variant", () => {
  test("only bases with a fast variant advertise the tier", () => {
    const config = cursorConfig();
    const support = (id: string) =>
      serviceTierSupportFromPolicy(fastPolicyForModel(config, id, "cursor"));

    for (const base of cursorFastCapableBases()) expect(support(base)).toBe(true);
    // No dead toggle: a base with no fast wire must publish definitive negative evidence,
    // not "unknown" (which Codex would render as an offerable tier).
    for (const base of ["kimi-k3", "gpt-5.6-sol", "glm-5.3", "gemini-3.7-flash"]) {
      expect(support(base)).toBe(false);
    }
  });

  test("the toggle produces a set decision only on a fast-capable base", () => {
    const config = cursorConfig();
    const decide = (id: string) =>
      decideTier(fastPolicyForModel(config, id, "cursor"), undefined, "priority");

    expect(decide("claude-opus-5")).toEqual(FAST_DECISION);
    expect(decide("grok-4.6")).toEqual(FAST_DECISION);
    expect(decide("kimi-k3")).toEqual({ kind: "drop" });
  });

  test("a thinking umbrella pick upgrades to thinking-fast, not the regular-fast sibling", () => {
    // The regular-fast sibling is a different product with a shorter ladder, and for
    // claude-opus-5 its regular family is quarantined.
    expect(createCursorRequest(parsedFor("cursor/claude-opus-5", "max")).modelId)
      .toBe("claude-opus-5-thinking-max");
    expect(createCursorRequest(parsedFor("cursor/claude-opus-5", "max", FAST_DECISION)).modelId)
      .toBe("claude-opus-5-thinking-max-fast");
    expect(upgradeToFast("claude-opus-5", "thinking")).toBe("thinkingFast");
  });

  test("grok keeps the parameterized fast shape instead of a flattened id", () => {
    const request = createCursorRequest(parsedFor("cursor/grok-4.6", "high", FAST_DECISION));
    expect(request.modelId).toBe("grok-4.6");
    expect(request.requestedModelParameters).toEqual([
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ]);
    // Off, it keeps the cursor- prefix the regular variant requires.
    expect(createCursorRequest(parsedFor("cursor/grok-4.6", "high")).modelId)
      .toBe("cursor-grok-4.6-high");
  });

  test("a base without a fast variant is byte-identical with the toggle on", () => {
    const off = createCursorRequest(parsedFor("cursor/kimi-k3", "max"));
    const on = createCursorRequest(parsedFor("cursor/kimi-k3", "max", FAST_DECISION));
    expect(on.modelId).toBe(off.modelId);
    expect(on.requestedModelParameters).toEqual(off.requestedModelParameters);
  });

  test("telemetry reports the variant that the wire will actually carry", () => {
    // tierLogForRunTurn runs BEFORE runTurn, so this must be computable from parsed alone.
    expect(cursorRequestEmitsFastVariant(parsedFor("cursor/claude-opus-5", "max", FAST_DECISION))).toBe(true);
    expect(cursorRequestEmitsFastVariant(parsedFor("cursor/grok-4.6", "high", FAST_DECISION))).toBe(true);
    expect(cursorRequestEmitsFastVariant(parsedFor("cursor/kimi-k3", "max", FAST_DECISION))).toBe(false);
    expect(cursorRequestEmitsFastVariant(parsedFor("cursor/claude-opus-5", "max"))).toBe(false);
  });

  test("an explicit legacy variant id still wins over the toggle", () => {
    // Alias retention: a pinned session naming a variant must not be re-pointed.
    expect(createCursorRequest(parsedFor("cursor/claude-opus-5-thinking", "high", FAST_DECISION)).modelId)
      .toBe("claude-opus-5-thinking-high-fast");
    expect(createCursorRequest(parsedFor("cursor/claude-opus-4-8-thinking-fast", "max")).modelId)
      .toBe("claude-opus-4-8-thinking-max-fast");
  });
});
