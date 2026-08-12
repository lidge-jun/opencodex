# 140 — Phase 15: effort-picker fail-closed + Pi loopback export (PRs #1092, #1085)

Credit: **Eachann** (`关俊江 <email from PR head>`, PR #1092) and **n3wr1ch**
(`n3wr1ch <email from PR head>`, PR #1085).
Adoption: **adapted** — the two bug cores are extracted from two large PRs.

Both slices are small, independent, and touch different files, so they share one
stack phase rather than splitting into two near-empty PRs. If review prefers
them separate, the phase splits cleanly at the file boundary.

## Defect A — effort picker (Eachann, #1092)

A model whose capability ladder is unknown disappears from the effort picker
entirely, instead of being offered with no forced default.

File list read from `gh pr diff 1092` against `dev` = `e9d957bf6`.

| Path | Op | Content |
|------|----|---------|
| `gui/src/combo-workspace-data.ts` | ADAPT | Treat an unknown capability ladder as a wildcard **for picker availability only** |
| `src/combos/request.ts` | ADOPT (+14) | Continue omitting the runtime default when support is unknown — the runtime stays fail-closed |
| `src/combos/types.ts`, `src/combos/index.ts`, `src/types.ts` | ADOPT (+6/+1/+6) | Supporting types |
| `src/server/management/combo-routes.ts` | ADOPT (+13/−~2) | Route plumbing for the picker contract |
| `src/server/responses/core.ts` | ADOPT (+4) | Runtime guard |
| `tests/combo-workspace-data.test.ts` | ADOPT (+47/−~4) | Unknown-ladder model appears in the picker |
| `tests/combos.test.ts`, `tests/combo-management-api.test.ts`, `tests/server-combo-failover-e2e.test.ts` | ADOPT (+26/+27/+17) | Runtime fail-closed behavior end to end |
| `tests/codex-catalog.test.ts` (#1092: +211) | DROP | Belongs to the dropped catalog fallback synthesis |
| The #1092 copy/`imageInput`/locale files | DROP | Feature work, not this defect |

**Dropped from #1092:** catalog fallback synthesis, public-name copy redesign,
`imageInput` policy, and locale churn. The PR also fails `git diff --check` on
an added EOF blank line, which the extraction avoids.

## Defect B — Pi loopback export (n3wr1ch, #1085)

Pi's exported client config references an unresolved environment variable, so
loopback models vanish for a user with no API key set.

File list read from `gh pr diff 1085` against `dev` = `e9d957bf6`.

| Path | Op | Content |
|------|----|---------|
| `src/clients/config-export.ts` | ADAPT (#1085: +46/−~29) | Use the existing non-secret loopback placeholder instead of the unresolved env reference, and declare no required environment variable for Pi. **Dropped** from the same file: the generalized export-policy rewrite |
| `tests/client-config-export.test.ts` | ADOPT (+19/−~11) | Serializer output for Pi with no key set |
| `tests/management-client-config-route.test.ts` | ADOPT (+76/−~2) | Route-level output |
| `tests/client-config-export-new-clients.test.ts`, `tests/client-config-new-clients.test.ts` | ADOPT (+4 each) | Client-matrix alignment |
| `src/cli/export-command.ts` (#1085: +20/−~11), `src/cli/opencode.ts` (+13/−~4), `src/server/management/model-rows.ts` (+25/−~10), `tests/cli-export-command.test.ts` (+87/−~2) | DROP | Combo/direct-mode filtering and cross-client contract churn |
| `src/combos/index.ts` (#1085: +1), `src/combos/types.ts` (#1085: +15) | DROP **#1085 hunks only** | These two files are also touched by #1092 in slice A above, and **those hunks are adopted**. Only #1085's additions — its direct-mode combo filtering — are excluded. When implementing, take the #1092 hunks and skip the #1085 ones rather than reverting the file |

**Dropped from #1085:** combo/direct-mode filtering, cross-client contract
changes, and generalized export-policy churn across 31 files.

## Verification

- `bun test` on the combo/config-export suites
- `bun run typecheck`
- `bun run lint:gui` and `bun run build:gui` (this phase touches `gui/`)
- `bun run privacy:scan`
- GUI screenshot required in the PR description by repository policy

## PR

Stack 14, base = stack 13 head. Credits Eachann and n3wr1ch, and lists what was
intentionally left in their original PRs.
