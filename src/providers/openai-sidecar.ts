import { resolveEnvValue } from "../config";
import {
  CodexPoolAuthenticationError,
  headersForCodexAuthContext,
  hasCallerCodexBearer,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  type CodexAccountSelectionAdmission,
  type CodexAuthContext,
} from "../codex/auth-context";
import { recordCodexUpstreamOutcome, type CodexUpstreamOutcome } from "../codex/routing";
import { extractAccountId } from "../oauth/chatgpt";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "../server/auth-cors";
import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "../types";
import {
  CODEX_FORWARD_BASE_URL,
  isCanonicalOpenAiForwardProvider,
  OPENAI_API_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
} from "./openai-tiers";
import { getProviderRegistryEntry, providerCodexAccountMode } from "./registry";

export interface OpenAiForwardSidecarCandidate {
  providerName: typeof OPENAI_CODEX_PROVIDER_ID;
  provider: OcxProviderConfig;
  accountMode: CodexAccountMode;
}

export interface ResolvedOpenAiForwardSidecar extends OpenAiForwardSidecarCandidate {
  authContext: CodexAuthContext;
  headers: Headers;
  recordOutcome?: (outcome: CodexUpstreamOutcome) => void;
}

/**
 * Server-resolved exact account selection for a ChatGPT sidecar call.
 * `accountId` must come from a validated account-qualified route; request headers
 * are never trusted as account ids. `modelId` is the sidecar's actual upstream
 * model so cooldown admission and outcome recording use the correct quota scope.
 */
export interface ExactOpenAiSidecarAccount {
  accountId: string;
  modelId: string;
}

export interface OpenAiImagesProviderSelection {
  forwardCandidates: OpenAiForwardSidecarCandidate[];
  keyed?: {
    providerName: string;
    provider: OcxProviderConfig;
    apiKey: string;
  };
  error?: string;
}

export function listOpenAiForwardSidecarCandidates(config: OcxConfig): OpenAiForwardSidecarCandidate[] {
  const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (!provider || provider.disabled === true) return [];
  // The built-in registry defaults an omitted authMode to forward. Normalize only that
  // missing field before the strict adapter/destination check; explicit key mode and
  // noncanonical destinations remain ineligible for ChatGPT credential injection.
  const canonicalProvider = provider.authMode === undefined
    ? { ...provider, authMode: "forward" as const }
    : provider;
  if (!isCanonicalOpenAiForwardProvider(canonicalProvider)) return [];
  // The predicate accepts harmless trailing-slash variants. Pin the provider returned
  // to credential-bearing sidecars so every consumer builds one exact ChatGPT path
  // instead of independently concatenating the operator's equivalent spelling.
  const pinnedProvider = canonicalProvider.baseUrl === CODEX_FORWARD_BASE_URL
    ? canonicalProvider
    : { ...canonicalProvider, baseUrl: CODEX_FORWARD_BASE_URL };
  return [{
    providerName: OPENAI_CODEX_PROVIDER_ID,
    provider: pinnedProvider,
    accountMode: providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, pinnedProvider) ?? "pool",
  }];
}

function directSidecarHeaders(
  incomingHeaders: Headers,
): Headers | undefined {
  const bearer = incomingHeaders.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return undefined;
  const derivedAccountId = extractAccountId(undefined, bearer);
  if (!derivedAccountId) return undefined;
  const requestedAccountId = incomingHeaders.get("chatgpt-account-id")?.trim();
  // JWT payloads are decoded locally but not signature-verified. Requiring the caller's
  // explicit account header, and checking it against the token claim, makes forwarding an
  // intentional ChatGPT-auth operation instead of silently reclassifying any JWT-shaped
  // provider credential as a Codex bearer.
  if (!requestedAccountId || requestedAccountId !== derivedAccountId) return undefined;
  const selected = headersForCodexAuthContext(incomingHeaders, { kind: "main", accountId: null });
  return selected;
}

