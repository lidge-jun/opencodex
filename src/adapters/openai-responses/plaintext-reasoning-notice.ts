import { sanitizeLogMetadataString } from "../../lib/redact";
import { isOpenAiOperatedResponsesDestination } from "../../providers/openai-tiers";
import { normalizedProviderEndpoint, PROVIDER_REGISTRY } from "../../providers/registry";
import type { OcxProviderConfig } from "../../types";

/**
 * #6675: a custom Responses provider drops replayed plaintext reasoning unless it sets
 * `preserveResponsesReasoningContent`. That default is deliberate (the ChatGPT backend rejects
 * echoed raw reasoning, and forwarding it costs tokens), but it is silent, and the similarly named
 * Chat-wire `preserveReasoningContentModels` does not opt in. Say so once per destination.
 *
 * Only a hand-configured `openai-responses` row with key auth qualifies. Registry presets (matched
 * by endpoint on either OpenAI wire, since a preset may be routed to Responses per model), OAuth and
 * forward rows, Azure, and OpenAI-operated destinations are skipped: their replay contract is
 * curated, so blanking there is a decision rather than a missing setting. The notice carries only
 * the destination host and option names, never request content.
 */
const MAX_NOTICED_DESTINATIONS = 64;
const noticedDestinations = new Set<string>();

function destinationHost(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== "string") return undefined;
  try {
    return sanitizeLogMetadataString(new URL(baseUrl).host, 128);
  } catch {
    return undefined;
  }
}

/** Azure OpenAI and Azure AI Foundry serve OpenAI-operated models under per-resource hosts. */
const AZURE_OPENAI_HOST_SUFFIXES = [".openai.azure.com", ".services.ai.azure.com", ".cognitiveservices.azure.com"];

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** A templated preset (`https://{resource}.openai.azure.com/...`) matches by host pattern. */
function templatedHostMatches(template: string, hostname: string): boolean {
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(template)?.[1];
  if (!host || !/\{[^}]*\}/.test(host)) return false;
  const pattern = host.toLowerCase().split(/\{[^}]*\}/).map(part => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("[^.]+");
  return new RegExp(`^${pattern}$`).test(hostname);
}

function isRegistryDestination(baseUrl: string): boolean {
  const endpoint = normalizedProviderEndpoint(baseUrl);
  const hostname = hostnameOf(baseUrl);
  if (hostname && AZURE_OPENAI_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))) return true;
  return PROVIDER_REGISTRY.some(entry =>
    normalizedProviderEndpoint(entry.baseUrl) === endpoint
    || (hostname !== undefined && templatedHostMatches(entry.baseUrl, hostname))
    || (entry.destinationAliases ?? []).some(alias => normalizedProviderEndpoint(alias.baseUrl) === endpoint));
}

function isCustomResponsesProvider(provider: OcxProviderConfig): boolean {
  if (provider.adapter !== "openai-responses") return false;
  if (provider.authMode !== undefined && provider.authMode !== "key") return false;
  if (typeof provider.baseUrl !== "string" || !provider.baseUrl) return false;
  return !isOpenAiOperatedResponsesDestination(provider) && !isRegistryDestination(provider.baseUrl);
}

export function plaintextReasoningDroppedNotice(host: string): string {
  return `[opencodex] Replayed plaintext reasoning was dropped for the custom Responses provider at ${host}. `
    + "If that endpoint accepts reasoning_text replay, set \"preserveResponsesReasoningContent\": true on the provider; "
    + "\"preserveReasoningContentModels\" applies only to the Chat wire.";
}

export function notePlaintextReasoningDropped(
  provider: OcxProviderConfig,
  warn: (message: string) => void = message => console.warn(message),
): void {
  if (!isCustomResponsesProvider(provider)) return;
  const host = destinationHost(provider.baseUrl);
  if (!host || noticedDestinations.has(host) || noticedDestinations.size >= MAX_NOTICED_DESTINATIONS) return;
  noticedDestinations.add(host);
  warn(plaintextReasoningDroppedNotice(host));
}

export function resetPlaintextReasoningNoticesForTests(): void {
  noticedDestinations.clear();
}
