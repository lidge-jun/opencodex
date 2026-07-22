import type { Server } from "bun";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "../bridge";
import {
  getConfigPath,
  resolveEnvValue,
} from "../config";
import { parseRequest } from "../responses/parser";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "../responses/compaction";
import { FORWARD_HEADERS, sanitizeReasoningInputContent } from "../adapters/openai-responses";
import { expandPreviousResponseInput, previousResponseConversationId, previousResponseCursorContextTokens, rememberResponseState } from "../responses/state";
import { routeModel } from "../router";
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
} from "../combos";
import { isInjectionDebugEnabled } from "../lib/debug-settings";
import { injectionDebugLog } from "../lib/injection-debug-log";
import { modelInList, namespacedToolName } from "../types";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../types";
import {
  forceRefreshOAuthAccessSnapshot,
  getOAuthCredentialApiBaseUrl,
  getOAuthCredentialProjectId,
  getValidAccessTokenSnapshot,
  type OAuthAccessSnapshot,
  UnsupportedOAuthProviderError,
} from "../oauth";
import { buildWebSearchTool, planWebSearch, runWithWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../web-search";
import { describeImagesInPlace, planVisionSidecar, shouldResolveOpenAiVisionSidecar, stripImagesInPlace } from "../vision";
import { createAdapterEventQueue, preflightAdapterEvents } from "../adapters/run-turn-queue";
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
} from "../codex/auth-context";
import {
  formatCodexProviderForLog,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../codex/routing";
import { fetchWithResetRetry, fetchWithTransientRetry, applyUpstreamRecoveryInit } from "../lib/upstream-retry";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "./auth-cors";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar, type ResolvedOpenAiForwardSidecar } from "../providers/openai-sidecar";
import { applyOpenAiVirtualModel, resolveOpenAiCompactModel } from "../providers/openai-virtual-models";
import { isUsageDebugEnabled } from "../usage/debug";
import { readJsonRequestBody, DecompressedBodyTooLargeError, UnsupportedContentEncodingError } from "./request-decompress";
import { resolveAdapter, resolveWireProtocolOverride } from "./adapter-resolve";
import { hasKeyPoolFailover, rotateProviderTransportOn429 } from "../providers/key-failover";
import { shouldAttemptImageTierRetry } from "./image-retry";
import { resolveProviderTransport } from "../providers/xai-transport";
import type { WsData } from "./ws-bridge";
import { registerTurn, trackStreamLifetime, unregisterTurn } from "./lifecycle";
import { redactSecretString } from "../lib/redact";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { supportedLadderFor } from "./effort-policy";
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
} from "./request-log";
import type { AttemptRecoveryKind } from "../usage/log";
import {
  consumeForInspection,
  consumeForResponseLogMetadata,
  markNativePassthroughSseResponse,
  relaySseWithFailedTail,
  relayWithAbort,
  sanitizePassthroughHeaders,
} from "./relay";

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

/** Verbatim upstream Proactive text (codex-rs core/src/context/multi_agent_mode_instructions.rs). */
const PROACTIVE_MULTI_AGENT_MODE_TEXT = [
  "Proactive multi-agent delegation is active.",
  "Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies.",
  "Delegate independent sub-tasks to sub-agents whenever parallel work would materially improve speed or quality — do not serialize work that can run concurrently.",
  "Each sub-agent runs in its own context and can use all available tools; prefer spawning specialists over doing everything yourself.",
  "This mode remains active until a later multi-agent mode developer message changes it.",
].join(" ");

/**
 * True when this turn runs the v1 collab surface, judged from the request's own tool list
 * (codex registers exactly one surface per thread, core/src/tools/spec_plan.rs): v1 ships
 * spawn_agent inside a namespace plus v1-only names (send_input/close_agent); v2 ships a
 * flat spawn_agent. A flat spawn_agent vetoes so an ambiguous mix never counts as v1.
 */
export function isV1CollabSurface(parsed: OcxParsedRequest): boolean {
  return collabSurface(parsed) === "v1";
}

/**
 * Which multi-agent collab surface this turn carries, judged from the request's own
 * tool list. Real wire shapes (codex-rs spec_plan.rs add_collaboration_tools):
 *  - v1: tools under the "multi_agent_v1" namespace, always accompanied by v1-only
 *    names (send_input / resume_agent / close_agent).
 *  - v2 on namespace_tools providers (e.g. the ChatGPT backend): tools under the
 *    "collaboration" namespace (config.multi_agent_v2.tool_namespace — user-settable,
 *    so the name is not hardcoded here), with v2-only companions (send_message /
 *    followup_task / interrupt_agent / list_agents).
 *  - v2 without namespace support: a flat spawn_agent.
 * Companion tools are the primary discriminator; a companionless namespaced spawn
 * falls back to "v1" (legacy behavior) and a companionless flat spawn to "v2".
 * Contradictory markers count as neither — never inject on unclear ground.
 */
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

/**
 * Multi-agent guidance for this turn, or null when nothing applies.
 *
 * V1 surface: codex-rs only emits its Proactive delegation developer message on the
 * v2 surface, so when a v1-surface turn arrives at the synthetic top tier (codex
 * converts ultra -> max on the wire, so max arrival means the user picked the top
 * rung) the proxy supplies the same one-liner, wrapped in codex's own
 * <multi_agent_mode> tags. That is ALL v1 gets — no model designation, no roster
 * (kept lean by request, devlog 260710): ultra-tier injection is sufficient there.
 *
 * V2 surface (flat spawn_agent — sol/terra under the default mode, EVERY model when
 * `ocx v2 mode v2` forces the pins): codex-rs already emits its own Proactive text
 * there, so the proxy never duplicates it — it adds only model-designation guidance,
 * and only when it has something to designate: an injectionModel and/or a
 * subagentModels roster entry that resolves in the injected catalog. v2 rejects
 * model/effort overrides on a full-history fork (multi_agents_v2/spawn.rs
 * reject_full_fork_spawn_overrides), so the prompt mandates fork_turns "none" or a
 * partial fork plus a self-contained task message.
 * The published spawn_agent schema HIDES model/reasoning_effort by
 * default (hide_spawn_agent_metadata=true upstream — and it must STAY hidden: the
 * ChatGPT backend treats collaboration.spawn_agent as a reserved function and
 * rejects any request whose declared schema deviates, "Invalid Value: 'tools'").
 * That is prompt-workable: SpawnAgentArgs always parses model/reasoning_effort
 * regardless of the flag (spawn.rs), so the prompt tells the model to pass the
 * arguments even though the schema does not list them.
 *
 * The v2 body is budgeted to <= 700 chars (V2_GUIDANCE_CHAR_BUDGET): rules first,
 * then the preferred model, then the compact roster of configured `subagentModels`
 * with the effort ladder each advertises in the injected catalog (the list codex-rs
 * validates spawn efforts against). A user-configured `injectionPrompt` replaces the
 * v2 body with {{model}}/{{effort}}/{{roster}} placeholder substitution (own length,
 * user-owned); firing gates are unchanged.
 */
