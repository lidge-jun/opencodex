import type { OcxProviderConfig } from "../types";
import { resolveAnthropicMessagesUrl } from "../adapters/anthropic";
import { providerApiKeySelectionIsCurrent } from "./api-key-selection";
import { hasKeyPoolFailover } from "./key-failover";
import type { OcxConfig } from "../types";
import { registerProviderResponseProvenance } from "./request-pacing";
import { isEgressTransparentExecutor, markEgressTransparentExecutor } from "../lib/provider-egress";

interface BillingSendOwnership {
  readonly providerName: string;
  readonly provider: OcxProviderConfig;
  readonly target: string;
}
const responseOwners = new WeakMap<Response, BillingSendOwnership | null>();
registerProviderResponseProvenance(responseOwners);

/** Runs inside connection policy, after plugin/header rewrites, at the physical fetch. */
export function anthropicBillingPhysicalFetch(
  physicalFetch: typeof globalThis.fetch,
  providerName: string,
  provider: OcxProviderConfig,
): typeof globalThis.fetch {
  const wrapped = (async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const selection = provider._apiKeyAttempt;
    const ownsCredential = provider.apiKeyTransport === "bearer"
      ? headers.get("authorization") === `Bearer ${provider.apiKey}` && !headers.has("x-api-key")
      : headers.get("x-api-key") === provider.apiKey && !headers.has("authorization");
    const ownsKey = provider.adapter === "anthropic" && (provider.authMode === undefined || provider.authMode === "key")
      && hasKeyPoolFailover(provider) && selection !== undefined && provider.apiKey !== undefined
      && ownsCredential
      && target === resolveAnthropicMessagesUrl(provider);
    const owner: BillingSendOwnership | null = ownsKey ? Object.freeze({
      providerName, target,
      provider: Object.freeze({ ...provider,
        _apiKeyAttempt: Object.freeze({ ...selection }),
        headers: Object.freeze({ ...provider.headers }),
        apiKeyPool: provider.apiKeyPool?.map(entry => Object.freeze({ ...entry })),
      }),
    }) : null;
    // No await between capturing the selected credential and invoking the actual send.
    const response = await physicalFetch(input, init);
    // An executor reusing a Response across physical sends cannot assign it two owners.
    responseOwners.set(response, responseOwners.has(response) ? null : owner);
    return response;
  }) as typeof globalThis.fetch;
  return isEgressTransparentExecutor(physicalFetch) ? markEgressTransparentExecutor(wrapped) : wrapped;
}

/** Immutable response ownership, matched to the attempted route and still-current selection. */
export function anthropicBillingResponseOwner(
  response: Response, config: OcxConfig, providerName: string, attemptedProvider: OcxProviderConfig,
): OcxProviderConfig | null {
  const owner = responseOwners.get(response);
  if (!owner || owner.providerName !== providerName || owner.target !== resolveAnthropicMessagesUrl(attemptedProvider)) return null;
  const sent = owner.provider;
  const current = config.providers[providerName];
  if (!current || current.adapter !== sent.adapter || current.adapter !== "anthropic"
    || (current.authMode !== undefined && current.authMode !== "key") || !hasKeyPoolFailover(current)) return null;
  const sentTransport = sent.apiKeyTransport ?? "x-api-key";
  if ((current.apiKeyTransport ?? "x-api-key") !== sentTransport
    || (attemptedProvider.apiKeyTransport ?? "x-api-key") !== sentTransport) return null;
  // Configured headers can change billing/account ownership independently of key selection.
  const headerShape = (provider: OcxProviderConfig) => JSON.stringify(Object.entries(provider.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  if (headerShape(current) !== headerShape(sent)) return null;
  const attempted = attemptedProvider._apiKeyAttempt;
  if (!attempted || attemptedProvider.apiKey !== sent.apiKey || attemptedProvider.baseUrl !== sent.baseUrl
    || attemptedProvider.authMode !== sent.authMode || attemptedProvider.adapter !== sent.adapter
    || attempted.entryId !== sent._apiKeyAttempt?.entryId || attempted.reference !== sent._apiKeyAttempt?.reference
    || attempted.revision !== sent._apiKeyAttempt?.revision
    || !providerApiKeySelectionIsCurrent(config, providerName, sent)) return null;
  return sent;
}
