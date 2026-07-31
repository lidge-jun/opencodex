# WP141 — #140 Usage query migration

- Base/branch: WP140 tip -> `codex/wibias-140-05-usage-query`.
- Interview decision: take ALL Wibias Usage changes (currently 603 lines). Split into sub-children at P if needed.
- MODIFY only Usage selectors assigned from PR140 `gui/src/styles.css` in `001_hunk_fanout.tsv`.
- Before -> after: mirrored request state and in-component churn -> query-derived Usage state with output parity.
- Conditional activation: loading, error, empty, refetch, zero-token, and date-range states are driven through the WP141 procedure from `006_gui_qa_protocol.md`.
- Verification: `bun run --cwd gui doctor:full`; `bun run --cwd gui lint`; `bun run --cwd gui build`; `git diff --check`; diff <=500. Run `006_gui_qa_protocol.md` with `WP_ID=141 ROUTE='#usage'`; save loading/error/empty/refetch/zero-token/date-range in `evidence/WP141/<state>.md` plus screenshot JSON.
- Rollback: Usage child reverts independently from Dashboard and later pages.