export async function multiAgentGuidanceText(parsed: OcxParsedRequest, injectionModel?: string, injectionEffort?: string, subagentModels?: string[], injectionPrompt?: string): Promise<string | null> {
  const surface = collabSurface(parsed);
  if (surface === null) return null;

  if (surface === "v2") {
    // codex-rs supplies the Proactive text on v2; the proxy only adds model-designation
    // guidance, and only when there is something concrete to designate: a configured
    // injectionModel and/or a roster entry that resolves in the injected catalog.
    const roster = await subagentRosterText(subagentModels);
    if (!injectionModel && roster === "") return null;
    if (injectionPrompt) {
      return `<multi_agent_mode>${applyInjectionPlaceholders(injectionPrompt, injectionModel, injectionEffort, roster)}</multi_agent_mode>`;
    }
    let text = "spawn_agent also accepts hidden \"model\" and \"reasoning_effort\" string arguments "
      + "(not in the schema, but parsed and applied) — never claim sub-agent models cannot be selected. "
      + "When setting either, set fork_turns to \"none\" (or e.g. \"3\"; full-history forks reject overrides) "
      + "and make the message self-contained.";
    if (injectionModel) {
      text += ` Preferred sub-agent: model "${injectionModel}"`
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

/** Hard budget for the built-in v2 guidance body (user request: keep injection lean). */
export const V2_GUIDANCE_CHAR_BUDGET = 700;

/** {{model}}/{{effort}}/{{roster}} substitution for the user-configured injectionPrompt. */
function applyInjectionPlaceholders(prompt: string, model?: string, effort?: string, roster?: string): string {
  return prompt
    .replaceAll("{{model}}", model ?? "")
    .replaceAll("{{effort}}", effort ?? "")
    .replaceAll("{{roster}}", roster ?? "");
}

/**
 * Compact one-line roster of configured sub-agent models, or "" when no configured
 * model resolves to a catalog entry. Efforts come from the injected catalog
 * (catalogModelEfforts) so only rungs codex-rs will actually accept are advertised.
 */
async function subagentRosterText(subagentModels?: string[]): Promise<string> {
  const featured = (subagentModels ?? []).filter(id => typeof id === "string" && id.trim().length > 0);
  if (featured.length === 0) return "";
  const { catalogModelEfforts } = await import("../codex/catalog");
  const efforts = catalogModelEfforts(featured);
  const resolved = featured.filter(id => efforts.has(id));
  if (resolved.length === 0) return "";
  const ladders = new Set(resolved.map(id => efforts.get(id)!.join("/")));
  if (ladders.size === 1) {
    // Shared ladder (the common case: the injected catalog advertises one rung set)
    // -> state it once instead of per model, keeping the roster inside the budget.
    const ids = resolved.map(id => `"${id}"`).join(", ");
    return ` Available models (reasoning_effort ${[...ladders][0]}): ${ids}.`;
  }
  const entries = resolved.map(id => `"${id}" (${efforts.get(id)!.join("/")})`);
  return ` Available models (valid reasoning_effort): ${entries.join(", ")}.`;
}

/**
 * Append a developer message to BOTH request shapes: parsed.context.messages feeds the
 * routed adapters, while the ChatGPT passthrough serializes _rawBody verbatim (same
 * dual-write contract as the mock-max clamp in handleResponses).
 */
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

/**
 * True when an encrypted_content payload plausibly came from the ChatGPT backend
 * (opaque base64-ish blob). codex-rs's `InterAgentCommunication::new_encrypted` performs
 * NO local crypto — it just parks plaintext in the encrypted slot and relies on the
 * backend to swap in real ciphertext. Under a routed (ocx-served) parent the backend
 * never sees the parent turn, so the slot still holds plaintext when a native child
 * replays it — and the backend then fails the turn with "Encrypted function output
 * content could not be decrypted or decoded" (observed 260709 as 502 retry loops).
 */
function looksLikeBackendCiphertext(payload: string): boolean {
  return payload.length >= 64 && /^[A-Za-z0-9+/=_-]+$/.test(payload);
}

/**
 * Backend-minted ciphertext runs are Fernet tokens (base64url, version byte 0x80 ->
 * literal "gAAAA" prefix). Used to carve embedded blobs out of MIXED slots: plugin
 * hooks (e.g. codexclaw's leaf guard) prepend plaintext preambles to spawn messages
 * whose task body is already backend-encrypted, producing a slot that is neither
 * decryptable (backend) nor readable (model) as a whole.
 */
const FERNET_TOKEN_RUN = /gAAAA[A-Za-z0-9_-]{60,}={0,2}/g;

/**
 * Split a non-ciphertext encrypted slot into ordered parts: prose becomes input_text,
 * embedded Fernet blobs stay encrypted_content so the backend can still decrypt the
 * real task body. A slot with no embedded blob degrades to a single input_text part.
 */
function encryptedSlotParts(payload: string): Array<Record<string, string>> {
  const parts: Array<Record<string, string>> = [];
  let last = 0;
  for (const match of payload.matchAll(FERNET_TOKEN_RUN)) {
    const index = match.index ?? 0;
    const before = payload.slice(last, index);
    if (before.trim().length > 0) parts.push({ type: "input_text", text: before });
    parts.push({ type: "encrypted_content", encrypted_content: match[0] });
    last = index + match[0].length;
  }
  const rest = payload.slice(last);
  if (rest.trim().length > 0) parts.push({ type: "input_text", text: rest });
  return parts.length > 0 ? parts : [{ type: "input_text", text: payload }];
}

function hasEncryptedContentPart(content: unknown): boolean {
  return Array.isArray(content) && content.some(part => (
    part && typeof part === "object"
    && (part as { type?: unknown }).type === "encrypted_content"
  ));
}

/**
 * Rewrite non-ciphertext `{type:"encrypted_content"}` parts into `{type:"input_text"}`
 * throughout a request's input items (message content and function_call_output content
 * arrays share the part shape, codex-rs protocol/models.rs). An `agent_message` whose
 * payload becomes entirely plaintext is normalized to a user message so routed parsers
 * that do not understand the internal item type still deliver the spawn task.
 * Genuine backend blobs are left byte-identical so replay/cache semantics survive, and
 * MIXED slots (plaintext preamble + embedded Fernet task body) are split so the backend
 * decrypts the blob while the prose passes as text. Returns the number of parts rewritten.
 */
export function sanitizeEncryptedContentInPlace(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let rewritten = 0;
  const visit = (node: unknown): number => {
    const before = rewritten;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const child = node[i] as unknown;
        if (
          child && typeof child === "object"
          && (child as { type?: unknown }).type === "encrypted_content"
          && typeof (child as { encrypted_content?: unknown }).encrypted_content === "string"
        ) {
          const payload = (child as { encrypted_content: string }).encrypted_content;
          if (!looksLikeBackendCiphertext(payload)) {
            const parts = encryptedSlotParts(payload);
            node.splice(i, 1, ...parts);
            i += parts.length - 1;
            rewritten += 1;
            continue;
          }
        }
        const childRewrites = visit(child);
        if (
          childRewrites > 0
          && child && typeof child === "object"
          && (child as { type?: unknown }).type === "agent_message"
          && !hasEncryptedContentPart((child as { content?: unknown }).content)
        ) {
          const message = child as { type: string; role?: string; id?: unknown; author?: unknown; recipient?: unknown };
          message.type = "message";
          message.role = "user";
          delete message.id;
          delete message.author;
          delete message.recipient;
        }
      }
      return rewritten - before;
    }
    if (node && typeof node === "object") {
      for (const value of Object.values(node)) visit(value);
    }
    return rewritten - before;
  };
  visit(input);
  return rewritten;
}

export function sidecarOutcomeRecorder(
  config: OcxConfig,
  authCtx: CodexAuthContext,
  threadId?: string | null,
): ((outcome: CodexUpstreamOutcome) => void) | undefined {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool"
    ? outcome => recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, { threadId })
    : undefined;
}

/** Account id to attribute log labels / upstream outcomes to (pool + rotation-injected main). */
export function codexLogAccountId(authCtx: CodexAuthContext): string | null {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool" ? authCtx.accountId : null;
}

export function usesCodexForwardPoolAuth(
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
): authCtx is Extract<CodexAuthContext, { kind: "pool" | "main-pool" }> {
  return (authCtx.kind === "pool" || authCtx.kind === "main-pool")
    && provider.authMode === "forward" && provider.adapter === "openai-responses";
}

export function codexForwardTerminalOutcomeRecorder(
  config: OcxConfig,
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
  logCtx?: RequestLogContext,
  threadId?: string | null,
): ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined {
  if (!usesCodexForwardPoolAuth(authCtx, provider)) return undefined;
  return (status, httpStatusOverride) => {
    if (status === "incomplete") {
      // Normal limit/content-filter/stall terminal — the account served the
      // request. Don't penalize account health; record success to clear any
      // prior soft-avoid so a healthy account isn't stuck avoided.
      recordCodexUpstreamOutcome(config, authCtx.accountId, 200, { threadId });
      return;
    }
    // status === "completed" or "failed": use the semantic HTTP status derived
    // from the terminal SSE error payload (httpStatusFromTerminalError in
    // request-log inspection) instead of collapsing every non-completed terminal
    // to 502. A 400 invalid_request_error must not soft-avoid the account or
    // rebind threads — only genuine transport/5xx failures should trigger
    // transient health recording.
    // httpStatusOverride: the combo WS path inspects SSE payloads into the parent
    // logCtx, but this recorder closes over the child logCtx. The caller passes
    // the parent's terminalHttpStatus so the semantic status is not lost.
    const outcome = status === "completed"
      ? 200
      : (httpStatusOverride ?? logCtx?.terminalHttpStatus ?? 502);
    recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, { threadId });
  };
}

/**
 * Map a request-body read failure to an honest error response. `readJsonRequestBody` can fail three
 * ways and they must not all collapse into "Invalid JSON body": an unsupported content-encoding
 * (415), a body that inflates past the decompression cap (413 — the image-heavy case Codex hits when
 * zstd-compressed screenshot history exceeds the limit), or a genuine JSON syntax error (400). The
 * real decode error was previously swallowed, so log it before returning the generic 400.
 */