export async function resolveFirstUsableOpenAiSidecar(
  candidates: readonly OpenAiForwardSidecarCandidate[],
  incomingHeaders: Headers,
  config: OcxConfig,
  options: {
    exactAccount?: ExactOpenAiSidecarAccount;
    beginCodexAccountSelection?: () => CodexAccountSelectionAdmission | undefined;
  } = {},
): Promise<ResolvedOpenAiForwardSidecar | undefined> {
  const { exactAccount } = options;
  let callerBearerMayBeForwarded = true;
  try {
    validateForwardAdmissionCredential(incomingHeaders, config);
  } catch (error) {
    if (!(error instanceof ForwardAdmissionCredentialError)) throw error;
    callerBearerMayBeForwarded = false;
  }
  for (const candidate of candidates) {
    if (exactAccount) {
      // An account-qualified model is an explicit user choice. Resolve the stored
      // credential directly even when the provider is globally Direct, and never
      // consult Pool active state, affinity, probes, or alternates.
      const authContext = await resolveCodexAuthContext(incomingHeaders, config, "pool", {
        accountId: exactAccount.accountId,
        modelId: exactAccount.modelId,
        beginCodexAccountSelection: options.beginCodexAccountSelection,
      });
      if ((authContext.kind !== "pool" && authContext.kind !== "main-pool")
        || !isCodexAuthContextUsable(authContext, config)) {
        // Exact selection is fail-closed. A generation/runtime-state race must not fall through
        // to the caller-bearer error or let a later candidate select another account.
        throw new CodexPoolAuthenticationError("Selected Codex account is unavailable");
      }
      return {
        ...candidate,
        authContext,
        headers: headersForCodexAuthContext(incomingHeaders, authContext),
        recordOutcome: (outcome: CodexUpstreamOutcome) => recordCodexUpstreamOutcome(
          config,
          authContext.accountId,
          outcome,
          {
            modelId: exactAccount.modelId,
            fixedAccount: true,
            probeLeaseId: authContext.probeLeaseId,
            probeQuotaScope: authContext.probeQuotaScope,
            writerGeneration: authContext.writerGeneration,
          },
        ),
      };
    }
    if (candidate.accountMode === "direct") {
      if (!callerBearerMayBeForwarded || !hasCallerCodexBearer(incomingHeaders)) continue;
      const headers = directSidecarHeaders(incomingHeaders);
      if (!headers) continue;
      return {
        ...candidate,
        authContext: { kind: "main", accountId: null },
        headers,
      };
    }
    const authContext = await resolveCodexAuthContext(incomingHeaders, config, candidate.accountMode, {
      beginCodexAccountSelection: options.beginCodexAccountSelection,
    });
    if (!isCodexAuthContextUsable(authContext, config)) continue;
    return {
      ...candidate,
      authContext,
      headers: headersForCodexAuthContext(incomingHeaders, authContext),
      ...(authContext.kind === "pool" || authContext.kind === "main-pool"
        ? {
          recordOutcome: (outcome: CodexUpstreamOutcome) => recordCodexUpstreamOutcome(
            config,
            authContext.accountId,
            outcome,
            {
              probeLeaseId: authContext.probeLeaseId,
              writerGeneration: authContext.writerGeneration,
            },
          ),
        }
        : {}),
    };
  }
  return undefined;
}

export function selectOpenAiImagesProvider(config: OcxConfig): OpenAiImagesProviderSelection {
  const selection: OpenAiImagesProviderSelection = {
    forwardCandidates: listOpenAiForwardSidecarCandidates(config),
  };
  const provider = config.providers[OPENAI_API_PROVIDER_ID];
  if (
    provider
    && provider.disabled !== true
    && provider.adapter === "openai-responses"
    && provider.authMode !== "forward"
    && provider.baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1"
  ) {
    const apiKey = resolveEnvValue(provider.apiKey)?.trim();
    if (apiKey) selection.keyed = { providerName: OPENAI_API_PROVIDER_ID, provider, apiKey };
  }
  return selection;
}

/** Resolve an explicit custom Images provider, otherwise preserve the existing OpenAI fallback. */
export function selectImagesProvider(config: OcxConfig): OpenAiImagesProviderSelection {
  const configuredProvider = config.images?.provider;
  if (configuredProvider === undefined) return selectOpenAiImagesProvider(config);
  if (typeof configuredProvider !== "string" || !configuredProvider.trim()) {
    return { forwardCandidates: [], error: "images.provider must be a nonblank provider name" };
  }
  const providerName = configuredProvider.trim();

  if (getProviderRegistryEntry(providerName)) {
    return {
      forwardCandidates: [],
      error: `images.provider "${providerName}" must name a custom provider; omit it to use built-in OpenAI tiers`,
    };
  }

  const provider = Object.prototype.hasOwnProperty.call(config.providers, providerName)
    ? config.providers[providerName]
    : undefined;
  if (!provider) {
    return { forwardCandidates: [], error: `images.provider "${providerName}" is not configured` };
  }
  if (provider.disabled === true) {
    return { forwardCandidates: [], error: `images.provider "${providerName}" is disabled` };
  }
  if (provider.adapter !== "openai-responses" || (provider.authMode !== undefined && provider.authMode !== "key")) {
    return {
      forwardCandidates: [],
      error: `images.provider "${providerName}" must be an API-key openai-responses provider`,
    };
  }

  const apiKey = resolveEnvValue(provider.apiKey)?.trim();
  if (!apiKey) {
    return { forwardCandidates: [], error: `images.provider "${providerName}" has no usable API key` };
  }

  return {
    forwardCandidates: [],
    keyed: { providerName, provider, apiKey },
  };
}
