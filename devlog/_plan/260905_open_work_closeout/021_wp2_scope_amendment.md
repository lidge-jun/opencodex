# 021 — wp2 P re-verification: parallel-unit overlap and scope amendment

Re-read at P of wp2 (2026-09-05, `origin/dev` = `1362b1a38`).

## Overlap with `devlog/_plan/260905_bug_triage_stack` (session `01a06e87-…`, worktree `ef41`)

A second maintainer session is running its own stacked chain on the bug *issues*. It already
opened PRs that cover four items 020 planned to carry or reimplement:

| Item (020) | Parallel PR | Branch | State |
|------------|-------------|--------|-------|
| #3469 carry (→ #3467) | #3547 | `codex/3467-google-location-error` | open, CHANGES_REQUESTED by Ingwannu on exact head (5xx precedence) — owned there |
| #3462 issue (020 said #3489 covers it; the parallel research disproves that) | #3551 | `codex/3462-mihomo-ipv6-fakeip` | open |
| #3464 issue (050 E5) | #3554 | `codex/3464-launchd-stable-launcher` | open |
| #3407 reimplementation (B5, → #3406) | parallel wp6 (050 doc there) | not yet opened | planned there |

**Amendment (LOOP-UNIT-CHAIN, no double work):** #3469/#3547, #3462/#3551, #3464/#3554, and
#3407 (B5) are **HANDED_TO_PARALLEL** — recorded here with the PR numbers and left to that
session's stack. wp5 E5 (#3464) is likewise struck. If that session stalls, the items return
to this unit as an appended work-phase.

## wp2 scope after amendment

| Layer | Item | Route | Base |
|-------|------|-------|------|
| pre-flight | #3544 (carry of #3480, wp1 residual) | merge when macOS 2/2 rerun reports green | dev |
| carry-3489 | #3489 fake-IP TUN discovery | carry = PR head + merge origin/dev (merge-tree CLEAN); trailer `Flowershangfromthebranches <id+login@users.noreply.github.com>` | dev |
| B1 | #3502 OAuth failover policy boundaries (split 1) | branch from origin/dev, cherry-pick the OAuth hunks; `src/oauth/` restricted surface → owner-authored so `unsponsored_surface` does not fire; trailer Ingwannu `186453546+Ingwannu@…` | dev |
| B2 | #3502 Kiro continuation auth context (split 2) | cherry-pick the `core.ts` hunk | B1 |
| B3 | #3519 native Claude launch fallback | carry PR head + merge origin/dev (merge-tree CLEAN) + docs-site sync; dismiss stale CHANGES_REQUESTED; trailer everton-dgn (id via gh api) | B2 |
| B4 | #3524 reimplementation (guarded startup reconcile) | fresh implementation per 020 §3.6; trailer yansigit `44089734+yansigit@…` | B3 |
| B6 | #3348 PR A: combo failure classification only | per 020 §3.8 (unref timers, no policy-fallback status change); trailer RHODIZSECURITY (id via gh api) | B4 |

B5 removed; B6 rebases onto B4. All 020 per-item sections stay authoritative for file maps,
tests, and verifiers; this doc only changes membership and bases.

## Verifiers (run at P; exist at 1362b1a38)

Per 020 §3.x. Sandbox-red server-binding suites run unsandboxed or on hosted CI (008).

## Stop condition

Six layers merged bottom-up with ancestry exit 0 (or documented escalation), #3544 landed,
originals closed at wp6. Trailers use the id-prefixed noreply form (008 Blocker 4).


## Audit fold (wp2 A round 1 — claude-opus-5, GO-WITH-FIXES blockers=7; report 022)

1. **Cross-unit collisions recorded.** #3551 (parallel) edits `src/lib/provider-outbound.ts:157`, the
   line carry-3489 rewrites. Sequence: carry-3489 is built **after** #3551 lands (or, if #3551 is
   still open when wp2 reaches it, carry-3489 branches from `origin/dev` and re-probes `merge-tree`
   against #3551's head; a conflict pauses carry-3489 until #3551 merges). 020 §3.2 (carry-3469)
   is **superseded** by #3547.
