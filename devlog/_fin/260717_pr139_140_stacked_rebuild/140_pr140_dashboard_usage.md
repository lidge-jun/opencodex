# WP140 — #140 Dashboard query migration

- Base/branch: WP130 tip -> `codex/wibias-140-04-dashboard-usage-query`.
- Interview decision: take ALL Wibias Dashboard changes (currently 1671 lines). Split into sub-children at P to stay under 500-line gate.
- MODIFY `gui/src/styles.css` only for Dashboard selectors assigned by `001_hunk_fanout.tsv`.
- Before -> after: mirrored query data/setState-in-effect and repeated computation -> query-derived state with behavior parity.
- Explicit drops: visual redesign, large helper inlining, or formatting churn not required to clear a named diagnostic.
- Conditional activation: loading/error/empty/refetch and editable-state transitions are exercised; no render-time state loop.
- Verification: `bun run --cwd gui doctor:full`; `bun run --cwd gui lint`; `bun run --cwd gui build`; `git diff --check`; diff <=500. Run `006_gui_qa_protocol.md` with `WP_ID=140 ROUTE='#dashboard'`; save loading/error/empty/refetch in `evidence/WP140/<state>.md` plus screenshot JSON.
- Rollback: Dashboard child reverts independently; Usage is WP141.
