import { describe, expect, test } from "bun:test";
import {
  decideV2RoutedDelegationBridge,
  hasMirrorableV2CollaborationCatalog,
  type V2RoutedDelegationBridgePolicyInput,
} from "../../src/server/responses/v2-routed-delegation-policy";

const collaboration = {
  type: "namespace",
  name: "collaboration",
  tools: [
    { type: "function", name: "spawn_agent", parameters: { type: "object" } },
    { type: "function", name: "list_agents", parameters: { type: "object" } },
  ],
};

function eligible(
  patch: Partial<V2RoutedDelegationBridgePolicyInput> = {},
): V2RoutedDelegationBridgePolicyInput {
  return {
    enabled: true,
    inboundWire: "responses",
    multiAgentMode: "v2",
    upstreamV2Enabled: true,
    canonicalNativeRoute: true,
    hasSubagentMarker: false,
    threadSpawn: false,
    comboAttempt: false,
    compaction: false,
    shadowRoute: false,
    collaborationSurface: "v2",
    body: { tools: [collaboration] },
    ...patch,
  };
}

describe("Routed V2 delegation bridge policy", () => {
  test("admits roots and positively classified thread-spawn children", () => {
    expect(decideV2RoutedDelegationBridge(eligible())).toEqual({
      active: true,
      decision: "active",
      scope: "root",
    });
    expect(decideV2RoutedDelegationBridge(eligible({
      hasSubagentMarker: true,
      threadSpawn: true,
    }))).toEqual({ active: true, decision: "active", scope: "child" });
  });

  test("rejects maintenance markers unless thread_spawn is positive", () => {
    expect(decideV2RoutedDelegationBridge(eligible({ hasSubagentMarker: true }))).toEqual({
      active: false,
      decision: "maintenance_turn",
    });
    expect(decideV2RoutedDelegationBridge(eligible({
      hasSubagentMarker: true,
      threadSpawn: true,
    })).active).toBe(true);
  });

  test("returns one bounded reason for every safety exclusion", () => {
    const cases: Array<[Partial<V2RoutedDelegationBridgePolicyInput>, string]> = [
      [{ enabled: false }, "disabled"],
      [{ inboundWire: "chat" }, "not_v2"],
      [{ multiAgentMode: "v1" }, "not_v2"],
      [{ upstreamV2Enabled: false }, "not_v2"],
      [{ canonicalNativeRoute: false }, "non_native_route"],
      [{ comboAttempt: true }, "combo"],
      [{ compaction: true }, "compaction"],
      [{ shadowRoute: true }, "shadow_route"],
      [{ body: { tools: [] } }, "no_collaboration_catalog"],
    ];
    for (const [patch, decision] of cases) {
      expect(decideV2RoutedDelegationBridge(eligible(patch))).toEqual({ active: false, decision });
    }
  });

  test("uses only the current-turn catalog and requires a mirrorable operation", () => {
    const replayed = { type: "additional_tools", tools: [collaboration] };
    const leaf = {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "wait_agent", parameters: {} }],
    };
    expect(hasMirrorableV2CollaborationCatalog({
      tools: [],
      input: [replayed, { type: "additional_tools", tools: [leaf] }],
    }, 1)).toBe(false);
    expect(hasMirrorableV2CollaborationCatalog({
      tools: [],
      input: [replayed, { type: "additional_tools", tools: [collaboration] }],
    }, 1)).toBe(true);
  });
});