2. **B2 → B6 dependency recorded.** B2 edits `core.ts:6689`; B6 emits at `:6696` inside the same
   `applyFailoverSnapshot` block. Chain stays B1 → B2 → B3 → B4 → B6 and the §5 rollback row for
   B6 names B2 as its prerequisite.
3. **#3502 test split.** The Kiro continuation test inside
   `tests/…/anthropic-sidecar-account-failover.test.ts` (+277) moves to B2; B1 keeps only the
   OAuth policy tests so its CI is green alone.
4. **B4 RED anchors labelled:** the guarded-startup resilience test is RED against #3524's head,
   not dev (dev silently overwrites at `src/oauth/index.ts:1284`); the RED-on-dev proof is the
   carried concurrent-edit persistence test. Both are named as such in the B4 PR body.
5. **B4 startup test** binds a server → hosted-CI-only locally (EADDRINUSE class).
6. **Handoff residuals:** #3547 omits the `google-http.ts` TUN warning (dropped deliberately by the
   parallel author — accepted, no residual work); #3554 does not close #3464 (keep-open rider
   carried to wp6). 020's trailer table is superseded by the id-prefixed forms in 021.
7. **Line anchors** in 020 §3.3/§3.4/§3.8 re-resolved at B by `rg` before patching;
   B6's new 400→502 test must assert a status that `errors.ts:452` does not already map
   (use a non-`server_error` category) so it cannot pass vacuously.

DOCEOF; cp /Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260905_open_work_closeout/021_wp2_scope_amendment.md /private/tmp/ocx-closeout.xomWAA/wt/devlog/_plan/260905_open_work_closeout/; cp /private/tmp/ocx-closeout.xomWAA/wt/devlog/_plan/260905_open_work_closeout/022_audit_wp2.md /Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260905_open_work_closeout/
## B note — carry-3489 gated on #3551

`git merge-tree --write-tree refs/tmp/pr-3551 refs/tmp/pr-3489` → CONFLICT (`src/lib/provider-outbound.ts`,
plus #3551 also touches `destination-policy.ts`/`proxy-env.ts`). #3551 (parallel unit, head
`37622b92d`, 24 green, CHANGES_REQUESTED by its reviewer) is owned by session `01a06e87`. Per
audit fold 1, carry-3489 is built only after #3551 merges, from fresh `origin/dev`, and re-probed.
If #3551 is still open at wp2's D, carry-3489 is carried forward as a wp2 residual to a later
work-phase (LOOP-UNIT-CHAIN-01), not dropped.

## B progress — Stack B pushed (2026-09-05)

| Layer | PR | Branch | Head | Base | Source | Local evidence |
|-------|----|--------|------|------|--------|----------------|
| B1 | #3561 | codex/260905-oauth-failover-policy-boundaries | c2ba04a85 | dev | #3502 (1/2) | RED 41/2 → GREEN 43/0; layout 17/0; tc 0 |
| B2 | #3562 | codex/260905-kiro-continuation-auth-context | 49c48662f | B1 | #3502 (2/2) | RED 25/2 → GREEN 53/0; tc 0 |
| B3 | #3563 | codex/260905-claude-native-fallback | e9e9ebd23 | B2 | #3519 | RED compile-fail → GREEN 42/0; test:changed 503/0; tc 0 |
| B4 | #3564 | codex/260905-startup-reconcile-persistence | 589347fca | B3 | #3524 (reimpl) | RED 11/4 + 13/3 → GREEN 52/0 (unsandboxed); test:changed 10747/0; tc 0 |
| B6 | #3565 | codex/260905-combo-failure-classification | d0f80e85f | B4 | #3348 PR A | RED 6/8 → GREEN 14/0; 156/0 related; tc 0 |

