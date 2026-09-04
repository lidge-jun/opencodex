/**
 * Ultra Fast: name the tier the proxy is already carrying.
 *
 * PR #2994 added an `ultrafast` row to the pinned catalog and was closed unmerged with
 * the verdict that the picker gained a choice the wire could not honor —
 * `src/codex/data/upstream-models.json` advertises only `priority`, so the row was
 * fabricated metadata. That decision stands: nothing here synthesizes a catalog row.
 *
 * What #3429 reported is separately true and fixable. A caller who supplies
 * `service_tier: "ultrafast"` themselves gets the request forwarded, and then the proxy
 * records `fastOutcome: "not-requested"` and no speed label — it asserts the user asked
 * for nothing. These tests pin the corrected accounting.
 */
import { describe, expect, test } from "bun:test";
import { canonicalFastTierMarker, createAdapterTierMetadata, decideTier, tierObservationContext } from "../../src/providers/fastwire";
import { requestLogSpeedLabel } from "../../src/server/request-log";
import { normalizeRoutedCatalogEntry } from "../../src/codex/catalog/parsing";

describe("ultrafast intent is recognised, not mistaken for silence", () => {
  test("the caller marker folds ultrafast to its own canonical, not to priority", () => {
    // Folding it onto "priority" would be the other lie: claiming a 1.5x Fast tier was
    // requested when the caller named a different one.
    expect(canonicalFastTierMarker("ultrafast")).toBe("ultrafast");
    expect(canonicalFastTierMarker("UltraFast")).toBe("ultrafast");
    expect(canonicalFastTierMarker("  ultrafast  ")).toBe("ultrafast");
  });

  test("the existing Fast spellings are unchanged", () => {
    expect(canonicalFastTierMarker("priority")).toBe("priority");
    expect(canonicalFastTierMarker("fast")).toBe("priority");
    expect(canonicalFastTierMarker(" PRIORITY ")).toBe("priority");
  });

  test("unrelated tiers still fold to undefined", () => {
    // "auto" reaching a canonical marker would turn every default request into Fast intent.
    expect(canonicalFastTierMarker("auto")).toBeUndefined();
    expect(canonicalFastTierMarker("default")).toBeUndefined();
    expect(canonicalFastTierMarker("ultra")).toBeUndefined();
    expect(canonicalFastTierMarker("ultra-fast")).toBeUndefined();
    expect(canonicalFastTierMarker(undefined)).toBeUndefined();
    expect(canonicalFastTierMarker("")).toBeUndefined();
  });
});

describe("ultrafast gets a speed label", () => {
  test("the label is its own, so Logs cannot read it as Fast", () => {
    expect(requestLogSpeedLabel("ultrafast")).toBe("ultrafast");
    expect(requestLogSpeedLabel(" UltraFast ")).toBe("ultrafast");
  });

  test("the Fast contract is untouched", () => {
    expect(requestLogSpeedLabel("priority")).toBe("fast");
    expect(requestLogSpeedLabel("fast")).toBe("fast");
  });

  test("auto and absent still produce no label", () => {
    // A label here would put a speed badge on every ordinary request.
    expect(requestLogSpeedLabel("auto")).toBeUndefined();
    expect(requestLogSpeedLabel(undefined)).toBeUndefined();
    expect(requestLogSpeedLabel("")).toBeUndefined();
  });
});

/**
 * The catalog half. The flag PRESERVES a tier the operator supplied; it never invents one,
 * which is the line PR #2994 was closed for crossing.
 */
