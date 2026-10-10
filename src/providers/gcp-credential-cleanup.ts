import { mutatePersistedConfig } from "../config";
import { GCP_CREDENTIAL_MARKER_PREFIX, gcpCredentialMarkerAccount } from "../lib/gcp-adc";
import type { OcxProviderConfig } from "../types";
import { providerKeychainEntry } from "./api-key-resolve";

/** Snapshot credential references before removing a key or provider. */
export function providerGcpCredentialMarkers(provider: OcxProviderConfig): string[] {
  return [...new Set([provider.apiKey, ...(provider.apiKeyPool ?? []).map(entry => entry.key)]
    .filter((key): key is string => typeof key === "string" && key.startsWith(GCP_CREDENTIAL_MARKER_PREFIX)))];
}

/** After a successful config commit, remove only credentials no persisted provider references. */
export function cleanupRemovedGcpCredentials(markers: readonly string[]): void {
  if (!markers.length) return;
  try {
    // Re-read under the config mutation lock: another provider may share a marker, or a newer
    // commit may have reintroduced it. Never decide deletion from the caller's stale snapshot.
    const outcome = mutatePersistedConfig(fresh => {
      const retained = new Set(Object.values(fresh.providers).flatMap(providerGcpCredentialMarkers));
      for (const marker of new Set(markers)) {
        if (retained.has(marker)) continue;
        const account = gcpCredentialMarkerAccount(marker);
        if (account) providerKeychainEntry(account).deletePassword();
      }
      return { changed: false, value: true };
    });
    if (outcome.status === "unavailable") throw new Error("configuration unavailable");
  } catch {
    console.warn("GCP credential cleanup incomplete; inspect the OS credential store. Configuration removal remains committed.");
  }
}
