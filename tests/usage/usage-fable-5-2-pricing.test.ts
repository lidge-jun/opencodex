/** Claude Fable 5.2 list prices, official pricing and provider listings read 2026-11-10. */
import { expect, test } from "bun:test";
import { resolveMatchedPrice } from "../../src/usage/cost";
import { findExpectedPriceOverlay } from "../../src/usage/expected-prices";

// Claude Fable 5.2 (2026-11-09): 8 / 40 / 10.00 cache write and the same 0.025x cache-hit
// footnote as Fable 5.1 (0.20). Every surface that publishes it carries that list rate.
test("claude-fable-5-2 resolves to the official Fable 5.2 price on every exposing surface", () => {
  const COST4 = { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 };
  for (const provider of ["anthropic", "anthropic-apikey"]) {
    expect(findExpectedPriceOverlay(provider, "claude-fable-5-2")?.cost4, provider).toEqual(COST4);
    expect(resolveMatchedPrice(provider, "claude-fable-5-2"), provider).toMatchObject({
      provider,
      modelId: "claude-fable-5-2",
      cost4: COST4,
      source: "jawcode",
      jawcodeProvider: "anthropic",
      status: "verified",
    });
  }
  expect(resolveMatchedPrice("anthropic-pb51d9b", "claude-fable-5-2")?.cost4).toEqual(COST4);
  // Cursor publishes the same list rate. The bare and thinking spellings canonicalize onto the
  // one overlay row; a flat effort suffix has no capability row yet and stays unpriced until
  // Cursor's live roster shows the real ids.
  for (const spelling of ["claude-fable-5-2", "claude-fable-5.2", "claude-fable-5-2-thinking-high"]) {
    expect(resolveMatchedPrice("cursor", spelling), spelling).toMatchObject({ cost4: COST4, source: "expected", status: "verified" });
    expect(findExpectedPriceOverlay("cursor", spelling)?.modelId, spelling).toBe("claude-fable-5-2");
  }
  expect(findExpectedPriceOverlay("cursor", "claude-fable-5-2-high")).toBeUndefined();
  for (const provider of ["devin", "devin-cli"]) {
    expect(resolveMatchedPrice(provider, "claude-fable-5-2"), provider).toMatchObject({ cost4: COST4, source: "expected", status: "verified-derived" });
  }
  // Generated bundles (anthropic, amazon-bedrock, openrouter) price their own rows, including
  // OpenRouter's repriced Fable "latest" alias. Kilo, Vercel, Venice, opencode-zen and Copilot are
  // not generated bundles (scripts/generate-model-metadata.ts): their snapshot rows are source-only
  // and the base id resolves through the Anthropic vendor fallback.
  for (const [provider, model] of [
    ["openrouter", "anthropic/claude-fable-5.2"],
    ["openrouter", "~anthropic/claude-fable-latest"],
    ["kilo", "anthropic/claude-fable-5.2"],
    ["vercel-ai-gateway", "anthropic/claude-fable-5.2"],
    ["venice", "claude-fable-5-2"],
    ["opencode-zen", "claude-fable-5-2"],
    ["github-copilot", "claude-fable-5-2"],
    ["amazon-bedrock", "anthropic.claude-fable-5-2"],
    ["amazon-bedrock", "global.anthropic.claude-fable-5-2"],
  ] as const) {
    expect(resolveMatchedPrice(provider, model)?.cost4, `${provider}/${model}`).toEqual(COST4);
  }
  expect(resolveMatchedPrice("amazon-bedrock", "us.anthropic.claude-fable-5-2")?.cost4)
    .toEqual({ input: 8.8, output: 44, cacheRead: 0.22, cacheWrite: 11 });
  // Fable 5.1 keeps its own, higher price.
  expect(resolveMatchedPrice("anthropic", "claude-fable-5-1")?.cost4.input).toBe(10);
});

test("ids the vendor fallback cannot reach carry their own overlays", () => {
  // Kilo's fable-latest alias now points at Fable 5.2; Vercel's fast id is the 2x fast tuple.
  expect(resolveMatchedPrice("kilo", "~anthropic/claude-fable-latest")).toMatchObject({
    cost4: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }, source: "expected", status: "verified",
  });
  expect(resolveMatchedPrice("vercel-ai-gateway", "anthropic/claude-fable-5.2-fast")).toMatchObject({
    cost4: { input: 16, output: 80, cacheRead: 0.4, cacheWrite: 20 }, source: "expected", status: "verified",
  });
});
