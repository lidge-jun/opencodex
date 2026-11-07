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
  isCurrent: () => boolean;
  isAccountCurrent: () => boolean;
}

/** Bind the caller's enabled provider and destination without retaining credentials in DTOs. */
export function bindMuseQuotaConfig(owner: MuseQuotaOwner | null, config: OcxConfig, provider: string): MuseQuotaOwner | null {
  const initial = config.providers[provider];
  if (!owner || !initial || initial.disabled || initial.authMode !== "oauth") return null;
  const adapter = initial.adapter, baseUrl = initial.baseUrl;
  const generation = captureConfigGeneration();
  const configCurrent = () => {
    const current = config.providers[provider];
    return captureConfigGeneration() === generation && current === initial && !current.disabled && current.authMode === "oauth"
      && current.adapter === adapter && current.baseUrl === baseUrl;
  };
  return { ...owner, isCurrent: () => configCurrent() && owner.isCurrent(),
    isAccountCurrent: () => configCurrent() && owner.isAccountCurrent() };
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
  return {
    accountId: captured.id,
    identity: captured.identity,
    accountKey: JSON.stringify([provider, captured.id, captured.identity]),
    isCurrent: () => {
      const current = identityFor(captured.id);
      return current?.identity === captured.identity && current.selectionId === captured.selectionId
        && current.selectionRevision === captured.selectionRevision;
    },
    isAccountCurrent: () => identityFor(captured.id)?.identity === captured.identity,
  };
}
