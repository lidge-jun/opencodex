# Monolithic source-hunk fan-out

## `ProviderWorkspace.tsx` source hunk `139-H090`

The +2,791-line source hunk is `rewrite`, never copied whole.

| Symbols/ranges in source snapshot | Child | Target ownership |
|---|---|---|
| shared types, labels, icon/status helpers, `RailRow` | 080 | `gui/src/components/provider-workspace/types.ts`, `provider-workspace/ProviderRail.tsx` |
| `ConnectionCard`, `StatsSidebar`, `TabOverview`, `TabModels`, `TabUsage` | 090 | one component per file under `gui/src/components/provider-workspace/` |
| `AuthAccountsCard`, `TabSettings`, JSON/unsaved/remove dialogs | 091 | `ProviderAuthPanel.tsx`, `ProviderSettings.tsx`, `ProviderJsonEditor.tsx`, `ProviderDialogs.tsx` |
| `DetailPanel`, `EmptyState`, `OverviewPanel`, scroll reveal | 080 then 090 | shell in 080, overview panels in 090; no file over 400 lines without written exception |

## `styles-provider-workspace.css` source hunk `139-H209`

The +3,207-line source hunk is `rewrite`. Iterative duplicate/legacy selectors are not retained.

| Selector family | Child | Target stylesheet |
|---|---|---|
| add-provider catalog/modal | 050 | `gui/src/styles/provider-catalog.css` |
| account pool/auth | 060 | `gui/src/styles/provider-accounts.css` |
| quota/usage | 070 | `gui/src/styles/provider-quota.css` |
| root layout, rail, search/filter | 080 | `gui/src/styles/provider-workspace-shell.css` |
| overview/models/usage tabs | 090 | `gui/src/styles/provider-workspace-detail.css` |
| auth/settings/JSON/dialogs | 091 | `gui/src/styles/provider-workspace-settings.css` |
| responsive consolidation and legacy selector deletion | 100 | the six scoped files above plus one import list in `gui/src/styles.css` |

## Locale fan-out

The large final locale hunks in `de.ts`, `en.ts`, `ko.ts`, and `zh.ts` are split with their owning behavior. Each child adds only keys it renders, and the existing locale parity/type gate must reject missing keys. No child lands hundreds of dormant `pws.*` strings ahead of its consumer. Exact parent/subrow ownership lives in `001_hunk_fanout.tsv`; this prose is explanatory only.

## PR #140 global stylesheet hunks

- `140-H391` contains only `.dash-info-btn` and `.dash-mode-toggle`; parent owner `140` (Dashboard), no fan-out.
- `140-H392` contains only the shared `dialog.modal-overlay`; parent owner `120` (modal foundation), no fan-out.
- `140-H393` has exactly three consumer groups in `001_hunk_fanout.tsv`: CodexAuth card selection -> `153`, AddCodexAccountModal utilities -> `120`, Dashboard help popup -> `140`. No absent page family receives credit.

## Size gate

Before each B, run `git diff --numstat <base>...HEAD` and `git diff --shortstat`. A child over 500 changed lines returns to P for another split. Generated lockfile movement is reported separately but does not excuse oversized handwritten code.