export function decodeRequestErrorResponse(err: unknown, label: string): Response {
  if (err instanceof UnsupportedContentEncodingError) {
    return formatErrorResponse(415, "invalid_request_error", err.message);
  }
  if (err instanceof DecompressedBodyTooLargeError) {
    return formatErrorResponse(413, "invalid_request_error", err.message);
  }
  console.warn(`[${label}] request body decode/parse failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body");
}

function comboUnavailableResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "server_error", code: "combo_unavailable" },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}

interface ConsumedComboFailure {
  response: Response;
  classificationText: string;
  /** Valid numeric/date value used only for cooldown calculation. */
  retryAfter?: string;
  /** Reserved for 040 usage attribution without adding another body read. */
  usage?: OcxUsage;
}

interface HandleResponsesOptions {
  forceEmptyResponseId?: boolean;
  abortSignal?: AbortSignal;
  /** One-shot TTFT callback: first non-empty model output observed (WP4). */
  onFirstOutput?: () => void;
  onCodexAuthContextResolved?: (context: CodexAuthContext | undefined) => void;
  recordTerminalOutcomes?: boolean;
  setTerminalOutcomeRecorder?: (recorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined) => void;
  onNativePassthroughTerminal?: (status: ResponsesTerminalStatus) => void;
  onNativePassthroughCancel?: () => void;
  /** Internal recursion guard; callers outside this module must not set it. */
  comboAttempt?: boolean;
  /** 030-owned handoff when a child consumed the original failure under bounds. */
  onConsumedComboFailure?: (failure: ConsumedComboFailure) => void;
}

function clientCancelledResponse(): Response {
  return formatErrorResponse(499, "client_cancelled", "Client cancelled request");
}

function sanitizedRetryAfter(value: string | null, now: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return parseRetryAfterMs(trimmed, now) !== undefined ? trimmed : undefined;
}

async function consumeComboFailure(
  response: Response,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<ConsumedComboFailure> {
  const fallback = `Provider error ${response.status}`;
  let classificationText = fallback;
  let usage: OcxUsage | undefined;
  try {
    const body = await readBoundedResponseBody(response, { signal });
    usage = usageFromComboFailureText(body.text);
    if (body.displaySafe) {
      const safeText = redactSecretString(body.text).slice(0, 500);
      if (safeText) classificationText = safeText;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    classificationText = fallback;
  }
  const message = classificationText === fallback
    ? fallback
    : `${fallback}: ${classificationText}`;
  const retryAfter = sanitizedRetryAfter(response.headers.get("retry-after"), now);
  return {
    response: formatErrorResponse(response.status, "upstream_error", message),
    classificationText,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    ...(usage ? { usage } : {}),
  };
}

function usageFromComboFailureText(text: string): OcxUsage | undefined {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const nested = payload.response;
    const source = nested && typeof nested === "object" && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : payload;
    return usageFromResponsesPayload(source.usage);
  } catch {
    return undefined;
  }
}

function createChildPassthroughCallbackGate(options: HandleResponsesOptions) {
  type Pending =
    | { kind: "terminal"; status: ResponsesTerminalStatus }
    | { kind: "cancel" };
  let state: "pending" | "committed" | "discarded" = "pending";
  let pending: Pending | undefined;
  let accepted = false;
  const publish = (value: Pending): void => {
    if (value.kind === "terminal") options.onNativePassthroughTerminal?.(value.status);
    else options.onNativePassthroughCancel?.();
  };
  const receive = (value: Pending): void => {
    if (state === "discarded" || accepted) return;
    accepted = true;
    if (state === "committed") return publish(value);
    pending ??= value;
  };
  return {
    onTerminal: (status: ResponsesTerminalStatus) => receive({ kind: "terminal", status }),
    onCancel: () => receive({ kind: "cancel" }),
    commit: () => {
      if (state !== "pending") return;
      state = "committed";
      if (pending) publish(pending);
      pending = undefined;
    },
    discard: () => {
      state = "discarded";
      pending = undefined;
    },
  };
}

export function buildComboChildHeaders(parentHeaders: HeadersInit): Headers {
  const childHeaders = new Headers(parentHeaders);
  // Combo children re-serialize already-decoded JSON. Keeping transport metadata from
  // the parent would make the child decoder treat plain JSON as compressed bytes.
  childHeaders.delete("content-length");
  childHeaders.delete("content-encoding");
  return childHeaders;
}

async function handleComboResponses(
  req: Request,
  rawBody: unknown,
  comboId: string,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions,
): Promise<Response> {
  const requestedModel = typeof (rawBody as { model?: unknown } | null)?.model === "string"
    ? (rawBody as { model: string }).model
    : `combo/${comboId}`;
  Object.assign(logCtx, {
    requestedModel,
    model: requestedModel,
    provider: "combo",
    comboId,
  });
  const combo = getCombo(config, comboId);
  if (!combo) {
    return formatErrorResponse(404, "invalid_request_error", `Unknown combo: ${comboId}`);
  }

  const initialNow = Date.now();
  let pick = pickComboTarget(config, comboId, {
    eligible: target => !isComboTargetInCooldown(comboId, target, initialNow),
  });
  if (!pick) {
    return comboUnavailableResponse(`No available targets for combo: ${comboId}`);
  }

  let lastFailure: Response | null = null;
  while (pick) {
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const childLog: RequestLogContext = {
      model: pick.target.model,
      provider: pick.target.provider,
    };
    const targetRoute = routeModel(config, `${pick.target.provider}/${pick.target.model}`);
    const childBody = concreteComboRequestBody(
      rawBody,
      pick.target,
      comboDefaultEffort(config, comboId),
      supportedLadderFor({ provider: targetRoute.provider, modelId: targetRoute.modelId }),
    );
    const childHeaders = buildComboChildHeaders(req.headers);
    const childRequest = new Request(req.url, {
      method: req.method,
      headers: childHeaders,
      body: JSON.stringify(childBody),
    });
    let resolvedAuth: CodexAuthContext | undefined;
    let terminalRecorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined;
    const started = Date.now();
    const attempt = beginRequestAttempt(
      (logCtx.attempts?.length ?? 0) + 1,
      pick.target.provider,
      pick.target.model,
      config.providers[pick.target.provider]!.adapter,
    );
    childLog.activeAttempt = attempt;
    let attemptRetained = false;
    const retainCancelledAttempt = (): void => {
      if (attemptRetained) return;
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
      );
      finishRequestAttempt(attempt, 499, Date.now() - started, childLog.usage);
      (logCtx.attempts ??= []).push(attempt);
      attemptRetained = true;
    };
    let consumedChildFailure: ConsumedComboFailure | undefined;
    const callbackGate = createChildPassthroughCallbackGate(options);
    let response: Response;
    try {
      response = await handleResponses(childRequest, config, childLog, {
        ...options,
        comboAttempt: true,
        // Attempt-relative TTFT is recorded HERE (not via childLog.firstOutputMs — a later
        // Object.assign(logCtx, childLog) would overwrite the request-relative value).
        onFirstOutput: () => {
          if (attempt.firstOutputMs === undefined) {
            attempt.firstOutputMs = Math.max(0, Date.now() - started);
          }
          options.onFirstOutput?.();
        },
        onCodexAuthContextResolved: value => { resolvedAuth = value; },
        setTerminalOutcomeRecorder: value => { terminalRecorder = value; },
        onConsumedComboFailure: value => { consumedChildFailure = value; },
        onNativePassthroughTerminal: callbackGate.onTerminal,
        onNativePassthroughCancel: callbackGate.onCancel,
      });
    } catch (error) {
      callbackGate.discard();
      if (options.abortSignal?.aborted) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      throw error;
    }

    if (options.abortSignal?.aborted) {
      callbackGate.discard();
      retainCancelledAttempt();
      return clientCancelledResponse();
    }

    if (response.ok) {
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
      );
      (logCtx.attempts ??= []).push(attempt);
      attemptRetained = true;
      noteComboSuccess(comboId, combo, pick.target);
      Object.assign(logCtx, childLog, {
        requestedModel,
        model: requestedModel,
        provider: "combo",
        comboId,
        attempts: logCtx.attempts,
        activeAttempt: attempt,
        activeAttemptStartedAt: started,
        resolvedModel: childLog.resolvedModel ?? childLog.model,
      });
      options.onCodexAuthContextResolved?.(resolvedAuth);
      options.setTerminalOutcomeRecorder?.(terminalRecorder);
      callbackGate.commit();
      return response;
    }

    callbackGate.discard();
    if (response.status === 499) {
      retainCancelledAttempt();
      return clientCancelledResponse();
    }
    let failure: ConsumedComboFailure;
    try {
      failure = consumedChildFailure
        ?? await consumeComboFailure(response, options.abortSignal);
    } catch (error) {
      if (options.abortSignal?.aborted) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      throw error;
    }
    if (options.abortSignal?.aborted) {
      retainCancelledAttempt();
      return clientCancelledResponse();
    }
    sealRequestAttemptIdentity(
      attempt,
      childLog.provider,
      childLog.providerAdapter ?? attempt.adapter,
    );
    finishRequestAttempt(
      attempt,
      response.status,
      Date.now() - started,
      failure.usage,
    );
    (logCtx.attempts ??= []).push(attempt);
    attemptRetained = true;
    lastFailure = failure.response;
    if (comboFailureDecision(response.status, failure.classificationText) === "stop") {
      Object.assign(logCtx, childLog, {
        requestedModel,
        model: requestedModel,
        provider: "combo",
        comboId,
        attempts: logCtx.attempts,
        activeAttempt: undefined,
        activeAttemptStartedAt: undefined,
      });
      return lastFailure;
    }
    console.warn(
      `[combo] ${comboId}: ${targetKey(pick.target)} failed with ${response.status} after ${Date.now() - started}ms`,
    );
    pick = advanceComboAfterFailure(config, pick, {
      retryAfter: failure.retryAfter,
      now: Date.now(),
    });
  }
  return lastFailure!;
}

export async function handleResponses(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions = {},
): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    return decodeRequestErrorResponse(err, "responses");
  }
  const comboId = !options.comboAttempt ? comboIdFromRawBody(body, config) : null;
  if (comboId && Object.hasOwn(config.combos ?? {}, comboId)) {
    return handleComboResponses(req, body, comboId, config, logCtx, options);
  }
  const originalBody = body;
  body = expandPreviousResponseInput(body);
  const previousResponseInputExpanded = body !== originalBody;

  // Spawn-message compatibility (both directions): agent_message task payloads ride in
  // encrypted_content slots as plaintext. Rewrite them to input_text on the RAW body BEFORE
  // parsing so every consumer sees the payload: parseRequest (routed/translated providers read
  // the parsed messages) and the native passthrough (_rawBody is this same object, serialized
  // verbatim). Genuine backend ciphertext is left byte-identical (looksLikeBackendCiphertext).
  {
    const rewritten = sanitizeEncryptedContentInPlace(
      (body as { input?: unknown } | undefined)?.input,
    );
    if (rewritten > 0)
      console.warn(
        `[opencodex] rewrote ${rewritten} plaintext encrypted_content part(s) to input_text (spawn-message compatibility)`,
      );
  }

  let parsed;
  try {
    parsed = parseRequest(body);
    if (previousResponseInputExpanded) parsed._previousResponseInputExpanded = true;
    parsed._cursorConversationId = previousResponseConversationId(parsed.previousResponseId);
    // A compaction request intentionally resets active-context accounting. Normal Cursor turns carry
    // the preceding reported total as a floor so an early client-tool finalize cannot make Codex's
    // Context left jump back toward 100% when no fresh checkpoint arrives.
    if (!parsed._compactionRequest) {
      parsed._cursorPreviousContextTokens = previousResponseCursorContextTokens(parsed.previousResponseId);
    }
  } catch (err) {
    return formatErrorResponse(400, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  logCtx.requestedModel = parsed.modelId;
  logCtx.requestedEffort = parsed.options.reasoning;
  logCtx.requestedServiceTier = parsed.options.serviceTier;
  logCtx.requestedSpeedLabel = requestLogSpeedLabel(parsed.options.serviceTier);
  logCtx.configuredServiceTier = readConfiguredCodexServiceTier();
  logCtx.configuredSpeedLabel = requestLogSpeedLabel(logCtx.configuredServiceTier);

  // Shadow call intercept: rewrite Codex Desktop's hard-coded gpt-5.4-mini helper calls
  const _sci = config.shadowCallIntercept;
  if (_sci?.enabled && _sci.model && parsed.modelId.startsWith("gpt-5.4-mini")) {
    const _sciOriginal = parsed.modelId;
    parsed.modelId = _sci.model;
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = _sci.model;
    }
    // Force effort to low for shadow/helper calls (matching upstream behavior)
    parsed.options.reasoning = "low";
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as Record<string, unknown>).reasoning = { effort: "low" };
    }
    (logCtx as unknown as Record<string, unknown>).shadowCallRewrittenFrom = _sciOriginal;
  }

  let route;
  try {
    route = routeModel(config, parsed.modelId);
  } catch (err) {
    if (err instanceof NoAvailableComboTargetsError) {
      return comboUnavailableResponse(err.message);
    }
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  // Apply the routed model id upstream: routing may strip a "<provider>/" namespace
  // (e.g. "opencode-go/deepseek-v4-pro" → "deepseek-v4-pro"). Adapters read parsed.modelId,
  // and the passthrough adapter serializes _rawBody, so rewrite both.
  if (route.modelId !== parsed.modelId) {
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = route.modelId;
    }
    parsed.modelId = route.modelId;
  }
  logCtx.model = route.modelId;
  logCtx.provider = route.providerName;
  logCtx.providerAdapter = route.provider.adapter;

  // Virtual model rewriting: Pro aliases → base model + reasoning.mode="pro".
  // Must run before effort caps/native clamps so the base model gets correct limits.
  applyOpenAiVirtualModel(parsed, route, logCtx);

  // Fast mode override: when config.fastMode is explicitly set, inject or strip
  // service_tier for OpenAI-routed models. Undefined = passthrough (client decides).
  if (config.fastMode !== undefined && route.provider.adapter === "openai-responses") {
    const tier = config.fastMode ? "priority" : undefined;
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      if (tier) (parsed._rawBody as Record<string, unknown>).service_tier = tier;
      else delete (parsed._rawBody as Record<string, unknown>).service_tier;
    }
    parsed.options.serviceTier = tier;
  }

  // Multi-agent guidance shim: codex-rs emits its Proactive delegation developer
  // message only on the v2 surface. The proxy fills both gaps: the Proactive text
  // for v1 collab surfaces at the top tier, and the sub-agent model designation on
  // BOTH surfaces when an injectionModel is configured (v2 additionally gets the
  // fork_turns override rules). The surface is judged from the request's own tool list.
  // Runs BEFORE the mock-max clamp below so the synthetic top tier (ultra arrives
  // as max on the codex wire) is still visible. Both request shapes are rewritten.
  {
    const guidance = await multiAgentGuidanceText(parsed, config.injectionModel, config.injectionEffort, config.subagentModels, config.injectionPrompt);
    if (guidance) {
      injectDeveloperMessage(parsed, guidance);
      if (isInjectionDebugEnabled()) injectionDebugLog(`[opencodex] ${route.modelId}: multi-agent guidance injected (surface=${collabSurface(parsed)}, ${guidance.length} chars)`);
    } else if (isInjectionDebugEnabled() && collabSurface(parsed) !== null) {
      injectionDebugLog(`[opencodex] ${route.modelId}: collab surface=${collabSurface(parsed)}, guidance silent (effort=${parsed.options.reasoning ?? "unset"}, injectionModel=${config.injectionModel ?? "unset"})`);
    }
  }

  // Hard effort caps (effortCap / subagentEffortCap): enforcement companion to the advisory
  // injection above — spawn-arg prompting cannot stop codex-rs from inheriting the parent's
  // ultra-tier default on bare spawns (see src/server/effort-policy.ts). Runs BEFORE the
  // mock-max clamp so a capped effort is what nativeness clamping then validates; rewrites
  // both request shapes (same dual-write contract as the clamp below).
  // GATE: v2 feature only (effortCapAppliesTo) — v2-surface main turns plus header-marked
  // child turns admitted regardless of tool surface (depth-limited leaves carry no collab
  // tools while shallower children do, so tool sniffing alone would cap siblings
  // inconsistently); multiAgentMode "v1" disables caps entirely; compaction turns bypass
  // caps so routed compaction matches native /v1/responses/compact (which never enters
  // handleResponses).
  {
    const { applyEffortCap, effortCapAppliesTo, supportedLadderFor } = await import("./effort-policy");
    const surface = collabSurface(parsed);
    if (effortCapAppliesTo(surface, req.headers, config, parsed._compactionRequest === true)) {
      const capped = applyEffortCap(parsed, req.headers, config, supportedLadderFor(route));
      if (capped) {
        logCtx.requestedEffort = `${capped.from}->${capped.to}`;
        if (isInjectionDebugEnabled()) {
          injectionDebugLog(`[opencodex] ${route.modelId}: effort cap applied (${capped.from} -> ${capped.to}, ${capped.subagent ? "sub-agent" : "main"} turn)`);
        }
      }
    } else if (isInjectionDebugEnabled() && (config.effortCap || config.subagentEffortCap)) {
      injectionDebugLog(`[opencodex] ${route.modelId}: effort cap skipped (surface=${surface ?? "none"}, v2 feature only)`);
    }
  }

  // Mock-max clamp: native models whose real ladder stops below max (gpt-5.5/5.4/…)
  // receive `max` when the user picks Ultra (codex converts ultra->max client-side).
  // Clamp to the model's highest real effort BEFORE any adapter — the ChatGPT
  // passthrough serializes _rawBody verbatim, so both shapes must be rewritten.
  // GUARD: judge nativeness by the ORIGINALLY REQUESTED id (logCtx.requestedModel),
  // never by route.modelId — routing strips the "<provider>/" namespace, so a routed
  // model (anthropic/claude-opus-4-6, real max) would masquerade as an off-snapshot
  // bare native and get wrongly clamped. Routed efforts belong to their adapters.
  {
    const requestedModelId = logCtx.requestedModel ?? route.modelId;
    const { nativeEffortClamp } = await import("../codex/catalog");
    const clamped = requestedModelId.includes("/")
      ? null
      : nativeEffortClamp(route.modelId, parsed.options.reasoning);
    if (clamped) {
      parsed.options.reasoning = clamped;
      const raw = parsed._rawBody as { reasoning?: { effort?: string } } | undefined;
      if (raw?.reasoning && typeof raw.reasoning === "object") raw.reasoning.effort = clamped;
      logCtx.requestedEffort = `${logCtx.requestedEffort ?? "max"}->${clamped}`;
    }
  }
  logCtx.modelSupportsServiceTier = catalogModelSupportsServiceTier(
    route.modelId,
    logCtx.requestedServiceTier ?? logCtx.configuredServiceTier,
  );

  let authCtx: CodexAuthContext = { kind: "main", accountId: null };
  let selectedForwardHeaders: Headers;
  try {
    if (route.codexAccountMode === "direct") validateForwardAdmissionCredential(req.headers, config);
    if (route.codexAccountMode) {
      authCtx = await resolveCodexAuthContext(req.headers, config, route.codexAccountMode);
      options.onCodexAuthContextResolved?.(authCtx);
    } else {
      options.onCodexAuthContextResolved?.(undefined);
    }
    selectedForwardHeaders = headersForCodexAuthContext(req.headers, authCtx);
  } catch (err) {
    if (err instanceof CodexAccountCooldownError) {
      return formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down");
    }
    if (err instanceof CodexThreadAffinityExpiredError) {
      return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
    }
    if (err instanceof CodexAuthContextError) {
      const safeAccountLabel = formatCodexProviderForLog(route.providerName, err.accountId, config);
      console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed; reauthentication required`);
      return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
    }
    if (err instanceof CodexPoolAuthenticationError) {
      return formatErrorResponse(401, "authentication_error", err.message);
    }
    if (err instanceof CodexDirectAuthenticationError) {
      return formatErrorResponse(401, "authentication_error", err.message);
    }
    if (err instanceof ForwardAdmissionCredentialError) {
      return formatErrorResponse(401, "authentication_error", err.message);
    }
    throw err;
  }
  if (!isCodexAuthContextUsable(authCtx, config)) {
    return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
  }
  route.provider = applyCodexAuthContextToProvider(route.provider, authCtx, route.codexAccountMode);
  logCtx.provider = formatCodexProviderForLog(route.providerName, codexLogAccountId(authCtx), config);

  // OAuth providers: swap in a fresh access token (auto-refreshed) as the Bearer key, so the
  // existing openai-chat / anthropic adapters authenticate with no change.
  const isOAuth401ReplayProvider = (route.providerName === "xai" || route.providerName === "github-copilot")
    && route.provider.authMode === "oauth";
  let sentOAuthSnapshot: OAuthAccessSnapshot | undefined;
  if (route.provider.authMode === "oauth") {
    try {
      const resolved = await getValidAccessTokenSnapshot(route.providerName);
      if (isOAuth401ReplayProvider) sentOAuthSnapshot = resolved;
      route.provider = { ...route.provider, apiKey: resolved.accessToken };
      // Antigravity (cloud-code-assist) needs the discovered Cloud Code Assist project id in the
      // CCA envelope; the server injects only the bare token, so pull project from the credential.
      if (route.provider.googleMode === "cloud-code-assist" && !route.provider.project) {
        const projectId = getOAuthCredentialProjectId(route.providerName);
        if (projectId) route.provider = { ...route.provider, project: projectId };
      }
    } catch (err) {
      if (err instanceof UnsupportedOAuthProviderError) {
        return formatErrorResponse(
          400,
          "invalid_request_error",
          `${err.message}. Remove or reconfigure provider '${route.providerName}' in ${getConfigPath()}.`,
        );
      }
      return formatErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err));
    }
  }
  route.provider = resolveProviderTransport(
    route.providerName,
    route.provider,
    parsed.options.promptCacheKey,
    route.providerName === "github-copilot" ? getOAuthCredentialApiBaseUrl(route.providerName) : undefined,
  );
  const adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
  const adapter = resolveAdapter(adapterProvider, config.cacheRetention);
  logCtx.providerAdapter = adapter.name;
  sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, adapter.name);
  const isPassthrough = "passthrough" in adapter && !!adapter.passthrough;

  let openAiSidecar: ResolvedOpenAiForwardSidecar | undefined;
  const needsOpenAiVision = shouldResolveOpenAiVisionSidecar(config, route.provider, route.modelId, parsed);
  const needsOpenAiSearch = shouldResolveOpenAiWebSearchSidecar(config, parsed, isPassthrough);
  if (needsOpenAiVision || needsOpenAiSearch) {
    try {
      openAiSidecar = await resolveFirstUsableOpenAiSidecar(
        listOpenAiForwardSidecarCandidates(config),
        req.headers,
        config,
      );
    } catch (err) {
      // Sidecars are optional helpers for an otherwise independent routed turn.
      // An unavailable/cooling/expired Multi credential disables the helper; it
      // must not turn a valid routed-provider request into a Codex-auth failure.
      if (
        !(err instanceof CodexPoolAuthenticationError)
        && !(err instanceof CodexAuthContextError)
        && !(err instanceof CodexAccountCooldownError)
        && !(err instanceof CodexThreadAffinityExpiredError)
      ) throw err;
    }
  }

  // Vision sidecar: the routed model can't see images (provider.noVisionModels). Describe each
  // attached image through the selected sidecar backend and replace it with text BEFORE the main
  // call, so the text-only model can reason about it.
  const visionPlan = planVisionSidecar(config, route.provider, route.modelId, parsed, openAiSidecar);
  const recordSidecarOutcome = openAiSidecar?.recordOutcome;
  if (visionPlan) {
    await describeImagesInPlace(parsed, visionPlan, openAiSidecar?.headers ?? selectedForwardHeaders, options.abortSignal, recordSidecarOutcome);
  } else if (modelInList(route.provider.noVisionModels, route.modelId)) {
    // Sidecar-covered model but NO plan (no forward provider / missing forwarded auth / sidecar
    // disabled): fail closed — never forward raw images to a text-only upstream.
    stripImagesInPlace(parsed);
  }

  const recordTerminalOutcomes = options.recordTerminalOutcomes !== false;

  // Remote compaction v2 on a ROUTED model: Codex sent `compaction_trigger` and requires exactly
  // one `{type:"compaction"}` output item (codex-rs compact_remote_v2.rs). Passthrough handles it
  // natively upstream; here we run the routed model as a plain summarizer — no tools, no web-search
  // sidecar — and the bridge appends the synthetic compaction item (src/responses/compaction.ts).
  const routedCompaction = parsed._compactionRequest === true && !("passthrough" in adapter && adapter.passthrough);
  if (routedCompaction) {
    delete parsed.context.tools;
    delete parsed._webSearch;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  if ("passthrough" in adapter && adapter.passthrough) {
    // Local continuation cache for the ChatGPT passthrough. Codex WS turns chain with
    // previous_response_id, ocx converts them to internal HTTP requests, and the ChatGPT Codex
    // REST backend rejects the parameter — the adapter strips it in forward mode, so the ONLY
    // way a chained turn keeps its earlier context is the local replay expansion. Record
    // completed passthrough responses (force bypasses Codex's blanket store:false) so the next
    // turn's expansion hits. Never record a body whose own previous_response_id failed to
    // expand: its input is a delta, and storing it would replay a truncated conversation.
    // Compaction turns are excluded: _rawBody still carries the full pre-compaction history and
    // recording it would let a later expansion rehydrate the chain Codex just replaced.
    const passthroughRecordEligible = parsed._compactionRequest !== true
      && (!parsed.previousResponseId || parsed._previousResponseInputExpanded === true);
    const rememberPassthroughResponse = passthroughRecordEligible
      ? (response: { id?: unknown; output?: unknown; status?: unknown }) =>
        rememberResponseState(parsed._rawBody, response, undefined, { force: true })
      : undefined;
    if (parsed.previousResponseId && !parsed._previousResponseInputExpanded) {
      console.warn(
        `[responses] previous_response_id ${parsed.previousResponseId} not found in local replay state `
        + `(model ${parsed.modelId}); forwarding without it — earlier turns may be missing from this request`,
      );
    }
    const request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders });
    const passthroughEstimate = typeof request.usageLog?.inputTokens === "number"
      ? request.usageLog.inputTokens
      : undefined;
    if (passthroughEstimate !== undefined) {
      logCtx.usageLogInputTokens = passthroughEstimate;
    }
    // Abort the upstream if the client disconnects. A directly-relayed body does not propagate the
    // consumer's cancel to a signalled fetch, so we pass the signal and relay through relayWithAbort,
    // whose cancel() aborts the upstream — preventing leaked connections (RC2, passthrough path).
    const upstream = new AbortController();
    linkAbortSignal(upstream, options.abortSignal);
    const connectMs = config.connectTimeoutMs ?? 200_000;
    let upstreamResponse: Response;
    try {
      // Transient-5xx pre-stream retry (devlog/_plan/260716_claudecode_hardening/010):
      // the ChatGPT backend emits transient 502/520s that an immediate retry absorbs.
      // Body is a replayable string; nothing has streamed to the client yet.
      upstreamResponse = await fetchWithTransientRetry(
        recovery => {
          noteAttemptSend(logCtx.activeAttempt, passthroughEstimate, recovery);
          return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
            method: request.method,
            headers: request.headers,
            body: request.body,
          }, recovery), upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
        },
        { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
      );
    } catch (err) {
      upstream.abort();
      if (options.abortSignal?.aborted) return clientCancelledResponse();
      const outcome = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connect_error";
      if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
        recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
          threadId: req.headers.get("x-codex-parent-thread-id"),
        });
      }
      const msg = outcome === "timeout"
        ? `Provider connect timeout after ${connectMs}ms`
        : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
      return formatErrorResponse(502, "upstream_error", msg);
    }
    const headers = sanitizePassthroughHeaders(upstreamResponse.headers);
    const resolvedModel = headers.get("openai-model")?.trim();
    if (resolvedModel) logCtx.resolvedModel = resolvedModel;
    if (isUsageDebugEnabled()) {
      const upstreamContentType = upstreamResponse.headers.get("content-type");
      if (upstreamContentType) logCtx.usageDebugContentType = upstreamContentType;
    }
    // The chatgpt backend may omit Content-Type on SSE responses. Fall back to
    // treating a successful body as SSE when the caller requested streaming.
    const passthroughCt = headers.get("content-type")?.toLowerCase();
    const isEventStream = passthroughCt?.includes("text/event-stream")
      || (upstreamResponse.ok && !!upstreamResponse.body && !passthroughCt && parsed.stream);
    const terminalRecorder = codexForwardTerminalOutcomeRecorder(
      config,
      authCtx,
      route.provider,
      logCtx,
      req.headers.get("x-codex-parent-thread-id"),
    );
    const terminalBodyWillRecord = !!terminalRecorder && upstreamResponse.ok && isEventStream;
    // Capture quota from upstream response for multi-account tracking
   if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
      // primary was the 5h window; it now carries weekly data for GPT plans.
      // Prefer primary when present, fall back to secondary for compatibility.
      const primaryRaw = upstreamResponse.headers.get("x-codex-primary-used-percent");
      const secondaryRaw = upstreamResponse.headers.get("x-codex-secondary-used-percent");
      const weeklyRaw = primaryRaw ?? secondaryRaw;
      const monthlyRaw = upstreamResponse.headers.get("x-codex-tertiary-used-percent");
      const primaryResetRaw = upstreamResponse.headers.get("x-codex-primary-reset-at");
      const secondaryResetRaw = upstreamResponse.headers.get("x-codex-secondary-reset-at");
      const weeklyResetRaw = primaryRaw ? primaryResetRaw : secondaryResetRaw;
      const monthlyResetRaw = upstreamResponse.headers.get("x-codex-tertiary-reset-at");
      const retryAfterRaw = upstreamResponse.headers.get("retry-after");
      if (weeklyRaw || monthlyRaw) {
        const { updateAccountQuota } = await import("../codex/auth-api");
        updateAccountQuota(
          authCtx.accountId,
          weeklyRaw,
          weeklyResetRaw,
          monthlyRaw,
          monthlyResetRaw,
        );
      }
      if (terminalBodyWillRecord) {
        options.setTerminalOutcomeRecorder?.((status, httpStatusOverride) => {
          terminalRecorder(status, httpStatusOverride);
          options.onNativePassthroughTerminal?.(status);
        });
      } else {
        recordCodexUpstreamOutcome(config, authCtx.accountId, upstreamResponse.status, {
        retryAfter: retryAfterRaw,
         resetAt: [primaryResetRaw, secondaryResetRaw, monthlyResetRaw].filter(Boolean),
         threadId: req.headers.get("x-codex-parent-thread-id"),
        });
      }
    }

    // Bun#32111 workaround: passthrough SSE uses tee()+native relay to avoid the
    // async-pull segfault on Windows. Branch[0] goes directly to the Response (Bun
    // native relay, never enters JS Sink.write); branch[1] is consumed in the
    // background for terminal-outcome/quota inspection only.
    if (upstreamResponse.ok && isEventStream && upstreamResponse.body) {
      const [nativeBody, inspectBody] = upstreamResponse.body.tee();
      const turnAc = new AbortController();
      linkAbortSignal(upstream, turnAc.signal);
      registerTurn(turnAc);
      if (recordTerminalOutcomes) {
        // A real terminal was parsed from the (teed) inspection stream — record it as the outcome
        // even if the client has already disconnected: the turn genuinely reached that terminal, so
        // it must log as completed/failed, not be dropped or downgraded to a cancel (#44). A pure
        // client-cancel (no terminal seen) is finalized separately via consumeForInspection's onCancel.
        const reportNativeTerminal = (status: ResponsesTerminalStatus, httpStatusOverride?: number) => {
          terminalRecorder?.(status, httpStatusOverride);
          options.onNativePassthroughTerminal?.(status);
        };
        consumeForInspection(
          inspectBody,
          reportNativeTerminal,
          turnAc.signal,
          () => unregisterTurn(turnAc),
          logCtx,
          () => options.onNativePassthroughCancel?.(),
          rememberPassthroughResponse,
          options.onFirstOutput,
        );
      } else {
        consumeForResponseLogMetadata(
          inspectBody,
          logCtx,
          turnAc.signal,
          () => unregisterTurn(turnAc),
          rememberPassthroughResponse,
          options.onFirstOutput,
        );
      }
      if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
      // win32 must keep the pure native relay (Bun#32111 JS-sink segfault); elsewhere a JS pull
      // relay is established practice (relayWithAbort, relaySseWithHeartbeat) and lets a
      // mid-stream reset end with a clean response.failed terminal instead of a raw socket error.
      const clientBody = process.platform === "win32"
        ? nativeBody
        : relaySseWithFailedTail(nativeBody, upstream);
      return markNativePassthroughSseResponse(new Response(clientBody, {
        status: upstreamResponse.status,
        headers,
      }));
    }
    if (headers.get("content-type")?.toLowerCase().includes("application/json")) {
      if (!upstreamResponse.ok && options.comboAttempt) {
        const failure = await consumeComboFailure(upstreamResponse, options.abortSignal);
        options.onConsumedComboFailure?.(failure);
        return failure.response;
      }
      const text = await upstreamResponse.text();
      inspectResponseLogJson(logCtx, text);
      if (upstreamResponse.ok && rememberPassthroughResponse) {
        try {
          rememberPassthroughResponse(JSON.parse(text) as { id?: unknown; output?: unknown; status?: unknown });
        } catch { /* non-JSON despite content-type; recording is best-effort */ }
      }
      return new Response(text, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    }
    const body = relayWithAbort(upstreamResponse.body, upstream);
    const turnAc = new AbortController();
    const tracked = body ? trackStreamLifetime(body, turnAc) : null;
    return new Response(tracked, {
      status: upstreamResponse.status,
      headers,
    });
  }

  if (adapter.runTurn) {
    const runTurnAbort = new AbortController();
    linkAbortSignal(runTurnAbort, options.abortSignal);
    const queue = createAdapterEventQueue();
    const runTurn = async (): Promise<void> => {
      try {
        noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens);
        await adapter.runTurn?.(
          parsed,
          { headers: selectedForwardHeaders, abortSignal: runTurnAbort.signal },
          queue.push,
        );
      } catch (err) {
        queue.push({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        queue.close();
      }
    };

    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    if (parsed.stream) {
      void runTurn();
      let eventSource: AsyncIterable<AdapterEvent> = queue.stream();
      if (options.comboAttempt) {
        const preflight = await preflightAdapterEvents(eventSource);
        if (preflight.error || preflight.empty) {
          runTurnAbort.abort();
          queue.close();
          const message = preflight.error?.message ?? "Adapter ended before producing a response";
          return formatErrorResponse(502, "upstream_error", redactSecretString(message));
        }
        eventSource = preflight.stream;
      }
      const sseStream = bridgeToResponsesSSE(
        eventSource, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
        () => {
          runTurnAbort.abort();
          queue.close();
        }, 2_000,
        {
          ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
          stallTimeoutSec: config.stallTimeoutSec,
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
          ...(routedCompaction ? { compaction: true } : {}),
          ...(routedCompaction ? {} : { onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response, parsed._cursorConversationId) }),
        },
      );
      const bridgeTurnAc = new AbortController();
      const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc);
      return new Response(trackedSse, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
      });
    }

    await runTurn();
    const events = await queue.collect();
    if (options.comboAttempt) {
      const firstMeaningful = events.find(event => event.type !== "heartbeat");
      if (!firstMeaningful || firstMeaningful.type === "error") {
        const message = firstMeaningful?.type === "error"
          ? firstMeaningful.message
          : "Adapter ended before producing a response";
        return formatErrorResponse(502, "upstream_error", redactSecretString(message));
      }
    }
    const json = buildResponseJSON(events, parsed.modelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
    });
    if (!routedCompaction) rememberResponseState(parsed._rawBody, json, parsed._cursorConversationId);
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  // Web-search sidecar: Codex enabled web_search but this is a routed (non-OpenAI) model that can't
  // run it server-side. Expose web_search as a function tool and run searches via the gpt-mini sidecar
  // through the ChatGPT passthrough, looping until the model answers. Otherwise take the normal path.
  const wsPlan = planWebSearch(config, parsed, false, route.provider, route.modelId, openAiSidecar);
  if (wsPlan) {
    parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
    noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens);
    const wsResponse = await runWithWebSearch({
      parsed, adapter,
      backend: wsPlan.backend,
      forwardProvider: wsPlan.forwardSidecar?.provider,
      anthropicSidecar: wsPlan.anthropicSidecar,
      hostedTool: wsPlan.hostedTool,
      selectedForwardHeaders: wsPlan.forwardSidecar?.headers ?? selectedForwardHeaders,
      settings: wsPlan.settings,
      maxSearches: wsPlan.maxSearches,
      forceEmptyResponseId: true,
      abortSignal: options.abortSignal,
      ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
      recordSidecarOutcome: wsPlan.forwardSidecar?.recordOutcome,
      connectTimeoutMs: config.connectTimeoutMs ?? 200_000,
      routedModelStallTimeoutMs: wsPlan.routedModelStallTimeoutMs,
      stallTimeoutSec: wsPlan.stallTimeoutSec,
      on429: retryAfter => {
        const rotated = rotateProviderTransportOn429(config, route.providerName, {
          retryAfter,
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: parsed.options.promptCacheKey,
        });
        if (!rotated) return null;
        route.provider = rotated;
        return resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
          config.cacheRetention,
        );
      },
    });
    // Register the sidecar stream as an active turn so drainAndShutdown waits for (or aborts)
    // in-flight web-search turns instead of skipping them during graceful shutdown.
    if (wsResponse.body) {
      const wsTurnAc = new AbortController();
      return new Response(trackStreamLifetime(wsResponse.body, wsTurnAc), {
        status: wsResponse.status,
        headers: wsResponse.headers,
      });
    }
    return wsResponse;
  }

  const upstream = new AbortController();
  const cleanupUpstreamAbort = linkAbortSignal(upstream, options.abortSignal);
  const connectMs = config.connectTimeoutMs ?? 200_000;

  const request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders });
  const inputTokenEstimate = typeof request.usageLog?.inputTokens === "number"
    ? request.usageLog.inputTokens
    : undefined;
  if (inputTokenEstimate !== undefined) logCtx.usageLogInputTokens = inputTokenEstimate;
  let upstreamResponse: Response;
  try {
    if (adapter.fetchResponse) {
      noteAttemptSend(logCtx.activeAttempt, inputTokenEstimate);
      upstreamResponse = await adapter.fetchResponse(request, {
        abortSignal: upstream.signal,
        timeoutMs: connectMs,
        stream: parsed.stream,
      });
    } else {
      upstreamResponse = await fetchWithResetRetry(
        recovery => {
          noteAttemptSend(logCtx.activeAttempt, inputTokenEstimate, recovery);
          return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
            method: request.method,
            headers: request.headers,
            body: request.body,
          }, recovery), upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
        },
        { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
      );
    }
  } catch (err) {
    cleanupUpstreamAbort();
    upstream.abort();
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const msg = err instanceof Error && err.name === "TimeoutError"
      ? `Provider connect timeout after ${connectMs}ms`
      : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return formatErrorResponse(502, "upstream_error", msg);
  }

  if (!upstreamResponse.ok) {
    // Recovery loop: multi-key 429 failover + at most ONE anthropic 413 tightened retry
    // (devlog/260714_image_normalization_pipeline/030). One mutable activeAdapter serves
    // both paths so a 429→413 sequence never rebuilds against a stale pre-rotation
    // adapter, and imageTierBias — once armed — rides EVERY subsequent rebuild so a
    // 413→429 rotation cannot silently undo the tightening.
    let activeAdapter = adapter;
    let imageTierBias = 0;
    let imageRetryAttempted = false;
    let oauth401ReplayAttempted = false;
    const rebuildAndRefetch = async (
      recovery: AttemptRecoveryKind,
    ): Promise<Response | { failed: Response }> => {
      const retryRequest = await activeAdapter.buildRequest(parsed, {
        headers: selectedForwardHeaders,
        ...(imageTierBias > 0 ? { imageTierBias } : {}),
      });
      const retryEstimate = typeof retryRequest.usageLog?.inputTokens === "number"
        ? retryRequest.usageLog.inputTokens
        : undefined;
      if (retryEstimate !== undefined) logCtx.usageLogInputTokens = retryEstimate;
      logCtx.providerAdapter = activeAdapter.name;
      sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name);
      noteAttemptSend(logCtx.activeAttempt, retryEstimate, recovery);
      try {
        return activeAdapter.fetchResponse
          ? await activeAdapter.fetchResponse(retryRequest, { abortSignal: upstream.signal, timeoutMs: connectMs, stream: parsed.stream })
          : await fetchWithHeaderTimeout(retryRequest.url, {
              method: retryRequest.method, headers: retryRequest.headers, body: retryRequest.body,
            }, upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
      } catch (err) {
        cleanupUpstreamAbort();
        upstream.abort();
        if (options.abortSignal?.aborted) {
          return { failed: clientCancelledResponse() };
        }
        const msg = err instanceof Error && err.name === "TimeoutError"
          ? `Provider connect timeout after ${connectMs}ms`
          : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
        return { failed: formatErrorResponse(502, "upstream_error", msg) };
      }
    };
    recovery: for (;;) {
      if (
        upstreamResponse.status === 401
        && isOAuth401ReplayProvider
        && sentOAuthSnapshot
        && !oauth401ReplayAttempted
      ) {
        oauth401ReplayAttempted = true;
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        let refreshed: OAuthAccessSnapshot;
        try {
          refreshed = await forceRefreshOAuthAccessSnapshot(sentOAuthSnapshot);
        } catch (err) {
          cleanupUpstreamAbort();
          return formatErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err));
        }
        sentOAuthSnapshot = refreshed;
        const refreshedProvider = resolveProviderTransport(
          route.providerName,
          { ...route.provider, apiKey: refreshed.accessToken },
          parsed.options.promptCacheKey,
          route.providerName === "github-copilot" ? getOAuthCredentialApiBaseUrl(route.providerName) : undefined,
        );
        route.provider = refreshedProvider;
        activeAdapter = resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, refreshedProvider),
          config.cacheRetention,
        );
        const result = await rebuildAndRefetch("oauth-401");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
        continue recovery;
      }

      // Multi-key 429 failover: rotate to the next pool key (cooldown-aware) and retry the
      // SAME request once per remaining key. OAuth/forward providers and single-key pools
      // return null immediately, so this stays a no-op for them (src/providers/key-failover.ts).
      while (upstreamResponse.status === 429 && hasKeyPoolFailover(route.provider)) {
        const rotated = rotateProviderTransportOn429(config, route.providerName, {
          retryAfter: upstreamResponse.headers.get("retry-after"),
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: parsed.options.promptCacheKey,
        });
        if (!rotated) break;
        // Release the failed response's socket before retrying; unread bodies otherwise linger
        // until runtime cleanup (one per rotated key under a rate-limit storm).
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        route.provider = rotated;
        activeAdapter = resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
          config.cacheRetention,
        );
        const result = await rebuildAndRefetch("key-429");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
      }
      // Anthropic 413 request_too_large: rebuild once with every image one tier lower
      // (spiral guard: single attempt). The biased response re-enters the 429 check above.
      if (shouldAttemptImageTierRetry({
        status: upstreamResponse.status,
        adapterName: activeAdapter.name,
        parsed,
        alreadyAttempted: imageRetryAttempted,
      })) {
        imageRetryAttempted = true;
        imageTierBias = 1;
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        const result = await rebuildAndRefetch("image-413");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
        continue recovery;
      }
      break;
    }
    if (!upstreamResponse.ok) {
      if (options.comboAttempt) {
        const failure = await consumeComboFailure(upstreamResponse, options.abortSignal)
          .finally(cleanupUpstreamAbort);
        options.onConsumedComboFailure?.(failure);
        return failure.response;
      }
      const errorText = await upstreamResponse.text().catch(() => "unknown error");
      cleanupUpstreamAbort();
      // Upstreams occasionally echo request details in error bodies — scrub token-shaped
      // material before it reaches the client-facing error surface.
      return formatErrorResponse(upstreamResponse.status, "upstream_error", `Provider error ${upstreamResponse.status}: ${redactSecretString(errorText.slice(0, 500))}`);
    }
  }

  if (parsed.stream) {
    const eventStream = adapter.parseStream(upstreamResponse);
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    const sseStream = bridgeToResponsesSSE(
      eventStream, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
      () => upstream.abort(), 2_000,
      {
        ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
        stallTimeoutSec: config.stallTimeoutSec,
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
        ...(routedCompaction ? { compaction: true } : {}),
        // Compaction turns must NOT enter the continuation cache: _rawBody still holds the full
        // PRE-compaction history, and a later previous_response_id expansion would rehydrate the
        // giant stale chain Codex just replaced.
        ...(routedCompaction ? {} : { onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response, parsed._cursorConversationId) }),
      },
    );
    const bridgeTurnAc = new AbortController();
    const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc, cleanupUpstreamAbort);
    return new Response(trackedSse, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
    });
  }

  if (adapter.parseResponse) {
    let events: AdapterEvent[];
    try {
      events = await adapter.parseResponse(upstreamResponse);
    } finally {
      cleanupUpstreamAbort();
    }
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    const json = buildResponseJSON(events, parsed.modelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
    });
    // See the streaming branch: compaction turns skip the continuation cache.
    if (!routedCompaction) rememberResponseState(parsed._rawBody, json, parsed._cursorConversationId);
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  return formatErrorResponse(500, "internal_error", "Non-streaming not supported by this adapter");
}

