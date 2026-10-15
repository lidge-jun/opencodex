import { mutatePersistedConfig, readConfigAdmissionSnapshot, withConfigMutationLockSync } from "../config";
import { GCP_CREDENTIAL_MARKER_PREFIX, gcpCredentialMarkerAccount } from "../lib/gcp-adc";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { isKeychainReference, keychainAccount, providerKeychainEntry } from "./api-key-resolve";

/** Snapshot credential references before removing a key or provider. */
export function providerGcpCredentialMarkers(provider: OcxProviderConfig): string[] {
  return [...new Set([provider.apiKey, ...(provider.apiKeyPool ?? []).map(entry => entry.key)]
    .filter((key): key is string => typeof key === "string" && key.startsWith(GCP_CREDENTIAL_MARKER_PREFIX)))];
}

/** Capture both the caller's row and the valid durable row before a provider mutation. */
export function snapshotProviderGcpCredentialMarkers(name: string, provider: OcxProviderConfig | undefined): string[] {
  const durable = readConfigAdmissionSnapshot();
  const durableProvider = durable.kind === "read" && durable.diagnostics.source === "file"
    && durable.diagnostics.error === null ? durable.diagnostics.config.providers[name] : undefined;
  return [provider, durableProvider].flatMap(row => row ? providerGcpCredentialMarkers(row) : []);
}

/** Capture deletion candidates and save under the same lock; cleanup follows a successful save. */
export function commitProviderGcpCredentialRemoval<T>(config: OcxConfig, name: string, saveRemoval: () => T): T {
  let markers: string[] = [];
  const result = withConfigMutationLockSync(() => {
    markers = snapshotProviderGcpCredentialMarkers(name, config.providers[name]);
    return saveRemoval();
  });
  cleanupRemovedGcpCredentials(markers);
  return result;
}

function cleanupGcpCredentialAccount(key: string | undefined): string | undefined {
  if (key?.startsWith(GCP_CREDENTIAL_MARKER_PREFIX) && !key.slice(GCP_CREDENTIAL_MARKER_PREFIX.length).trim()) return undefined;
  return gcpCredentialMarkerAccount(key);
}

/** After a successful config commit, remove only credentials no persisted provider references. */
export function cleanupRemovedGcpCredentials(markers: readonly string[]): void {
  if (!markers.length) return;
  try {
    // Re-read under the config mutation lock: another provider may share a marker, or a newer
    // commit may have reintroduced it. Never decide deletion from the caller's stale snapshot.
    const outcome = mutatePersistedConfig(fresh => {
      const retained = new Set(Object.values(fresh.providers).flatMap(provider =>
        [provider.apiKey, ...(provider.apiKeyPool ?? []).map(entry => entry.key)]
          .flatMap(key => {
            const account = isKeychainReference(key) ? keychainAccount(key) : cleanupGcpCredentialAccount(key);
            return account === undefined ? [] : [account];
          })));
      for (const marker of new Set(markers)) {
        const account = cleanupGcpCredentialAccount(marker);
        if (account && !retained.has(account)) providerKeychainEntry(account).deletePassword();
      }
      return { changed: false, value: true };
    });
    if (outcome.status === "unavailable") throw new Error("configuration unavailable");
  } catch {
    console.warn("GCP credential cleanup incomplete; inspect the OS credential store. Configuration removal remains committed.");
  }
}
