# 260813_apply_patch_tool_visibility — outer vs nested apply_patch

## Objective

Explain why a Codex desktop session can list apply_patch only as a nested
exec tool (tools.apply_patch) and not as a first-class outer tool. Decide
NORMAL / OPENCODEX_BUG / CODEX_BUG / MIXED from live trees, then either fix
OpenCodex on dev and push, or record NOOP.

Live session that triggered this unit (2026-08-13, Codex desktop, cwd
/Users/jun/Developer/opencodex):

- Outer available tools: exec, wait, request_user_input, web_search.
- Nested inside exec: tools.apply_patch is a function; ALL_TOOLS lists apply_patch.
- Direct outer apply_patch is not in the model-visible catalog.

## Loop-spec

- Loop archetype: spec-satisfaction investigation, then repair only if OpenCodex-owned.
- Trigger: desktop/code-mode session reports outer apply_patch missing while nested tools.apply_patch still works.
- Goal: evidence-backed decision plus either a smallest OpenCodex fix on origin/dev or an explicit NOOP.
- Non-goals: changing Codex source; forcing every model onto a top-level apply_patch; merging unrelated open PR 1576 unless this unit proves that is the defect being asked about; touching unrelated dirty/untracked files.
- Verifier: cited Codex + OpenCodex files/functions; prior issue/PR/commit lineage; if a fix lands, bun run typecheck plus focused tests, then git push origin HEAD:dev.
- Stop: decision recorded and either pushed fix or NOOP evidence.
- Memory: this unit + goalplan determine-why-this-codex-desktop-session-exposes.
- Terminal: DONE / NOOP / BLOCKED / UNSAFE / NEEDS_HUMAN / BUDGET_EXHAUSTED.
- Escalation: three failed repairs return to P; do not reset unrelated worktrees.

## Dependency-ordered work-phase map

1. wp-0 (this cycle, docs-only): research the Codex hide + OpenCodex catalog stamp + prior lineage, then lock decade docs.
2. wp-1 (010_decision_and_noop_or_fix.md): re-verify the trees, decide, and either record NOOP or implement the smallest OpenCodex-owned fix.
3. wp-2 (020_push_and_close.md): only if wp-1 produced a code change — run gates, commit, push origin/dev. If wp-1 is NOOP, this phase is unused.

No effort buckets. Implementation cannot start until this docs cycle closes.

## IN / OUT

IN:

- /Users/jun/Developer/opencodex on dev matching origin/dev
- public-safe notes in this unit
- production src/ only if the defect is proven OpenCodex-owned

OUT:

- edits to /Users/jun/Developer/codex
- reset/rebase/clean of unrelated dirty or untracked files
- starring, new issues, or new PRs unless later asked
- inventing a product change that un-nests apply_patch for all routed models

## Risks

- Confusing the designed code_mode_only hide with the separate issue 1544 undeclared top-level call abort.
- Landing PR 1576 as if it restored outer apply_patch; that PR keeps the nested path and only fail-closes invented names.
- Changing tool_mode would re-expand the outer catalog and undo the routed Computer Use / browser / payload work from PR 1361 and PR 1596.
