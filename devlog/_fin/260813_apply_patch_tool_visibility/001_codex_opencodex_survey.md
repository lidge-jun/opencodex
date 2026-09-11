# 001 — Live-tree survey: why apply_patch is nested under exec

Research only. No diffs.

## Codex hide (expected)

Codex Feature::CodeModeOnly is documented as restricting the model-visible catalog to the code-mode entrypoints exec and wait.

- /Users/jun/Developer/codex/120_codex-cli/codex-rs/features/src/lib.rs:99 — Restrict model-visible tools to code mode entrypoints (exec, wait).
- /Users/jun/Developer/codex/120_codex-cli/codex-rs/core/src/tools/mod.rs:64-73 — effective_tool_mode() prefers model_info.tool_mode, else features.code_mode_only / features.code_mode.
- /Users/jun/Developer/codex/120_codex-cli/codex-rs/core/src/tools/spec_plan.rs:256 and :431-441 — is_hidden_by_code_mode_only() drops nested-eligible tools from the outer list unless they are DirectModelOnly.
- /Users/jun/Developer/codex/120_codex-cli/codex-rs/core/src/tools/spec_plan.rs:454-516 — build_code_mode_executors() re-exports those same specs inside exec.
- /Users/jun/Developer/codex/120_codex-cli/codex-rs/code-mode-protocol/src/description.rs:12-35 and :248-269 — exec description advertises nested tools on tools / ALL_TOOLS; in code_mode_only it inlines the nested specs.
- /Users/jun/Developer/codex/120_codex-cli/codex-rs/core/src/tools/handlers/apply_patch_spec.rs:9-26 — apply_patch remains a freeform custom tool.
- /Users/jun/Developer/codex/120_codex-cli/codex-rs/tools/src/code_mode_tests.rs:92-114 — locks the nested shape declare const tools: { apply_patch(input: string): Promise<unknown>; };
- /Users/jun/Developer/codex/120_codex-cli/codex-rs/core/src/tools/spec_plan_tests.rs:1032-1071 — code_mode_only_exposes_code_executor_and_hides_nested_tools.

Native GPT-5.6 rows already ship the same pair in both trees:

- gpt-5.6-sol / terra / luna: tool_mode=code_mode_only, apply_patch_tool_type=freeform
- Codex: /Users/jun/Developer/codex/120_codex-cli/codex-rs/models-manager/models.json
- OpenCodex snapshot: /Users/jun/Developer/opencodex/src/codex/data/upstream-models.json

Explorer subagents Aristotle and the Codex explorer both returned expected Codex behavior, not a Codex bug.

## OpenCodex catalog stamp (intentional, already on origin/dev)

OpenCodex does not delete apply_patch from a request tool list. It stamps routed catalog rows so Codex itself enters CodeModeOnly.

- src/codex/catalog/parsing.ts:337-341 ROUTED_CODEX_TOOL_MODE = code_mode_only
- src/codex/catalog/parsing.ts:381-384 normalizeRoutedCatalogEntry() always re-applies that mode
- structure/03_catalog-and-subagents.md:152-157 documents the pair with deferred MCP reachability through exec / ALL_TOOLS
- docs-site/src/content/docs/guides/codex-integration.md:208-216 says non-native routed rows use tool_mode: code_mode_only so Codex can expose official exec and nested MCP/Browser/Computer Use
- tests/codex-catalog.test.ts:2234-2240 and :2252-2260 pin the stamp
- src/adapters/tool-catalog-nudge.ts:9-46 only forbids neighbor-agent names that are already absent; it does not strip a present apply_patch

If Codex still sends a top-level custom apply_patch, OpenCodex keeps it:

- src/responses/parser.ts maps type: custom to freeform {input}
- src/responses/custom-tool-compat.ts passthroughs apply_patch and only converts exec

Explorer subagents Leibniz and the OpenCodex explorer returned NORMAL / MIXED-with-intended-stamp. Current HEAD == origin/dev == 570347304.

## Prior lineage

| Item | Decision | On origin/dev? |
| --- | --- | --- |
| PR 1361 / commit f60dd981d | Routed models get code_mode_only so local tools go through exec | yes |
| 30f48a0cf | Tests require that policy | yes |
| PR 1596 / fcbef381e | Restore deferred discovery on top of code-mode-only | yes |
| Issue 1544 (OPEN) | Nested exec -> tools.apply_patch is the working path; undeclared top-level apply_patch currently aborts | issue only |
| PR 1576 / b2c33e96b | Fail-close undeclared routed names; do not auto-convert top-level apply_patch into Code Mode | no (merge-base --is-ancestor false) |
| 1017 / 377 | Cursor structured-edit / freeform envelope | unrelated to desktop nesting |

Issue 1544 is a different defect: a routed model invents a top-level apply_patch after Codex already omitted it. This session's question is the designed hide, not that abort.

## Candidate decision for wp-1

Expected: NORMAL, with a MIXED footnote that OpenCodex selects the Codex surface on routed rows. Do not invent an un-nest. Do not merge PR 1576 as the answer to why apply_patch is only nested.