describe("routed rows and the ultrafast opt-in", () => {
  const operatorRow = () => ({
    slug: "kimi/k3",
    service_tier: "ultrafast",
    default_service_tier: "ultrafast",
    service_tiers: [
      { id: "priority", name: "Fast", description: "1.5x speed, increased usage" },
      { id: "ultrafast", name: "Ultra Fast", description: "operator supplied" },
    ],
    additional_speed_tiers: ["fast", "ultrafast"],
  });

  test("with the flag OFF every tier field is stripped, exactly as before", () => {
    const entry = normalizeRoutedCatalogEntry(operatorRow(), false, undefined, { ultraFastTier: false });
    expect(entry.service_tier).toBeUndefined();
    expect(entry.service_tiers).toBeUndefined();
    expect(entry.default_service_tier).toBeUndefined();
    expect(entry.additional_speed_tiers).toBeUndefined();
  });

  test("with the flag ON the operator's ultrafast survives regeneration", () => {
    // The whole reported symptom: a hand-edited catalog lost the tier on every sync.
    const entry = normalizeRoutedCatalogEntry(operatorRow(), false, undefined, { ultraFastTier: true });
    expect(entry.service_tiers).toEqual([{ id: "ultrafast", name: "Ultra Fast", description: "operator supplied" }]);
    expect(entry.additional_speed_tiers).toEqual(["ultrafast"]);
    expect(entry.service_tier).toBe("ultrafast");
    expect(entry.default_service_tier).toBe("ultrafast");
  });

  test("the flag never smuggles Fast onto a routed row", () => {
    // Routed rows are stripped because a clone of a native template would otherwise inherit
    // OpenAI's priority tier. Preserving ultrafast must not reopen that.
    const entry = normalizeRoutedCatalogEntry(operatorRow(), false, undefined, { ultraFastTier: true });
    const ids = (entry.service_tiers as Array<{ id: string }>).map(tier => tier.id);
    expect(ids).not.toContain("priority");
    expect(entry.additional_speed_tiers).not.toContain("fast");
  });

  test("the flag invents nothing when the operator supplied no ultrafast", () => {
    // A row carrying only the upstream Fast tier is stripped whether the flag is on or off:
    // upstream advertises no ultrafast, so there is nothing to preserve.
    const fastOnly = {
      slug: "kimi/k3",
      service_tiers: [{ id: "priority", name: "Fast" }],
      additional_speed_tiers: ["fast"],
    };
    const entry = normalizeRoutedCatalogEntry(fastOnly, false, undefined, { ultraFastTier: true });
    expect(entry.service_tiers).toBeUndefined();
    expect(entry.additional_speed_tiers).toBeUndefined();
  });
});

/**
 * The wire decision, which the unit tests above cannot see.
 *
 * Adversarial review caught this: recognising `ultrafast` as a canonical marker routed it
 * into the canonical-wire lookup, and because it is deliberately unmapped the lookup fell
 * through to `drop`. That made recognition strictly WORSE than leaving it unrecognised —
 * before, it was a foreign tier and `foreignCallerTiers: "verbatim"` forwarded it. Every
 * suite still passed, because none of them asserted the decision.
 */
describe("an unmapped canonical tier is forwarded, not dropped", () => {
  const policy = {
    capability: true,
    eligibility: "eligible",
    fastWire: {
      kind: "service-tier",
      canonicalToWire: { priority: "priority" },
      foreignCallerTiers: "verbatim",
    },
    forwardCallerTier: true,
  } as unknown as Parameters<typeof decideTier>[0];

  test("ultrafast reaches the provider instead of being stripped", () => {
    expect(decideTier(policy, undefined, "ultrafast")).toEqual({ kind: "forward-caller" });
  });

  test("mapped Fast spellings still resolve to the wire value", () => {
    expect(decideTier(policy, undefined, "priority")).toEqual({ kind: "set", value: "priority" });
    expect(decideTier(policy, undefined, "fast")).toEqual({ kind: "set", value: "priority" });
  });

  test("unrelated and absent tiers are unchanged", () => {
    expect(decideTier(policy, undefined, "auto")).toEqual({ kind: "forward-caller" });
    expect(decideTier(policy, undefined, undefined)).toEqual({ kind: "forward-caller" });
  });
});

describe("the Fast toggle does not claim to have suppressed a different tier", () => {
  const observe = (callerTier: string, fastMode: boolean | undefined) => {
    const policy = {
      capability: true,
      eligibility: "eligible",
      fastWire: {
        kind: "service-tier",
        canonicalToWire: { priority: "priority" },
        foreignCallerTiers: "verbatim",
      },
      forwardCallerTier: true,
    } as unknown as Parameters<typeof tierObservationContext>[0];
    const context = tierObservationContext(policy, fastMode, callerTier);
    const decision = decideTier(policy, fastMode, callerTier);
    const wireValue = decision.kind === "set" ? decision.value : decision.kind === "drop" ? null : callerTier;
    return createAdapterTierMetadata(context, decision, "service-tier", wireValue)?.outcome;
  };

  test("force-default suppressing a real Fast request is recorded as suppression", () => {
    const outcome = observe("priority", false);
    expect(outcome?.callerFastSuppressedByConfig).toBe(true);
  });

  test("force-default turning away ultrafast is a dropped tier, not a suppressed Fast", () => {
    // The Fast toggle did not suppress a 1.5x Fast request; it turned away a different one.
    const outcome = observe("ultrafast", false);
    expect(outcome?.callerFastSuppressedByConfig).toBeUndefined();
    expect(outcome?.callerTierDropped).toBe(true);
  });
});
