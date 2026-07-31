# WP151 — #140 Debug diagnostics

- Base/branch: WP150 tip -> `codex/wibias-140-07-debug-diagnostics`.
- MODIFY `gui/src/pages/Debug.tsx` and only Debug selectors assigned by `001_hunk_fanout.tsv`.
- Interview decision: take ALL Wibias Debug changes including layout. "Drop layout rewrites" rule overridden.
- Before -> after: broad Doctor rewrite -> isolated Debug behavior repair.
- Conditional activation: provider/usage/injection streams, empty output, request failure, and copy/download actions are exercised.
- Verification: `bun run --cwd gui doctor:full`; `bun run --cwd gui lint`; `bun run --cwd gui build`; `git diff --check`; diff <=500. Run `006_gui_qa_protocol.md` with `WP_ID=151 ROUTE='#debug'`; save provider/usage/injection/empty/failure/copy-download as `evidence/WP151/<state>.md` plus screenshot JSON.
- Rollback: Debug child reverts independently.
