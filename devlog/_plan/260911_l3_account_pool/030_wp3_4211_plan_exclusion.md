# WP3 — #4211 keep Free-tier ChatGPT accounts out of Codex pool selection

## Where this departs from the packet, and why

The packet's recorded decision was to filter in `getEligiblePoolAccounts` at `routing.ts:1248`
"rather than in `isCodexAccountUsable`". That choice is right and was kept. But the feasibility
audit that produced it did not consider a third site, and shipping only the recorded one would have
left the feature inert for the exact case the issue reports.

A read-only subagent traced it end to end. `getEligiblePoolAccounts` is the choke point for
picking a **new** account. An account that is already the active account, or already bound to a
thread by affinity, is served straight out of `isCodexAccountSelectable`, which builds its own
predicate and never consults the eligible list. Both paths return the account without the eligible
list being built at all — affinity reuse at `routing.ts:2126`, keep-active at `:2198` — and
priority preemption cannot rescue it because every account defaults to priority 0, so
`priorityOf(eligible[0]) <= priorityOf(active)` and it returns null.

The reporter's account is precisely that account: it was paid, it was taking traffic, and then the
subscription lapsed. Filtering only the eligible list would have shipped a config key that reads
correctly and changes nothing for them.

So the filter goes where pause already goes. Pause is checked in **both** places —
`isCodexAccountSelectable` at `:1014` and the `getEligiblePoolAccounts` pool-row chain at `:1248`
— and pause is the mechanism the issue itself names as today's manual workaround. Copying its two
insertion points is the smallest change that makes the policy true.

## Decisions this lane had to make

**The main account is exempt.** `getPoolAccountPlanForSelection` withholds the main plan during a
selection-only drain so routing never reads the fenced native credential for it. A rule covering
main would therefore exclude it under ordinary routing and not under drain — the same account,
two answers. Exempting it keeps the two consistent and avoids introducing a drain-time credential
read. Confirmed by audit: `isCodexAccountPlanExcluded` returns at the `__main__` check before any
plan lookup, so no new native read exists on any routing path.

**The last remaining account still serves.** Pause fails closed: all-paused returns `{status:
"none"}`. Plan exclusion deliberately does not copy that leftover. #4211 asks for "a selection
policy, not a hard block" and for an explicit route to keep working, and stranding an operator
whose remaining accounts are all excluded is a worse outcome than serving one downgraded request.
Pausing every account remains the way to stop serving entirely. Pinned by a test.

**No `minimumPlan`.** Per the packet: ranking plans needs an ordering this repository does not
have.

**Malformed policy degrades rather than failing the parse**, matching `quotaResetNotify`, because a
hand-edited typo must not trip the backup-and-defaults repair path and wipe providers or pool
accounts. The write path rejects it and `loadConfig` warns on all three success paths, so it cannot
degrade silently.

## Out of scope

`docs-site/src/content/docs/reference/configuration/providers.md` carries the field table where
`pausedCodexAccountIds` and `codexAccountPriorities` are listed, and `codexPool.excludedPlans`
belongs beside them. That file is not in the L3 owned list, so this lane documented the key in the
Codex integration guide it does own and reports the reference-table row as a follow-up.

## Audit

Four read-only `xai/grok-4.6` subagents. Two returned **fail** and both were folded in rather than
argued with.

- **Routing (fail → pass).** Four of the eight tests would have failed. Three because a `free` plan
  is thirty-day-only and scores on the monthly window, while the fixture recorded weekly only, so
  the account scored `CODEX_UNKNOWN_USAGE_SCORE` and lost the ranking even with no policy — the
  "no policy changes nothing" tests would have passed for the wrong reason and then failed. One
  because `previewCodexAccountForRequest` takes `(threadId, config)` and was called with one
  argument. Both fixed; the per-row `Set` rebuild it also flagged was hoisted.
- **Config (fail → fixed).** The schema comment claimed `loadConfig` warns, and it did not:
  the warning had only been wired into the diagnostics array that `ocx config show --source`
  prints, not into the `warnDegraded*` helpers the proxy calls at start. Since `.catch(undefined)`
  makes a malformed policy a *successful* parse, that gap meant the proxy would start, rotate onto
  the accounts the operator meant to exclude, and print nothing.
- **Re-audit (pass).** All eight tests predicted to pass; both gates match pause; `__main__` exempt
  before any plan read; an absent `codexPool` is a total no-op.

## Verification

Local suite, typecheck, and build: NOT RUN by operator instruction. Hosted CI on the pushed head is
the evidence.
