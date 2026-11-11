import { detectClaudeCodeTokenAsync, hasClaudeCredentialContinuity } from "./local-token-detect";
import { normalizeAnthropicIdentity, resolveAnthropicAccountIdentity, type AnthropicIdentityResolver } from "./anthropic-identity";
import { credentialGeneration, type AuthStore } from "./store";
import { mergeOAuthPlan } from "./plan";
import { REFRESH_SKEW_MS } from "./refresh-policy";
import type { OAuthCredentials, ProviderAccountSet } from "./types";
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";

export type ClaudeCredentialObservation =
  | { kind: "absent" }
  | { kind: "unresolved" | "different"; diskGeneration: string }
  | { kind: "adopt"; credential: OAuthCredentials; diskGeneration: string };

export async function newerClaudeCredential(
  stored: OAuthCredentials, now: number, signal?: AbortSignal,
  resolveIdentity: AnthropicIdentityResolver = resolveAnthropicAccountIdentity,
): Promise<ClaudeCredentialObservation> {
  return newerClaudeCredentialForInstance("anthropic", stored, now, signal, resolveIdentity);
}

export async function newerClaudeCredentialForInstance(
  instance: AnthropicInstanceId, stored: OAuthCredentials, now: number, signal?: AbortSignal,
  resolveIdentity: AnthropicIdentityResolver = resolveAnthropicAccountIdentity,
): Promise<ClaudeCredentialObservation> {
  if (instance === "anthropic2") return { kind: "absent" };
  if (stored.source !== "local-cli") return { kind: "absent" };
  const disk = await detectClaudeCodeTokenAsync();
  if (!disk || !Number.isFinite(disk.expires) || disk.expires <= now + REFRESH_SKEW_MS
    || credentialGeneration(disk) === credentialGeneration(stored)) return { kind: "absent" };
  const diskGeneration = credentialGeneration(disk);
  const before = normalizeAnthropicIdentity(stored.anthropicIdentity, stored.access);
  if (hasClaudeCredentialContinuity(stored, disk)) {
    return { kind: "adopt", diskGeneration: credentialGeneration(disk), credential: {
      ...stored, ...disk, plan: mergeOAuthPlan(disk, stored), anthropicIdentity: disk.access === stored.access ? before : undefined,
    } };
  }
  // Independent observations share a deadline through the caller signal; neither extends the other.
  const [oldProof, newProof] = await Promise.all([
    before ?? resolveIdentity(stored.access, signal), resolveIdentity(disk.access, signal),
  ]);
  const oldIdentity = normalizeAnthropicIdentity(oldProof, stored.access);
  const newIdentity = normalizeAnthropicIdentity(newProof, disk.access);
  if (!oldIdentity || !newIdentity) return { kind: "unresolved", diskGeneration };
  if (oldIdentity.accountUuid !== newIdentity.accountUuid) return { kind: "different", diskGeneration };
  return { kind: "adopt", diskGeneration: credentialGeneration(disk), credential: {
    ...stored, ...disk, accountId: newIdentity.accountUuid, anthropicIdentity: newIdentity, plan: newProof?.plan ?? null,
  } };
}

/**
 * Fresh re-read of the Claude CLI credential for a write that depends on it. Adoption awaits it
 * inside the serialized writer (afterPrePersistRead) so a rotation while the writer was queued is
 * caught; the read is asynchronous (a Keychain lookup must never be killed, #8161), so the writer's
 * synchronous ownership predicate only consumes its result. Fails closed: a missing, unreadable,
 * near-expiry or different generation is not current.
 */
export async function claudeCredentialGenerationCurrent(diskGeneration: string, now: () => number = Date.now): Promise<boolean> {
  const disk = await detectClaudeCodeTokenAsync();
  return disk !== null && disk.expires > now() + REFRESH_SKEW_MS && credentialGeneration(disk) === diskGeneration;
}

/**
 * Capture primitives before network awaits; check them again inside the serialized writer.
 * `diskVerified` marks a write that depends on the CLI credential and carries the caller's
 * {@link claudeCredentialGenerationCurrent} result: undefined for a write that does not depend on
 * it, and false fails closed. Store-side generation and selection checks stay in the predicate.
 */
export function captureAnthropicCredentialOwner(set: ProviderAccountSet, accountId: string) {
  return captureAnthropicCredentialOwnerForInstance("anthropic", set, accountId);
}

export function captureAnthropicCredentialOwnerForInstance(instance: AnthropicInstanceId, set: ProviderAccountSet, accountId: string) {
  const row = set.accounts.find(account => account.id === accountId)!;
  const loginId = row.loginId;
  const generation = credentialGeneration(row.credential);
  const metadata = identityMetadata(row.credential);
  const needsReauth = row.needsReauth;
  const selection = { id: set.activeAccountId, revision: set.selectionRevision };
  return (store: AuthStore, diskVerified?: boolean, allowPaused = false): boolean => {
    const current = store[instance];
    const account = current?.accounts.find(candidate => candidate.id === accountId);
    if (!account || (!allowPaused && account.paused) || account.loginId !== loginId
      || account.needsReauth !== needsReauth || credentialGeneration(account.credential) !== generation
      || identityMetadata(account.credential) !== metadata) return false;
    if (diskVerified !== undefined) {
      if (instance === "anthropic2") return false;
      if (current?.activeAccountId !== selection.id || current?.selectionRevision !== selection.revision) return false;
      if (!diskVerified) return false;
    }
    return true;
  };
}

function identityMetadata(credential: OAuthCredentials): string {
  return JSON.stringify([credential.source, credential.accountId, credential.email, credential.anthropicIdentity, credential.plan]);
}
