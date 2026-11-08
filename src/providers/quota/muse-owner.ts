import { createHash } from "node:crypto";
import { getConfigDir } from "../../config/paths";
import { runPassiveReadSync } from "../../lib/passive-read";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import { credentialGeneration, getAccountSet } from "../../oauth/store";
import type { OcxConfig } from "../../types";

export interface MuseQuotaOwner {
  accountId: string;
  identity: string;
  accountKey: string;
  configIdentity?: string;
  isCurrent: () => boolean;
  isAccountCurrent: () => boolean;
  isConfigCurrent?: (config: OcxConfig) => boolean;
}

/** Non-secret stable fingerprint of the provider fields that own an observation. */
export function museQuotaConfigIdentity(config: OcxConfig, provider: string): string | undefined {
  const current = config.providers[provider];
  if (!current || current.disabled || current.authMode !== "oauth") return undefined;
  return createHash("sha256").update(JSON.stringify([current.adapter, current.baseUrl, current.authMode])).digest("hex");
}

/** Bind the caller's enabled provider and destination without retaining credentials in DTOs. */
export function bindMuseQuotaConfig(owner: MuseQuotaOwner | null, config: OcxConfig, provider: string): MuseQuotaOwner | null {
  const initial = config.providers[provider];
  if (!owner || !initial || initial.disabled || initial.authMode !== "oauth") return null;
  const adapter = initial.adapter, baseUrl = initial.baseUrl;
  const generation = captureConfigGeneration();
  let retired = false;
  const configCurrent = (candidate: OcxConfig) => {
    const current = candidate.providers[provider];
    if (current !== initial || current.disabled || current.authMode !== "oauth"
      || current.adapter !== adapter || current.baseUrl !== baseUrl) retired = true;
    return !retired;
  };
  return { ...owner, configIdentity: museQuotaConfigIdentity(config, provider), isCurrent: () => captureConfigGeneration() === generation && configCurrent(config) && owner.isCurrent(),
    isAccountCurrent: () => configCurrent(config) && owner.isAccountCurrent(), isConfigCurrent: configCurrent };
}

/** Capture the serving account and the independent operator selection without publishing a roster. */
export function captureMuseQuotaOwner(provider: string, accountId?: string, sentGeneration?: string): MuseQuotaOwner | null {
  if (provider !== "meta-muse") return null;
  const root = getConfigDir();
  const identityFor = (servingId?: string) => runPassiveReadSync(() => {
    if (getConfigDir() !== root) return null;
    const set = getAccountSet(provider);
    const account = set?.accounts.find(row => row.id === (servingId ?? set.activeAccountId));
    if (!account || account.paused || account.needsReauth || !account.credential.access
      || (accountId && account.id !== accountId)
      || (sentGeneration && credentialGeneration(account.credential) !== sentGeneration)) return null;
    const identity = createHash("sha256").update(JSON.stringify([
      root, account.id, account.loginId, account.addedAt,
      account.pauseRevision, account.paused, account.needsReauth, account.credential,
    ])).digest("hex");
    return { id: account.id, identity, selectionId: set!.activeAccountId, selectionRevision: set!.selectionRevision };
  });
  const captured = identityFor(accountId);
  if (!captured) return null;
  let retired = false;
  const currentIdentity = () => {
    if (retired) return null;
    const current = identityFor(captured.id);
    if (!current || current.identity !== captured.identity) { retired = true; return null; }
    return current;
  };
  return {
    accountId: captured.id,
    identity: captured.identity,
    accountKey: JSON.stringify([provider, captured.id, captured.identity]),
    isCurrent: () => {
      const current = currentIdentity();
      return current !== null && current.selectionId === captured.selectionId
        && current.selectionRevision === captured.selectionRevision;
    },
    isAccountCurrent: () => currentIdentity() !== null,
  };
}
