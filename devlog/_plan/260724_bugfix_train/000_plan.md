# 000 — 260724_bugfix_train: Plan

> Roadmap master for the bugfix train. One work-phase = one full PABCD cycle.
> Bound goalplan: `.codexclaw/goalplans/opencodex-bugfix-train-6-pabcd-cycles-bookkeepin/goalplan.json`
> (session 019f8f62-c778-7550-bd4c-aa4419fce259).

## Objective

Land every verified-unpatched bug from the 2026-07-23 issue sweep as reviewable PRs
against `dev`, and bring the two open contributor PRs to merge-ready quality.

Evidence base: three Sol reviewer reports against origin/dev tip `d9e06c8d`
(issues #334/#326, issues #335/#331/#329/#324/#320/#241/#92, PRs #336/#337) plus a
3-Mind contradiction rescan (14 contradictions; 4 high folded into this plan as
corrections, 6 medium recorded as OPEN ASSUMPTIONS below).

## Loop-spec

- Loop archetype: verifier-defined (spec-satisfaction repair) for every phase.
- Trigger: owner directive 2026-07-24 — auto-resolve open questions via subagent
  opinion, run repeated small PABCD cycles, push + open PR per cycle.
- Goal: cycles 1-6 each closed through D with branch pushed and PR opened; #324
  closed; #92/#241 status comments posted.
- Non-goals: upstream-blocked fixes (#92/#241 root causes), #42 Phase 2/3, all
  feature-request issues, merging any PR (owner decision; gui/ merges need fresh
  explicit approval).
- Verifier per cycle: `bun run typecheck` + `bun run test` + `bun run privacy:scan`
  green; cycle 4/6 add `bun run lint:gui` + `bun run build:gui`; docs-site sync
  decision recorded in the D summary.
- Stop condition: all goalplan criteria met, or a stated terminal outcome
  (BLOCKED / NEEDS_HUMAN / UNSAFE / BUDGET_EXHAUSTED with evidence).
- Memory artifact: this unit + goalplan + `.codexclaw/ledger.jsonl`.
- Escalation: upward — main reclaims a slice after two distinct agent failures on
  the same packet (DISPATCH-RETIRE-01); downward — pushing a slice to a worker is a
  P-phase amendment, never mid-B improvisation.
- Resource bounds: tools = local git/gh/bun + GitHub via gh; write scope = the
  ocx-bugfix-train worktree + contributor PR branches (maintainerCanModify verified);
  push scope = per-cycle `codex/260724-*` branches and the two contributor branches
  only (owner pre-approved for this exact scope).

## Topology (corrected per contradiction scan)

- One worktree: `/Users/jun/.codex/worktrees/ocx-bugfix-train` (deps installed).
- Per-cycle branches `codex/260724-<unit>` cut from CURRENT `origin/dev` — never
  stacked on unmerged predecessors (keeps every PR independently reviewable).
- Cycles 5/6 fetch the contributor head branches and push fix commits there
  (attribution preserved; no superseding PRs).
- The review worktree `codex-260723-issue-pr-review` stays pinned at d9e06c8d as
  read-only reference; all post-cycle-1 verification runs in this worktree.

## Work-phase map (dependency-ordered, PHASE-SPLIT-01)

| WP  | Doc  | Slice | Depends on |
|-----|------|-------|------------|
| wp0 | 000  | This roadmap (docs-only cycle) | — |
| wp1 | 010  | #334 SSE output backfill + #326 idempotent guidance injection (file set per 010: src/server/relay.ts, src/types.ts, src/responses/parser.ts, src/server/responses/collaboration.ts — core.ts/state.ts explicitly untouched) | wp0 |
| wp2 | 020  | #335 bounded single pool retry on allow-listed account-specific 400 (SECURITY GATE) | wp1 |
| wp3 | 030  | #320 codex-shim auto-restore after external npm update (SECURITY GATE) | wp1 |
| wp4 | 040  | #329 discovery-error badge + #331 helper-fallback UX copy (gui) | wp1 |
| wp5 | 050  | PR #336 takeover: refresh to live head (87af85fb, 8 files, Cross-platform CI already GREEN), rebase onto post-wp1 dev, interdiff review, re-run gates. Expected textual overlap with wp1 is LOW (wp1 avoids core.ts); treat any collaboration.ts adjacency case-by-case | wp1 MERGED |
| wp6 | 060  | PR #337 takeover: interactive component tests + split 840-line component + root-suite failures | wp4 merged preferred (i18n overlap) |
| wp7 | —    | Bookkeeping: close #324 (docs pointer), status comments on #92/#241 | wp1 |

Dependency rationale: wp1 is the foundation (passthrough state machine; PR #336
edits the same subsystem, so it rebases after wp1 lands to keep semantics
consistent even though direct textual conflict is expected to be low). wp2-wp4
are independent capability lanes. wp5 is integration gated on wp1 merging. wp6
prefers wp4 merged to avoid i18n hunk collisions. wp7 is hygiene.

## wp0 artifact map (docs-only cycle, DIFFLEVEL-ROADMAP-01)

| Action | Path (relative to repo root) |
|--------|------------------------------|
| NEW    | devlog/_plan/260724_bugfix_train/000_plan.md (this file) |
| NEW    | devlog/_plan/260724_bugfix_train/010_passthrough_state.md |
| NEW    | devlog/_plan/260724_bugfix_train/020_pool_retry_400.md |
| NEW    | devlog/_plan/260724_bugfix_train/030_shim_autorestore.md |
| NEW    | devlog/_plan/260724_bugfix_train/040_ux_discovery_badge.md |
| NEW    | devlog/_plan/260724_bugfix_train/050_pr336_takeover.md |
| NEW    | devlog/_plan/260724_bugfix_train/060_pr337_takeover.md |
| NEW    | devlog/_plan/260724_bugfix_train/061_root_suite_investigation.md (wp6 research artifact, split per LEXICO-SPLIT-01) |

Note: the six `0N0_phaseN.md` scaffolds were replaced before the unit's first
commit and were never tracked by git — no DELETE rows apply to this map.

No production code changes in wp0. Activation proof for this cycle: the A-gate
reviewer verdict (adversarial repo-grounded audit) + `git status` showing only
devlog/_plan additions + the D attestation in `.codexclaw/ledger.jsonl`.
devlog/ is gitignored with tracked content: force-add these artifacts when
committing (`git add -f devlog/_plan/260724_bugfix_train`).

## OPEN ASSUMPTIONS (carried from Interview, recorded)

1. #335 intentionally refines the 35d28a02 "4xx = caller, no failover" policy; PR
   description must say so explicitly; the pinned no-penalty test stays green.
2. Done-gate extended beyond the user's "PR open": + privacy:scan + docs-site sync
   decision per cycle (AGENTS.md requirements).
3. Cycles 5/6 push fix commits to contributor branches (maintainerCanModify=true);
   no superseding PRs; original authors keep attribution.
4. #326 fix = idempotent injection (option a) with replayPrefixLen plumbed through
   parseRequest; option (b) strip-at-persist rejected (5 call sites).
5. #334 fix = one shared SSE item-accumulator helper for both consumers;
   trackSseForRequestLog needs no backfill (terminal-status only).
6. Cycles 2 and 3 carry security-review checkpoints (MAINTAINERS.md security
   boundary); gui/ merges are outside this loop's authority.
7. (superseded assumption, corrected by A-gate round 1) PR #336's required CI was
   NOT missing — the initial gap was the first-time-contributor approval gate;
   Cross-platform CI is green on live head 87af85fb. wp5 scope is rebase +
   interdiff + gates re-run, not CI restoration.

## Accept criteria (mirrored in goalplan criteria[])

- c0: this roadmap closes its own PABCD cycle with reviewer PASS/near-pass.
- c1-c6: each cycle's branch pushed, PR opened, gates output captured.
- c7: #324 closed with docs-pointer comment; #92/#241 status comments posted.

## SoT sync (SOT-SYNC-01)

Repo SoT targets: `structure/` maintainer invariants + `docs-site/` user docs.
Each cycle's P names which docs-site page (if any) its behavior change touches;
the D summary records the sync decision.
