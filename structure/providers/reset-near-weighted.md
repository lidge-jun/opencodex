# Reset-near-weighted Account Ordering

`src/routing/machine-weighted-routing.ts` defines the opt-in reset preference for Codex and
Anthropic account pools. A target needs a future weekly reset within 24 hours, five-hour usage
below 60%, and more than 2% weekly quota remaining. Both observations must be at most 15 minutes old.
The qualifying account with the nearest reset receives weight N−1. Other ring members receive
weight 1. Equal reset times are ordered by account ID. Without a qualifying account, every member
receives weight 1. When weights become equal, `src/oauth/pool-kernel.ts` clears accumulated
weighted scores before continuing the ring. Both pools honor existing eligibility, session affinity,
and the sticky limit.

`src/codex/routing/selection.ts` applies the preference after the
[round-robin placement headroom check](codex-round-robin-placement.md) for new assignments.
Independent quota scopes use equal round-robin weights. `src/codex/quota-observation-freshness.ts`
provides the per-window clocks for shared quota. Codex uses a short quota reading for weighting
only when its reported duration is exactly five hours.

`src/oauth/anthropic-routing.ts` ranks candidates for the eligible instance and model route. A
keyless turn keeps the healthy active account without advancing the weighted ring. The strategy
uses fixed usage cutoffs. `src/providers/quota/account-cache.ts` stamps separate clocks for the
shared five-hour and weekly bars on account and provider refresh. Both clocks belong to the
credential revision that supplied their readings. In both pools, carrying a bar forward during a partial update
preserves its original observation time. An Anthropic probe that only retires monthly extra usage
keeps those clocks for unchanged plan bars that still belong to the current credential.
Hydrated display snapshots lack live observation clocks.
