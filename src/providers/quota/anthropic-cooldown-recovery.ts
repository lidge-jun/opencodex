import { mergeAnthropicFamilyWindows, hasAnthropicFamilyEnumeration } from "./anthropic-family-headers";
import { getCachedProviderAccountQuota, captureProviderAccountQuotaEpoch } from "./account-cache";
import { anthropicModelQuotaFor } from "../../oauth/anthropic-model-quota";
import type { AnthropicInstanceId } from "../anthropic-instance-id";
import type { GenerationContext } from "../../lib/state-store-sweeper";
import { credentialGeneration, getAccountCredential, getAccountCredentialWithStatus, getAccountSet } from "../../oauth/store";
import type { ProviderQuota } from "../quota-types";

export class AnthropicQuotaProbeOwnershipError extends Error {}

export type AnthropicCooldownRecoveryProbe = Readonly<{
  instance: AnthropicInstanceId;
  requiresFreshDispatch: boolean;
  isCurrentCredential(): boolean;
  isCurrentFamily(): boolean;
  isCurrent(): boolean;
  settle(quota: ProviderQuota): "cleared" | "retained" | "superseded";
}>;

export type AnthropicQuotaRecoveryResult = Readonly<{
  instance: AnthropicInstanceId;
  quota: ProviderQuota;
  /** Must be checked synchronously at each publication boundary. */
  isCurrent(): boolean;
}>;

