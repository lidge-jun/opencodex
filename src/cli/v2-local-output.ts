import { loadConfig } from "../config";
import { multiAgentSurfaceAdvisory, resolveMultiAgentMode } from "../config/multi-agent-surface";
import { getAgentsEnabled, getAgentsMaxDepth, getLogicalMaxThreads, getMultiAgentModeHintText,
  getSubagentDeveloperInstructions, hasAgentsMaxThreads, isMultiAgentV2Enabled } from "../codex/features";
import { MULTI_AGENT_MODE_HINT_RECOMMENDATION } from "../codex/multi-agent-mode-policy";
import type { CodexSyncResult } from "../codex/sync";
import { projectLocalSyncResult, type LocalSyncResult } from "./local-sync-result";

/** Rebuild local state from actual post-write readers; no paths, credentials, or logs. */
export function localV2State(isEnabled = isMultiAgentV2Enabled, hasMaxThreads = hasAgentsMaxThreads) {
  const config = loadConfig();
  const enabled = isEnabled();
  return { enabled, agentsMaxThreadsConflict: enabled && hasMaxThreads(),
    multiAgentMode: resolveMultiAgentMode(config), keepNativeChatGptOnV1: config.keepNativeChatGptOnV1 === true,
    multiAgentSurfaceAdvisory: multiAgentSurfaceAdvisory(config), maxConcurrentThreadsPerSession: getLogicalMaxThreads(),
    agentsEnabled: getAgentsEnabled(), agentsMaxDepth: getAgentsMaxDepth(),
    agentsMaxDepthAppliesWhenV2Disabled: !enabled, subagentDeveloperInstructions: getSubagentDeveloperInstructions(),
    multiAgentModeHintText: getMultiAgentModeHintText(), multiAgentModeHintRecommendation: MULTI_AGENT_MODE_HINT_RECOMMENDATION };
}

export type V2LocalSync = LocalSyncResult | { status: "unverified"; ok: false };

/** The existing injected sync contract returns unknown. Validate before the typed shared projection. */
export function v2LocalSyncResult(value: unknown): V2LocalSync {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "unverified", ok: false };
  const source = value as Record<string, unknown>;
  if (typeof source.status !== "string" || !["applied", "catalog-only", "skipped", "refused"].includes(source.status)
    || typeof source.ok !== "boolean" || typeof source.catalogExists !== "boolean"
    || typeof source.catalogWritten !== "boolean" || typeof source.cacheSynced !== "boolean"
    || typeof source.added !== "number" || !Number.isSafeInteger(source.added) || source.added < 0
    || (source.catalogPath !== null && typeof source.catalogPath !== "string") || typeof source.message !== "string"
    || (source.refreshOutcome !== undefined && source.refreshOutcome !== "committed" && source.refreshOutcome !== "refused")) {
    return { status: "unverified", ok: false };
  }
  // The checked fields are the complete mandatory backend contract. Private text is never emitted.
  return projectLocalSyncResult(source as unknown as CodexSyncResult);
}
