# 260717 — PR #139/#140 semantic child stack

## Loop specification

- Archetype: spec-satisfaction reconstruction from immutable contributor snapshots.
- Trigger: completed provenance cycle left 764 source hunks (PR #139: 276, PR #140: 488) to convert into reviewable children.
- Goal: build a dependency-ordered maintainer stack on `origin/dev`, preserve @Wibias attribution, repair the five High review blockers, and keep each child one rollback behavior with a default limit of 500 changed lines.
- Non-goals: force-pushing contributor refs, merging/closing #139 or #140, importing either integration tree wholesale, retaining cosmetic churn without a consumer, or mixing the dirty local `dev` checkout.
- Verifier: `001_hunk_ledger.tsv` row count/coverage, per-child diff-size and attribution gates, focused tests, typecheck, GUI lint/build, final base-to-tip coverage comparison, and draft-PR CI after explicit push approval.
- Stop condition: all retained/rewrite ledger rows are represented by verified child commits, every dropped row has rationale, blocker tests pass, and no unaccounted source hunk remains.
- Memory artifact: this unit plus the completed `devlog/_fin/260717_pr139_140_stacked_rebuild` provenance unit.
- Terminal outcomes: DONE, NOOP for a child whose source behavior already exists on the current base, UNSAFE for provenance/contract loss, BLOCKED for unavailable GitHub writes, or NEEDS_HUMAN only for an unresolved product choice.
- Escalation: after two identical integration failures enter root-cause mode; after three, return to P. Never weaken the hunk ledger or attribution gates to finish.

## Ground truth and exclusions

- Baseline: `origin/dev` at `31fabf96084b86c23ed3d60e8ff18f6593f9eed9`.
- Sources: immutable `codex/source-pr139-d209dfd5` and `codex/source-pr140-d92ae937`; integration snapshots are evidence only.
- The main checkout is dirty with unrelated OpenAI hardening work and is out of scope. Every child uses a dedicated worktree.
- `ProviderWorkspace.tsx` (+2,791) and `styles-provider-workspace.css` (+3,207) are rewrite sources, not files to copy. Their single source hunks fan out by symbols/selectors in `003_monolith_fanout.md`.
- PR #140 backend changes not tied to an isolated consumer or regression proof are dropped from this stack and remain recoverable from the immutable source ref.
- Push, PR creation, CI-triggering writes, merge, and closure require a later explicit remote-write approval. Local branches/commits are allowed.

## Interview decisions (2026-07-17)

- Provider classification is 3-way: **Free / Paid / Accounts**. Forward-auth providers (openai, openai-multi) go in the Accounts section. API-key providers with freeTier/keyOptional go in Free. All others go in Paid.
- Direct vs Multi differentiation uses registry `note` field + `codexAccountMode` from the management DTO.
- `isFreeProvider` no longer treats `authMode === "forward"` as free. New `isAccountProvider` predicate handles forward providers separately.
- ChatGPT hiding logic (`hideRedundantChatGptForwardProviders`) is replaced by `isCanonicalOpenAiForwardProvider` from wp-020.
- "Drop layout rewrites" rule for WP150-154 is overridden: take ALL Wibias GUI changes.
- 500-line child gate still applies. Phases exceeding it (WP120, WP130, WP140, WP141) split further at their P cycle.
- WP040 management API scope decided per-phase at P, recorded in devlog.
- WP090/091 split: Overview/Models/Usage (090) + Auth/Settings/JSON/Dialogs (091), each file ≤400 lines.

## Complete roadmap

| WP | Child outcome | Base |
|---|---|---|
| 010 | #139 provider catalog contract | `origin/dev` |
| 020 | #139 quota normalization contract | 010 |
| 030 | #139 pure workspace data helpers | 020 |
| 040 | #139 safe provider management API | 030 |
| 050 | #139 decomposed add-provider catalog | 040 |
| 060 | #139 Codex account pool embedding | 050 |
| 070 | #139 quota rows and usage UI | 060 |
| 080 | #139 workspace route, shell, and rail | 070 |
| 090 | #139 overview/models/usage panels | 080 |
| 091 | #139 auth/settings/JSON/dialog panels | 090 |
| 100 | #139 scoped styles, locale copy, responsive integration | 091 |
| 110 | #140 pinned advisory React Doctor tooling | 100 |
| 120 | #140 query/client and modal foundations | 110 |
| 130 | #140 Providers/Models diagnostics atop #139 | 120 |
| 140 | #140 Dashboard query migration | 130 |
| 141 | #140 Usage query migration | 140 |
| 150 | #140 ClaudeCode diagnostics | 141 |
| 151 | #140 Debug diagnostics | 150 |
| 152 | #140 Logs diagnostics | 151 |
| 153 | #140 ApiKeys/CodexAuth diagnostics | 152 |
| 154 | #140 Subagents diagnostics | 153 |
| 160 | #140 immutable update target | 154 |
| 170 | #140 bounded image normalization | 160 |
| 180 | #140 Cursor retry transport ordering | 170 |

Each implementation document is one PABCD work-phase and one local child branch. The known large phases are pre-split as 090/091, 140/141, and 150-154. If current-tree drift later makes a prewritten child exceed 500 changed lines, P returns to this roadmap for a named amendment before any B; exceeding the limit is never silently accepted.

## Attribution and branch contract

- Branches: `codex/wibias-139-XX-<slug>` or `codex/wibias-140-XX-<slug>`.
- Wholly reconstructed contributor behavior: author `Wibias <37517432+Wibias@users.noreply.github.com>` with maintainer as committer.
- Maintainer repairs or mixed redesign: maintainer author plus `Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>`.
- Commit message/body names source PR and exact source head. Future PR body says `Based on #139/#140 by @Wibias` and links the parent.
- No child may change `wibias/*`, `pr/139`, `pr/140`, or immutable `codex/source-*` refs.

## Docs-only cycle acceptance

- `001_hunk_ledger.tsv` has exactly 764 data rows: 276 for #139 and 488 for #140; no blank disposition or child mapping and zero multi-child parent rows.
- `001_hunk_fanout.tsv` gives each of 42 symbol/selector/key subrows one numeric child; seven `rewrite-fanout` parents receive no child credit.
- The eight textual conflicts and four clean shared paths have explicit synthesis ownership in `002_conflict_matrix.md`.
- The two monolithic new-file hunks have symbol/selector fan-out in `003_monolith_fanout.md`.
- All 24 implementation documents name exact paths, before/after behavior, exact test commands, rollback, and child base; the global attribution contract above applies to every child.
- Independent A-gate review returns PASS or GO-WITH-FIXES with every blocker folded into this unit.

## Prior-cycle continuity

Prior D direction: do not push the integration snapshots; classify all 764 hunks and build the first semantic child from `origin/dev`. This cycle locks that roadmap only. Implementation starts in the next PABCD cycle at 010.