Stack top `d0f80e85f`: typecheck 0; 214 pass / 0 fail across all layers' focused files +
layout guard + `tests/lab/core-lab-boundary.test.ts`. Restack via `git rebase --onto` was
conflict-free (B3/B4/B6 were built on `445742966`/`4dde2db97` and moved onto the chain).
carry-3489 gated on #3551 (parallel unit) — see B note above. Implementation lanes: four
claude-opus-5 agents, each with RED/GREEN evidence in its handoff; audit-fold items 3, 4, 5, 7
were applied by the lanes (Kiro test in B2, RED anchors labelled, healthz test hosted-CI-gated,
anchors re-resolved by symbol). 022 blocker 2's core.ts adjacency did not materialize (B6's
emit is ~550 lines from B2's hunk); the B2→B6 order is kept anyway.


### Review round 1 (023, claude-opus-5) — GO-WITH-FIXES (blockers=2), both folded in B6 `2faac80eb`

1. [High] `tests/oauth/generic-oauth-failover.test.ts:352` rotator-count guard: B6 adds a third
   `hasKeyPoolFailover(` site (pre-stream 401 recovery) → assertion and comment updated to 3.
   Reproduced deterministically at the stack top before the fix (25/1), and CI shard 4/4 on #3565.
2. [Medium] `rotateKeyOn401` / `rotateProviderTransportOn401` had only the enum round-trip test →
   three sibling cases added in `tests/adapters/key-failover.test.ts` pinning MAX_COOLDOWN_MS on 401.
Non-blocking: B1 docs sync English-only (the seven locales never carried the wrong claim — verified by
the B1 lane with rg); `failover.ts:295` "free tier + prompt" matcher is an extension of the plan's
request-shape class, accepted.

CI shard 1/4 on #3563 failed `tests/responses/responses-state.test.ts` "late async spill completion
cannot overwrite the shutdown fallback" (a timing test around the spill shutdown budget). B3's diff
touches only `src/cli/claude.ts`, `src/cli/registry.ts`, docs, and its own test; the file passes on
B3's head and on `origin/dev` locally (3× repeat). Classified as a timing flake pending the exact-head
rerun; not asserted as flake until the rerun reports.

DOCEOF; cp /private/tmp/ocx-closeout.xomWAA/wt/devlog/_plan/260905_open_work_closeout/023_impl_review_wp2.md /Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260905_open_work_closeout/
### Merges and cascade (DEV-STACK-02)

B1 #3561 → `71cfc8de6`, B2 #3562 → `24cc558d5` (admin squash, bypass comments, ancestry exit 0).
B3/B4/B6 cascaded with `git rebase --onto origin/dev 49c48662f` → `dc074672e` / `29182deb6` /
`6a31fcb77`; stack top typecheck 0, 222 pass / 0 fail on the combined focused set; pushed
`--force-with-lease`; #3563 retargeted to `dev`, #3564/#3565 base refs verified.
`tests/responses/responses-state.test.ts` failed twice on #3563's *previous* head with two
different spill-shutdown-budget tests (attempt 1 "late async spill completion…", attempt 2
"shutdown fallback spends only its reserved ACL budget"); the file is 0 fail ×6 locally on that
head and ×3 on dev, and B3's diff does not touch `src/responses`. The cascaded head gets a fresh
full run; only a green exact-head run merges it.

### #3563 (cascaded head dc074672e) macos 2/2 — pre-existing test race, not B3

`tests/codex-integration/codex-auth-context.test.ts:1461` "an admission bearer on main substitutes
the stored credential" builds `liveJwt()` twice (`:211`, `exp` derived from `Date.now()/1000`);
when the two calls straddle a second boundary the expected and written tokens differ by one
second of `exp`. B3's diff (`src/cli/claude.ts`, `src/cli/registry.ts`, docs, its own test) cannot
reach this path; the file is 0 fail locally ×3 on the head and on dev. Candidate for a
follow-up chore (freeze the JWT once per test) recorded for wp5/wp6 — not folded into B3 to keep
the layer's thesis clean. Exact-head rerun requested; merge waits for it.
