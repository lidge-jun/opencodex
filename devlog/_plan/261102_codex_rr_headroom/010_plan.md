# 010 — Codex round-robin places new conversations on accounts with headroom

Lane C of the multi-account parallel lanes. Branch `goat/lane-c-codex-rr-threshold`, PR target `dev`.

## Problem

`accountPoolStrategy: "round-robin"` rotates unbound (new) Codex conversations by counter only.
`pickUnboundStrategyAccount` (src/codex/routing/selection.ts) hands `listEligibleCodexAccountIds`
straight to `pickRoundRobinAccount` / `peekRoundRobinAccount`. A new conversation can therefore land
on an account already at 95%. The conversation binds there (thread affinity), and when the account
reaches 100% the binding is released and the conversation moves to another account with a cold
prompt cache.

## Finding that changes the brief

The brief says the Claude pool's round-robin already skips accounts over `autoSwitchThreshold` for new
sessions. On current `dev` it does not: `src/oauth/anthropic-routing.ts` `pickUnboundStrategyAccount`
filters only `anthropicModelExhausted` (model family at 100%), and the docs say Claude round-robin is
not usage-driven (docs-site providers-accounts.md, structure/providers/anthropic-account-thresholds.md).
The "prefer under threshold, fall back when none" rule lives in Claude's `pickLowestUsage`
("Thresholds are preferences, never eligibility"). This lane models the Codex rule on that idea and
leaves Claude routing code alone (out of lane scope). The PR body states this.

## Design (diff level)

src/codex/routing/selection.ts only.

1. New private helper next to `hasCodexQuotaHeadroom`:

   ```ts
   function roundRobinPlacementCandidates(config, eligible, now, selectionOptions): readonly string[] {
     const withHeadroom = eligible.filter(id => hasCodexQuotaHeadroom(config, id, selectionOptions, now));
     return withHeadroom.length > 0 ? withHeadroom : eligible;
   }
   ```

2. `pickUnboundStrategyAccount`, round-robin branch: compute `eligible` as today, then
   `const candidates = roundRobinPlacementCandidates(...)` and pass `candidates` to BOTH
   `peekRoundRobinAccount` (commit=false, preview) and `pickRoundRobinAccount` (commit=true). Everything
   after the pick (shared-active commit, `bindThreadAffinity`, `notePoolRotationSuccess`) is unchanged.

Why this predicate: `hasCodexQuotaHeadroom` is the score server-side threshold evaluation already uses
for fill-first, reset-first, the priority-tier filter, pin drain and the bound-thread cache-safe
replacement: `computeCodexUsageScore` (hottest known 5h/weekly/30d window, credits cap at 99) against
`getEffectiveCodexAutoSwitchThreshold` (per-account override, use-remaining = 0, else global, default 80).
"At or over" = `usage >= threshold` is not headroom. Threshold 0 = always headroom (switching disabled).
Unknown usage (unprimed) = headroom, same as fill-first and the tier filter.

Scope/pool interactions:
- Quota scopes (shared / reserve): `eligible` is already scope-filtered (cooldowns per scope) and the ring
  is keyed per scope (`codexPoolKeyForScope`). Usage score is the account-level quota for every scope, as
  for every other Codex usage decision (quota strategy, fill-first, tier filter). No scope-specific usage
  store exists.
- Model detours: `strategySelectionOptionsForModelDetour` narrows `modelEligibleAccountIds` before
  eligibility; the headroom filter only narrows that further and falls back to it.
- Priority tiers: `selectPriorityTier` already keeps a tier while any member has headroom; members without
  headroom are in that tier only because a sibling has some. The new filter drops them for RR placement.
- Sticky limit: `pickRoundRobinFromState` keeps `activeKey` while it is in the passed list; a sticky
  account that crossed the threshold is released and rotation continues over the headroom set. With all
  over, the full list returns and sticky behaves as today.

Not changed (deliberate):
- Bound conversations: RR never re-evaluates a live binding for quota (`reevaluateAffinityQuota` returns
  null for non-quota strategies); a binding releases only on exhaustion/cooldown/failure/pause etc. This
  change does not touch that path, and a test pins it.
- `pickAlternateCodexAccount` / `peekAlternateCodexAccount` (failover and transient detours): the request is
  leaving a failing account, not being placed. Left as-is; preview/resolve agreement there is untouched.
- `listEligibleCodexAccountIds` itself (shared by fill-first/reset-first and failover paths).
- Claude/Anthropic routing.