export function linkAbortSignal(upstream: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    upstream.abort(signal.reason);
    return () => {};
  }
  const onAbort = () => upstream.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Remote compaction v1 (`POST /v1/responses/compact`). Codex uses this whenever the provider
 * "is openai" and Feature::RemoteCompactionV2 is OFF (the default) — under Design B that is the
 * proxy. The response is a unary `{"output":[ResponseItem...]}` that codex installs as the
 * REPLACEMENT history (compact_remote.rs). Passthrough forwards to the real ChatGPT backend;
 * routed models run the same summarizer used for v2 and convert the summary to v1 history items.
 */
export const COMPACT_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

function compactResponseTooLargeError(): Response {
  return new Response(JSON.stringify({
    error: {
      message: "Compact response exceeded 32 MiB",
      type: "compact_response_too_large",
      code: "compact_response_too_large",
    },
  }), { status: 502, headers: { "Content-Type": "application/json" } });
}

/** Exported for tests: owns the compact client-cancel branch (499 client_cancelled). */
export async function bufferCompactResponse(upstream: Response, signal: AbortSignal): Promise<Response> {
  const reader = upstream.body?.getReader();
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  if (!reader) return new Response(null, { status: upstream.status, headers: { "Content-Type": contentType } });
  const declaredLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > COMPACT_RESPONSE_MAX_BYTES) {
    await reader.cancel("compact_response_too_large").catch(() => undefined);
    return compactResponseTooLargeError();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel(signal.reason).catch(() => undefined);
        return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > COMPACT_RESPONSE_MAX_BYTES) {
        await reader.cancel("compact_response_too_large").catch(() => undefined);
        return compactResponseTooLargeError();
      }
      chunks.push(value);
    }
  } catch {
    if (signal.aborted) return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    return formatErrorResponse(502, "upstream_error", "Failed to read compact response");
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, { status: upstream.status, headers: { "Content-Type": contentType } });
}

