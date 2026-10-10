# Claude 5.5 usage attribution while preserving discovered wire routing

Depends on: audited roadmap and explicit ROADMAP LOCKED. Revalidate current dev and #6497 before B. No new public type/enum or persistence field is introduced.

## Exact file map

MODIFY src/providers/antigravity-models.ts only in ANTIGRAVITY_USAGE_BASE_BY_ID (currently :754-775). Preserve discoveredAntigravityEffortWireModelId precedence (:667), snapshot scoping, partial-family behavior and existing 4.6 IDs. Add only deterministic known Claude 5.5 base/tier usage identities before return rev:

```diff
+  for (const base of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
+    rev[base] = base;
+    for (const effort of ANTIGRAVITY_DISCOVERY_EFFORTS) rev[`${base}-${effort}`] = base;
+  }
   return rev;
```

MODIFY src/usage/expected-prices.ts after existing Antigravity 4.6 rows (:367-374): adapt the eight 5.5 rows from #6497, retaining existing CLAUDE_SONNET_55/CLAUDE_OPUS_55 constants; ALL eight status fields are verified-derived. Source text says derived Anthropic reference price, not CCA billing. Verify the cited underlying vendor price before carrying a fresh verifiedAt date; do not invent current-price evidence. Preserve 4.6 historical overlay rows.

MODIFY tests/usage/usage-cost.test.ts membership assertion at :466 from 152 to 160 and include all eight new keys in its reviewed expected set, then adjacent existing Claude 5.5 price cases: add google-antigravity derived source assertions for the base and each tier with literal expected tuples (Sonnet 2/10/0.2/2.5; Opus 4/20/0.2/5, confirmed in the official pricing table on 2026-10-03). Assert 4.6 identity/cost unchanged and unknown future suffix identity unchanged; use tests/usage/usage-summary.test.ts if durable aggregation-level coverage is missing. Check file-size cap before adding; if at cap use NEW tests/usage/usage-antigravity-55.test.ts and register it in both scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json with the existing usage domain shape. No lowered caps/skips.

MODIFY structure/providers-and-adapters.md :557-559: append that deterministic known 5.5 usage normalization is independent of discovery and does not migrate saved routing. MODIFY docs-site/src/content/docs/guides/providers.md at Antigravity guidance: reference costs are derived estimates; use discovered models/efforts; do not claim #6502 resolved without a successful matching request. Review all manifest owners for src/providers and src/usage; amend only affected prose.

## Routing evidence decision before implementation

Inspect the existing intended Antigravity discovery path and credential availability without printing secrets. After unlock, bound model discovery and at most a minimal request for the reported saved Sonnet 5.5-high selection; retain only wire IDs/effort/status and redacted endpoint identity. No account configuration or installed-service restart. If credentials are absent or discovery/request fails, record that exact limitation and leave #6502 unresolved. Existing #6501 controlled fixture proof does not prove live entitlement or backend availability.

Static 5.5 fallback, 4.6 retirement, inferred context/image metadata, and cross-generation aliases are NOT in the patch above. Adding static fallback requires evidence plus P/A amendment with exact maps/tests. That amendment must cover medium default, xhigh/max/ultra clamp, suffix override, complete/partial/empty discovery and snapshot invalidation using an unbundled family so a new fallback cannot make invalidation coverage tautological.

## Acceptance and commands (planned; NOT RUN at initial gate)

- All known 5.5 base/low/medium/high usage spellings normalize deterministically without requiring registration; unknown model suffixes remain exact; historical 4.6 stays itself. Both src/usage/cost.ts and src/usage/summary.ts consume canonicalAntigravityUsageModel. src/adapters/google.ts:95 also calls it for a Gemini-only rejection predicate; Claude normalization must leave that behavior unchanged.
- Exact discovered family remains authoritative; explicit high plus conflicting low effort yields high wire and no thinkingConfig. Complete/partial/empty discovery, restart/outage and home/destination/generation isolation keep existing tests green.
- Eight reference-price rows carry verified-derived; literal tuple assertions and a source assertion prove provenance. No charge/billing claim.
- Run each affected file in its own Bun process: tests/adapters/google/antigravity-discovered-families.test.ts, tests/adapters/google/google-antigravity-wire.test.ts, tests/adapters/google/antigravity-static-catalog.test.ts, tests/providers/provider-antigravity-effort-families.test.ts, tests/providers/provider-antigravity-family-catalog.test.ts, tests/providers/provider-antigravity-wire-snapshot.test.ts, tests/usage/usage-cost.test.ts, tests/usage/usage-summary.test.ts, tests/providers/provider-registry-parity.test.ts.
- Run bun run typecheck; bun run privacy:scan; bun run structure:check; focused layout and file-size guards; bun run test:changed after examining its scope. Full local suite exception: concurrent stabilization worktrees share resources; record focused commands/counts and remaining platform/CI coverage in PR.
- Independent implementation/security review, actual applicable exact-head PR CI and maintained source credit precede review readiness.

Credit for adapted source: Co-authored-by: Prince <princepal9120@gmail.com>. Source #6497 stays open; report the withheld routing/migration delta explicitly.

## Execution revalidation

Previous D concluded: docs-only roadmap complete at 12d0ba48d0; next execute 010 usage/pricing only and preserve current routing. This cycle follows that direction. Live discovery/inference at the baseline supports retaining routing, and official vendor pricing supports the two reference tuples. Baseline usage-cost 102/0; direct installed-Bun tsc/structure/privacy all exit0. usage-cost is uncapped, but usage-summary is exactly at its 2069-line cap. Add the already-planned tests/usage/usage-antigravity-55.test.ts sibling and both layout registrations; do not edit usage-summary. Coordinator clarified that its own integrated candidate gets final parallel review; this slice may publish after scoped independent review and local verification.

