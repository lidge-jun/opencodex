# 000 — v2.32.1 hotfix train: baseline, scope, and work-phase map

Unit opened 2026-08-24. Session `01a0339b-4c6e-73e3-8890-23f65c5bbd46`.
Goalplan slug `prepare-opencodex-dev-as-the-verified-release-ca`.

## Baseline correction

The planning note this unit started from was written against a v2.31 baseline.
That baseline is void. Verified live on 2026-08-24:

| Ref | SHA | Meaning |
|-----|-----|---------|
| `origin/dev` | `c44e43f00` | Merge of #2453 (wait yield_time_ms underscore) |
| `origin/main` | `96e2f67c3` | `release: v2.32.0` |

```
git merge-base --is-ancestor origin/dev origin/main  ->  exit 0   (dev IS an ancestor of main)
git merge-base --is-ancestor origin/main origin/dev  ->  exit 1
git rev-list --count origin/dev..origin/main         ->  27
git rev-list --count origin/main..origin/dev         ->  0
git diff --name-status origin/dev origin/main        ->  M package.json
git show origin/main:package.json                    ->  "version": "2.32.0"
```

Three facts follow, and they set the entire unit:

1. **The next release is v2.32.1, not v2.31.1.** v2.32.0 is already published from
   `main` (`npm` `latest` = 2.32.0, GitHub release `v2.32.0` targets `96e2f67c3`).
   A 2.31.x number would move backwards over a shipped release.
2. **`dev` and `main` have NOT diverged.** `dev` is an *ancestor* of `main`:
   0 commits ahead, 27 behind. The 27 are main-side promotion and release commits
   accumulated since 2.25.0. This was recorded incorrectly in the first draft of
   this document — the original text read the one-way `--is-ancestor` result as
   divergence. Corrected here after an independent audit re-ran both directions.
3. **The net tree delta is one line.** `main` carries `version: 2.32.0`; `dev`
   still says `2.27.0` because release bumps are made on the promotion commit and
   never flow back. Nothing else differs.

### What wp1 therefore is

Because `dev` is strictly behind `main`, `git merge origin/main` on `dev` is a
**fast-forward**, not a merge commit. That is the intended operation and it is
recorded as such: wp1 advances `dev` to `96e2f67c3` so the release lineage and
the version line are one. `git merge-tree` confirms the only content change:

```
git merge-tree $(git merge-base origin/dev origin/main) origin/dev origin/main
  - "version": "2.27.0",
  + "version": "2.32.0",
```

`bun.lock`, `scripts/release.ts`, and `.github/workflows/release.yml` are
untouched. **Mandatory post-condition: `dev` package.json reads exactly
`2.32.0`.** Keeping `2.27.0` would regress the release ledger; bumping to
`2.32.1` belongs to the promotion commit, not to wp1.

## Why bugfix-only

The open queue is far larger than one train can absorb: 46 open PRs, 25 of them
draft, 21 `review-ready`, 11 `intake: hygiene-blocked`, plus 67 open issues.
Merging by availability rather than by risk is how a hotfix release grows a
regression radius it cannot verify. This train is capped at five runtime fixes
plus one repository-infrastructure fix, each of which closes a defect class that
is *currently user-visible on the shipped v2.32.0*.

## Included units

| # | PR | Defect class it closes |
|---|-----|------------------------|
| wp3 | #2483 | Model unusable — capitalized/dotted Claude vendor ids take the legacy `thinking.enabled` wire and get a 400 |
| wp4 | #2481 | Catalog inconsistency — slash-bearing models vanish from the picker while direct calls still work |
| wp5 | #2473 | Thread unrecoverable — a >16 MiB turn repeatedly dies on the WS transport with no SSE escape |
| wp6 | #2477 | Tool authorization boundary — namespace aliases restored outside the caller's `tool_choice` |
| wp7 | #2476 | Disk/CPU amplification — a ~24 MiB snapshot rewritten every two seconds unchanged |
| wp2 | #2427 | Verification cost — the full suite reads as hung, which pushes contributors toward unverified merges |

## Excluded, with reason

Excluded because they widen the regression radius, not because they lack value:

- **#1905** per-model compaction budgets — 27 files, `+813/-80`, touches config,
  management, and catalog. First candidate for v2.33.0.
- **#2418** subagent scoped cooldown — 8 files, `+2044/-111`, changes routing,
  credential admission, quota probing, and encrypted recovery together. Needs its
  own security lane.
- **#2470** Google thought-signature — three unrelated concerns in one PR
  (signature replay, output clamps, Windows fixtures). Must be split.
