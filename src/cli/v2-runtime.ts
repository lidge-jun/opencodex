import { SUBAGENT_SURFACE_GUIDE_URL } from "../config/multi-agent-surface";
import { printCatalogResult, runCatalogAction } from "./catalog-command-result";
import { serializeManagementJson } from "./json-input";
import { RuntimeApiError, printData, runtimeBaseUrl, runtimeRequest, type RuntimeApiDeps } from "./runtime-api";
import type { V2ParsedCommand } from "./v2-input";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function mode(value: unknown): value is "v1" | "default" | "v2" {
  return value === "v1" || value === "default" || value === "v2";
}
function nullableString(value: unknown): value is string | null { return value === null || typeof value === "string"; }

/** Allowlisted task fields only: neither helper errors nor arbitrary response spreads. */
function stateDto(value: unknown): Record<string, unknown> {
  if (!record(value) || !mode(value.multiAgentMode)) throw new Error("Invalid v2 state");
  const result: Record<string, unknown> = { multiAgentMode: value.multiAgentMode };
  for (const key of ["enabled", "agentsMaxThreadsConflict", "keepNativeChatGptOnV1", "agentsMaxDepthAppliesWhenV2Disabled"] as const) {
    if (typeof value[key] !== "boolean") throw new Error("Invalid v2 boolean");
    result[key] = value[key];
  }
  if (value.agentsEnabled !== null && typeof value.agentsEnabled !== "boolean") throw new Error("Invalid agents state");
  if (value.maxConcurrentThreadsPerSession !== null && !(typeof value.maxConcurrentThreadsPerSession === "number"
    && Number.isSafeInteger(value.maxConcurrentThreadsPerSession) && value.maxConcurrentThreadsPerSession >= 1)) throw new Error("Invalid thread state");
  if (value.agentsMaxDepth !== null && !(typeof value.agentsMaxDepth === "number" && Number.isInteger(value.agentsMaxDepth)
    && value.agentsMaxDepth >= -2147483648 && value.agentsMaxDepth <= 2147483647)) throw new Error("Invalid depth state");
  for (const key of ["subagentDeveloperInstructions", "multiAgentModeHintText"] as const) {
    if (!nullableString(value[key])) throw new Error("Invalid text state");
    result[key] = value[key];
  }
  const recommendation = value.multiAgentModeHintRecommendation;
  if (!record(recommendation) || typeof recommendation.revision !== "string" || typeof recommendation.text !== "string") throw new Error("Invalid hint recommendation");
  const advisory = value.multiAgentSurfaceAdvisory;
  if (!record(advisory) || typeof advisory.required !== "boolean" || advisory.mode !== value.multiAgentMode
    || advisory.recommended !== "v1" || typeof advisory.version !== "number" || !Number.isSafeInteger(advisory.version)
    || advisory.version < 1 || advisory.docsUrl !== SUBAGENT_SURFACE_GUIDE_URL) throw new Error("Invalid surface advisory");
  return { ...result, agentsEnabled: value.agentsEnabled, agentsMaxDepth: value.agentsMaxDepth,
    maxConcurrentThreadsPerSession: value.maxConcurrentThreadsPerSession,
    multiAgentModeHintRecommendation: { revision: recommendation.revision, text: recommendation.text },
    multiAgentSurfaceAdvisory: { required: advisory.required, mode: advisory.mode, recommended: "v1",
      version: advisory.version, docsUrl: advisory.docsUrl } };
}

function bodyFor(parsed: V2ParsedCommand): Record<string, unknown> {
  switch (parsed.verb) {
    case "on": case "off": return { enabled: parsed.verb === "on" };
    case "mode": return { multiAgentMode: parsed.value,
      ...(parsed.acknowledge ? { multiAgentSurfaceAdvisoryAcknowledged: true } : {}) };
    case "keep-native-v1": return { keepNativeChatGptOnV1: parsed.value };
    case "threads": return { maxConcurrentThreadsPerSession: parsed.value };
    case "mode-hint": return { multiAgentModeHintText: parsed.value };
    case "status": return {};
  }
}

export async function handleV2RuntimeCommand(parsed: V2ParsedCommand, deps: RuntimeApiDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const read = parsed.verb === "status";
    const body = read ? undefined : serializeManagementJson(bodyFor(parsed));
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    let response: unknown;
    try {
      response = await runtimeRequest("/api/v2", { method: read ? "GET" : "PUT", redirect: "error", ...(body ? { body } : {}) }, pinned);
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 502) {
        console.error("Error: Native V2 settings may be partially applied. Read ocx v2 status --live before retrying; no rollback is implied.");
        return 1;
      }
      throw error;
    }
    const state = stateDto(response);
    const lines = [`multi_agent_v2: ${state.enabled ? "ON" : "OFF"}`, `multi_agent_mode: ${state.multiAgentMode}`,
      `keep_native_chatgpt_on_v1: ${state.keepNativeChatGptOnV1 ? "ON" : "OFF"}`,
      `max_threads: ${state.maxConcurrentThreadsPerSession ?? "unset"}`,
      `agents.enabled: ${state.agentsEnabled ?? "unset (upstream default)"}`,
      `agents.max_depth: ${state.agentsMaxDepth ?? "unset"}${state.enabled ? " (V1-only — ignored while V2 is enabled)" : ""}`,
      `subagent_developer_instructions: ${JSON.stringify(state.subagentDeveloperInstructions)}`,
      `multi_agent_mode_hint_text: ${JSON.stringify(state.multiAgentModeHintText)}`];
    if (state.agentsMaxThreadsConflict) lines.push("Native thread-limit conflict: inspect the selected target's Codex configuration before starting Codex.");
    if (state.enabled && state.agentsEnabled === false) lines.push("agents.enabled=false does not disable multi-agent while the global V2 feature is enabled.");
    if (record(state.multiAgentSurfaceAdvisory) && state.multiAgentSurfaceAdvisory.required) {
      lines.push(`Surface advisory: v1 is recommended. ${SUBAGENT_SURFACE_GUIDE_URL}`);
    }
    if (read) { printData({ target: "live", ...state }, parsed.json, lines); return 0; }
    if (!record(response) || response.ok !== true) throw new Error("Invalid write receipt");
    return printCatalogResult({ ok: true, target: "live", ...state }, response.catalogRefresh, parsed.json,
      [...lines, "V2 settings saved. Applies to new sessions."]);
  });
}
