# 010 — Decide NORMAL vs bug, then NOOP or smallest OpenCodex fix

Consumes 000_plan.md and 001_codex_opencodex_survey.md.
One work-phase only. Re-verify the trees before executing.

## Loop-spec

- Loop archetype: spec-satisfaction
- Trigger: docs-first D has locked the research
- Goal: recorded decision plus either NOOP or a proven OpenCodex-owned patch
- Non-goals: Codex source edits; product change to un-nest apply_patch for all routed models; merging PR 1576 unless wp-1 re-opens that as the asked defect
- Verifier: re-read the cited files; git rev-parse --abbrev-ref HEAD is dev; git merge-base --is-ancestor origin/dev HEAD; if patching, focused tests plus typecheck
- Stop: decision written back into this unit's close-out paragraph
- Activation: if the hide is still is_hidden_by_code_mode_only + catalog tool_mode=code_mode_only, the NOOP path is the intended activation

## File map

### READ-only re-verify

- /Users/jun/Developer/codex/120_codex-cli/codex-rs/core/src/tools/spec_plan.rs — is_hidden_by_code_mode_only, build_code_mode_executors
- /Users/jun/Developer/codex/120_codex-cli/codex-rs/features/src/lib.rs — Feature::CodeModeOnly
- /Users/jun/Developer/opencodex/src/codex/catalog/parsing.ts — applyRoutedCodexToolMode, normalizeRoutedCatalogEntry
- /Users/jun/Developer/opencodex/docs-site/src/content/docs/guides/codex-integration.md — routed local tools section
- /Users/jun/Developer/opencodex/structure/03_catalog-and-subagents.md — routed tool discovery section
- GitHub: issue 1544, PR 1576, PR 1361, commit f60dd981d

### Expected NOOP (default from 001)

No production file changes.

Record the decision in the D summary and mark this decade done.

Decision text that must be recorded:

- Classification: NORMAL (Codex CodeModeOnly hide) + OpenCodex intentionally stamps routed rows with that mode.
- Nested tools.apply_patch is the supported edit path for this session.
- Issue 1544 / PR 1576 are about undeclared top-level calls, not about restoring outer apply_patch.

### Contingent MODIFY only if re-verify flips the decision

If and only if live trees now show OpenCodex stripping a request-visible apply_patch that Codex actually advertised as an outer tool:

- NEW or MODIFY the smallest adapter/parser file that performs the strip
- NEW focused test next to the existing catalog/parser coverage
- Do not change ROUTED_CODEX_TOOL_MODE as a drive-by

Before/after for that contingent path cannot be written until the flip is observed. 001 currently predicts this branch stays dark.

## Accept criteria

- C-ACTIVATION: on a code_mode_only catalog row, outer tools lack apply_patch and exec description / ALL_TOOLS still name it.
- If NOOP: no src/ diff; decision recorded with citations.
- If fix: focused tests green and the strip no longer happens.

## OUT

- Do not land PR 1576 in this phase unless the user question is re-interpreted as undeclared top-level apply_patch should not abort silently.
- Do not push; that is 020.
## Exact B steps (copy-paste)

1. Confirm branch: git -C /Users/jun/Developer/opencodex rev-parse --abbrev-ref HEAD must print dev.
2. Confirm ancestry: git -C /Users/jun/Developer/opencodex merge-base --is-ancestor origin/dev HEAD; echo $?
3. Re-read these functions and confirm the hide still exists:
   - is_hidden_by_code_mode_only in spec_plan.rs
   - applyRoutedCodexToolMode / normalizeRoutedCatalogEntry in parsing.ts
4. If both still match 001, write 011_decision_record.md in this unit with:
   Classification: NORMAL
   OpenCodex role: intentional catalog stamp, not a strip bug
   Action: NOOP for src/
   Citations: the same files re-read in step 3
5. Do not modify src/, tests/, docs-site/, or structure/ on the NOOP path.
6. Only if step 3 finds OpenCodex deleting a request-visible apply_patch that Codex advertised as an outer tool, stop and amend this doc with the exact before/after before any patch.

## 011_decision_record.md template (NEW on NOOP)

    # 011 — Decision record

    Classification: NORMAL
    OpenCodex role: stamps routed rows with tool_mode=code_mode_only (PR 1361 / f60dd981d).
    Codex role: CodeModeOnly hides outer apply_patch and exposes tools.apply_patch inside exec.
    Action: NOOP. No src/ change. 020 skipped.
    Re-verified: <date> HEAD=<sha> files=<paths>

