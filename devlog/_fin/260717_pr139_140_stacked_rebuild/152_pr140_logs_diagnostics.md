# WP152 — #140 Logs diagnostics

- Base/branch: WP151 tip -> `codex/wibias-140-08-logs-diagnostics`.
- MODIFY `gui/src/pages/Logs.tsx` and only Logs selectors assigned by `001_hunk_fanout.tsv`.
- Interview decision: take ALL Wibias Logs changes including layout. "Drop layout rewrites" rule overridden.
- Before -> after: mixed Logs rewrite -> isolated virtualization/accessibility repair.
- Conditional activation: empty list, large virtualized list, filtered list, and missing timing metadata are exercised.
- Verification: `bun run --cwd gui doctor:full`; `bun run --cwd gui lint`; `bun run --cwd gui build`; `git diff --check`; diff <=500. Run `006_gui_qa_protocol.md` with `WP_ID=152 ROUTE='#logs'`; save empty/large-list/filtered/missing-timing as `evidence/WP152/<state>.md` plus screenshot JSON.
- Rollback: Logs child reverts independently.