Placement after a released binding (account exhausted/cooled) goes through `pickUnboundStrategyAccount`
too, so that re-placement also prefers headroom — which is the cold move we want to land well.

## Tests (new file tests/codex-integration/codex-round-robin-headroom.test.ts)

Registered in scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json.
Three accounts a/b/c, global threshold 80, RR, stickyLimit 1 unless stated.

1. New placements skip an account at 95% while b/c are at 10%: 6 unbound picks never return a, split 3/3.
2. Exactly at threshold (80) is skipped (>=).
3. All over threshold (90/95/85): unbound picks rotate across all three (old behaviour).
4. Per-account override above usage (a override 99, usage 95) keeps a in rotation.
5. Global threshold 0 keeps a at 95% in rotation.
6. Unknown usage counts as headroom: a=95, b/c unprimed -> never a.
7. Bound conversation stays: thread bound to a at 10%, a rises to 95% -> 20 resolves stay on a.
8. Preview agrees with resolve: previewCodexAccountForRequest(null) equals next resolve and is never a.
9. Reserve scope ring also skips a and does not advance the shared ring.
10. Sticky limit 2 over headroom set: b,b,c,c.

Regression proof: run the new file against unchanged selection.ts before implementing; record failing tests.

## Docs

docs-site (English + fr, ja, ko, ru, tr, zh-cn, zh-tw where the row exists):
- reference/configuration/providers.md `anthropicAccountPool.strategy` and `quotaWindow` rows: exact rule in
  "Audit round 1" B3 below. (All 8 locales.)
- guides/claude-code.md quota sentence (en, fr, tr, zh-tw carry it): same correction.
- Codex `autoSwitchThreshold` row ("normal round-robin selection does not use it"), `accountPoolStrategy` row
  (round-robin clause) and the Codex strategy table `round-robin` row ("ignores usage thresholds"; en, fr, tr,
  zh-tw): new rule — new placements skip accounts at/over their effective threshold while any eligible
  account is under it; all over -> plain rotation; bound conversations never move for the threshold.
- getting-started/how-it-works.mdx if it states RR ignores usage (it does not today; check only).

structure/providers/openai-accounts.md (owner of src/codex routing): add the RR placement rule to the
per-account auto-switch thresholds paragraph (where effective threshold is consumed).

## Verification

Focused: new file + codex-pool-rotation, codex-account-threshold-routing, codex-routing, codex-idle-window,
codex-priority-failback, codex-use-remaining-quota, codex-preserve-signed-in, codex-pool-request-owned-main,
codex-auth-context (baseline 502 pass / 1 skip / 0 fail on 6f1d3e65c).
Gates: bun run typecheck, bun run structure:check, bun run privacy:scan, test-layout tests,
bun scripts/test.ts --changed=dev --parallel=1. docs-site build (required, see B4).

## Risks

- Existing tests asserting RR rotation onto an over-threshold account would change colour: none found in the
  baseline run; any that appears is examined as contract vs incidental.
- Unknown-as-headroom differs from Claude's pickLowestUsage (which filters only when a KNOWN account is under
  threshold). Chosen for consistency with Codex fill-first/tier filter; an unprimed account is a better
  placement than a known 95% one.


## Audit round 1 (Terra, FAIL) — dispositions

