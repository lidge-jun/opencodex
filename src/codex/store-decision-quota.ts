/** Credential owner publishes only loaded, secret-free pool eligibility generations. */
import { publishDecisionQuotaRoster, withdrawDecisionQuotaRoster } from "../providers/quota-decision-snapshot";
import type { CodexAccountCredentialRecord } from "../types";
/** Guarded publisher for the secret-free Codex pool roster (id, credential generation, usability), never throws; on failure the pool becomes unknown. */
export function publishCodexDecisionQuotaRoster(store: Record<string, CodexAccountCredentialRecord>): void {
  try { projectCodexDecisionQuotaRoster(store); }
  catch {
    // Advisory evidence must never alter Codex account-store loading or persistence.
    try { withdrawDecisionQuotaRoster("codex"); } catch { /* best-effort; the store result is already decided */ }
  }
}
/** Project a loaded store into the roster that advisory decision evidence is bound to; may throw, so callers go through the guarded publisher. */
function projectCodexDecisionQuotaRoster(store: Record<string, CodexAccountCredentialRecord>): void {
  publishDecisionQuotaRoster("codex", Object.entries(store).map(([id, row]) => ({
    id, generation: row.generation,
    usable: !!row.credential && row.deletedAt == null && !row.codexValidationPending && !row.lastCodexValidationTerminal,
  })));
}
