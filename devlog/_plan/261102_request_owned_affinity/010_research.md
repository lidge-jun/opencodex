# 010 — Research (#8080)

Source: Terra research task, 2026-11-02, read-only, at 6f1d3e65c.

- Ownership flag: `codexRouteCredentialOwnership` (src/server/responses/core-auth.ts) marks a forwardable
  caller bearer request-scoped.
- `poolStateEligible` (src/codex/auth-context.ts) rejects request-scoped credentials, so `affinityKey` and
  lineage are undefined and `resolveCodexAccountForThreadDetailed` receives a null key.
- Since #5019/#5024 an unpinned caller bearer makes main an ordinary round-robin candidate; a stored
  account selection materializes that stored credential. Intentional and documented in
  structure/providers/openai-tiers.md.
- Round-robin commits its pick with a null key but binds only when `commitAffinity && threadId`
  (src/codex/routing/selection.ts). With main + one stored account and sticky limit 1 the ring
  alternates; with two stored accounts it cycles main, A, B.
- Every unbound success returns `affinityAfterRelease(null, undefined)` = `new_bind/healthy`.
- Log path: `noteCodexSelectionAffinity` (pool/main-pool only) → request log → `persistedAffinityFields`
  → usage.jsonl via `KNOWN_AFFINITY_MOVES/REASONS` (src/usage/log.ts). No exhaustive Record over the
  unions; GUI does not render these values.
- Options weighed: opt-in process-local namespace (chosen); always serve main (contradicts #5019);
  raise sticky limit (shared counter, not affinity); omit label only (honest but uninformative).