- **#2475** Kiro tool-search priority, **#2425** xAI hosted `x_search`,
  **#2429** `test:changed` — not release blockers; #2429 is stacked on #2427.
- **#2462** and every OAuth / remote-dashboard / hosted-SaaS / billing PR —
  product-direction and security-boundary changes, currently hygiene-blocked.
- All 11 `intake: hygiene-blocked` PRs, by policy.

## Work-phase map (dependency order)

The order is a dependency chain, not a difficulty ranking. Each phase consumes
the verified output of the one before it.

```
wp0  docs (this unit)
 │
 └─ wp1  dev fast-forward to main (v2.32.0)      [every later head depends on it]
     │
     ├─ wp3  #2483 anthropic ids                 ┐
     ├─ wp4  #2481 selectedModels                │  runtime fixes, merged
     ├─ wp5  #2473 oversized WS                  ├─ sequentially, each verified
     ├─ wp6  #2477 namespace authz  [sec review] │  on the SERIAL runner
     ├─ wp7  #2476 snapshot writes  [conditional]┘
     │        │
     │        └──── all of wp3..wp7 must be merged-or-deferred ────┐
     │                                                            │
     └─ wp9  #2472 mixed-sequence regression                       │
              [independent of wp3..wp7; may run any time after wp1]│
                       │                                          │
                       └──────────────┬───────────────────────────┘
                                      │
                                 wp2  #2427 test runner   [LAST, or deferred]
                                      │
                                 wp8  freeze + GO/NO-GO
                                      [requires wp3..wp7, wp9, and wp2]
```

The join is explicit because the ordering rule is easy to lose in a tree
drawing: **wp2 does not start until every runtime phase has a terminal
outcome.** It is drawn as a sibling of nothing — it is downstream of all of
them.

### Why #2427 moved to the end (audit amendment)

The first draft put #2427 first, reasoning that landing the verification
instrument early means every later phase is verified by the same runner. The
A-phase auditor argued the opposite and it is the stronger argument: #2427
switches the suite from serial isolated execution to file-parallel isolated
execution (`scripts/test.ts` default becomes `bun test --isolate --parallel
./tests/`), and its own PR body reports **7 failures across 902 files** on its
exact head. Landing an unproven runner first makes every subsequent runtime
failure ambiguous: flakiness from parallel shared-state contention would be
indistinguishable from a regression introduced by the runtime PR under test.

A verification instrument must be changed against a known-good baseline, not
used to establish one. #2427 therefore runs LAST, immediately before freeze, and
only with a pre/post gate: the runtime phases are verified on the serial runner,
then #2427's head must produce a green exact-head `bun run test` plus required
cross-platform CI. If it does not, it is deferred and the train proceeds on the
existing runner. It is a convenience, never a blocker.

wp8 depends on **every** runtime phase, not only on the phase drawn above it.

## Out of scope for this unit (STRICT)

No `dev` -> `main` promotion, no tag, no npm publish, no release workflow
dispatch, no version bump beyond what the backmerge carries. This unit ends at a
frozen, verified `dev` SHA plus a GO/NO-GO report. Promotion is a human decision.

## Verification doctrine

Exact-head evidence only. A remembered green run is not evidence. Every phase
closes with fresh command output captured at the SHA being claimed, and every
merge is proven with its merge SHA plus
`git merge-base --is-ancestor <merge> origin/dev`.

## Known defects already shipped in v2.32.0 (audit amendment)

v2.32.0 is the v2.27.0-line tree plus a version bump, so every defect open
against 2.31.0 also ships in 2.32.0. The audit was right that a hotfix train
without this ledger is choosing its scope blind. Dispositions:

| Issue | Defect | Fixing PR | Disposition | NO-GO? |
|-------|--------|-----------|-------------|--------|
| #2407 | Kiro drops tools loaded by `tool_search` | #2475 (draft, red suite) | Decide at wp2/wp8 on exact-head evidence; include only if it goes green before freeze | No |
| #2458 | Gemini 3.7 Flash video input 502 — routed provider emits undeclared client tool `get_video_duration` | none | Defer: the candidate fix touches the undeclared-tool guard, the same authorization surface wp6 is hardening. Two changes to one guard in one hotfix is exactly the regression radius this train exists to avoid | No |
| #2459 | Windows bare npm reinstall can leave a live proxy on a mixed old/new module graph | none | Defer: install/service surface, not a runtime defect the proxy can fix mid-session; needs its own unit | No |

None forces NO-GO, but each is now a recorded decision rather than an omission.
If any acquires a verified fix before freeze it may be reconsidered — the
inclusion bar stays exact-head green plus review, not urgency.

## Two review-ready PRs the first draft did not mention (audit amendment)

