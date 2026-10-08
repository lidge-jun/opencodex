/** Ownership captured before a physical send, independent of subsequent cooldown observations. */
import type { OAuthAccessSnapshot } from "./index";
import { credentialGeneration, getAccountSet } from "./store";
import { isAnthropicInstanceId, type AnthropicInstanceId } from "../providers/anthropic-instance-id";
import { anthropicCooldownRecoveryFor } from "../providers/quota/anthropic-cooldown-recovery";
import { captureProviderAccountQuotaEpoch } from "../providers/quota/account-cache";

export type AnthropicPhysicalSendOwnership = Readonly<{
  provider: AnthropicInstanceId;
  accountId: string;
  accessToken: string;
  generation: string;
  accountIncarnation: number;
  loginId?: string;
  addedAt?: number;
  quotaEpoch: number;
}>;

/** Namespace API: config/target admission remains with the config-aware physical caller. */
export function captureAnthropicPhysicalSendOwnership(snapshot: OAuthAccessSnapshot): AnthropicPhysicalSendOwnership | null {
  if (!isAnthropicInstanceId(snapshot.provider)) return null;
  const row = getAccountSet(snapshot.provider)?.accounts.find(account => account.id === snapshot.accountId);
  if (!row || row.paused || row.needsReauth || row.credential.access !== snapshot.accessToken
    || credentialGeneration(row.credential) !== snapshot.generation) return null;
  return Object.freeze({
    provider: snapshot.provider, accountId: snapshot.accountId,
    accessToken: snapshot.accessToken, generation: snapshot.generation,
    accountIncarnation: anthropicCooldownRecoveryFor(snapshot.provider).reserveAnthropicAccountIncarnation(snapshot.accountId),
    loginId: row.loginId, addedAt: row.addedAt,
    quotaEpoch: captureProviderAccountQuotaEpoch(snapshot.provider),
  });
}

/** Pure ownership read: never adopt or reserve the replacement account's current incarnation. */
export function anthropicPhysicalSendOwnershipIsCurrent(owner: AnthropicPhysicalSendOwnership): boolean {
  const row = getAccountSet(owner.provider)?.accounts.find(account => account.id === owner.accountId);
  return !!row && row.loginId === owner.loginId && row.addedAt === owner.addedAt
    && row.credential.access === owner.accessToken && credentialGeneration(row.credential) === owner.generation
    && anthropicCooldownRecoveryFor(owner.provider).anthropicAccountIncarnation(owner.accountId) === owner.accountIncarnation
    && captureProviderAccountQuotaEpoch(owner.provider) === owner.quotaEpoch;
}
