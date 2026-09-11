# 011 — Decision record

Classification: NORMAL

OpenCodex role: stamps routed rows with tool_mode=code_mode_only (PR 1361 / f60dd981d).
Codex role: CodeModeOnly hides outer apply_patch and exposes tools.apply_patch inside exec.
Action: NOOP. No src/ change. 020 skipped.

Re-verified: 2026-08-13T08:47+09:00
HEAD=5703473041a9f4f415743652de5d86d51fd66db5
branch=dev
origin/dev ancestor: yes (merge-base --is-ancestor origin/dev HEAD exit 0)
src/tests/structure/docs-site dirty: none

Files still present:

- /Users/jun/Developer/codex/120_codex-cli/codex-rs/features/src/lib.rs:99 Feature::CodeModeOnly
- /Users/jun/Developer/codex/120_codex-cli/codex-rs/core/src/tools/spec_plan.rs:431 is_hidden_by_code_mode_only
- /Users/jun/Developer/codex/120_codex-cli/codex-rs/core/src/tools/spec_plan.rs:454 build_code_mode_executors
- /Users/jun/Developer/codex/120_codex-cli/codex-rs/core/src/tools/mod.rs:64 effective_tool_mode
- /Users/jun/Developer/opencodex/src/codex/catalog/parsing.ts:337-384 ROUTED_CODEX_TOOL_MODE / applyRoutedCodexToolMode / normalizeRoutedCatalogEntry
- /Users/jun/Developer/opencodex/docs-site/src/content/docs/guides/codex-integration.md:208
- /Users/jun/Developer/opencodex/structure/03_catalog-and-subagents.md:153

Separate open defect, not this question: issue 1544 / PR 1576 undeclared top-level apply_patch abort. That PR is not on origin/dev and would not restore an outer apply_patch.
