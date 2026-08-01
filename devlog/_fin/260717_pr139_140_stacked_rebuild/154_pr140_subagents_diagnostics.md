# WP154 — #140 Subagents diagnostics

- Base/branch: WP153 tip -> `codex/wibias-140-10-subagents-diagnostics`.
- MODIFY `gui/src/pages/Subagents.tsx` and only Subagents selectors assigned by `001_hunk_fanout.tsv`.
- Interview decision: take ALL Wibias Subagents changes including layout. "Drop layout rewrites" rule overridden.
- Before -> after: broad mechanical edit -> isolated Subagents page diagnostics.
- Conditional activation: empty list, filtered results, sort direction, action success, and action failure are exercised.
- Verification: `bun run --cwd gui doctor:full`; `bun run --cwd gui lint`; `bun run --cwd gui build`; `git diff --check`; diff <=500. Run `006_gui_qa_protocol.md` with `WP_ID=154 ROUTE='#subagents'`; save empty/filter/sort/action-success/action-failure as `evidence/WP154/<state>.md` plus screenshot JSON.
- Rollback: Subagents child reverts independently; WP160 update work begins after this tip.
