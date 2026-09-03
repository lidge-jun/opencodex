# wp3 closeout: every parity surface, closed or recorded

Terminal record for the unit. `001` §C listed the gaps; this dispositions each one against the
tree as it stands after wp1 and wp2.

## Closed with a diff

| # | Surface | What changed | Where |
|---|---|---|---|
| 1-3 | per-account quota read, write, and `?quota=1` enrichment | passive parser, cache, observation seam, cache-only API read | wp1 (#3358) |
| 4 | observation age | `QuotaBars` renders it for passive providers only | wp2 (#3359) |
| 6 | provider note | now states that the windows ARE read, that they can be stale, and where they are absent | `src/providers/registry.ts` |
| 7 | docs-site | same correction, English source | `docs-site/src/content/docs/guides/providers.md` |
| 8 | `ocx account refresh meta-muse` | said "no quota report available", which reads as a failed probe; now explains that nothing is probed and how to update the value. **Behaviour unchanged** — no command may spend an inference turn to refresh a quota (c4) | `src/cli/account-extended.ts` |
| 9 | `skills/ocx` | new recipe 9 covering the read, the staleness, both expected absences, and the connection-test answer | `skills/ocx/references/03_recipes.md` |
| — | `ocx account strategy` help text | claimed "`anthropic` is the only OAuth pool with this setting; other OAuth providers are refused without a round-trip". `001` showed that is wrong: generic providers reach the endpoint and their settings persist inertly | `src/cli/capabilities.ts` |

## Recorded NOT-APPLICABLE, with the measured reason

Each of these differs from a first-class provider because of a **measured property of Meta's API**,
not because the work was skipped.

| Surface | Reason | Evidence |
|---|---|---|
| Connection test | `liveModels === false` short-circuits to `{ applicable: false, reason: "static_catalog" }` before any network call. The flag is deliberate: the authenticated roster carries `muse-image-1.0` and `muse-voice-transcribe-1.0`, which a Responses-agent provider cannot drive. `kiro` is the same class | `provider-routes.ts:1195`; `registry.ts:1538`; `003` §C |
| Provider-level overview card | **Option (b) was taken here and OVERRULED by the owner on the live dashboard** — see `040_wp4_provider_level_quota.md`. The rebuttal was already in the tree: `fetchAnthropicQuota` and `fetchKiroQuota` answer the provider row with the ACTIVE account's usage, so provider level in this dashboard means "the account in use", and a per-subscription window is exactly the right quantity. Implemented as option (a): the row is the active account's last observation, cache-only | `040`; `quota.ts` `fetchPassiveProviderQuota` |
| 401 replay (`FORCE_REFRESH_PROVIDERS`) | the credential is a static API key — the OAuth `access_token` 401s while the sibling `api_key` returns 200 — so a replay would resend an identical credential | `src/oauth/index.ts:540`; `003` §B |
| Background refresh | `defaultRefreshPolicy: "disabled"`, the same posture as `anthropic`: the vendor restricts use outside its own client, so every exchange stays attributable to a user action | `src/oauth/index.ts:240` |
| Account import | `ACCOUNT_IMPORT_PROVIDER` is a cockpit-tools document format with no Meta analogue | `src/oauth/account-import/types.ts:3` |
| `clear-cooldown` | anthropic-only because the generic failover health map is process-local. A provider-WIDE gap, not a Muse gap; fixing it here would land untested for its other providers | `oauth-account-routes.ts:465`; `generic-account-failover.ts:78` |
| GUI generic pool card | no dashboard editor exists for ANY generic OAuth provider | `ProviderAuthPanel.tsx:353` |
| Translated-path quota | `openai-responses.ts` dispatches on `payload.type` through a switch with no case for the event, so a translated turn drops it. Now stated in the provider note and the docs rather than left silent | `004` Q3 |
| Quota-aware cooldown | `030` §7 and `001` §B originally said wp1 would arm this. **That was wrong** and is corrected here: `exhaustedCooldownMs` returns null unless the provider is `kiro`, so a Muse 429 still gets Retry-After or the 60s default. Only pre-dispatch RANKING arms | `account-quota-rank.ts:102` |

The last row is the one worth reading twice. It was an over-claim in this unit's own roadmap,
caught at review, and it would have shipped in a PR description as a capability that does not
exist.

## The routing change, and why it is bounded

wp1's cache arms headroom-ranked pre-dispatch selection for a user with two or more Muse accounts.
That is desirable — it is part of what "first-class" means — but only inside the two guards wp1
added, both of which closed review blockers:

- **Staleness:** passive rows older than an hour return "no evidence", so a stale roster degrades
  to today's unranked ring rather than to a confidently wrong preference.
- **Partial rosters:** a probe fills every account at once; an observation fills one at a time.
  Since `RANK_UNKNOWN` sorts after `RANK_HEALTHY`, one observed account at 100% would otherwise
  outrank N unmeasured ones — the exact inversion ranking exists to prevent.

## Terminal outcome

`DONE`. Every row in `001` §C is closed with a diff or recorded above with its measured reason,
and no user-facing text claims OpenCodex cannot read a value it now reads.
