import { credentialGeneration, getAccountCredential, getAccountCredentialWithStatus } from "../../oauth/store";
import type { ProviderQuota } from "../quota-types";

export class AnthropicQuotaProbeOwnershipError extends Error {}

/** Check live pause and bearer ownership at the last synchronous step before usage dispatch. */
export function assertAnthropicQuotaSendAllowed(accountId: string, token: string): void {
  const row = getAccountCredentialWithStatus("anthropic", accountId);
  if (!row || row.paused || row.needsReauth || row.credential.access !== token) {
    throw new AnthropicQuotaProbeOwnershipError("anthropic quota account is no longer eligible");
  }
}

const cooldownGenerationByAccount = new Map<string, number>();
let nextCooldownGeneration = 1;
let afterSettlementForTests: (() => void) | undefined;

export function setAnthropicQuotaAfterSettlementForTests(hook: (() => void) | undefined): void {
  afterSettlementForTests = hook;
}

/** Monotonic per-account fence shared by routing mutations and quota publication. */
export function anthropicCooldownGeneration(accountId: string): number {
  return cooldownGenerationByAccount.get(accountId) ?? 0;
}

/** Keep same-state quota calls joinable while moving post-429 calls to a fresh flight. */
export function anthropicCooldownFlightKey(baseKey: string, accountId: string): string {
  return `${baseKey}\0anthropic-cooldown:${anthropicCooldownGeneration(accountId)}`;
}

export function noteAnthropicCooldownMutation(accountId: string): number {
  const generation = nextCooldownGeneration++;
  cooldownGenerationByAccount.set(accountId, generation);
  return generation;
}

export function clearAnthropicCooldownGenerations(): void {
  cooldownGenerationByAccount.clear();
}

export type AnthropicCooldownRecoveryProbe = Readonly<{
  requiresFreshDispatch: boolean;
  isCurrentCredential(): boolean;
  isCurrent(): boolean;
  settle(quota: ProviderQuota): "cleared" | "retained" | "superseded";
}>;

export type AnthropicQuotaRecoveryResult = Readonly<{
  quota: ProviderQuota;
  /** Must be checked synchronously at each publication boundary. */
  isCurrent(): boolean;
}>;

/**
 * Bind a quota probe to both the credential and cooldown generations it observed before
 * dispatch. A successful response may otherwise arrive after either credential replacement
 * or a newer 429 and incorrectly make unrelated state eligible.
 */
export async function captureAnthropicCooldownRecoveryProbe(
  accountId: string,
  accessToken: string,
): Promise<AnthropicCooldownRecoveryProbe | null> {
  const credential = getAccountCredential("anthropic", accountId);
  if (!credential || credential.access !== accessToken) return null;
  const generation = credentialGeneration(credential);
  // Lazy because anthropic-routing reads the quota cache on normal request routing.
  const routing = await import("../../oauth/anthropic-routing");
  const cooldownGeneration = anthropicCooldownGeneration(accountId);
  const claim = routing.captureAnthropicCooldownRecovery(accountId);
  const isCurrentCredential = () => {
    const current = getAccountCredential("anthropic", accountId);
    return !!current && credentialGeneration(current) === generation;
  };
  return {
    requiresFreshDispatch: claim !== null,
    isCurrentCredential,
    isCurrent: () => isCurrentCredential()
      && anthropicCooldownGeneration(accountId) === cooldownGeneration,
    settle: quota => claim === null ? "retained"
      : routing.settleAnthropicCooldownRecovery(claim, quota),
  };
}

/** Run one authoritative usage read and publish its recovery effect only while still owned. */
export async function probeAnthropicQuotaWithRecovery(
  accountId: string,
  accessToken: string,
  read: (requireFreshDispatch: boolean) => Promise<ProviderQuota | null>,
  mayPublish: () => boolean,
): Promise<AnthropicQuotaRecoveryResult | null> {
  const probe = await captureAnthropicCooldownRecoveryProbe(accountId, accessToken);
  if (!probe) throw new AnthropicQuotaProbeOwnershipError("anthropic quota probe lost credential ownership");
  let quota: ProviderQuota | null;
  try { quota = await read(probe.requiresFreshDispatch); }
  catch (error) {
    if (!probe.isCurrent() || !mayPublish()) throw new AnthropicQuotaProbeOwnershipError("anthropic quota probe failure is stale");
    throw error;
  }
  if (!probe.isCurrent() || !mayPublish()) {
    throw new AnthropicQuotaProbeOwnershipError("anthropic quota probe result is stale");
  }
  if (!quota) return null;
  const settlement = probe.settle(quota);
  if (settlement === "superseded") {
    throw new AnthropicQuotaProbeOwnershipError("anthropic quota probe lost cooldown ownership");
  }
  // Clearing the claimed cooldown intentionally advances the fence. Adopt that exact new
  // generation; any later observation/429 then invalidates publication before a cache write.
  const publicationGeneration = anthropicCooldownGeneration(accountId);
  afterSettlementForTests?.();
  return {
    quota,
    isCurrent: () => probe.isCurrentCredential()
      && anthropicCooldownGeneration(accountId) === publicationGeneration
      && mayPublish(),
  };
}
