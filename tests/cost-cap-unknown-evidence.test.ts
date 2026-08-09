/**
 * Reproduction for issue #1181 — "Routing: define hard cost-cap behavior when
 * runtime cost evidence is unknown".
 *
 * The hard ceiling `limits.maxEstimatedCostUsd` is documented as a hard
 * per-request cap. In the live routing path it never fires, because
 * `router.ts` assembles cost evidence WITHOUT usage:
 *
 *   costEvidenceForCandidate({ provider, model, limitUsd })   // no `usage`
 *
 * `costEvidenceForCandidate` then returns `{ limitUsd, incomplete: true }`
 * with no `estimatedUsd`, and the evaluator's cap check
 * (evaluator.ts:307-310) requires `typeof estimatedCost === "number"`, so an
 * unknown estimate silently passes a cap the operator configured as hard.
 *
 * The existing test in cost-scoring.test.ts only exercises the cap with
 * `usage: USAGE` supplied — i.e. on a code path production never takes.
 *
 * These tests pin both sides of `limits.onUnknownCost`:
 *   - the default `"allow"`, which preserves the documented dry-run contract
 *     and lets an unprovable candidate through, and
 *   - the opt-in `"exclude"`, which makes the ceiling genuinely hard and
 *     reports the distinct `cost-limit-unknown` exclusion.
 *
 * The first case was originally written as a failing reproduction before the
 * evaluator change landed; it is retained to keep the fail-open default
 * asserted rather than assumed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costEvidenceForCandidate } from "../src/routing/cost";
import { evaluatePolicyProfile } from "../src/routing/evaluator";
import type { OcxConfig } from "../src/types";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-cost-cap-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

/** Mirrors the live routing path: a cap is configured, usage is NOT available. */
function configWithCap(capUsd: number, overrides: Record<string, unknown> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "kan",
        models: ["claude-opus-5"],
      },
    },
    routingProfiles: {
      cost: {
        candidates: [{ provider: "anthropic", model: "claude-opus-5" }],
        optimize: { cost: 0.8 },
        limits: { maxEstimatedCostUsd: capUsd },
        unknownEvidence: { capability: "allow", health: "allow", quota: "allow", cost: "allow" },
        ...overrides,
      },
    },
  } as OcxConfig;
}

describe("issue #1181 — hard cost cap under unknown evidence", () => {
  test("default allow: live-path evidence carries no estimate, so the cap does not fire", async () => {
    // Exactly how router.ts:515-519 builds it — no `usage` argument.
    const evidence = costEvidenceForCandidate({
      provider: "anthropic",
      model: "claude-opus-5",
      limitUsd: 0.000001, // an absurdly low cap; nothing should realistically pass
    });

    // The evidence is explicitly unknown, and correctly so.
    expect(evidence.estimatedUsd).toBeUndefined();
    expect(evidence.incomplete).toBe(true);
    expect(evidence.limitUsd).toBe(0.000001);

    const result = evaluatePolicyProfile(configWithCap(0.000001), "cost", {}, [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        capability: { contextWindow: 200000 },
        cost: evidence,
      },
    ]);

    // Current behaviour: the candidate is eligible and selected despite a cap
    // of $0.000001. No `cost-limit` exclusion is recorded, and nothing in the
    // trace distinguishes "known below cap" from "cost unknown".
    expect(result.candidates[0]!.eligible).toBe(true);
    expect(
      result.candidates[0]!.exclusions.some(e => e.code === "cost-limit"),
    ).toBe(false);
    expect(result.selectedIndex).toBe(0);
  });

  test("opt-in exclude: fail-closed cap excludes unknown-cost candidates", async () => {
    const evidence = costEvidenceForCandidate({
      provider: "anthropic",
      model: "claude-opus-5",
      limitUsd: 0.000001,
    });

    // Proposed opt-in policy: limits.onUnknownCost = "exclude".
    const result = evaluatePolicyProfile(
      configWithCap(0.000001, { limits: { maxEstimatedCostUsd: 0.000001, onUnknownCost: "exclude" } }),
      "cost",
      {},
      [
        {
          provider: "anthropic",
          model: "claude-opus-5",
          capability: { contextWindow: 200000 },
          cost: evidence,
        },
      ],
    );

    expect(result.candidates[0]!.eligible).toBe(false);
    // Distinct code so operators can tell "over a known cap" from "cost unknown".
    expect(
      result.candidates[0]!.exclusions.some(e => e.code === "cost-limit-unknown"),
    ).toBe(true);
    expect(result.selectedIndex).toBeNull();
  });

  test("cap policy and unknownEvidence.cost are distinct mechanisms", async () => {
    // unknownEvidence.cost governs SCORING of an unknown-cost candidate;
    // limits.onUnknownCost governs whether the hard CEILING applies to it.
    // They must produce distinct exclusion codes so a trace stays diagnosable.
    const evidence = costEvidenceForCandidate({
      provider: "anthropic",
      model: "claude-opus-5",
      limitUsd: 0.000001,
    });

    const scoringExcluded = evaluatePolicyProfile(
      configWithCap(0.000001, {
        unknownEvidence: { capability: "allow", health: "allow", quota: "allow", cost: "exclude" },
      }),
      "cost",
      {},
      [{ provider: "anthropic", model: "claude-opus-5", capability: { contextWindow: 200000 }, cost: evidence }],
    );

    const codes = scoringExcluded.candidates[0]!.exclusions.map(e => e.code);
    expect(codes).toContain("unknown-price");
    expect(codes).not.toContain("cost-limit-unknown");
    expect(scoringExcluded.candidates[0]!.eligible).toBe(false);
  });

  test("no cap configured — onUnknownCost is inert", async () => {
    const evidence = costEvidenceForCandidate({ provider: "anthropic", model: "claude-opus-5" });
    const noCap = {
      port: 10100,
      defaultProvider: "anthropic",
      providers: {
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "kan", models: ["claude-opus-5"] },
      },
      routingProfiles: {
        cost: {
          candidates: [{ provider: "anthropic", model: "claude-opus-5" }],
          optimize: { cost: 0.8 },
          limits: { onUnknownCost: "exclude" }, // no maxEstimatedCostUsd
          unknownEvidence: { capability: "allow", health: "allow", quota: "allow", cost: "allow" },
        },
      },
    } as unknown as OcxConfig;

    const result = evaluatePolicyProfile(noCap, "cost", {}, [
      { provider: "anthropic", model: "claude-opus-5", capability: { contextWindow: 200000 }, cost: evidence },
    ]);

    // Without a ceiling there is nothing to fail closed against.
    expect(result.candidates[0]!.eligible).toBe(true);
    expect(
      result.candidates[0]!.exclusions.some(e => e.code === "cost-limit-unknown"),
    ).toBe(false);
  });

  test("default stays allow — the documented contract is unchanged", async () => {
    const evidence = costEvidenceForCandidate({
      provider: "anthropic",
      model: "claude-opus-5",
      limitUsd: 0.000001,
    });

    // No onUnknownCost configured → must behave exactly as today (fail-open),
    // so existing deployments do not lose every live route on upgrade.
    const result = evaluatePolicyProfile(configWithCap(0.000001), "cost", {}, [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        capability: { contextWindow: 200000 },
        cost: evidence,
      },
    ]);

    expect(result.candidates[0]!.eligible).toBe(true);
    expect(result.selectedIndex).toBe(0);
  });
});
