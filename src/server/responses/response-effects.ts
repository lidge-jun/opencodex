import type { ResponsesRequestContext, ResponsesAdmissionState } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesSidecarAuth } from "./request-sidecar-auth";
import type { OcxProviderContinuationState } from "../../types";
import { providerContinuationPayload } from "./core-replay";
import { mergeProviderContinuationPayload } from "../../responses/provider-continuation";
import { commitReasoningReplayServingIdentity } from "../../responses/reasoning-replay-cache";
import { rememberServingConversationStateIssuer } from "./account-change-state";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { contextRelayActivated } from "../../codex/context-compat";
import { recordContextSessionOwner } from "../../codex/context-owner";
import { resolveContextPrincipal } from "../auth-cors";
import { COMPACT_PROMPT } from "../../responses/compaction";
import type { RoutedNamespaceToolAliases } from "../../responses/namespace-tool-compat";
import type { MuseToolNameAliases } from "../../responses/muse-tool-name-alias";
import type { AdapterRequest } from "../../adapters/base";

/** Owns completion callbacks, replay publication, and live tool aliases. */
export function createResponsesEffects(
  requestContext: Pick<ResponsesRequestContext, "options" | "req" | "config">,
  admissionState: ResponsesAdmissionState,
  requestState: Pick<
    PreparedResponsesRequest,
    | "parsed"
    | "poolAffinityKey"
    | "route"
    | "substituteMainCredential"
  >,
  sidecarState: Pick<ResponsesSidecarAuth, "routedCompaction">,
) {
  const { options, req, config } = requestContext;
  const { parsed, poolAffinityKey, route, substituteMainCredential } = requestState;
  const { routedCompaction } = sidecarState;


  const recordTerminalOutcomes = options.recordTerminalOutcomes !== false;
  let responseCompletionNotified = false;
  let responseCompletionCancelled = false;
  const cancelResponseCompletion = (): void => { responseCompletionCancelled = true; };
  const notifyResponseComplete = (response: { status?: unknown; model?: unknown }): void => {
    if (responseCompletionNotified || responseCompletionCancelled
      || options.abortSignal?.aborted || req.signal.aborted
      || response.status !== "completed"
      || typeof response.model !== "string" || !response.model.trim()) return;
    responseCompletionNotified = true;
    options.onResponseComplete?.(response.model);
  };

  const continuationStateForResponse = (
    emitted?: OcxProviderContinuationState,
  ): OcxProviderContinuationState | undefined => {
    const cursorConversationId = parsed._cursorConversationId;
    const inherited = providerContinuationPayload(parsed._providerContinuation);
    const emittedPayload = providerContinuationPayload(emitted);
    if (!emittedPayload && !inherited && !cursorConversationId) return undefined;
    const merged = mergeProviderContinuationPayload(
      inherited ?? {},
      emittedPayload ?? {},
    ) as OcxProviderContinuationState;
    if (cursorConversationId) {
      merged.cursor = { ...(merged.cursor ?? {}), conversationId: cursorConversationId };
    }
    return parsed._providerContinuationOwner
      ? { ...merged, __ocxOwner: { ...parsed._providerContinuationOwner } }
      : merged;
  };

  // Remote compaction v2 on a ROUTED model: Codex sent `compaction_trigger` and requires exactly
  // one `{type:"compaction"}` output item (codex-rs compact_remote_v2.rs). Passthrough handles it
  // natively upstream; here we run the routed model as a plain summarizer — no tools, no web-search
  // sidecar — and the bridge appends the synthetic compaction item (src/responses/compaction.ts).
  // A Responses-shaped wire does not imply support for Codex's private
  // `compaction_trigger` item — only the canonical ChatGPT backend speaks that
  // contract. An API-key gateway would receive the trigger, answer with an ordinary
  // message, and leave Codex fataling on a missing compaction item (#422).
  const commitReasoningReplayServingRoute = (outboundHeaders?: HeadersInit): void => {
    commitReasoningReplayServingIdentity(parsed._reasoningReplayScope);
    rememberServingConversationStateIssuer(admissionState.authCtx, poolAffinityKey);
    // History has no model namespace. Record the account that actually accepted this
    // final attempt, after refresh/failover, rather than guessing from mutable affinity.
    // Recording is relay state. With the feature off there is no relay, so building an owner
    // registry for it is out of scope for this request.
    if (outboundHeaders && isCanonicalOpenAiForwardProvider(route.provider) && contextRelayActivated()) {
      recordContextSessionOwner(resolveContextPrincipal(req, config, options.admission), req.headers,
        route.provider.baseUrl, admissionState.authCtx, new Headers(outboundHeaders), substituteMainCredential);
    }
  };
  if (routedCompaction) {
    delete parsed.context.tools;
    delete parsed._webSearch;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    // The compaction turn is a plain prose summary; a surviving structured-output format
    // would force schema-constrained JSON into the synthetic compaction item. The flag and
    // the raw `text` control go too: the key-mode openai-responses adapter builds from
    // _rawBody, so a surviving format there would still reach the upstream. (The Kiro
    // guard no longer reads _rawBody.text; it refuses structured output only.)
    delete parsed.options.textFormat;
    delete parsed._structuredOutput;
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      delete (parsed._rawBody as Record<string, unknown>).text;
    }
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  let routedNamespaceToolAliases: RoutedNamespaceToolAliases = new Map();
  let plaintextV2AgentMessageToolNames: ReadonlySet<string> = new Set();
  let plaintextV2AgentMessageAliasedToolNames: ReadonlySet<string> = new Set();
  let routedMuseToolNameAliases: MuseToolNameAliases = new Map();
  const refreshRequestToolAliases = (builtRequest: AdapterRequest): void => {
    routedNamespaceToolAliases = builtRequest.convertedRoutedNamespaceToolAliases ?? new Map();
    plaintextV2AgentMessageToolNames = builtRequest.plaintextV2AgentMessageToolNames ?? new Set();
    plaintextV2AgentMessageAliasedToolNames = builtRequest.plaintextV2AgentMessageAliasedToolNames ?? new Set();
    routedMuseToolNameAliases = builtRequest.convertedMuseToolNameAliases ?? new Map();
  };

  return {
    recordTerminalOutcomes,
    get responseCompletionCancelled(): typeof responseCompletionCancelled {
      return responseCompletionCancelled;
    },
    set responseCompletionCancelled(value: typeof responseCompletionCancelled) {
      responseCompletionCancelled = value;
    },
    cancelResponseCompletion,
    notifyResponseComplete,
    continuationStateForResponse,
    commitReasoningReplayServingRoute,
    get routedNamespaceToolAliases(): RoutedNamespaceToolAliases {
      return routedNamespaceToolAliases;
    },
    set routedNamespaceToolAliases(value: RoutedNamespaceToolAliases) {
      routedNamespaceToolAliases = value;
    },
    get plaintextV2AgentMessageToolNames(): ReadonlySet<string> {
      return plaintextV2AgentMessageToolNames;
    },
    set plaintextV2AgentMessageToolNames(value: ReadonlySet<string>) {
      plaintextV2AgentMessageToolNames = value;
    },
    get plaintextV2AgentMessageAliasedToolNames(): ReadonlySet<string> {
      return plaintextV2AgentMessageAliasedToolNames;
    },
    set plaintextV2AgentMessageAliasedToolNames(value: ReadonlySet<string>) {
      plaintextV2AgentMessageAliasedToolNames = value;
    },
    get routedMuseToolNameAliases(): MuseToolNameAliases {
      return routedMuseToolNameAliases;
    },
    set routedMuseToolNameAliases(value: MuseToolNameAliases) {
      routedMuseToolNameAliases = value;
    },
    refreshRequestToolAliases,
  };
}

export type ResponsesEffects = Exclude<ReturnType<typeof createResponsesEffects>, Response>;
