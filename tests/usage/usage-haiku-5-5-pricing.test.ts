/** Haiku 5.5 base/>100K rates, official pricing and provider listings read 2026-10-08. */
import { describe, expect, test } from "bun:test";
import { resolveCursorSelection } from "../../src/adapters/cursor/catalog";
import { estimateAttemptCost, estimateRequestCost, resolveMatchedPrice } from "../../src/usage/cost";
import { CONTEXT_TIERS, EXPECTED_PRICE_OVERLAYS, findContextTier, findExpectedPriceOverlay, type Cost4 } from "../../src/usage/expected-prices";

const BASE: Cost4 = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const CURSOR_BASES = ["claude-haiku-5-5", "claude-haiku-5.5", "claude-5.5-haiku"];
const cursorIds = CURSOR_BASES.flatMap(base => [base, ...LEVELS.map(level => `${base}-${level}`)]);
const rows: [string, string, number][] = [
  ...["anthropic", "anthropic-apikey", "opencode-go", "opencode-zen", "github-copilot", "devin", "devin-cli", "claude-cli"].map(provider => [provider, "claude-haiku-5-5", 1] as [string, string, number]),
  ["venice", "claude-haiku-5-5", 1.25],
  ...["", "global.", "us.", "eu.", "jp.", "au."].map(prefix => ["amazon-bedrock", `${prefix}anthropic.claude-haiku-5-5`, ["", "global."].includes(prefix) ? 1 : 1.1] as [string, string, number]),
  ...["openrouter", "vercel-ai-gateway", "zenmux"].map(provider => [provider, "anthropic/claude-haiku-5.5", 1] as [string, string, number]),
  ["cloudflare-ai-gateway", "anthropic/claude-haiku-5-5", 1], ["kiro", "claude-haiku-5.5", 1],
  ...cursorIds.map(id => ["cursor", id, 1] as [string, string, number]),
];

function rates(scale: number): Cost4 {
  return Object.fromEntries(Object.entries(BASE).map(([key, value]) => [key, Number((value * scale).toFixed(8))])) as unknown as Cost4;
}

function checkBoundary(provider: string, model: string, scale: number, inputTokens: number) {
  // The raw prompt crosses the boundary even though uncached input is only ~20K.
  const usage = { inputTokens, outputTokens: 1000, cacheReadInputTokens: 60_000, cacheCreationInputTokens: 20_000 };
  const request = { provider, model, usageStatus: "reported" as const, usage };
  const expected = rates(scale * (inputTokens > 100_000 ? 5 : 1));
  for (const estimate of [estimateRequestCost(request), estimateAttemptCost({ ...request, ordinal: 1 })]) {
    expect(estimate).not.toBeNull();
    expect(estimate!.contextTier).toBe(inputTokens > 100_000 ? "long" : undefined);
    expect(estimate!.cost.input).toBeCloseTo((inputTokens - 80_000) * expected.input / 1e6, 12);
    expect(estimate!.cost.output).toBeCloseTo(1000 * expected.output / 1e6, 12);
    expect(estimate!.cost.cacheRead).toBeCloseTo(60_000 * expected.cacheRead / 1e6, 12);
    expect(estimate!.cost.cacheWrite).toBeCloseTo(20_000 * expected.cacheWrite / 1e6, 12);
    expect(estimate!.cost.total).toBeCloseTo(((inputTokens - 80_000) * expected.input + 1000 * expected.output + 60_000 * expected.cacheRead + 20_000 * expected.cacheWrite) / 1e6, 12);
  }
}

