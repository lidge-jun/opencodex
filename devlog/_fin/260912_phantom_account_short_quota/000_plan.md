# Phantom account-level 5h row after Spark attribution (#4122 leftover) — plan

## Reader summary

Problem: one Codex Pro pool account still renders an account-level 5h bar
(`5시간 리셋 9월 10일 02:24 4%`) even though Pro has no account-level 5h window and
Issue #4122 already stopped new Spark 5h writes into that slot. Answer: stop
`mergeAccountQuota` from carrying an elapsed `short*` tuple across a refresh that
does not include a short window. What changes: the polluted Pro row drops the
phantom bar on the next ordinary weekly/Spark refresh; Plus/Team accounts whose
5h window is still open keep it.

## Loop spec

- Loop archetype: satisfy-spec (single work-phase wp1; not multi-cycle, so no
  extra docs-first roadmap cycle).
- Trigger: live 2026-09-12 dashboard report on http://localhost:10100/#codex-set
  plus HOTL objective to land a merged PR on `dev`.
- Goal: a Pro account whose refresh reports no account-level short window stops
  showing a 5h row; the stale display tuple is removed while existing main-policy evidence remains protected; PR merged
  to `dev` with exact-head CI.
- Non-goals: GUI redesign; WHAM Spark-primary remapping (WHAM already files Spark
  under customWindows and is not rewriting this account's shortObservedAt);
  dropping still-open Plus/Team 5h windows; routing-policy redesign; release or
  promotion; docs-site translation; local product suite/typecheck/build/install
  (standing user rule: NOT RUN; remote CI is the gate).
- Verifier: remote `.github/workflows/ci.yml` on the PR exact final head. The
  `test` job's change filter includes `src/**` and `tests/**`;
  `scripts/ci/run-bun-test-batches.sh` selects
  `tests/codex-integration/codex-quota-parser-parity.test.ts`. Local
  `bun test` / `bun run typecheck` / `bun run test` / `bun run build:gui`: NOT RUN
  by standing user rule (command not executed; no exit code). Conditional paths:
  (1) elapsed short + weekly/Spark refresh with no `short*` — activation: seed
  past `shortResetAt`, apply weekly or Spark headers, observe `short*` absent;
  (2) live short + weekly-only refresh — activation: seed future `shortResetAt`,
  apply weekly headers, observe `short*` retained; (3) incoming explicit short
  even if elapsed — activation: `setAccountQuotaFromParsed` with past reset,
  observe the tuple stored so auto-refresh/scorer fixtures stay intact.
- Stop condition: fetched `origin/dev` contains the PR commit and the live
  phantom row is gone after the normal refresh path, or BLOCKED/NEEDS_HUMAN with
  evidence.
- Memory artifact: this unit directory plus
  `.codexclaw/goalplans/hotl-fix-the-opencodex-dashboard-rendering-a-pha/`.
- Expected terminal outcomes: DONE = c1–c4; BLOCKED = irreducible CI or
  merge-policy denial; NEEDS_HUMAN = authority gap.
- Escalation: local suite requirement, push without `--no-verify`, or expanding
  into GUI/routing redesign returns to the user.
- Architect consultation gap: this session has no bounded architect-subagent
  transport (create_thread is user-owned and forbidden for subtasks). Design
  decisions below are main-owned with file:line evidence.
- HOTL resource bounds: this worktree shell/git/gh plus read-only local
  management GETs; existing gh auth; write scope = this worktree and PRs on
  lidge-jun/opencodex; no token/wall-clock budget set by the user.

## Root cause (evidence)

Live cache `~/.opencodex/codex-quota-cache.json`, entry for the affected Pro pool account, on
2026-09-12 03:05 UTC (account identifiers deliberately omitted: this directory is public):

- `shortPercent` 4 / `shortObservedAt` 1788956674678 (2026-09-09 12:24 UTC) /
  `shortResetAt` 1788974652 (2026-09-09 17:24 UTC = KST 9월 10일 02:24) /
  `shortWindowSeconds` 18000
- `updatedAt` 1789182311711 (current)
- current Spark customWindows (`GPT-5.3-Codex-Spark 5h` percent 0, reset in the
  future) and weeklyPercent 29

Peer Pro accounts in the same file have weekly + Spark customWindows and no
account-level short. The one Team account there has a *fresh* short tuple
(`shortObservedAt === updatedAt`, reset in the future) — a real Plus/Team 5h
window that must be kept.

`mergeAccountQuota` (`src/codex/quota.ts`) treats absence of `short*` as a partial
update and copies the entire existing short tuple, then
`setAccountQuotaFromParsed` always sets `updatedAt = Date.now()`. Disk hydration
(`QUOTA_DISK_MAX_AGE_MS = 6h`) keys expiry on `updatedAt`
(`src/codex/quota.ts:14-15,637-640`), so the carry prevents the TTL #4122 relied
on. The carried `shortResetAt` is already in the past, so the rendered row is
unreachable, not merely stale-but-plausible.

Issue #4122 (`devlog/_fin/260909_spark_short_quota_attribution`) stopped *new* Spark
header writes into the account short slot
(`parseUpstreamQuotaHeaders` Spark branch, `src/codex/quota.ts:466-473`) and
explicitly left polluted entries to the six-hour TTL. That assertion is false
once carry rewrites `updatedAt`.

### Alternatives refuted

- GUI inventing the row: `normalizeQuotaForPlan` /
  `buildQuotaRows` map `shortPercent` to a five-hour row with no expiry check
  (`gui/src/codex-quota-utils.ts:38-45`, `gui/src/components/QuotaBars.tsx:73-82`).
  They display what the cache already holds. The KST timestamp matches
  `shortResetAt`, not a GUI clock bug.
- WHAM still writing a Pro account-level short: `parseUsageQuota` still files an
  explicit sub-day *primary* as short (`src/codex/quota.ts:811-814`) and Spark
  additional limits as customWindows (`src/codex/quota.ts:871`). This account's
  `shortObservedAt` is frozen on 2026-09-09 while weekly and Spark customWindows
  keep moving, so current WHAM refreshes are not rewriting `short*`.
- auth-api synthesizing a 5h row: DTO mapping copies stored short fields
  (`src/codex/auth-api.ts:296`) and only filters Spark *custom* windows for
  display. It does not invent `short*`.

## File-change map

See `010_phase1_drop_elapsed_short_carry.md`.

## Accepted consequence

A merge that drops an elapsed tuple also clears `fiveHourAvailable` in
`codexQuotaAutoRefreshStatus` (`src/codex/quota-auto-refresh.ts:62-65`) until the
window is observed again, because that flag reads `shortWindowSeconds` and
`shortResetAt` from the same slot. Bounded on both sides: the scheduler keeps its
own boundary (`rememberWindows` persists `nextFiveHourResetAt` and
`dueCodexQuotaAutoRefreshWindows` prefers it over the stored quota,
`src/codex/quota-auto-refresh.ts:78-101`), and any real Plus/Team response
re-observes the window as an explicit incoming short, which this change never
drops. The gap therefore only spans a credits-only or weekly-only refresh
arriving between a reset instant and the next observation — and for a Pro
account, where the window does not exist, clearing the flag is the correct
outcome.

## SoT

The canonical current rule is in `structure/providers/openai-tiers.md`, with links from the
other Codex structure owners and dashboard documentation. Display expiry never removes main
hard-lock evidence. Reset-notification history retains omitted short observations separately.

## Final audit refinement

The initial design also expired identity-bound policy evidence. Independent review rejected
that behavior: an elapsed deadline plus a credits-only update is not quota recovery. The final
patch preserves policy evidence and removes only obsolete display/rotation carry. A second
review found that notification history needed separate retention across those display updates;
Codex now opts into that retention without changing other provider writers.