Focused architect 01a1021d-d929-7f41-bad4-e49df00f9633 D1-D6 accepted. Add estimateRequestCost estimated=true assertion, pool provider pricing, required top-level/per-day grouping with literal request/token/cost totals, and unchanged historical/unknown identities. Also update the pricing paragraph in structure/dashboard-and-usage.md. No wire changes. New sibling uses existing summarizeUsage and PersistedUsageEntry interfaces; for each family, low/medium/high rows plus one base row with a resolved high tier produce four requests per family, 4400 tokens and Sonnet 0.012 / Opus 0.024 reference cost at 1000 input+100 output each. Both aggregate and per-day rows must match those literals. Historical 4.6 and unknown future suffix rows remain separate.

## Complete new sibling test content

NEW tests/usage/usage-antigravity-55.test.ts (the existing cost file changes only membership; focused new assertions live together here):

```typescript
import { describe, expect, test } from "bun:test";
import { canonicalAntigravityUsageModel } from "../../src/providers/antigravity-models";
import { estimateRequestCost, resolveMatchedPrice } from "../../src/usage/cost";
import { findExpectedPriceOverlay } from "../../src/usage/expected-prices";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { summarizeUsage } from "../../src/usage/summary";

const families = [
  { base: "claude-sonnet-5-5", cost4: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, total: 0.012 },
  { base: "claude-opus-5-5", cost4: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, total: 0.024 },
];
const now = Date.UTC(2026, 9, 3, 12);

function row(model: string, index: number, resolvedModel?: string): PersistedUsageEntry {
  return {
    requestId: `antigravity-fixture-${index}`, timestamp: now - index,
    provider: "google-antigravity", model, ...(resolvedModel ? { resolvedModel } : {}),
    status: 200, durationMs: 1, usageStatus: "reported",
    usage: { inputTokens: 1000, outputTokens: 100 }, totalTokens: 1100,
  };
}

describe("Antigravity Claude 5.5 usage", () => {
  for (const { base, cost4, total } of families) {
    test(`${base} has deterministic identity and derived reference prices without discovery`, () => {
      for (const id of [base, `${base}-low`, `${base}-medium`, `${base}-high`]) {
        expect(canonicalAntigravityUsageModel(id)).toBe(base);
        expect(findExpectedPriceOverlay("google-antigravity", id)).toMatchObject({
          provider: "google-antigravity", modelId: id, cost4, status: "verified-derived",
        });
        for (const provider of ["google-antigravity", "google-antigravity-pabcdef"]) {
          const price = resolveMatchedPrice(provider, id);
          expect(price).toMatchObject({ cost4, status: "verified-derived", source: "expected" });
          expect(price?.sourceRef).toContain("derived:");
          expect(price?.sourceRef).toContain("platform.claude.com/docs/en/about-claude/pricing");
          const estimate = estimateRequestCost({ provider, model: id, usageStatus: "reported", usage: { inputTokens: 1000, outputTokens: 100 } });
          expect(estimate?.estimated).toBe(true);
          expect(estimate?.cost.total).toBeCloseTo(total / 4, 10);
        }
      }
    });

    test(`${base} aggregates tiers and resolved IDs in model and day summaries`, () => {
      const entries = [row(`${base}-low`, 1), row(`${base}-medium`, 2), row(`${base}-high`, 3), row(base, 4, `${base}-high`)];
      const summary = summarizeUsage(entries, "all", now);
      expect(summary.models).toHaveLength(1);
      expect(summary.models[0]).toMatchObject({ provider: "google-antigravity", model: base, requests: 4, totalTokens: 4400 });
      expect(summary.models[0]?.resolvedModel).toBeUndefined();
      expect(summary.models[0]?.estimatedCostUsd).toBeCloseTo(total, 10);
      const days = summary.days.filter(day => day.requests > 0);
      expect(days).toHaveLength(1);
      expect(days[0]?.models).toHaveLength(1);
      expect(days[0]?.models[0]).toMatchObject({ model: base, requests: 4, totalTokens: 4400 });
      expect(days[0]?.models[0]?.estimatedCostUsd).toBeCloseTo(total, 10);
      expect(summary.summary.estimatedCostUsd).toBeCloseTo(total, 10);
    });
  }

  test("historical Claude and unknown suffixes retain their exact usage identities", () => {
    const ids = ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "claude-sonnet-6-0-high", "claude-sonnet-5-5-ultra"];
    for (const id of ids) expect(canonicalAntigravityUsageModel(id)).toBe(id);
    const summary = summarizeUsage(ids.map((id, i) => row(id, i + 1)), "all", now);
    expect(summary.models.map(model => model.model).sort()).toEqual([...ids].sort());
    expect(resolveMatchedPrice("google-antigravity", "claude-sonnet-4-6")?.cost4)
      .toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(resolveMatchedPrice("google-antigravity", "claude-opus-4-6-thinking")?.cost4)
      .toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });
});
```

Same-architect final reflection: ALIGNED D1-D6 after correcting fixture count to four; no material gaps.

B fixture correction: summarizeUsage all-range deliberately includes a leading empty day (dayCountForAllRange uses ceil(delta/day)+1). Assert exactly one nonempty day and its full model totals; no production change for an incorrect fixture assumption. New tests first failed four behavior cases before the runtime change, then all five passed after the mapping/overlays and this calendar-independent assertion.
