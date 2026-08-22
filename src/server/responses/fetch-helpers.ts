import type { Server } from "bun";
import {
  codexWsUpstreamFetch,
  currentBunRuntimeIdentity,
  shouldUseCodexWsUpstream,
  type BunRuntimeGateInput,
} from "./ws-upstream";
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
import { waitForProviderRequestSlot } from "../../providers/request-pacing";
import { withUpstreamHttpVersion } from "../../lib/upstream-http-version";

export { withUpstreamHttpVersion } from "../../lib/upstream-http-version";

export function disableResponsesRequestTimeout(req: Request, server: Pick<Server<WsData>, "timeout"> | undefined): boolean {
  if (!server) return false;
  try {
    server.timeout(req, 0);
    return true;
  } catch {
    return false;
  }
}



export function safeHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "upstream";
  }
}

/** Canonical origin (scheme + host) for failure-attribution keys: http and
 * https for the same host must not share one ledger entry (#914 review). */
export function safeOriginLabel(url: string): string {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return "upstream";
  }
}



export interface PaceAwareFetch {
  waitForPacing?: (signal?: AbortSignal) => Promise<void>;
  unpacedFetch?: typeof globalThis.fetch;
}

export type ProviderFetch = typeof globalThis.fetch & PaceAwareFetch;

export interface ProviderFetchOptions {
  providerName?: string;
  modelId?: string;
  /** One pacing slot was acquired immediately before this fetch wrapper was created. */
  pacingSlotAcquired?: boolean;
}

export function providerFetch(
  provider: OcxProviderConfig,
  runtime: BunRuntimeGateInput = currentBunRuntimeIdentity(),
  options: ProviderFetchOptions = {},
): ProviderFetch {
  const base = (provider as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch ?? globalThis.fetch;
  // ChatGPT Codex backend: streaming turns ride the responses_websockets
  // transport (measured ~3s faster TTFT than the SSE POST queue); everything
  // else keeps the provider's HTTP fetch. See ws-upstream.ts for the details.
  const unpaced = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    if (typeof input === "string" && init && shouldUseCodexWsUpstream(input, init, runtime)) {
      return codexWsUpstreamFetch(input, init, base, runtime);
    }
    return base(input, withUpstreamHttpVersion(input, init, provider));
  };
  let pacingSlotAcquired = options.pacingSlotAcquired === true;
  const waitForPacing = (signal?: AbortSignal) => {
    if (pacingSlotAcquired) {
      pacingSlotAcquired = false;
      return Promise.resolve();
    }
    return options.providerName
      ? waitForProviderRequestSlot(options.providerName, provider, options.modelId, signal)
      : Promise.resolve();
  };
  const wrapped = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    await waitForPacing(init?.signal ?? undefined);
    return unpaced(input, init);
  };
  const preconnect = (...args: Parameters<typeof globalThis.fetch.preconnect>): void => {
    base.preconnect?.(...args);
  };
  return Object.assign(wrapped, {
    preconnect,
    waitForPacing,
    unpacedFetch: Object.assign(unpaced, { preconnect }),
  });
}



export async function fetchWithHeaderTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  abortSignal: AbortSignal,
  timeoutMs: number,
  preferIdentityEncoding = false,
  executor: typeof globalThis.fetch = globalThis.fetch,
  manualRedirect = false,
): Promise<Response> {
  const pacing = executor as ProviderFetch;
  await pacing.waitForPacing?.(abortSignal);
  const fetchExecutor = pacing.unpacedFetch ?? executor;
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
    return await fetchExecutor(url, {
      ...init,
      headers,
      // Credential-bearing sends opt into manual redirects so a 3xx is relayed
      // as a Response instead of being followed into a rejection that is
      // indistinguishable from a pre-connection failure (#914).
      ...(manualRedirect ? { redirect: "manual" as const } : {}),
      signal: AbortSignal.any([abortSignal, timeout.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
}
