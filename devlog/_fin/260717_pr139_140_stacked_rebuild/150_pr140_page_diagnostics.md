# WP150 — #140 ClaudeCode diagnostics

- Base/branch: WP141 tip -> `codex/wibias-140-06-claudecode-diagnostics`.
- MODIFY `gui/src/pages/ClaudeCode.tsx` and only its assigned selectors in `gui/src/styles.css`.
- Interview decision: take ALL Wibias ClaudeCode changes including layout. "Drop layout rewrites" rule overridden.
- Before -> after: broad ClaudeCode rewrite -> bounded page-local repair with behavior parity.
- Verification: `bun run --cwd gui doctor:full`; `bun run --cwd gui lint`; `bun run --cwd gui build`; `git diff --check`; diff <=500. Run `006_gui_qa_protocol.md` with `WP_ID=150 ROUTE='#claude'`; save setup/loading/error as `evidence/WP150/<state>.md` plus screenshot JSON.
- Rollback: ClaudeCode child reverts independently; Debug/Logs/Auth/Subagents are WP151-154.