export async function handleResponsesCompact(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    return decodeRequestErrorResponse(err, "responses-compact");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return formatErrorResponse(400, "invalid_request_error", "Invalid compaction request body");
  }
  const raw = body as { model?: unknown; input?: unknown };
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    return formatErrorResponse(400, "invalid_request_error", "compaction request requires a model");
  }

  let route;
  try {
    route = routeModel(config, raw.model);
  } catch (err) {
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  const selectedModelId = route.modelId;
  logCtx.requestedModel = raw.model;
  logCtx.model = selectedModelId;
  logCtx.provider = route.providerName;
  logCtx.providerAdapter = route.provider.adapter;
  const virtual = resolveOpenAiCompactModel(route.providerName, selectedModelId);
  if (virtual) {
    route.modelId = virtual.wireModelId;
    logCtx.model = virtual.selectedModelId;
    logCtx.resolvedModel = virtual.wireModelId;
  } else {
    logCtx.resolvedModel = route.modelId;
  }

  if (route.codexAccountMode === "direct") {
    try { validateForwardAdmissionCredential(req.headers, config); }
    catch (err) {
      if (err instanceof ForwardAdmissionCredentialError) return formatErrorResponse(401, "authentication_error", err.message);
      throw err;
    }
  }

  if (route.provider.adapter === "openai-responses") {
    // Native ChatGPT/OpenAI model: forward the compact request verbatim to the real backend.
    // Resolve the SAME pool/thread auth context as /v1/responses — forwarding the caller's raw
    // headers would run compaction on the wrong account (or 401) whenever a pool account is
    // active for this thread while normal turns succeed.
    let compactProvider = route.provider;
    let authCtx: CodexAuthContext = { kind: "main", accountId: null };
    const headers = new Headers({ "content-type": "application/json" });
    try {
      if (route.codexAccountMode) {
        authCtx = await resolveCodexAuthContext(req.headers, config, route.codexAccountMode);
        const selected = headersForCodexAuthContext(req.headers, authCtx);
        compactProvider = applyCodexAuthContextToProvider(route.provider, authCtx, route.codexAccountMode);
        for (const name of FORWARD_HEADERS) {
          const value = selected.get(name);
          if (value) headers.set(name, value);
        }
        const override = (compactProvider as { _codexAccountOverride?: { accessToken: string; chatgptAccountId: string } })._codexAccountOverride;
        if (override) {
          headers.set("authorization", `Bearer ${override.accessToken}`);
          headers.set("chatgpt-account-id", override.chatgptAccountId);
        }
      }
    } catch (err) {
      if (err instanceof CodexAccountCooldownError) {
        return formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down");
      }
      if (err instanceof CodexThreadAffinityExpiredError) {
        return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
      }
      if (err instanceof CodexAuthContextError) {
        return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
      }
      if (err instanceof CodexPoolAuthenticationError || err instanceof CodexDirectAuthenticationError) {
        return formatErrorResponse(401, "authentication_error", err.message);
      }
      throw err;
    }
    const base = (compactProvider.baseUrl ?? "").replace(/\/$/, "");
    if (compactProvider.apiKey) headers.set("authorization", `Bearer ${resolveEnvValue(compactProvider.apiKey)}`);
    const { reasoning: _reasoning, ...compactBodyRaw } = raw as typeof raw & { reasoning?: unknown };
    // The regular /v1/responses path applies sanitizeReasoningInputContent via the adapter's
    // buildRequest, but the compact endpoint forwards directly. Apply the same sanitizer here
    // so routed-model reasoning items (reasoning_text content) don't 400 the ChatGPT backend.
    const compactBody = sanitizeReasoningInputContent(compactBodyRaw) as typeof compactBodyRaw;
    const compactUrl = `${base}/responses/compact`;
    const compactThreadId = req.headers.get("x-codex-parent-thread-id");
    const connectMs = config.connectTimeoutMs ?? 200_000;
    const recordCompactPoolOutcome = (outcome: CodexUpstreamOutcome, meta: { retryAfter?: string | null } = {}) => {
      if (!usesCodexForwardPoolAuth(authCtx, route.provider)) return;
      recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
        ...meta,
        threadId: compactThreadId,
      });
    };
    let upstream: Response;
    try {
      // Same connect timeout + keep-alive reset + transient-5xx recovery as /v1/responses —
      // compact hits the same ChatGPT host and must soft-avoid / clear affinity (#186).
      upstream = await fetchWithTransientRetry(
        recovery => fetchWithHeaderTimeout(
          compactUrl,
          applyUpstreamRecoveryInit({
            method: "POST",
            headers,
            body: JSON.stringify({ ...compactBody, model: route.modelId }),
          }, recovery),
          req.signal,
          connectMs,
          false,
          providerFetch(compactProvider),
        ),
        { abortSignal: req.signal, label: safeHostLabel(compactUrl) },
      );
    } catch (err) {
      if (req.signal.aborted) return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      const outcome = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connect_error";
      recordCompactPoolOutcome(outcome);
      return formatErrorResponse(502, "upstream_error", "Failed to connect to compact upstream");
    }
    const retryAfter = upstream.headers.get("retry-after");
    const buffered = await bufferCompactResponse(upstream, req.signal);
    // Record pool health only after the body is fully delivered (or definitively failed).
    // A premature 200 would clear soft-avoid while the client still sees a buffer 502.
    if (buffered.status === 499) {
      return buffered;
    }
    if (upstream.ok && buffered.status >= 500) {
      // The upstream account returned 200 — it is healthy. The buffering failure
      // (oversized body exceeding COMPACT_RESPONSE_MAX_BYTES, or a rare mid-read
      // reset on a small JSON payload) is a local proxy issue, not account flakiness.
      // Record the upstream status so a deterministic payload-size limit does not
      // soft-avoid a healthy account and rotate a thread for 30s.
      recordCompactPoolOutcome(upstream.status, { retryAfter });
    } else {
      recordCompactPoolOutcome(upstream.status, { retryAfter });
    }
    return buffered;
  }

  // ROUTED model: run the v2 synthetic-compaction turn internally (appends COMPACT_PROMPT, no
  // tools) and decode the resulting ocx1 envelope into plain v1 replacement-history items.
  const inputItems = Array.isArray(raw.input) ? (raw.input as unknown[]) : [];
  const internalBody = {
    ...raw,
    stream: false,
    input: [...inputItems, { type: "compaction_trigger" }],
  };
  const internalHeaders = new Headers({ "content-type": "application/json" });
  for (const name of FORWARD_HEADERS) {
    const value = req.headers.get(name);
    if (value) internalHeaders.set(name, value);
  }
  const internalReq = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: internalHeaders,
    body: JSON.stringify(internalBody),
  });
  const response = await handleResponses(internalReq, config, logCtx, { abortSignal: req.signal });
  if (!response.ok) return response;
  let json: { output?: unknown[] };
  try {
    json = await response.json() as { output?: unknown[] };
  } catch {
    return formatErrorResponse(502, "server_error", "compaction turn returned a non-JSON response");
  }
  const compactionItem = (json.output ?? []).find(
    (item): item is { type: string; encrypted_content?: string } =>
      !!item && typeof item === "object" && (item as { type?: string }).type === "compaction",
  );
  const summary = compactionItem?.encrypted_content
    ? decodeCompactionSummary(compactionItem.encrypted_content) ?? ""
    : "";
  const output = buildCompactV1Output(extractCompactUserMessages(inputItems), summary);
  return new Response(JSON.stringify({ output }), { headers: { "Content-Type": "application/json" } });
}

export function disableResponsesRequestTimeout(req: Request, server: Pick<Server<WsData>, "timeout"> | undefined): boolean {
  if (!server) return false;
  try {
    server.timeout(req, 0);
    return true;
  } catch {
    return false;
  }
}

/** Host-only label for retry logs — never leaks path/query/credentials. */
export function safeHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "upstream";
  }
}

function providerFetch(provider: OcxProviderConfig): typeof globalThis.fetch {
  return (provider as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch ?? globalThis.fetch;
}

export async function fetchWithHeaderTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  abortSignal: AbortSignal,
  timeoutMs: number,
  preferIdentityEncoding = false,
  executor: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    if (!timeout.signal.aborted) timeout.abort(new DOMException("Timeout elapsed", "TimeoutError"));
  }, timeoutMs);
  const headers = new Headers(init.headers);
  // Compressed SSE can be held until the decompressor has a complete block. Streaming calls
  // default to identity for low-latency frame delivery, while an explicit caller choice wins.
  if (preferIdentityEncoding && !headers.has("accept-encoding")) {
    headers.set("accept-encoding", "identity");
  }
  try {
    return await executor(url, {
      ...init,
      headers,
      signal: AbortSignal.any([abortSignal, timeout.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
}
