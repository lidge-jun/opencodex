import type { Server } from "bun";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "../../bridge";
import {
  getConfigPath,
  multiAgentGuidanceEnabled,
  resolveEnvValue,
} from "../../config";
import { parseRequest } from "../../responses/parser";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "../../responses/compaction";
import { FORWARD_HEADERS, sanitizeReasoningInputContent } from "../../adapters/openai-responses";
import { expandPreviousResponseInput, previousResponseProviderState, rememberResponseState } from "../../responses/state";
import { routeModel } from "../../router";
import {
  advanceComboAfterFailure,
  comboDefaultEffort,
  comboFailureDecision,
  comboIdFromRawBody,
  concreteComboRequestBody,
  getCombo,
  isComboTargetInCooldown,
  NoAvailableComboTargetsError,
  noteComboSuccess,
  parseRetryAfterMs,
  pickComboTarget,
  targetKey,
} from "../../combos";
import { isInjectionDebugEnabled } from "../../lib/debug-settings";
import { injectionDebugLog } from "../../lib/injection-debug-log";
import { modelInList, namespacedToolName } from "../../types";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig, OcxProviderContinuationState, OcxUsage } from "../../types";
import {
  forceRefreshOAuthAccessSnapshot,
  getOAuthCredentialApiBaseUrl,
  getOAuthCredentialProjectId,
  getValidAccessTokenSnapshot,
  type OAuthAccessSnapshot,
  UnsupportedOAuthProviderError,
} from "../../oauth";
import { buildWebSearchTool, planWebSearch, runWithWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../../web-search";
import { describeImagesInPlace, planVisionSidecar, shouldResolveOpenAiVisionSidecar, stripImagesInPlace } from "../../vision";
import { createAdapterEventQueue, preflightAdapterEvents } from "../../adapters/run-turn-queue";
import {
  applyCodexAuthContextToProvider,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  type CodexAuthContext,
} from "../../codex/auth-context";
import {
  formatCodexProviderForLog,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../../codex/routing";
import { fetchWithResetRetry, fetchWithTransientRetry, applyUpstreamRecoveryInit } from "../../lib/upstream-retry";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "../auth-cors";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar, type ResolvedOpenAiForwardSidecar } from "../../providers/openai-sidecar";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { slugsEquivalent } from "../../providers/slug-codec";
import { applyOpenAiVirtualModel, resolveOpenAiCompactModel } from "../../providers/openai-virtual-models";
import { isUsageDebugEnabled } from "../../usage/debug";
import { readJsonRequestBody, DecompressedBodyTooLargeError, UnsupportedContentEncodingError } from "../request-decompress";
import { resolveAdapter, resolveWireProtocolOverride } from "../adapter-resolve";
import { hasKeyPoolFailover, rotateProviderTransportOn429 } from "../../providers/key-failover";
import { shouldAttemptImageTierRetry } from "../image-retry";
import { resolveProviderTransport } from "../../providers/xai-transport";
import type { WsData } from "../ws-bridge";
import { registerTurn, trackStreamLifetime, unregisterTurn } from "../lifecycle";
import { redactSecretString } from "../../lib/redact";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { supportedLadderFor } from "../effort-policy";
import {
  beginRequestAttempt,
  catalogModelSupportsServiceTier,
  finishRequestAttempt,
  inspectResponseLogJson,
  noteAttemptSend,
  readConfiguredCodexServiceTier,
  requestLogSpeedLabel,
  sealRequestAttemptIdentity,
  usageFromResponsesPayload,
  type RequestLogContext,
} from "../request-log";
import type { AttemptRecoveryKind } from "../../usage/log";
import {
  consumeForInspection,
  consumeForResponseLogMetadata,
  markNativePassthroughSseResponse,
  relaySseWithFailedTail,
  relayWithAbort,
  sanitizePassthroughHeaders,
} from "../relay";
import { hasResponsesItemIdRepair, relaySseWithResponsesItemIdRepair } from "../responses-item-id-repair";
import type { EffectiveSubagentRoster, SpawnAgentSurface } from "../../codex/catalog";


export function buildToolBridgeMaps(parsed: OcxParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const t of parsed.context.tools ?? []) {
    if (t.namespace) toolNsMap.set(namespacedToolName(t.namespace, t.name), { namespace: t.namespace, name: t.name });
    if (t.freeform) freeformToolNames.add(t.name);
    if (t.toolSearch) toolSearchToolNames.add(t.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}



export const PROACTIVE_MULTI_AGENT_MODE_TEXT = [
  "Proactive multi-agent delegation is active.",
  "Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies.",
  "Delegate independent sub-tasks to sub-agents whenever parallel work would materially improve speed or quality — do not serialize work that can run concurrently.",
  "Each sub-agent runs in its own context and can use all available tools; prefer spawning specialists over doing everything yourself.",
  "This mode remains active until a later multi-agent mode developer message changes it.",
].join(" ");

export function isV1CollabSurface(parsed: OcxParsedRequest): boolean {
  return collabSurface(parsed) === "v1";
}



export function collabSurface(parsed: OcxParsedRequest): "v1" | "v2" | null {
  let namespacedSpawn = false;
  let flatSpawn = false;
  let v1Only = false;
  let v2Only = false;
  for (const t of parsed.context.tools ?? []) {
    if (t.name === "spawn_agent") {
      if (t.namespace) namespacedSpawn = true;
      else flatSpawn = true;
    } else if (t.name === "send_input" || t.name === "resume_agent" || t.name === "close_agent") {
      v1Only = true;
    } else if (t.name === "send_message" || t.name === "followup_task" || t.name === "interrupt_agent" || t.name === "list_agents") {
      v2Only = true;
    }
  }
  if (!namespacedSpawn && !flatSpawn) return null; // no spawn_agent -> no collab surface
  if (namespacedSpawn && flatSpawn) return null;   // contradictory spawn shapes
  if (v1Only && v2Only) return null;               // contradictory companions
  if (v1Only) return "v1";
  if (v2Only) return "v2";
  return namespacedSpawn ? "v1" : "v2"; // companionless fallbacks (legacy defaults)
}



export interface MultiAgentGuidanceOptions {
  multiAgentGuidanceEnabled?: boolean;
  injectionModel?: string;
  injectionEffort?: string;
  subagentModels?: string[];
  injectionPrompt?: string;
}



export interface MultiAgentGuidanceDeps {
  resolveEffectiveSubagentRoster?: (
    configuredModels: readonly string[],
    surface: SpawnAgentSurface,
  ) => EffectiveSubagentRoster | Promise<EffectiveSubagentRoster>;
}



export async function resolveEffectiveSubagentRoster(
  configuredModels: readonly string[],
  surface: SpawnAgentSurface,
): Promise<EffectiveSubagentRoster> {
  const { effectiveSubagentRoster } = await import("../../codex/catalog");
  return effectiveSubagentRoster(configuredModels, surface);
}



export async function multiAgentGuidanceText(
  parsed: OcxParsedRequest,
  options: MultiAgentGuidanceOptions = {},
  deps: MultiAgentGuidanceDeps = {},
): Promise<string | null> {
  if (options.multiAgentGuidanceEnabled === false) return null;
  const {
    injectionModel,
    injectionEffort,
    subagentModels,
    injectionPrompt,
  } = options;
  const surface = collabSurface(parsed);
  if (surface === null) return null;

  if (surface === "v2") {
    // A whitespace-only override used to produce `<multi_agent_mode> </multi_agent_mode>`.
    // Treat an explicitly blank custom prompt as silent instead of emitting a no-op
    // developer message on every request continuation.
    if (injectionPrompt !== undefined && injectionPrompt.trim() === "") return null;

    // codex-rs supplies the Proactive text on v2; the proxy only adds model-designation
    // guidance, and only when there is something concrete to designate: a configured
    // injectionModel and/or a roster entry that resolves in the injected catalog.
    const configuredForGuidance = [
      ...(subagentModels ?? []),
      ...(injectionModel ? [injectionModel] : []),
    ];
    const resolveRoster = deps.resolveEffectiveSubagentRoster ?? resolveEffectiveSubagentRoster;
    const effective = await resolveRoster(configuredForGuidance, "v2");
    const rosterModels = effective.advertised.filter(candidate =>
      (subagentModels ?? []).some(model => slugsEquivalent(model, candidate.model))
    );
    const roster = subagentRosterText(rosterModels);
    const preferred = injectionModel
      ? effective.candidates.find(candidate => slugsEquivalent(injectionModel, candidate.model))
      : undefined;

    if (isInjectionDebugEnabled() && effective.excluded.length > 0) {
      injectionDebugLog(`[opencodex] multi-agent guidance excluded: ${effective.excluded
        .map(item => `${item.configured}:${item.reason}`)
        .join(", ")}`);
    }
    if (!injectionModel && roster === "") return null;
    if (injectionPrompt) {
      return `<multi_agent_mode>${applyInjectionPlaceholders(injectionPrompt, injectionModel, injectionEffort, roster)}</multi_agent_mode>`;
    }
    if (!preferred && roster === "") return null;
    let text = "When the active spawn_agent tool supports optional \"model\" or \"reasoning_effort\" overrides, "
      + "use only models listed for this collaboration surface. "
      + "When setting either override, set fork_turns to \"none\" "
      + "(or a positive turn count such as \"3\"; full-history forks reject overrides) "
      + "and make the task message self-contained.";
    if (preferred) {
      text += ` Preferred sub-agent: model "${preferred.model}"`
        + (injectionEffort ? `, reasoning_effort "${injectionEffort}"` : "")
        + " — use it unless the user names another.";
    }
    text += roster;
    if (text.length > V2_GUIDANCE_CHAR_BUDGET) {
      // Roster is the only unbounded part — drop it before breaking the budget.
      text = text.slice(0, text.length - roster.length);
    }
    return `<multi_agent_mode>${text}</multi_agent_mode>`;
  }

  const effort = parsed.options.reasoning;
  // v1 keeps only the upstream-parity behavior: Proactive text at the top tier
  // (ultra arrives as max on the wire). No designation/roster payload here.
  if (effort !== "max" && effort !== "ultra") return null;
  return `<multi_agent_mode>${PROACTIVE_MULTI_AGENT_MODE_TEXT}</multi_agent_mode>`;
}

/** True when the raw Responses request contains only tool-result delta items. */
export function isToolOutputContinuation(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const input = (body as { input?: unknown }).input;
  return Array.isArray(input)
    && input.length > 0
    && input.every(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const type = (item as { type?: unknown }).type;
      return typeof type === "string" && type.endsWith("_call_output");
    });
}

/** Build guidance for a raw Responses request, excluding tool-result continuations. */
export async function multiAgentGuidanceForRequest(
  parsed: OcxParsedRequest,
  rawBody: unknown,
  options: MultiAgentGuidanceOptions = {},
  deps: MultiAgentGuidanceDeps = {},
): Promise<string | null> {
  if (isToolOutputContinuation(rawBody)) return null;
  return multiAgentGuidanceText(parsed, options, deps);
}



export const V2_GUIDANCE_CHAR_BUDGET = 700;

export function applyInjectionPlaceholders(prompt: string, model?: string, effort?: string, roster?: string): string {
  return prompt
    .replaceAll("{{model}}", model ?? "")
    .replaceAll("{{effort}}", effort ?? "")
    .replaceAll("{{roster}}", roster ?? "");
}



export function subagentRosterText(models: Array<{ model: string; efforts: string[] }>): string {
  if (models.length === 0) return "";
  const ladders = new Set(models.map(model => model.efforts.join("/")));
  if (!ladders.has("") && ladders.size === 1) {
    return ` Available models (reasoning_effort ${[...ladders][0]}): ${models
      .map(model => `"${model.model}"`)
      .join(", ")}.`;
  }
  const entries = models.map(model => model.efforts.length > 0
    ? `"${model.model}" (${model.efforts.join("/")})`
    : `"${model.model}"`);
  return ` Available models (valid reasoning_effort): ${entries.join(", ")}.`;
}



export function injectDeveloperMessage(parsed: OcxParsedRequest, text: string): void {
  parsed.context.messages.push({ role: "developer", content: text, timestamp: Date.now() });
  const raw = parsed._rawBody as { input?: unknown } | undefined;
  if (raw && Array.isArray(raw.input)) {
    const devItem = { type: "message", role: "developer", content: [{ type: "input_text", text }] };
    // compaction_trigger must remain the final input item (codex-rs + ChatGPT backend both
    // validate this). Insert the developer message BEFORE the trigger when present.
    const last = raw.input[raw.input.length - 1];
    if (last && typeof last === "object" && (last as { type?: string }).type === "compaction_trigger") {
      raw.input.splice(raw.input.length - 1, 0, devItem);
    } else {
      raw.input.push(devItem);
    }
  }
}
