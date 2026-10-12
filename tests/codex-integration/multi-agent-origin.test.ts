import { describe, expect, test } from "bun:test";
import { applyMultiAgentMode, MULTI_AGENT_ORIGIN_FIELD, type RawEntry } from "../../src/codex/catalog/parsing";

/**
 * Issue 5636: returning from a forced multi-agent mode to default left newer native rows
 * pinned to the forced value when the pristine baseline predated them. The forced pass now
 * records the row's original value, and default mode restores it only where the baseline and
 * native metadata say nothing about the row.
 */
const OLD_BASELINE: ReadonlyMap<string, string | null> = new Map([["gpt-5.4", "v2"]]);

/** Serialize and reload rows the way a retained catalog file does between passes. */
function roundTrip(entries: RawEntry[]): RawEntry[] {
  return JSON.parse(JSON.stringify(entries)) as RawEntry[];
}

describe("multi-agent mode provenance (#5636)", () => {
  test("v1 then default restores a newer native row's original v2 pin across a reload", () => {
    const forced = roundTrip(applyMultiAgentMode([{ slug: "gpt-6-luna", multi_agent_version: "v2" }], "v1"));
    expect(forced[0]!.multi_agent_version).toBe("v1");
    const restored = applyMultiAgentMode(forced, "default", false, { nativeDefaults: OLD_BASELINE });
    expect(restored[0]!.multi_agent_version).toBe("v2");
    expect(restored[0]).not.toHaveProperty(MULTI_AGENT_ORIGIN_FIELD);
  });

  test("repeated forced modes keep the first recorded origin", () => {
    let rows: RawEntry[] = [{ slug: "gpt-6-astra", multi_agent_version: "v2" }];
    rows = roundTrip(applyMultiAgentMode(rows, "v1"));
    rows = roundTrip(applyMultiAgentMode(rows, "v2"));
    rows = roundTrip(applyMultiAgentMode(rows, "v1"));
    const restored = applyMultiAgentMode(rows, "default", false, { nativeDefaults: OLD_BASELINE });
    expect(restored[0]!.multi_agent_version).toBe("v2");
  });

  test("an originally unpinned row returns to unpinned, or v2 when the native feature is on", () => {
    const forcedOff = roundTrip(applyMultiAgentMode([{ slug: "gpt-6-luna" }], "v1"));
    expect(applyMultiAgentMode(forcedOff, "default", false, { nativeDefaults: OLD_BASELINE })[0])
      .not.toHaveProperty("multi_agent_version");
    const forcedOn = roundTrip(applyMultiAgentMode([{ slug: "gpt-6-luna" }], "v1"));
    expect(applyMultiAgentMode(forcedOn, "default", true, { nativeDefaults: OLD_BASELINE })[0]!.multi_agent_version)
      .toBe("v2");
  });

  test("a pristine baseline entry, including an explicit null, still wins over the recorded origin", () => {
    const pinned = roundTrip(applyMultiAgentMode([{ slug: "gpt-5.4", multi_agent_version: "v1" }], "v2"));
    const baseline = new Map<string, string | null>([["gpt-5.4", "v1"]]);
    expect(applyMultiAgentMode(pinned, "default", false, { nativeDefaults: baseline })[0]!.multi_agent_version).toBe("v1");

    const nulled = roundTrip(applyMultiAgentMode([{ slug: "gpt-5.4", multi_agent_version: "v2" }], "v1"));
    const nullBaseline = new Map<string, string | null>([["gpt-5.4", null]]);
    expect(applyMultiAgentMode(nulled, "default", false, { nativeDefaults: nullBaseline })[0])
      .not.toHaveProperty("multi_agent_version");
  });

  test("a historical row without a recorded origin keeps its live pin", () => {
    const rows: RawEntry[] = [{ slug: "gpt-6-luna", multi_agent_version: "v1" }];
    expect(applyMultiAgentMode(rows, "default", false, { nativeDefaults: OLD_BASELINE })[0]!.multi_agent_version).toBe("v1");
  });

  test("routed rows keep default-mode normalization regardless of a recorded origin", () => {
    const forced = roundTrip(applyMultiAgentMode([{ slug: "xai/grok-4.7", multi_agent_version: "v1" }], "v2"));
    const restored = applyMultiAgentMode(forced, "default", false, { nativeDefaults: OLD_BASELINE });
    expect(restored[0]).not.toHaveProperty("multi_agent_version");
    expect(restored[0]).not.toHaveProperty(MULTI_AGENT_ORIGIN_FIELD);
  });
});
