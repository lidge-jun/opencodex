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

export function clearAccountNeedsReauth(id: string): void {
  reauthAccounts.delete(id);
}
