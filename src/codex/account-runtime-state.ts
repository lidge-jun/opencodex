import { captureConfigGeneration, type GenerationContext } from "../lib/state-store-sweeper";
import { isCodexAccountGenerationLive } from "./account-store";

/**
 * Accounts quarantined for reauthentication, each remembering WHICH credential produced the
 * evidence (#2892 gap 4).
 *
 * A 401 describes one credential, not an account. Recording only the id let a 401 raced by a
 * cross-process credential replacement quarantine the replacement: the flag outlived the credential
 * it was evidence about, and routing then refused a perfectly good credential until a restart. A
 * post-write re-read cannot fix that — the replacement may land at any point after the write — so
 * the generation travels WITH the flag and is checked when the flag is read.
 *
 * `undefined` means "no credential generation was supplied", which stays account-wide: callers such
 * as a login flow have no specific credential in hand, and their quarantine must not silently expire.
 */
const reauthAccounts = new Map<string, number | undefined>();
let lastReconciledGeneration = 0;
let liveAccountIds = new Set<string>();
/**
 * Fingerprint of the native-main refresh grant the token endpoint itself refused.
 *
 * A main quarantine is deliberately overridable by the presence of a refresh grant
 * ({@link import("./main-account").hasMainAccountRefreshGrant}), because a bare WHAM 401 can
 * quarantine a credential the next refresh would have fixed. A grant the token endpoint answered
 * with `invalid_grant` can fix nothing, so it must stop vouching for the account — otherwise a
 * revoked session is rediscovered by an upstream round trip on every single request.
 *
 * A fingerprint, never a token, and never the account id: a replacement credential written by
 * login, reauth, or another process carries a different grant and makes this verdict inert.
 */
let deadMainRefreshGrant: string | undefined;

/** `undefined` retracts the verdict: a refresh that succeeded proved the grant is alive. */
export function setMainRefreshGrantDead(fingerprint: string | undefined): void {
  deadMainRefreshGrant = fingerprint;
}

export function isMainRefreshGrantDead(fingerprint: string): boolean {
  return deadMainRefreshGrant === fingerprint;
}

export function markAccountNeedsReauth(
  id: string,
  writerGeneration = captureConfigGeneration(),
  credentialGeneration?: number,
): void {
  if (writerGeneration < lastReconciledGeneration && !liveAccountIds.has(id)) return;
  // An account-wide mark supersedes a generation-scoped one: it is the stronger claim.
  if (credentialGeneration === undefined || !reauthAccounts.has(id)) {
    reauthAccounts.set(id, credentialGeneration);
    return;
  }
  const existing = reauthAccounts.get(id);
  if (existing === undefined) return;
  reauthAccounts.set(id, Math.max(existing, credentialGeneration));
}

export function reconcileCodexReauthState(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  let removed = 0;
  for (const id of [...reauthAccounts.keys()]) {
    if (context.codexAccountIds.has(id)) continue;
    reauthAccounts.delete(id);
    removed += 1;
  }
  liveAccountIds = new Set(context.codexAccountIds);
  lastReconciledGeneration = context.generation;
  return removed;
}

export function isAccountNeedsReauth(id: string): boolean {
  if (!reauthAccounts.has(id)) return false;
  const credentialGeneration = reauthAccounts.get(id);
  if (credentialGeneration === undefined) return true;
  // The credential this evidence describes is gone, so the evidence is spent. Drop it rather than
  // re-deriving the same answer on every read.
  if (!isCodexAccountGenerationLive(id, credentialGeneration)) {
    reauthAccounts.delete(id);
    return false;
  }
  return true;
}

export function clearAccountNeedsReauth(id: string, credentialGeneration?: number): void {
  // A model response proves only the credential it used. Keep account-wide
  // quarantine and evidence from another generation intact.
  if (credentialGeneration !== undefined
    && (reauthAccounts.get(id) !== credentialGeneration
      || !isCodexAccountGenerationLive(id, credentialGeneration))) return;
  reauthAccounts.delete(id);
  // The dead-grant verdict deliberately SURVIVES this. It is a fact about one refresh token, not
  // about the quarantine that accompanied it, and it already self-invalidates by fingerprint when
  // the credential is replaced. Retracting it here let the WHAM probe's explicit-refresh clear
  // (#327) -- which `ocx account list` and an open dashboard both trigger -- hand a grant upstream
  // had already refused back to routing, and the probe's own re-mark could not stop it: with a
  // grant apparently alive, `hasMainAccountRefreshGrant` cancels the quarantine. Every look at the
  // dashboard bought another upstream 401.
}
