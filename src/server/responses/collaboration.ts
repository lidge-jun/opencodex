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
import { modelInList, namespacedToolName, toolChoiceToolPredicate } from "../../types";
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
import { subagentFallbackGuidanceText } from "../../codex/subagent-model-fallback";
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
import type { EffectiveSubagentModel, EffectiveSubagentRoster, SpawnAgentSurface } from "../../codex/catalog";
import type { TranslatorBudget } from "../../lib/translator-budget";


export function buildToolBridgeMaps(parsed: OcxParsedRequest, budget?: TranslatorBudget): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  declaredToolNames: Set<string>;
  /** Declared parameter schema per request-visible tool name (#1611 integer repair). */
  toolParameterSchemas: Map<string, Record<string, unknown>>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const declaredToolNames = new Set<string>();
  const toolParameterSchemas = new Map<string, Record<string, unknown>>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  const toolAllowed = toolChoiceToolPredicate(parsed.options.toolChoice);
  for (const t of parsed.context.tools ?? []) {
    // Upstream output is untrusted: only restore calls for tools the caller authorized.
    if (!toolAllowed(t)) continue;
    const wireName = namespacedToolName(t.namespace, t.name);
    budget?.chargeRetained(new TextEncoder().encode(wireName).byteLength, { kind: "retained_collectors" });
    declaredToolNames.add(wireName);
    // Retained by reference (the schema is already resident in parsed.context.tools),
    // so this adds a map entry rather than a copy of every tool's parameters.
    if (t.parameters && typeof t.parameters === "object") toolParameterSchemas.set(wireName, t.parameters);
    if (t.namespace) {
      budget?.chargeRetained(new TextEncoder().encode(JSON.stringify([wireName, t.namespace, t.name])).byteLength, { kind: "retained_collectors" });
      toolNsMap.set(wireName, { namespace: t.namespace, name: t.name });
    }
    if (t.freeform) {
      budget?.chargeRetained(new TextEncoder().encode(t.name).byteLength, { kind: "retained_collectors" });
      freeformToolNames.add(t.name);
    }
    if (t.toolSearch) {
      budget?.chargeRetained(new TextEncoder().encode(t.name).byteLength, { kind: "retained_collectors" });
      toolSearchToolNames.add(t.name);
    }
  }
  return { toolNsMap, declaredToolNames, toolParameterSchemas, freeformToolNames, toolSearchToolNames };
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
  codexAccountNamespace?: string;
  injectionModel?: string;
  injectionEffort?: string;
  subagentModels?: string[];
  subagentModelFallback?: string[];
  injectionPrompt?: string;
}



export interface MultiAgentGuidanceDeps {
  resolveEffectiveSubagentRoster?: (
    configuredModels: readonly string[],
    surface: SpawnAgentSurface,
  ) => EffectiveSubagentRoster | Promise<EffectiveSubagentRoster>;
  collectCatalogState?: () => { state: "fresh" | "stale" | "not_running" | "unknown" }
    | Promise<{ state: "fresh" | "stale" | "not_running" | "unknown" }>;
}

async function defaultCollectCatalogState(): Promise<{ state: "fresh" | "stale" | "not_running" | "unknown" }> {
  // Explicit override for tests and diagnostics: process state is global and
  // would otherwise leak the host machine's app-server into hermetic tests.
  const override = process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE;
  if (override === "fresh" || override === "stale" || override === "not_running" || override === "unknown") {
    return { state: override };
  }
  const { collectCodexAppServerCatalogStateForRequest } = await import("../../codex/app-server-processes");
  return collectCodexAppServerCatalogStateForRequest();
}



export async function resolveEffectiveSubagentRoster(
  configuredModels: readonly string[],
  surface: SpawnAgentSurface,
): Promise<EffectiveSubagentRoster> {
  const { effectiveSubagentRoster } = await import("../../codex/catalog");
  return effectiveSubagentRoster(configuredModels, surface);
}

/** Reuse one parsed catalog snapshot across every roster projection for this request. */
async function createRequestScopedSubagentRosterResolver(): Promise<NonNullable<
  MultiAgentGuidanceDeps["resolveEffectiveSubagentRoster"]
