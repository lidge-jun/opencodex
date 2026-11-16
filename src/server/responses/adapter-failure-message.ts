/**
 * Client-facing message for an adapter's non-2xx upstream response.
 *
 * This is the HTTP Responses recovery path's own composition: scrub the body once, let a plan
 * refusal this proxy proved outrank the upstream wording, then let Antigravity's model-denial
 * sentence and the OpenCode Zen rate-limit enrichment adjust what remains. The caller needs the
 * normalized envelope as well — it decides the cyber-policy status and type in the response —
 * so both are returned from the single read rather than normalizing twice.
 */
import { normalizeUpstreamErrorText, type NormalizedUpstreamErrorText } from "./core-errors";
import { enrichOpenCodeZenUpstreamMessage } from "../../providers/opencode-zen-rate-limit";
import { stampMetaMusePlanRefusal } from "../../providers/meta-muse-plan-refusal";
import { isCyberPolicyCode, CYBER_POLICY_FALLBACK_MESSAGE } from "../../lib/errors";
import type { RequestFailureCause } from "../../usage/telemetry-contract";

/** The provider facts the Zen enrichment reads; a name or endpoint alone is not enough. */
export interface AdapterFailureProviderFacts {
  providerName: string;
  provider: {
    baseUrl: string;
    adapter: string;
    authMode?: string | undefined;
    apiKey?: string | null;
  };
}

export interface AdapterFailureMessageInput {
  status: number;
  errorText: string;
  route: AdapterFailureProviderFacts;
  upstreamRetryAfter: string | null;
  /** The Antigravity request-local denial sentence, already bound to its recovery state. */
  denialMessage: (fallback: string) => string;
  logCtx: { causeHint?: RequestFailureCause };
}

export interface AdapterFailureMessage {
  normalized: NormalizedUpstreamErrorText;
  message: string;
}

export function formatAdapterUpstreamFailure(input: AdapterFailureMessageInput): AdapterFailureMessage {
  const normalized = normalizeUpstreamErrorText(input.errorText, "unknown error");
  // Meta's Muse Code refusal is a plan restriction, not a rejected credential (#8352). The body
  // proved it here, so stamp the cause and answer with this proxy's own sentence.
  const musePlanRefusal = stampMetaMusePlanRefusal(input.logCtx, input.status, input.errorText);
  const message = musePlanRefusal ?? input.denialMessage(normalized.cyberPolicy
    ? normalized.message
      ?? (isCyberPolicyCode(normalized.code) ? CYBER_POLICY_FALLBACK_MESSAGE : normalized.safeText)
    : enrichOpenCodeZenUpstreamMessage(
      `Provider error ${input.status}: ${normalized.safeText}`,
      {
        status: input.status,
        providerName: input.route.providerName,
        baseUrl: input.route.provider.baseUrl,
        adapter: input.route.provider.adapter,
        authMode: input.route.provider.authMode,
        hasApiKey: Boolean(input.route.provider.apiKey?.trim()),
        upstreamRetryAfter: input.upstreamRetryAfter,
        upstreamErrorType: normalized.type,
        upstreamErrorCode: normalized.code,
        // This recovery path is the HTTP Responses wire; custom runTurn transports never reach
        // enrichOpenCodeZenUpstreamMessage here.
        supportsHttpSameKeyRetry: true,
      },
    ));
  return { normalized, message };
}
