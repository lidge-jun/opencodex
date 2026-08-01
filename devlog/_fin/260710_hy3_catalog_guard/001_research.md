# Issue #82 HY3 Catalog Guard — Research Ledger

## External evidence (checked 2026-07-10)

| Status | Evidence | Consequence |
| --- | --- | --- |
| CONFIRMED | `https://opencode.ai/zen/go/v1/models` returned HTTP 200 and included `hy3-preview`. | A live-authoritative client will currently ingest the bad row. |
| CONFIRMED | Current OpenCode Go documentation and upstream Go UI source omit HY3. | The public catalog conflicts with the documented lite lineup. |
| CONFIRMED | Issue #82 records Console Go's HTTP 400: `hy3-preview` is not supported on the lite model list. | Keeping the row selectable is a reproducible client-facing defect. |
| CONFIRMED | `https://opencode.ai/inference/go/openai/v1/models` returned the public OpenCode 404 page. | The error's relative `/inference/...` path is not a safe replacement base URL. |
| CONFIRMED | Upstream PR #26533 added HY3 to Go on 2026-05-10; commit `c04fa9e` reverted public HY3 listings about 35 minutes later. | Treat availability as withdrawn/inconsistent, not a stable catalog addition. |
| INFERENCE | Backend allowlist and public `/zen/go/v1/models` are out of sync. | A narrow downstream catalog compatibility guard is justified until upstream converges. |

## Local code evidence

- `src/codex/catalog.ts:1088-1185` treats schema-valid live `/models` data as the
  authoritative provider lineup and caches it.
- `src/codex/catalog.ts:1219-1243` gathers all provider rows, augments jawcode metadata,
  then applies `shouldExposeRoutedModel` as the final exposure pass.
- `src/server/management-api.ts:341-358` uses gathered rows for the dashboard, and
  `src/server/index.ts:264-290` uses them for `/v1/models` after user visibility filters.
- `src/codex/catalog.ts:1425-1455` uses the same gathered rows for on-disk catalog sync.
- `tests/codex-catalog.test.ts:766-779` only proves the generated metadata bundle no
  longer resurrects HY3. It cannot reproduce a live `/models` response that contains it.
- A read-only mock of the current public seam returned
  `opencode-go/hy3-preview`, proving that the issue survives the existing regression.

## Existing mechanisms considered

- `disabledModels`: user-owned state; old/new installs would not inherit a project-wide
  compatibility policy.
- `selectedModels`: useful user allowlist, but a project default would freeze future rows.
- `liveModels: false`: suppresses all discovery and future valid models.
- jawcode metadata removal: already done, but live discovery bypasses that deletion.
- request-router rejection: does not remove the id from any picker.
- global id rejection: would wrongly hide `hy3-preview` under unrelated providers.

## Dirty-worktree baseline

Before this unit, local edits already existed in workflow files,
`src/codex/catalog.ts`, `tests/codex-catalog.test.ts`, `tests/kiro-retry.test.ts`, and
`tests/ci-workflows.test.ts`. The catalog edit adds dated-alias handling around the
live-discovery mapper. The HY3 guard will be placed in the existing exposure-policy
hunk so those edits remain intact.