>> {
  const { effectiveSubagentRoster, readCatalog, readCodexCatalogPath } = await import("../../codex/catalog");
  const catalogEntries = readCatalog(readCodexCatalogPath())?.models ?? [];
  return (configuredModels, surface) =>
    effectiveSubagentRoster(configuredModels, surface, catalogEntries);
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
    codexAccountNamespace,
    subagentModels,
    subagentModelFallback,
    injectionPrompt,
  } = options;
  const activeAccountNamespace = codexAccountNamespace?.length
    ? codexAccountNamespace
    : undefined;
  const surface = collabSurface(parsed);
  if (surface === null) return null;

  if (surface === "v2") {
    // #857: the disk catalog may be newer than the running app-server's
    // in-memory copy. Advertising preferred models or a roster the running
    // Codex cannot actually spawn makes spawn_agent reject the override, so
    // suppress positive model claims while the state is stale or unknown.
    const catalogState = await (deps.collectCatalogState ?? defaultCollectCatalogState)();
    // #1354 / #1395: `collectCodexAppServerCatalogState()` folds every app-server
    // owned by the current user into ONE global observation, and the inbound
    // request carries no sender PID or catalog fingerprint. So a stale process A
    // makes the global state `stale` even when this request came from a fresh
    // process B, and `unknown` can be reached by a process-enumeration failure
    // that says nothing about any particular server.
    //
    // Emitting "do not set model or reasoning_effort overrides" off that global
    // observation prohibits options the active `spawn_agent` tool legitimately
    // advertises, for a request we cannot attribute to the stale process. The
    // safe behaviour is to withhold OpenCodex's own disk-derived claims —
    // preferred model, roster, fallback, custom guidance — and stay silent about
    // overrides, leaving the active tool schema authoritative.
    //
    // `fresh` and `not_running` are unchanged: there we can positively describe
    // the catalog, so the guidance below still applies.
    if (catalogState.state === "stale" || catalogState.state === "unknown") {
      return null;
    }
    // codex-rs supplies the Proactive text on v2; the proxy only adds model-designation
    // guidance, and only when there is something concrete to designate: a configured
    // injectionModel and/or a roster entry that resolves in the injected catalog.
    const configuredForGuidance = [
      ...(subagentModels ?? []),
      ...(injectionModel ? [injectionModel] : []),
    ];
    const resolveRoster = deps.resolveEffectiveSubagentRoster
      ?? await createRequestScopedSubagentRosterResolver();
    const effective = await resolveRoster(configuredForGuidance, "v2");
    // Resolve the roster and preferred roles independently so a bare native can project onto its
    // generated account rows without making an unrelated provider/gpt-* row look equivalent.
    // The intersection keeps both projections inside Codex's one global five-model window.
    const candidateModels = new Set(effective.candidates.map(candidate => candidate.model));
    const withinCandidateWindow = (candidate: EffectiveSubagentModel): boolean =>
      candidateModels.has(candidate.model);
    const configuredSubagents = subagentModels ?? [];
    const subagentEffective = configuredSubagents.length > 0
      ? injectionModel
        ? await resolveRoster(configuredSubagents, "v2")
        : effective
      : undefined;
    const preferredEffective = injectionModel
      ? configuredSubagents.length > 0
        ? await resolveRoster([injectionModel], "v2")
        : effective
      : undefined;
    const explicitlyConfigured = (candidate: EffectiveSubagentModel): boolean =>
      configuredSubagents.some(model =>
        model.includes("/") && slugsEquivalent(model, candidate.model)
      );
    const allowedForCurrentRoute = (candidate: EffectiveSubagentModel): boolean =>
      explicitlyConfigured(candidate)
      || !candidate.model.includes("/")
      || (activeAccountNamespace !== undefined
        && candidate.model.startsWith(`${activeAccountNamespace}/`));
    const rosterModels = (subagentEffective?.advertised ?? [])
      .filter(withinCandidateWindow)
      .filter(allowedForCurrentRoute);
    const roster = subagentRosterText(rosterModels);
    const preferredCandidates = (preferredEffective?.advertised ?? []).filter(withinCandidateWindow);
    const soleBarePreferred = preferredCandidates.length === 1
      && !preferredCandidates[0]!.model.includes("/")
      ? preferredCandidates[0]
      : undefined;
    const preferred = injectionModel?.includes("/")
      ? preferredCandidates[0]
      : activeAccountNamespace
        ? preferredCandidates.find(candidate =>
          candidate.model.startsWith(`${activeAccountNamespace}/`)
        ) ?? soleBarePreferred
        : soleBarePreferred;

    if (isInjectionDebugEnabled() && effective.excluded.length > 0) {
      injectionDebugLog(`[opencodex] multi-agent guidance excluded: ${effective.excluded
        .map(item => `${item.configured}:${item.reason}`)
        .join(", ")}`);
    }
    const fallbackGuidance = subagentFallbackGuidanceText({ subagentModelFallback } as OcxConfig);
    if (!injectionModel && roster === "" && fallbackGuidance === "") return null;
    if (injectionPrompt) {
      // Bare ids must resolve to a unique/current-route candidate. Preserve the legacy raw
      // fallback only for explicit routed/account-qualified ids.
      const promptModel = preferred?.model
        ?? (injectionModel?.includes("/") ? injectionModel : undefined);
      return `<multi_agent_mode>${applyInjectionPlaceholders(injectionPrompt, promptModel, injectionEffort, roster, fallbackGuidance)}</multi_agent_mode>`;
    }
    if (!preferred && roster === "" && fallbackGuidance === "") return null;
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
    text += fallbackGuidance;
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



export const V2_GUIDANCE_CHAR_BUDGET = 700;

export function applyInjectionPlaceholders(prompt: string, model?: string, effort?: string, roster?: string, fallback?: string): string {
  return prompt
    .replaceAll("{{model}}", model ?? "")
    .replaceAll("{{effort}}", effort ?? "")
    .replaceAll("{{roster}}", roster ?? "")
    .replaceAll("{{fallback}}", fallback ?? "");
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



function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function generatedDeveloperText(item: unknown): string | undefined {
  if (!isRecord(item) || item.type !== "message" || item.role !== "developer") return undefined;
  if (!Array.isArray(item.content) || item.content.length !== 1) return undefined;
  const [part] = item.content;
  return isRecord(part) && part.type === "input_text" && typeof part.text === "string"
    ? part.text
    : undefined;
}

function isGeneratedDeveloperItem(item: unknown, text: string): boolean {
  return generatedDeveloperText(item) === text;
}

function isDeveloperPrefixItem(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (item.type === "additional_tools") return item.role === "developer";
  const type = item.type ?? (typeof item.role === "string" ? "message" : undefined);
  return type === "message" && (item.role === "system" || item.role === "developer");
}

function leadingDeveloperPrefixLength(items: readonly unknown[]): number {
  let index = 0;
  while (index < items.length && isDeveloperPrefixItem(items[index])) index += 1;
  return index;
}

function isConversationalItem(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (item.type === "agent_message") return true;
  const type = item.type ?? (typeof item.role === "string" ? "message" : undefined);
  return type === "message" && (item.role === "user" || item.role === "assistant");
}

function statefulRawInsertionIndex(items: readonly unknown[], replayPrefixLen: number): number {
  for (let index = replayPrefixLen; index < items.length; index += 1) {
    if (isConversationalItem(items[index])) return index;
  }
  const last = items[items.length - 1];
  return isRecord(last) && last.type === "compaction_trigger"
    ? items.length - 1
    : items.length;
}

export function injectDeveloperMessage(parsed: OcxParsedRequest, text: string): void {
  const raw = parsed._rawBody as { input?: unknown } | undefined;
  const rawInput = raw && Array.isArray(raw.input) ? raw.input : undefined;
  const replayPrefixLen = rawInput
    ? Math.min(parsed._replayPrefixLen ?? 0, rawInput.length)
    : 0;
  const devItem = { type: "message", role: "developer", content: [{ type: "input_text", text }] };
  if (rawInput) {
    const replayPrefix = rawInput.slice(0, replayPrefixLen);
    const taggedGuidance = text.startsWith("<multi_agent_mode>") && text.endsWith("</multi_agent_mode>");
    const lastTaggedGuidance = taggedGuidance
      ? replayPrefix.map(generatedDeveloperText)
        .filter(item => item?.startsWith("<multi_agent_mode>") && item.endsWith("</multi_agent_mode>"))
        .at(-1)
      : undefined;
    if (taggedGuidance ? lastTaggedGuidance === text : replayPrefix.some(item => isGeneratedDeveloperItem(item, text))) {
      return;
    }
  }

  const statefulContinuation = parsed.previousResponseId !== undefined;
  const message = { role: "developer" as const, content: text, timestamp: Date.now() };
  const statefulRawIndex = statefulContinuation && rawInput
    ? statefulRawInsertionIndex(rawInput, replayPrefixLen)
    : undefined;

  // A previous_response_id delta can begin with tool/protocol items. Keep those first, then place
  // changed guidance before the current conversation. Stateless requests keep guidance in the prefix.
  if (statefulContinuation) {
    const index = Math.min(
      parsed._continuationConversationMessageIndex ?? parsed.context.messages.length,
      parsed.context.messages.length,
    );
    parsed.context.messages.splice(index, 0, message);
  } else {
    const prefixLen = parsed.context.messages.findIndex(item => item.role !== "developer");
    parsed.context.messages.splice(prefixLen < 0 ? parsed.context.messages.length : prefixLen, 0, message);
  }

  if (rawInput) {
    if (statefulContinuation) {
      rawInput.splice(statefulRawIndex!, 0, devItem);
    } else {
      rawInput.splice(leadingDeveloperPrefixLength(rawInput), 0, devItem);
    }
  }
}