describe("Haiku 5.5 exact provider pricing bands", () => {
  test("tier membership is exactly the audited provider/id set, with no priority relationship", () => {
    const actual = CONTEXT_TIERS.filter(row => row.modelId.includes("haiku"));
    expect(actual.map(row => `${row.provider}/${row.modelId}`).sort()).toEqual(rows.map(([provider, id]) => `${provider}/${id}`).sort());
    for (const row of actual) {
      expect(row.thresholdInputTokens).toBe(100_000);
      expect(row.inclusive).toBe(false);
      expect(row.multiplier).toEqual({ input: 5, output: 5, cacheRead: 5, cacheWrite: 5 });
      expect(row.confirmedPriorityRelation).toBeUndefined();
      expect(row.source).toContain("https://");
      expect(row.verifiedAt).toBe("2026-10-08");
    }
  });

  for (const [provider, model, scale] of rows) {
    test(`${provider}/${model} resolves its base price`, () => {
      expect(resolveMatchedPrice(provider, model)?.cost4).toEqual(rates(scale));
    });
    for (const input of [100_000, 100_001]) {
      test(`${provider}/${model} request and attempt at ${input}`, () => checkBoundary(provider, model, scale, input));
    }
  }

  test("an account-labelled Anthropic provider retains the native tier", () => {
    for (const input of [100_000, 100_001]) checkBoundary("anthropic-pabcdef", "claude-haiku-5-5", 1, input);
  });

  for (const base of CURSOR_BASES) {
    for (const effort of LEVELS) {
      test(`Cursor ${base} ${effort} selection reaches its priced wire id`, () => {
        const selected = resolveCursorSelection(base, effort);
        expect(selected).toMatchObject({ known: true, maxMode: false, wireId: `${base}-${effort}` });
        checkBoundary("cursor", selected.wireId, 1, 100_001);
      });
    }
  }

  test("published overlays and preemptive/derived provenance stay distinct", () => {
    for (const provider of ["anthropic", "anthropic-apikey"]) {
      expect(findExpectedPriceOverlay(provider, "claude-haiku-5-5")).toMatchObject({ cost4: BASE, status: "verified", verifiedAt: "2026-10-08" });
    }
    const cursor = EXPECTED_PRICE_OVERLAYS.filter(row => row.provider === "cursor" && row.modelId.includes("haiku"));
    expect(cursor.map(row => row.modelId).sort()).toEqual(cursorIds.sort());
    for (const row of cursor) {
      expect(row.status).toBe("verified");
      expect(row.source).toContain("https://cursor.com/docs/models/claude-haiku-5-5");
    }
    for (const provider of ["devin", "devin-cli", "venice"]) {
      const row = findExpectedPriceOverlay(provider, "claude-haiku-5-5")!;
      expect(row.status).toBe("verified-derived");
      expect(row.source).toContain(provider === "venice" ? "models.dev/api.json" : "preemptive");
      expect(estimateRequestCost({ provider, model: row.modelId, usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1 } })?.estimated).toBe(true);
    }
  });

  test("Kilo stays untiered above 100K, and Vertex gets no unsupported overlay", () => {
    const provider = "kilo", model = "anthropic/claude-haiku-5.5";
    expect(resolveMatchedPrice(provider, model)?.cost4).toEqual(BASE);
    expect(findContextTier(provider, model)).toBeUndefined();
    for (const inputTokens of [100_000, 100_001]) {
      const request = { provider, model, usageStatus: "reported" as const, usage: { inputTokens, outputTokens: 1000 } };
      for (const estimate of [estimateRequestCost(request), estimateAttemptCost({ ...request, ordinal: 1 })]) {
        expect(estimate?.contextTier).toBeUndefined();
        expect(estimate?.cost.total).toBeCloseTo((inputTokens * BASE.input + 1000 * BASE.output) / 1e6, 12);
      }
    }
    expect(findExpectedPriceOverlay("google-vertex", "claude-haiku-5-5@default")).toBeUndefined();
    expect(findContextTier("google-vertex", "claude-haiku-5-5@default")).toBeUndefined();
  });

  test("Sonnet 5.5 cache cut follows serving provenance; Bedrock remains unchanged", () => {
    for (const [provider, model] of [
      ["anthropic", "claude-sonnet-5-5"], ["anthropic-apikey", "claude-sonnet-5-5"],
      ["cursor", "claude-sonnet-5-5"], ["devin", "claude-sonnet-5-5"], ["devin-cli", "claude-sonnet-5-5"],
      ["openrouter", "anthropic/claude-sonnet-5.5"], ["vercel-ai-gateway", "anthropic/claude-sonnet-5.5"],
      ["kilo", "anthropic/claude-sonnet-5.5"], ["github-copilot", "claude-sonnet-5-5"],
      ["opencode-zen", "claude-sonnet-5-5"], ["cloudflare-ai-gateway", "anthropic/claude-sonnet-5-5"], ["zenmux", "anthropic/claude-sonnet-5.5"],
    ]) expect(resolveMatchedPrice(provider, model)?.cost4.cacheRead).toBe(0.1);
    expect(resolveMatchedPrice("venice", "claude-sonnet-5-5")?.cost4).toEqual({ input: 2.5, output: 12.5, cacheRead: 0.125, cacheWrite: 3.125 });
    for (const prefix of ["", "global.", "us.", "eu.", "jp.", "au."]) {
      expect(resolveMatchedPrice("amazon-bedrock", `${prefix}anthropic.claude-sonnet-5-5`)?.cost4.cacheRead).toBe(["", "global."].includes(prefix) ? 0.2 : 0.22);
    }
    for (const row of EXPECTED_PRICE_OVERLAYS.filter(row => row.modelId === "claude-sonnet-5-5" && row.provider !== "venice")) {
      expect(row.cost4.cacheRead).toBe(0.1);
      expect(row.verifiedAt).toBe("2026-10-08");
      expect(row.source).toContain("platform.claude.com/docs/en/about-claude/pricing");
    }
  });
});
