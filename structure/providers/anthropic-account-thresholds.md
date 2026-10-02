# Anthropic Account Thresholds

`src/oauth/anthropic-account-threshold.ts` resolves `ProviderAccount.autoSwitchThresholdOverride`
against `anthropicAccountPool.autoSwitchThreshold` (default 80). Stored integers 0..100 survive
refresh, re-login and restart. Missing/null inherits; malformed disk values normalize to absent.
`setAnthropicAccountThreshold` in `src/oauth/store.ts` serializes writes with pause, refresh and
deletion and advances selection revision when policy changes. Account deletion removes it.
`src/server/responses/request-transport.ts` re-evaluates Anthropic selection after a revision
conflict during credential resolution, with or without a model route, before physical dispatch.
The policy-only post-persistence signal runs before the generic selection event and carries exact
previous/current revisions. A pending one-shot manual choice may adopt the new revision only while
it still owns the previous one; this fences old automatic proposals without silently discarding
operator intent. Ordinary selection publications clear stale ownership, including A→B→A and
same-account revision replacement.

Management reads and writes resolve Anthropic OAuth eligibility through the same configured-or-
built-in provider definition, so a separately persisted account store remains editable when the
explicit provider row is absent. A successful write returns its validated committed override and
derived effective value directly; it never re-reads a newer concurrent mutation into the response.

`src/oauth/anthropic-routing.ts` compares quota and fill-first source/candidates against each
account's effective threshold. Zero disables usage-driven switching for that account, including
the weekly five-hour exhaustion guard. Unknown source usage does not force a switch. Existing
reset-aware last-good normalization remains the freshness authority. Known below-threshold
candidates are preferred; unknown and all-drained sets retain the legacy ranking/fallback.
Thresholds are preferences, not exclusions: model routes do not widen merely because candidates
are drained. Manual/affinity and identity-less RR/fill-first priorities remain subject to the requested
model's shared/family exhaustion evidence; unrelated family windows cannot displace them.
round-robin is not usage-driven. With pooling disabled, reactive recovery ignores stored policy.
Pause, reauthentication, cooldown and credential admission continue to take precedence over zero.

> Decision record: [ADR-6014](../decisions/ADR-6014-anthropic-account-threshold.md)

Model-scoped weekly evidence follows the [family admission contract](anthropic-account-pool.md#family-weekly-admission).
The configured quota window still determines the shared usage preference, with the requested
family's weekly counter also contributing to that preference. Numeric all-drained fallback
continues to exist; a fresh explicit upstream family rejection excludes only that family.
