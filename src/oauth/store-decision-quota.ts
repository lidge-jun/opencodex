/** Auth owner projects a loaded store; JEV never imports the auth-store reader. */
import { createHash } from "node:crypto";
import { publishDecisionQuotaRoster, withdrawDecisionQuotaRoster } from "../providers/quota-decision-snapshot";
import type { AuthStore } from "./store";
/** Guarded publisher for the secret-free Anthropic pool roster, never throws; the generation is a one-way digest of the credential, never the credential itself. */
export function publishAuthDecisionQuotaRoster(store: AuthStore): void {
  try { projectAuthDecisionQuotaRoster(store); }
  catch {
    // Advisory evidence must never alter auth-store loading or persistence; on failure the pool becomes unknown.
    try { withdrawDecisionQuotaRoster("anthropic"); } catch { /* best-effort; the auth store result is already decided */ }
  }
}
/** Project a loaded store into the secret-free roster; may throw, so callers go through the guarded publisher. */
function projectAuthDecisionQuotaRoster(store: AuthStore): void {
  publishDecisionQuotaRoster("anthropic", (store.anthropic?.accounts ?? []).map(row => ({
    id: row.id,
    generation: createHash("sha256").update(JSON.stringify([row.credential.refresh, row.credential.access, row.credential.expires])).digest("hex"),
    usable: row.paused !== true && row.needsReauth !== true && Boolean(row.credential.access || row.credential.refresh),
  })));
}
