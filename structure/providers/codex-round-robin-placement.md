# Codex Round-Robin Placement

`accountPoolStrategy: "round-robin"` uses the effective per-account `autoSwitchThreshold` only when it
places a conversation that has no live binding. The threshold resolution itself is described under
[per-account auto-switch thresholds](openai-accounts.md#per-account-auto-switch-thresholds).

## Placement prefers headroom

`pickUnboundStrategyAccount` in `src/codex/routing/selection.ts` narrows the eligible list to accounts
that pass `hasCodexQuotaHeadroom` before it calls the ring, for the committed pick and the preview
peek alike, so `previewCodexAccountForRequest` names the account the next placement takes. When no
eligible account passes, the ring receives the full eligible list, so the threshold is a placement
preference and never eligibility.

`hasCodexQuotaHeadroom` is the score fill-first, reset-first and the priority-tier filter already use:
`computeCodexUsageScore` (the hottest known weekly or 30-day window, refined by an unexpired short
window) against `getEffectiveCodexAutoSwitchThreshold`. Usage at or over the threshold has no
headroom; a threshold of 0 and unknown usage count as headroom.

The narrowing runs after eligibility, so it composes with every existing pool boundary: quota-scope
cooldowns, the model-eligible roster of a model detour, the priority tier (a hot member of the top
tier is skipped rather than the tier descended), and plan, pause and credit exclusions. The ring and its
sticky count stay keyed per quota scope through `codexPoolKeyForScope`. A sticky account that crosses
the threshold drops out of the list the ring sees, which releases it for the next placement; it rejoins
rotation once its usage is back under the threshold.

An operator's unspent manual selection for the scope stays in the list whatever its usage
(`unspentManualPreference` in `src/codex/routing/active-account.ts`). Manual selection seeds the shared
ring and each independent quota-scope ring, and records a one-shot for each of them, so the next
placement in every scope lands on the chosen account; dropping that account here would clear the seed
and let a preference overrule an explicit choice. A successful dispatch in a scope spends that scope's
one-shot, after which the account is narrowed like any other there. Only the shared one-shot guards the
shared active cursor (`manualPreferenceBlocks`).

## What does not move

Bound conversations never reach the narrowing. Round-robin reuses a live binding past the threshold
(`reevaluateAffinityQuota` in `src/codex/routing.ts` re-scores only `quota` and `reset-first`) and releases
it only on cooldown, quota refusal, failover, pause or another selectability guard; the re-placement that
follows goes through the same narrowing. Failover alternates (`pickAlternateCodexAccount` and its peek)
keep plain ring order, because leaving a failing account is not a placement. Idle-window steering and the
lineage first-placement hint run before the strategy: idle-window steering already requires headroom,
and a child of a live conversation starts on the account its parent is being served from.

`tests/codex-integration/codex-round-robin-headroom.test.ts` covers placement, the at-threshold edge,
all-over fallback, per-account and zero thresholds, unknown usage, Reserve, sticky release and re-entry,
preview agreement, cooldown re-placement, the priority tier, and the bound, failover, model-roster and
lineage boundaries.
