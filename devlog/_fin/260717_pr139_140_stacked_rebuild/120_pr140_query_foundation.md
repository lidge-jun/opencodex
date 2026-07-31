# WP120 — #140 query/client and modal foundations

- Base/branch: WP110 tip -> `codex/wibias-140-02-query-modal-foundation`.
- MODIFY `gui/src/main.tsx`, `gui/src/api.ts`, `gui/src/i18n/provider.tsx`, `gui/src/App.tsx`: install/reuse one query client/provider and stable API helpers without changing #139 routes.
- Interview decision: take ALL Wibias GUI changes, not just Doctor diagnostics. If diff exceeds 500 lines, split into sub-children at P.
- MODIFY post-#139 `AddCodexAccountModal` and `AddProviderModal` modules only for verified focus, dialog semantics, and state ownership findings.
- MODIFY `src/codex/auth-api.ts` only when required by the account modal contract and with a focused API test.
- MODIFY `tests/codex-auth-api.test.ts` for account status/error contracts and `tests/provider-workspace-data.test.ts` for query-key/preset derivation that remains pure.
- Before -> after: page-local mirrored fetch state -> shared query/client foundation; inaccessible modal edges -> explicit labels/focus/escape behavior.
- Conditional activation: rejected request, modal cancel/escape, and stale-query refresh paths are triggered in tests.
- Verification: `bun test tests/codex-auth-api.test.ts tests/provider-workspace-data.test.ts`; `bun run --cwd gui lint`; `bun run --cwd gui build`; `git diff --check`; diff <=500. Run `006_gui_qa_protocol.md` with `WP_ID=120 ROUTE='#providers'`; save modal-cancel/modal-escape/request-failure in `evidence/WP120/<state>.md` plus screenshot JSON.
- Rollback: query provider/modal diagnostics revert without changing the #139 workspace data/API contracts.
