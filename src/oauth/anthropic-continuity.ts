import { detectClaudeCodeToken, hasClaudeCredentialContinuity } from "./local-token-detect";
import { normalizeAnthropicIdentity, resolveAnthropicAccountIdentity, type AnthropicIdentityResolver } from "./anthropic-identity";
import { credentialGeneration, type AuthStore } from "./store";
import { REFRESH_SKEW_MS } from "./refresh-policy";
import type { OAuthCredentials, ProviderAccountSet } from "./types";

export type ClaudeCredentialObservation =
  | { kind: "absent" }
  | { kind: "unresolved" | "different"; diskGeneration: string }
  | { kind: "adopt"; credential: OAuthCredentials; diskGeneration: string };

export async function newerClaudeCredential(
  stored: OAuthCredentials, now: number, signal?: AbortSignal,
  resolveIdentity: AnthropicIdentityResolver = resolveAnthropicAccountIdentity,
): Promise<ClaudeCredentialObservation> {
  if (stored.source !== "local-cli") return { kind: "absent" };
  const disk = detectClaudeCodeToken();
  if (!disk || !Number.isFinite(disk.expires) || disk.expires <= now + REFRESH_SKEW_MS
    || credentialGeneration(disk) === credentialGeneration(stored)) return { kind: "absent" };
  const diskGeneration = credentialGeneration(disk);
  const before = normalizeAnthropicIdentity(stored.anthropicIdentity, stored.access);
  if (hasClaudeCredentialContinuity(stored, disk)) {
    return { kind: "adopt", diskGeneration: credentialGeneration(disk), credential: {
      ...stored, ...disk, anthropicIdentity: disk.access === stored.access ? before : undefined,
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
    ...stored, ...disk, accountId: newIdentity.accountUuid, anthropicIdentity: newIdentity,
  } };
}

/** Capture primitives before network awaits; check them again inside the serialized writer. */
export function captureAnthropicCredentialOwner(set: ProviderAccountSet, accountId: string) {
  const row = set.accounts.find(account => account.id === accountId)!;
  const loginId = row.loginId;
  const generation = credentialGeneration(row.credential);
  const metadata = identityMetadata(row.credential);
  const needsReauth = row.needsReauth;
  const selection = { id: set.activeAccountId, revision: set.selectionRevision };
  return (store: AuthStore, diskGeneration?: string, allowPaused = false): boolean => {
    const current = store["anthropic"];
    const account = current?.accounts.find(candidate => candidate.id === accountId);
    if (!account || (!allowPaused && account.paused) || account.loginId !== loginId
      || account.needsReauth !== needsReauth || credentialGeneration(account.credential) !== generation
      || identityMetadata(account.credential) !== metadata) return false;
    if (diskGeneration !== undefined) {
      if (current?.activeAccountId !== selection.id || current?.selectionRevision !== selection.revision) return false;
      const disk = detectClaudeCodeToken();
      if (!disk || disk.expires <= Date.now() + REFRESH_SKEW_MS || credentialGeneration(disk) !== diskGeneration) return false;
    }
    return true;
  };
}

function identityMetadata(credential: OAuthCredentials): string {
  return JSON.stringify([credential.source, credential.accountId, credential.email, credential.anthropicIdentity]);
}