function createAnthropicCooldownRecovery(instance: AnthropicInstanceId) {
  const familyGeneration = (accountId: string) => anthropicModelQuotaFor(instance).anthropicFamilyQuotaGeneration(accountId);

  /** Check live pause and bearer ownership at the last synchronous step before usage dispatch. */
  function assertAnthropicQuotaSendAllowed(accountId: string, token: string): void {
    const row = getAccountCredentialWithStatus(instance, accountId);
    if (!row || row.paused || row.needsReauth || row.credential.access !== token) {
      throw new AnthropicQuotaProbeOwnershipError(`${instance} quota account is no longer eligible`);
    }
  }

  let cooldownGenerationByAccount: Map<string, number> | undefined;
  let emptyGeneration = 0;
  let nextCooldownGeneration = 1;
  // Account lifetime is distinct from refusal/probe mutations; a valid refusal must not revoke itself.
  let accountIncarnations: Map<string, number> | undefined;
  let emptyAccountIncarnation = 0;
  let nextAccountIncarnation = 1;
  let afterSettlementForTests: (() => void) | undefined;

  function setAnthropicQuotaAfterSettlementForTests(hook: (() => void) | undefined): void {
    afterSettlementForTests = hook;
  }

  /** Monotonic per-account fence shared by routing mutations and quota publication. */
  function anthropicCooldownGeneration(accountId: string): number {
    return cooldownGenerationByAccount?.get(accountId) ?? emptyGeneration;
  }

  /** Keep same-state quota calls joinable while moving post-429 calls to a fresh flight. */
  function anthropicCooldownFlightKey(baseKey: string, accountId: string): string {
    // Flight reservation establishes an incarnation even without prior refusal evidence.
    const generation = reserveCooldownGeneration(accountId);
    return `${baseKey}\0${instance}-cooldown:${generation}`;
  }

  /** Active usage readers bind this key after token refresh; renewal keeps the legacy flight valid. */
  function anthropicCredentialQuotaFlightKey(baseKey: string, accountId: string): string {
    const row = getAccountSet(instance)?.accounts.find(row => row.id === accountId);
    return `${anthropicCooldownFlightKey(baseKey, accountId)}\0${row ? JSON.stringify([credentialGeneration(row.credential), row.loginId, row.addedAt]) : "missing"}`;
  }

  function reserveCooldownGeneration(accountId: string): number {
    return cooldownGenerationByAccount?.get(accountId) ?? noteAnthropicCooldownMutation(accountId);
  }

  function noteAnthropicCooldownMutation(accountId: string): number {
    const generation = nextCooldownGeneration++;
    (cooldownGenerationByAccount ??= new Map()).set(accountId, generation);
    return generation;
  }

  function anthropicAccountIncarnation(accountId: string): number {
    return accountIncarnations?.get(accountId) ?? emptyAccountIncarnation;
  }

  function reserveAnthropicAccountIncarnation(accountId: string): number {
    const existing = accountIncarnations?.get(accountId);
    if (existing !== undefined) return existing;
    const incarnation = nextAccountIncarnation++;
    (accountIncarnations ??= new Map()).set(accountId, incarnation);
    return incarnation;
  }

  function clearAnthropicCooldownGenerations(): void {
    emptyGeneration = nextCooldownGeneration++;
    cooldownGenerationByAccount = undefined;
    emptyAccountIncarnation = nextAccountIncarnation++;
    accountIncarnations = undefined;
  }

  /**
   * Bind a quota probe to both the credential and cooldown generations it observed before
   * dispatch. A successful response may otherwise arrive after either credential replacement
   * or a newer 429 and incorrectly make unrelated state eligible.
   */
  async function captureAnthropicCooldownRecoveryProbe(
    accountId: string,
    accessToken: string,
  ): Promise<AnthropicCooldownRecoveryProbe | null> {
    const credential = getAccountCredential(instance, accountId);
    if (!credential || credential.access !== accessToken) return null;
    const generation = credentialGeneration(credential);
    const incarnation = reserveAnthropicAccountIncarnation(accountId);
    const quotaEpoch = captureProviderAccountQuotaEpoch(instance);
    const initialRow = getAccountSet(instance)?.accounts.find(row => row.id === accountId);
    if (!initialRow || initialRow.paused || initialRow.needsReauth || credentialGeneration(initialRow.credential) !== generation) return null;
    // Lazy because anthropic-routing reads the quota cache on normal request routing.
    const { anthropicRoutingFor } = await import("../../oauth/anthropic-routing");
    const routing = anthropicRoutingFor(instance);
    const live = getAccountCredential(instance, accountId);
    if (!live || credentialGeneration(live) !== generation) return null;
    const cooldownGeneration = reserveCooldownGeneration(accountId);
    const capturedFamilyGeneration = anthropicModelQuotaFor(instance).captureAnthropicFamilyQuotaGeneration(accountId);
    const claim = routing.captureAnthropicCooldownRecovery(accountId);
    const isCurrentCredential = () => {
      const currentRow = getAccountSet(instance)?.accounts.find(row => row.id === accountId);
      const current = currentRow?.credential;
      return quotaEpoch === captureProviderAccountQuotaEpoch(instance)
        && anthropicAccountIncarnation(accountId) === incarnation
        && currentRow?.loginId === initialRow?.loginId && currentRow?.addedAt === initialRow?.addedAt
        && !!current && credentialGeneration(current) === generation;
    };
    return {
      instance,
      requiresFreshDispatch: claim !== null,
      isCurrentCredential,
      isCurrentFamily: () => familyGeneration(accountId) === capturedFamilyGeneration,
      isCurrent: () => isCurrentCredential()
        && anthropicCooldownGeneration(accountId) === cooldownGeneration,
      settle: quota => !isCurrentCredential() || anthropicCooldownGeneration(accountId) !== cooldownGeneration ? "superseded"
        : claim === null ? "retained" : routing.settleAnthropicCooldownRecovery(claim, quota),
    };
  }

  /** Run one authoritative usage read and publish its recovery effect only while still owned. */
  async function probeAnthropicQuotaWithRecovery(
    accountId: string,
    accessToken: string,
    read: (requireFreshDispatch: boolean) => Promise<ProviderQuota | null>,
    mayPublish: () => boolean,
  ): Promise<AnthropicQuotaRecoveryResult | null> {
    const probe = await captureAnthropicCooldownRecoveryProbe(accountId, accessToken);
    if (!probe) throw new AnthropicQuotaProbeOwnershipError(`${instance} quota probe lost credential ownership`);
    if (!probe.isCurrent() || !mayPublish()) throw new AnthropicQuotaProbeOwnershipError(`${instance} quota probe lost dispatch ownership`);
    let quota: ProviderQuota | null;
    try { quota = await read(probe.requiresFreshDispatch); }
    catch (error) {
      if (!probe.isCurrent() || !mayPublish()) throw new AnthropicQuotaProbeOwnershipError(`${instance} quota probe failure is stale`);
      throw error;
    }
    if (!probe.isCurrent() || !mayPublish()) {
      throw new AnthropicQuotaProbeOwnershipError(`${instance} quota probe result is stale`);
    }
    if (!quota) return null;
    const settlement = probe.settle(quota);
    if (settlement === "superseded") {
      throw new AnthropicQuotaProbeOwnershipError(`${instance} quota probe lost cooldown ownership`);
    }
    // Clearing the claimed cooldown intentionally advances the fence. Adopt that exact new
    // generation; any later observation/429 then invalidates publication before a cache write.
    const ownsFamily = probe.isCurrentFamily();
    const authoritative = ownsFamily && hasAnthropicFamilyEnumeration(quota);
    if (ownsFamily) anthropicModelQuotaFor(instance).observeAnthropicFamilyQuota(accountId, quota.customWindows ?? [], quota.updatedAt, authoritative);
    if (!authoritative) {
      const cached = getCachedProviderAccountQuota(instance, accountId)?.customWindows;
      const windows = ownsFamily ? mergeAnthropicFamilyWindows(cached, quota.customWindows)
        : cached ?? [];
      // A superseded family enumeration has no authority, including over absent families.
      if (!ownsFamily || windows.length) quota = { ...quota, customWindows: windows };
    }
    const publicationGeneration = anthropicCooldownGeneration(accountId);
    const publicationFamilyGeneration = familyGeneration(accountId);
    afterSettlementForTests?.();
    return {
      instance,
      quota,
      isCurrent: () => probe.isCurrentCredential()
        && anthropicCooldownGeneration(accountId) === publicationGeneration
        && familyGeneration(accountId) === publicationFamilyGeneration
        && mayPublish(),
    };
  }

  function reconcileAnthropicCooldownGenerations(context: GenerationContext): number {
    // Probe reservations include accounts with no cooldown, so every claim retires here.
    for (const id of cooldownGenerationByAccount?.keys() ?? []) {
      if (!context.oauthAccountKeys.has(`${instance}\0${id}`)) noteAnthropicCooldownMutation(id);
    }
    for (const id of accountIncarnations?.keys() ?? []) {
      if (!context.oauthAccountKeys.has(`${instance}\0${id}`)) accountIncarnations!.set(id, nextAccountIncarnation++);
    }
    return 0; // Tombstones are retained, never reclaimed into an older generation.
  }
  return Object.freeze({ instance, assertAnthropicQuotaSendAllowed, setAnthropicQuotaAfterSettlementForTests,
    anthropicCooldownGeneration, anthropicCooldownFlightKey, anthropicCredentialQuotaFlightKey, noteAnthropicCooldownMutation,
    anthropicAccountIncarnation, reserveAnthropicAccountIncarnation,
    clearAnthropicCooldownGenerations, captureAnthropicCooldownRecoveryProbe,
    probeAnthropicQuotaWithRecovery, reconcileAnthropicCooldownGenerations });
}
export type AnthropicCooldownRecovery = ReturnType<typeof createAnthropicCooldownRecovery>;
const instances = new Map<AnthropicInstanceId, AnthropicCooldownRecovery>();
export function anthropicCooldownRecoveryFor(instance: AnthropicInstanceId): AnthropicCooldownRecovery {
  let facade = instances.get(instance);
  if (!facade) { facade = createAnthropicCooldownRecovery(instance); instances.set(instance, facade); }
  return facade;
}
export function reconcileAllAnthropicCooldownGenerations(context: GenerationContext): number {
  for (const facade of instances.values()) facade.reconcileAnthropicCooldownGenerations(context);
  return 0;
}
export function clearAllAnthropicCooldownGenerations(): void {
  for (const facade of instances.values()) facade.clearAnthropicCooldownGenerations();
}
export function assertAnthropicQuotaSendAllowed(accountId: string, token: string): void {
  anthropicCooldownRecoveryFor("anthropic").assertAnthropicQuotaSendAllowed(accountId, token);
}
export function setAnthropicQuotaAfterSettlementForTests(hook: (() => void) | undefined): void {
  anthropicCooldownRecoveryFor("anthropic").setAnthropicQuotaAfterSettlementForTests(hook);
}
export function anthropicCooldownGeneration(accountId: string): number {
  return anthropicCooldownRecoveryFor("anthropic").anthropicCooldownGeneration(accountId);
}
export function anthropicCooldownFlightKey(baseKey: string, accountId: string): string {
  return anthropicCooldownRecoveryFor("anthropic").anthropicCooldownFlightKey(baseKey, accountId);
}
export function noteAnthropicCooldownMutation(accountId: string): number {
  return anthropicCooldownRecoveryFor("anthropic").noteAnthropicCooldownMutation(accountId);
}
export function clearAnthropicCooldownGenerations(): void {
  anthropicCooldownRecoveryFor("anthropic").clearAnthropicCooldownGenerations();
}
export function captureAnthropicCooldownRecoveryProbe(accountId: string, accessToken: string): Promise<AnthropicCooldownRecoveryProbe | null> {
  return anthropicCooldownRecoveryFor("anthropic").captureAnthropicCooldownRecoveryProbe(accountId, accessToken);
}
export function probeAnthropicQuotaWithRecovery(
  accountId: string, accessToken: string,
  read: (requireFreshDispatch: boolean) => Promise<ProviderQuota | null>, mayPublish: () => boolean,
): Promise<AnthropicQuotaRecoveryResult | null> {
  return anthropicCooldownRecoveryFor("anthropic").probeAnthropicQuotaWithRecovery(accountId, accessToken, read, mayPublish);
}
