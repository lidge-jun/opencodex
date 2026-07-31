# 2026-06-23 PR #16/#22 Integration Result

## Integrated Commits

- `38bca18 feat: allow static provider model catalogs`
  - Absorbs PR #16 from `0disoft`.
  - Adds `liveModels?: boolean`.
  - Keeps live `/models` discovery as the default.
  - Makes `liveModels:false` an exact configured model allowlist.
  - Documents empty `models` behavior in English, Korean, and Chinese configuration references.

- `47defbe fix: repair anthropic tool result history`
  - Absorbs PR #22 from `jaekwonhong`.
  - Folds adjacent tool results after assistant tool uses.
  - Synthesizes missing tool results as Anthropic `is_error` tool results.
  - Preserves orphan and duplicate tool results as text instead of invalid standalone `tool_result` blocks.
  - Preserves image/non-string tool-result content blocks.

- `e586acd fix: honor static allowlists during catalog augmentation`
  - Follow-up from read-only verification.
  - Prevents jawcode metadata augmentation from appending `opencode-go` rows when that provider has `liveModels:false`.
  - Adds exact allowlist and empty static allowlist regressions.

## Verification Evidence

- Focused before fix:
  - `bun test tests/codex-catalog.test.ts`: 22 pass.
  - `bun test tests/adapter-usage.test.ts tests/umans-provider.test.ts`: 21 pass.
  - `bun run typecheck`: pass.

- Full after integration:
  - `bun run typecheck`: pass.
  - `bun test tests`: 163 pass before follow-up, then 165 pass after follow-up.
  - `cd docs-site && bun install --frozen-lockfile && bun run build`: 46 pages built.
  - `git diff --check`: pass.

- Read-only verification:
  - First verifier found a real `opencode-go` augmentation issue for `liveModels:false`.
  - Second verifier returned DONE after `e586acd`.
  - Focused verifier run: catalog + adapter tests 39 pass and typecheck pass.

## GitHub Closeout

After `origin/dev` is updated, close:

- PR #16 as absorbed into `dev`.
- PR #22 as absorbed into `dev` despite draft status, per maintainer instruction.
