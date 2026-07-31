# WP100 — #139 scoped styles, locale copy, and integration

- Base/branch: WP091 tip -> `codex/wibias-139-11-workspace-integration`.
- MODIFY the five scoped provider stylesheets and `gui/src/styles.css`: consolidate responsive rules, remove duplicate/legacy selectors, and keep one import per scope.
- Interview decision: mechanical consolidation. No design judgment — merge scoped styles, add consumed locale keys, delete unused selectors.
- MODIFY `gui/src/i18n/{en,de,ko,zh}.ts`: add only still-consumed keys, enforce parity, and preserve current translations not owned by #139.
- MODIFY `gui/package.json` only for the existing i18n lint target if still missing on the stack base.
- No new product behavior; this child closes cross-component visual/responsive and locale consistency.
- Before -> after: iterative 3,207-line stylesheet/large dormant locale blocks -> scoped selectors and consumer-backed keys.
- Verification: `bun run --cwd gui lint:i18n`; `bun run --cwd gui lint`; `bun run --cwd gui build`; `bun run typecheck`; `git diff --check`; diff <=500. Run `006_gui_qa_protocol.md` with `WP_ID=100 ROUTE='#providers'`, then `agbrowse resize 960 900 && agbrowse screenshot --full-page --json > devlog/_plan/260717_pr139_140_child_stack/evidence/WP100/960.screenshot.json`; save empty/overview/detail/modal/accounts/quota/json-warning as `evidence/WP100/<state>.md` plus screenshot JSON.
- Attribution: mixed repair commit with Wibias co-author when deleting source duplication.
- Rollback: revert integration cleanup without removing functional children 010-090.
