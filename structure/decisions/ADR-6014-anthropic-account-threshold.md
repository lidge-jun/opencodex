# ADR-6014 — decision recorded under "Anthropic account thresholds"

- Contract owner: [Anthropic account thresholds](../providers/anthropic-account-thresholds.md)

## Decision Log

- Purpose and intent: Give individual Claude subscriptions an optional usage-switch policy,
  completing the second vertical slice of issue #6013 without changing manual pause semantics.
- Existing implementation and constraints: Anthropic owns its active/manual/affinity selector,
  three strategies and three quota windows. Model routes constrain the roster. The first slice
  stores pause on the OAuth account; credentials, policy changes and deletion must serialize.
- Alternatives considered: A config-side account-id map mirrors Codex but creates an auth/config
  split write and orphan cleanup problem. Hard eligibility would strand all-drained or unknown
  quota requests. Reusing the generic pool threshold would change every account.
- Selected approach: Store optional `autoSwitchThresholdOverride` on the protected OAuth row.
  Missing/null inherits the current Anthropic pool default; validate integer 0..100, retaining
  concrete zero as usage-driven switching disabled. The auth mutation lock bumps selection
  revision on changes, rejecting old admission proposals without touching credentials or health.
  A post-persistence policy event carries the exact previous/current selection revisions and runs
  before the generic selection publication. It rebases only a one-shot manual preference that
  still owns the previous revision; every ordinary selection generation clears stale ownership,
  including A→B→A. Re-login and refresh preserve metadata; account/provider deletion owns cleanup.
- Why this approach: One account-owned record provides atomic lifetime and restart persistence.
  The existing cache remains the freshness/unknown authority. Known below-threshold candidates
  are preferred using their own policy, but usage never makes an account ineligible.
  Manual/affinity and identity-less strategy fast paths keep their existing priority. Quota and
  fill-first use policy with pooling enabled; round-robin and pool-off recovery stay unchanged.
- Benefits, tradeoffs, and impact: No config migration or additional secret store. Account DTOs
  expose override/default/effective values without credentials. The dedicated PUT, explicit CLI
  `--account` and reused compact card control share the contract. Same-provider mutation ownership
  and roster generations protect GUI reads. GET and PUT both use the built-in Anthropic OAuth
  definition when the explicit provider row is absent, and each PUT response projects the value
  committed by that request instead of re-reading a later concurrent write. Focus/draft behavior
  uses existing React components with a localized Anthropic hint. The confirmed pool default lives
  in the shared account-roster state: settings reads/saves invalidate older roster generations and
  start a fresh read, so late responses cannot overwrite a save while later external changes remain
  observable. Per-account writes use the roster client's bounded, abortable request lifecycle, so an
  unmount or API-base change cannot leave mutation ownership locked. Additional auth-store reads occur
  at selection boundaries.
  Thresholds are soft preferences, not spend caps; admitted/sent requests are not cancelled.

## Verification

Focused tests cover every strategy/window, zero/inheritance, unknown/reset-expired quotas,
route scope, pool-off recovery, generation invalidation, active and non-active policy edits after
a manual selection, observer ordering, A→B→A and same-id generations, rejected persistence,
successive policy edits, refresh/pause races, restart and deletion in
`tests/adapters/anthropic/anthropic-account-threshold.test.ts`. CLI and mounted GUI tests verify
surface parity. Validation uses isolated homes, not the live proxy.
