import { isKeyInCooldown } from "./api-key-cooldowns";
import { randomUUID } from "node:crypto";
import { mutatePersistedConfig } from "../config";
import { publishAccountSelection } from "../lib/account-selection-events";
import { clearModelCache } from "../codex/model-cache";
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { ProviderApiKeySelection } from "../types/provider";
import { routedProviderConfig } from "./routed-config";
import { OPENCODE_GO_SESSION_HEADER } from "./opencode-go-transport";
import { resolveProviderTransport, XAI_GROK_COMPATIBILITY, type OcxProviderTransport } from "./xai-transport";
import { captureProviderApiKeySelection } from "./api-key-selection-capture";

export { captureProviderApiKeySelection } from "./api-key-selection-capture";

function matchesSelection(provider: OcxProviderConfig, expected: ProviderApiKeySelection): boolean {
  const current = captureProviderApiKeySelection(provider);
  return current.entryId === expected.entryId && current.reference === expected.reference
    && current.revision === expected.revision;
}

function currentKeyProvider(config: OcxConfig, name: string, selection?: ProviderApiKeySelection, allowCooling = false): OcxProviderConfig | null {
  const configured = config.providers[name];
  if (!configured || configured.disabled) return null;
  let row = configured;
  if (selection?.distributed) {
    const entry = configured.apiKeyPool?.find(key => key.id === selection.entryId && key.key === selection.reference);
    if (!entry || (!allowCooling && isKeyInCooldown(name, entry.id)) || configured.apiKeySelectionRevision !== selection.revision
      || !configured.requestPacing?.enabled || configured.requestPacing.keySelection !== "round-robin") return null;
    row = { ...configured, apiKey: entry.key, _apiKeyAttempt: selection };
  }
  const current = routedProviderConfig(name, { ...row, _apiKeyAttempt: selection?.distributed ? selection : undefined });
  if (current.authMode === "oauth" || current.authMode === "forward") return null;
  if (current.authMode === "key" && !current.keyOptional && !current.apiKey?.trim()) return null;
  return current;
}

/** Physical-send check; stored references alone do not detect a changed env/keychain value. */
export function providerApiKeySelectionIsCurrent(
  config: OcxConfig,
  name: string,
  routedProvider: OcxProviderConfig,
): boolean {
  return matchesConfiguredSelection(config, name, routedProvider, false);
}

/** An already sent failure can extend cooldown, but cannot authorize another dispatch. */
export function providerApiKeySelectionOwnsFailure(
  config: OcxConfig, name: string, routedProvider: OcxProviderConfig,
): boolean {
  return matchesConfiguredSelection(config, name, routedProvider, true);
}

function matchesConfiguredSelection(
  config: OcxConfig, name: string, routedProvider: OcxProviderConfig, allowCooling: boolean,
): boolean {
  const expected = routedProvider._apiKeyAttempt;
  const current = currentKeyProvider(config, name, expected, allowCooling);
  return current !== null && expected !== undefined
    && (expected.distributed === true || matchesSelection(config.providers[name]!, expected))
    && current.apiKey === routedProvider.apiKey
    && current.authMode === routedProvider.authMode
    && current.baseUrl === routedProvider.baseUrl;
}

/** Rebuild transport from the already committed choice; never allocate or publish a selection. */
export function resolveCurrentProviderApiKeyTransport(
  config: OcxConfig,
  name: string,
  routedProvider: OcxProviderConfig,
): OcxProviderConfig | null {
  // A permit acquired for one key cannot authorize a different key after a manual edit.
  if (routedProvider.requestPacing?.enabled && routedProvider.requestPacing.keys
    && routedProvider._apiKeyAttempt && config.providers[name]
    && !routedProvider._apiKeyAttempt.distributed && !matchesSelection(config.providers[name]!, routedProvider._apiKeyAttempt)) return null;
  const current = currentKeyProvider(config, name, routedProvider._apiKeyAttempt);
  if (!current) return null;
  const runtime = routedProvider as OcxProviderTransport;
  const headers = { ...current.headers };
  const affinityHeaders = name === "xai"
    ? [XAI_GROK_COMPATIBILITY.headers.conversationId, XAI_GROK_COMPATIBILITY.headers.sessionId]
    : [OPENCODE_GO_SESSION_HEADER];
  for (const header of affinityHeaders) {
    const configured = Object.keys(headers).some(key => key.toLowerCase() === header.toLowerCase());
    const value = Object.entries(runtime.headers ?? {}).find(([key]) => key.toLowerCase() === header.toLowerCase())?.[1];
    if (!configured && value !== undefined) headers[header] = value;
  }
  const fetch = (current as OcxProviderTransport).fetch ?? runtime.fetch;
  return resolveProviderTransport(name, {
    ...current,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(fetch ? { fetch } : {}),
  });
}

type SelectionMutation<T> = { changed: boolean; value: T; selectionChanged?: boolean };
export type ProviderApiKeyCommit<T> =
  | { status: "committed"; provider: OcxProviderConfig; value: T }
  | { status: "superseded"; provider: OcxProviderConfig }
  | { status: "unavailable" };

/** GUI and recovery share one persisted selection transaction and post-commit notification. */
export function commitProviderApiKeySelection<T>(
  config: OcxConfig,
  name: string,
  mutation: (provider: OcxProviderConfig) => SelectionMutation<T>,
  expectedSelection?: ProviderApiKeySelection,
): ProviderApiKeyCommit<T> {
  const outcome = mutatePersistedConfig<ProviderApiKeyCommit<T> & { notify?: boolean }>(fresh => {
    const provider = fresh.providers[name];
    if (!provider || provider.authMode === "oauth" || provider.authMode === "forward") {
      return { changed: false, value: { status: "unavailable" } };
    }
    if (expectedSelection && !matchesSelection(provider, expectedSelection)) {
      return { changed: false, value: { status: "superseded", provider: structuredClone(provider) } };
    }
    const before = provider.apiKey;
    const result = mutation(provider);
    const notify = result.selectionChanged === true || before !== provider.apiKey;
    if (notify) provider.apiKeySelectionRevision = randomUUID();
    delete provider._apiKeyAttempt;
    return {
      changed: result.changed || notify,
      value: { status: "committed", provider: structuredClone(provider), value: result.value, notify },
    };
  });
  if (outcome.status === "unavailable") return { status: "unavailable" };
  const committed = outcome.value;
  if (committed.status !== "unavailable") config.providers[name] = structuredClone(committed.provider);
  if (committed.status === "committed" && committed.notify) {
    clearModelCache(name);
    publishAccountSelection(name, "api-key");
  }
  return committed;
}
