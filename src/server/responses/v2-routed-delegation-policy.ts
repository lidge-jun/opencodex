const MIRRORABLE_COLLABORATION_OPERATIONS = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function catalogLists(body: unknown, replayPrefixLength: number): unknown[][] {
  if (!isRecord(body)) return [];
  const lists: unknown[][] = [];
  if (Array.isArray(body.tools)) lists.push(body.tools);
  if (!Array.isArray(body.input)) return lists;
  const start = Math.max(0, Math.min(replayPrefixLength, body.input.length));
  for (const item of body.input.slice(start)) {
    if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
      lists.push(item.tools);
    }
  }
  return lists;
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