B1 lineage first placement (routing.ts pickLineageServingAccount) — REBUTTED. The lineage pick is not a
round-robin placement: it runs for every strategy, before any strategy pick, and it places a child that has
no binding on the account its PARENT (or a compatible sibling) is being served from right now. The parent is
itself pinned there and, under cache affinity, stays until exhaustion/cooldown/failure; the child following
it keeps the family on one warm prefix, and the whole family moves together at the same release. Applying the
round-robin headroom filter here would split a family onto a cold account to save headroom, which is exactly
the trade the cache-affinity design (#4546) refuses, and it would change quota/fill-first/reset-first behaviour
the brief does not ask for. `lineageServingAccountId` already refuses a serving account that is not selectable,
has an unrecovered quota refusal, or is failover-tripped, so an exhausted parent does not attract children.
Kept unchanged; the docs and PR state that a child of a live conversation follows its parent's account.
(routing.ts is also at 1623/1626 of its file-size cap.)

B2 docs scope — ACCEPTED. Codex round-robin claims to update:
- en providers.md: autoSwitchThreshold row (126), accountPoolStrategy row (128), strategy table round-robin row (1047).
- fr: rows 58, 60, strategy table 258.  tr: rows 58, 60, strategy table 284.  zh-tw: rows 54, 56, table 199.
- ja: rows 56, 58, strategy prose 236.  ko: rows 56, 58, strategy prose 240.  ru: rows 57, 59, prose 268.
  zh-cn: rows 56, 58, prose 264.
Claude quota claims to update (all 8 locales): `anthropicAccountPool.strategy` row, and the `quotaWindow` row
sentence that says `quota` ranks eligible candidates directly for new-session assignment; guides/claude-code.md
quota sentence (en, fr, tr, zh-tw).

B3 Claude wording — ACCEPTED. Accurate rule (anthropic-routing.ts resolveAnthropicAccountForSession):
with a new session and no manual/affinity hit, `quota` keeps a healthy active account while its known usage in
`quotaWindow` is below that account's effective `autoSwitchThreshold` (default 80); unknown usage also keeps it.
It picks the lowest known usage in `quotaWindow` when the active account reaches the threshold, or cannot be used
(paused, reauth, cooling, model-family exhausted, or under `weekly` its 5-hour bar is exhausted). With threshold
`0` a healthy active account is kept and lowest usage is used only when it cannot be used. 429 recovery ranks
replacements by `quotaWindow` directly.

B4 docs build — ACCEPTED. Required locally: `cd docs-site && bun install --frozen-lockfile && bun run build`;
report honestly if it cannot run.

Non-blocking notes folded:
- Tests added: sticky batch where the sticky account crosses the threshold mid-batch; re-entry after usage drops;
  all-over fallback after a narrowed ring; released-binding re-placement (bound account goes to 100% -> next
  placement avoids an over-threshold sibling); failover (pickAlternateCodexAccount) unchanged (may pick an
  over-threshold account) as a boundary; model roster (modelEligibleAccountIds) narrowing; priority tier;
  terminal short window (short-only 100% = no headroom); credits documented, not separately tested.
- Score wording qualified: hottest KNOWN long window (weekly/30d) refined by an unexpired short window; a
  short-only observation is unknown except a terminal (100%) short window; spendable credits cap at 99 only
  when credits-after-limit is enabled.
- Regression proof without stash: write the new test file first, run it against unchanged selection.ts, record
  the failing tests, then implement.
- structure/: openai-accounts.md (per-account thresholds paragraph) is the owner touched; other src/codex
  mapped docs checked for RR-ignores-threshold claims (none found besides openai-tiers' pin note, unaffected).

## Audit round 2 (Terra, FAIL on one blocker) — dispositions

R2-B1 Claude rule — ACCEPTED. Replacement rule used by the docs (supersedes the B3 wording above where they differ):
With the pool enabled, a new session without a manual or affinity hit keeps a healthy active account while its
known usage in `quotaWindow` is below that account's effective `autoSwitchThreshold` (default 80); unknown usage
also keeps it. When the active account reaches its threshold or cannot be used (paused, reauth, cooling,
model-family exhausted, or under `weekly` its 5-hour bar is exhausted), `quota` picks a replacement: among
candidates (5-hour-exhausted and model-exhausted ones dropped while others remain) it prefers accounts below their
own effective threshold whenever any account with known usage is below it, then takes the lowest usage in
`quotaWindow`; when every account is at or over its threshold it takes the lowest usage among all. Threshold 0
keeps a healthy active account. 429 recovery under `quota` uses the same replacement picker. (anthropic-routing.ts
pickLowestUsage ~785-830, resolveAnthropicAccountForSession ~1048-1083.) Docs keep this compact: "keeps the active
account until it reaches autoSwitchThreshold (or cannot serve); then moves to the least-used account, preferring
accounts still under their own threshold".

R2-N1 lineage — rationale CORRECTED, decision unchanged. The lineage pick precedes strategy selection and gives a
child with no binding the account its parent (or compatible sibling) is serving from now, for the warm family prefix.
Once placed, the child's binding is independent (a later parent move does not drag it). Kept as-is because it is a
strategy-agnostic cache-family hint, not a round-robin placement; documented as an exception ("a child of a live
conversation starts on its parent's account"), with a regression test: parent bound to an over-threshold account, an
under-threshold alternative exists -> the child still starts on the parent's account (boundary pin).

R2-N2 idle-window — idle-window steering (codexPool.startIdleWindows) precedes round-robin and already requires
hasCodexQuotaHeadroom; docs say "round-robin placements", not "all new placements".
