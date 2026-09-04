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
import { canonicalFastTierMarker } from "../src/providers/fastwire";
import { requestLogSpeedLabel } from "../src/server/request-log";

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
