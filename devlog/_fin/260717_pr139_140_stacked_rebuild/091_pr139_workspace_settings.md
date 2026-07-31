# WP091 — #139 auth, settings, JSON editor, and dialogs

- Base/branch: WP090 tip -> `codex/wibias-139-10-workspace-settings`.
- NEW `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`, `ProviderSettings.tsx`, `ProviderJsonEditor.tsx`, `ProviderDialogs.tsx` from `139-H090` subrow `PW-04`.
- Interview decision: settings/auth panel split from WP090. Files: ProviderAuthPanel.tsx (OAuth/account cards, login flow), ProviderSettings.tsx (adapter, baseUrl, defaultModel, headers editing), ProviderJsonEditor.tsx (raw JSON with unsaved/dirty detection), ProviderDialogs.tsx (remove confirm, auth failure, unsaved leave). Each file ≤400 lines.
- MODIFY `ProviderWorkspaceShell.tsx` and `gui/src/pages/Providers.tsx` only to connect WP040/WP060 handlers and JSON state.
- NEW `gui/src/styles/provider-workspace-settings.css`; add only auth/settings/JSON/dialog locale keys assigned by `001_hunk_fanout.tsv`.
- MODIFY `tests/provider-workspace-state.test.ts`: invalid JSON location, unsaved leave, restore, remove confirm, auth failure, and unavailable-key states.
- Before -> after: settings/auth/dialog logic inside one 2,791-line component -> bounded owners with explicit state guards.
- Conditional activation: every state listed above is triggered in `tests/provider-workspace-state.test.ts` and the WP091 state procedure from `006_gui_qa_protocol.md`.
- Verification: `bun test tests/provider-workspace-state.test.ts`; `bun run --cwd gui lint`; `bun run --cwd gui build`; `git diff --check`; diff <=500. Run `006_gui_qa_protocol.md` with `WP_ID=091 ROUTE='#providers'`; save invalid-json/unsaved-leave/remove-confirm/auth-failure in `evidence/WP091/<state>.md` plus screenshot JSON.
- Rollback: settings child reverts without removing WP090 read-only overview/models/usage.
