import { MIRRORABLE_COLLABORATION_OPERATIONS, catalogLists, isRecord } from "./v2-routed-delegation-shared";

export type V2RoutedDelegationBridgeScope = "root" | "child";

export type V2RoutedDelegationBridgeInactiveReason =
  | "disabled"
  | "not_v2"
  | "non_native_route"
  | "maintenance_turn"
  | "no_collaboration_catalog"
  | "combo"
  | "compaction"
  | "shadow_route";

export type V2RoutedDelegationBridgeDecision =
  | { active: true; decision: "active"; scope: V2RoutedDelegationBridgeScope }
  | { active: false; decision: V2RoutedDelegationBridgeInactiveReason };

export interface V2RoutedDelegationBridgePolicyInput {
  enabled: boolean;
  inboundWire: string;
  multiAgentMode: string | undefined;
  upstreamV2Enabled: boolean;
  canonicalNativeRoute: boolean;
  hasSubagentMarker: boolean;
  threadSpawn: boolean;
  comboAttempt: boolean;
  compaction: boolean;
  shadowRoute: boolean;
  collaborationSurface: "v1" | "v2" | null;
  body: unknown;
  replayPrefixLength?: number;
}

/** The caller-supplied current-turn catalog is the delegation authority. */
export function hasMirrorableV2CollaborationCatalog(
  body: unknown,
  replayPrefixLength = 0,
): boolean {
  return catalogLists(body, replayPrefixLength).some(list => list.some(group => (
    isRecord(group)
    && group.type === "namespace"
    && group.name === "collaboration"
    && Array.isArray(group.tools)
    && group.tools.some(tool => (
      isRecord(tool)
      && tool.type === "function"
      && typeof tool.name === "string"
      && MIRRORABLE_COLLABORATION_OPERATIONS.has(tool.name)
    ))
  )));
}

/** Decide eligibility after fallback/recovery has settled the physical route. */
export function decideV2RoutedDelegationBridge(
  input: V2RoutedDelegationBridgePolicyInput,
): V2RoutedDelegationBridgeDecision {
  if (!input.enabled) return { active: false, decision: "disabled" };
  if (
    input.inboundWire !== "responses"
    || input.multiAgentMode !== "v2"
    || !input.upstreamV2Enabled
  ) return { active: false, decision: "not_v2" };
  if (!input.canonicalNativeRoute) return { active: false, decision: "non_native_route" };
  if (input.comboAttempt) return { active: false, decision: "combo" };
  if (input.compaction) return { active: false, decision: "compaction" };
  if (input.shadowRoute) return { active: false, decision: "shadow_route" };
  if (input.hasSubagentMarker && !input.threadSpawn) {
    return { active: false, decision: "maintenance_turn" };
  }
  if (
    input.collaborationSurface !== "v2"
    || !hasMirrorableV2CollaborationCatalog(input.body, input.replayPrefixLength)
  ) {
    return { active: false, decision: "no_collaboration_catalog" };
  }
  return {
    active: true,
    decision: "active",
    scope: input.threadSpawn ? "child" : "root",
  };
}
