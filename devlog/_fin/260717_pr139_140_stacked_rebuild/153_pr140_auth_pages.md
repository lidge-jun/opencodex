# WP153 — #140 ApiKeys and CodexAuth diagnostics

- Base/branch: WP152 tip -> `codex/wibias-140-09-auth-page-diagnostics`.
- MODIFY `gui/src/pages/ApiKeys.tsx` and the post-WP060 `gui/src/components/CodexAccountPool.tsx`; do not recreate deleted `gui/src/pages/CodexAuth.tsx` ownership.
- Interview decision: take ALL Wibias auth-page changes including layout.
- MODIFY `tests/desktop-3p.test.ts` only for the retained auth-page contract.
- MODIFY only ApiKeys/CodexAuth selectors assigned by `001_hunk_fanout.tsv`.
- Before -> after: source changes against a renamed page -> diagnostics replayed onto the extracted account owner.
- Conditional activation: no keys, masked keys, add/remove failure, no accounts, and reauth-required states are exercised.
- Verification: `bun test tests/desktop-3p.test.ts tests/codex-auth-api.test.ts`; `bun run --cwd gui doctor:full`; `bun run --cwd gui lint`; `bun run --cwd gui build`; `git diff --check`; diff <=500. Run `006_gui_qa_protocol.md` twice with `WP_ID=153-api ROUTE='#api'` and `WP_ID=153-auth ROUTE='#codex-auth'`; save no-keys/masked/add-remove-failure/no-accounts/reauth in the matching evidence directories.
- Rollback: auth-page diagnostics revert without removing WP060 account functionality.
