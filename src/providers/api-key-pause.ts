import { accountAutoPauseFenceMatchesDisk, type AccountAutoPauseFence } from "../config/account-auto-pause-revisions";
import { randomUUID } from "node:crypto";
import type { OcxConfig } from "../types";
import type { ProviderApiKeySelection } from "../types/provider";
import type { AccountPauseDetails } from "../types/account-auto-pause";
import { apiKeyPoolEntryId } from "./api-keys";
import { resolveProviderApiKey } from "./api-key-resolve";
import { commitProviderApiKeySelection } from "./api-key-selection";

export function setProviderApiKeyPaused(config: OcxConfig, name: string, id: string, paused: boolean,
  automatic?: { fence: AccountAutoPauseFence; selection: ProviderApiKeySelection; pauseRevision?: string; resolvedKey?: string; details: AccountPauseDetails }): boolean {
  const result = commitProviderApiKeySelection(config, name, provider => {
    if (automatic && !accountAutoPauseFenceMatchesDisk(name, automatic.fence)) return { changed: false, value: false };
    const pool = provider.apiKeyPool?.length ? provider.apiKeyPool
      : provider.apiKey ? [{ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey }] : [];
    const entry = pool.find(e => e.id === id);
    if (!entry || automatic && (entry.disabled || entry.key !== automatic.selection.reference || entry.pauseRevision !== automatic.pauseRevision
      || provider.accountAutoPause?.enabled !== true || resolveProviderApiKey(entry.key) !== automatic.resolvedKey)) return { changed: false, value: false };
    provider.apiKeyPool = pool;
    entry.disabled = paused;
    entry.pauseRevision = randomUUID();
    if (automatic) entry.pauseDetails = automatic.details;
    else delete entry.pauseDetails;
    if (paused && provider.apiKey === entry.key) {
      const next = provider.apiKeyPool?.find(e => !e.disabled);
      if (next) provider.apiKey = next.key;
      else delete provider.apiKey;
    } else if (!paused && !provider.apiKey) provider.apiKey = entry.key;
    return { changed: true, selectionChanged: true, value: true };
  }, automatic?.selection);
  return result.status === "committed" && result.value;
}
