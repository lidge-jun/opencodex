# WP5 — #389 model-switch visibility + ocx sync relationship (040)

PR #389 `fix(models): make switches reflect final visibility` (head
`csa906:codex/fix-models-selected-visibility`, +677/-71).

## Findings (Sol explorer, read-only)

Real dashboard bug: a switch showed ON whenever a model was absent from
`disabledModels`, even if a non-empty provider `selectedModels` allowlist still
excluded it. #389 computes final visibility = `selectedModels allows &&
!disabledModels blocks` (`gui/src/model-visibility.ts:36-55`), uses it for
counts/ordering/bulk state (`gui/src/pages/Models.tsx:201-271,783-807`), and adds
`PUT /api/model-visibility` updating both filters in one save
(`src/server/management/model-routes.ts:132-228`). Earlier reviewer findings
fixed in `b89c5399`/`792baab4`; regressions at
`tests/model-visibility-management-api.test.ts:96-245`.

### ocx sync relationship

Shared downstream catalog regen path, but #389 does NOT change the CLI sync impl:
visibility persists via atomic `saveConfig()` (`src/config.ts:775-786`);
`syncCatalogModels()` applies `filterCatalogVisibleModels()` and writes the Codex
catalog (`provider-fetch.ts:424-444`, `sync.ts:455-496`); `ocx sync` loads config
→ `refreshCodexModelCatalog()` (`cli/index.ts:621-623`, `codex/sync.ts:30-77`).
The new route immediately refreshes after save (`model-routes.ts:225-228`).
Conclusion: no semantic conflict; `ocx sync` reproduces the same visibility; a
simultaneous CLI sync is an existing last-writer race, not introduced by #389.

## Decision: merge-with-note

Logically correct, well-tested; no correctness blocker. #389 is GUI-touching and
NOT in the user's named GUI-merge scope (only #393/#340 were). So WP5 = A-gate
review + re-check full CI; if green, post a merge-with-note review and confirm
with user before the GUI merge, OR merge if maintainer scope clearly allows.

Actions:
1. `gh pr checks 389` — require full matrix green (not just target/label).
2. A-gate Sol reviewer.
3. Post merge-with-note; merge only if in approved GUI scope.

Terminal: DONE = merged SHA OR merge-readiness note posted.