- **#2474** (`fix(scripts): run ocx-run commands in the requested workdir`) —
  a real defect: `scripts/ocx-run:128` never enters the requested workdir.
  But root `package.json` excludes `scripts/` from the published artifact, so it
  cannot affect the shipped runtime. **This train does not use `ocx-run` in any
  verification step**, so it is deferred as repository-operations work rather
  than included. If a later phase adopts `ocx-run` for verification, this
  becomes a prerequisite and must be pulled in first.
- **#2432** (docs, `__omit__` reasoning-effort sentinel) — currently
  `CHANGES_REQUESTED` with unfixed table formatting. Excluded pending its
  requested changes; docs-only work does not need a hotfix train.

## Per-phase verifiers (audit amendment, PLAN-VERIFIER-REAL-01)

The auditor ran the baseline commands and proved they pass while observing none
of the planned fixes:

```
bun run typecheck                                     -> exit 0, 0.60s
bun test tests/namespace-tool-compat.test.ts \
         tests/selected-models.test.ts \
         tests/anthropic-reasoning.test.ts            -> 67 pass 0 fail, exit 0
```

Green there means nothing yet: on current `dev`,
`tests/selected-models.test.ts:15` has no slash-bearing selector,
`tests/anthropic-reasoning.test.ts:53` has no capitalized/dotted id, and
`tests/namespace-tool-compat.test.ts:239` hand-builds an alias map without ever
testing `tool_choice` authorization. That run is a **preflight**, not fix
evidence.

Each phase therefore names its own verifier, run at that phase's exact merge
head, plus the specific assertion that must newly exist:

| Phase | Verifier command | Assertion that must be present after merge |
|-------|------------------|--------------------------------------------|
| wp3 #2483 | `bun test tests/anthropic-reasoning.test.ts` | capitalized + dotted + dashed + date-pinned ids classify correctly, and the explicit-disable caller is covered |
| wp4 #2481 | `bun test tests/selected-models.test.ts tests/codex-catalog.test.ts tests/slug-codec.test.ts` | an encoded slug in `selectedModels` keeps a slash-bearing model visible at the route/sync level, not only in the helper |
| wp5 #2473 | `bun test tests/ws-upstream.test.ts tests/sse-failed-tail.test.ts` | oversized frame opens zero sockets; adjacent-byte boundary routes WS vs SSE |
| wp6 #2477 | `bun test tests/namespace-tool-compat.test.ts tests/responses-parser.test.ts` | a foreign tool-type selector authorizes no alias and restores no call |
| wp7 #2476 | `bun test tests/responses-state-write-amplification.test.ts tests/responses-state.test.ts` | unchanged flush does not rewrite; deleted snapshot is regenerated; eviction order unchanged |
| wp2 #2427 | `bun run test` (full, exact head) + cross-platform CI | exit 0 |
| wp8 | `bun run typecheck`, `bun run test`, `bun run privacy:scan` at the frozen SHA | all exit 0 |

## The #2472 canary, restated (audit amendment)

The original criterion — a 100-call zero-output canary — is not a feasible gate
as written, and the audit demonstrated why. The proxy currently listening on
:10100 is PID 922, started 2026-08-23: the **stale process from the bug report
itself**, not a frozen candidate. Worse, the defect needs Cursor
native-shell/host-shell interleaving with duplicate call ids; duplicates are
already dropped at `src/adapters/cursor/protobuf-events.ts:1055` while the two
execution paths stay separate at `src/adapters/cursor/live-transport.ts:1445`.
An ordinary local prompt cannot deterministically produce that sequence, so a
"100 calls, zero empty results" run would prove nothing while spending real
provider credits and restarting the user's live proxy.

Restated criterion: the mandatory gate is an **automated mixed-sequence
regression** driving the interleaved native/host shell path with duplicate call
ids, asserting a typed error or failover instead of a silent empty success.
A live canary stays **optional and separately authorized**: isolated port and
config, disposable workdir, the exact frozen SHA, a bounded call budget, and
teardown evidence. Restarting PID 922 is not part of this unit.

**That regression does not exist and no included PR writes it**, which the
second audit round correctly called out: a mandatory gate with no implementing
phase is a wish, not a gate. It therefore gets its own work-phase, **wp9**,
documented at `090_wp9_issue2472_mixed_sequence_regression.md`. wp9 is
independent of wp3–wp7 and may run any time after wp1, but it must have a
terminal outcome before freeze. If wp9 concludes the sequence cannot be driven
deterministically in-process, #2472 is recorded as an explicitly deferred known
defect and **stops being a GO criterion** — with that finding written down,
rather than left as an unmet checkbox.
