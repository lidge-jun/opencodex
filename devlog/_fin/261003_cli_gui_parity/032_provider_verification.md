# wp3 — Provider operations use the selected management authority

The seven provider-management task rows now have direct terminal workflows. Explicit --live add/remove/set-default operate on the selected running proxy, while omission retains local configuration behavior. Provider edit exposes HTTP version, Fast and provider context-window controls; pacing exposes configured rules and runtime observations separately. Non-secret snapshot/apply uses the same public editor contract and stale-baseline validation as the GUI.

## Contracts delivered

All new live requests use fixed routes, one pinned management address and redirect refusal. Live add reads target presets and roster, with explicit --force for an observed existing row; its preflight remains an upsert race, not an atomic create-only guarantee. Live remove --yes delegates dependency/default/custom-model/account cleanup to one server DELETE. Batch replacements remain one PUT and do not claim single-DELETE OAuth cleanup. A stale baseline returns conflict without refresh/rebase/retry.

The bounded JSON helper shares the server limit, checks the serialized composite, accepts explicit non-TTY stdin or regular files, decodes strict UTF-8/BOM and performs owned-resource cleanup with static diagnostics. Canonical public DTO validation rejects secret, derived and unknown editor fields without echoing them. Pacing scalar edits retain observed model rules but are whole-block replacements without CAS; numeric edits never enable pacing implicitly.

Local --sync runs before JSON output. The CLI distinguishes config injection from catalog convergence, reports safe configApplied/catalog evidence, and keeps needsSync plus nonzero exit for incomplete application. The existing backend now carries its optional refreshOutcome through applied results; it changes no synchronization action or retry. A current unchanged catalog succeeds without requiring a write. Canonical provider invariants remain enforced for the added local auth/path options.

## Review and evidence

Same-architect reflection and independent general/security plan audits passed before B. Independent functional and security code reviewers finished PASS after correction and re-review. Their scratch receipts are `.tmp/cli-parity/wp3-code-review.md` and `wp3-security-code.md`; the last verdict is authoritative and earlier failures remain historical evidence.

The four implementation slices passed 49 input, 61 lifecycle, 60 settings and 46 batch tests. Batch tests include actual isolated server round-trip and stale-CAS behavior. Integration passed 378 tests across 14 files before the final backend-result cases; the actual-backend sync regression file then passed 19 cases, and six existing backend files passed 116 tests/557 assertions. Final discovery/file-size validation passed 87 tests. Two actual CLI subprocess regressions verified saved-but-stopped --sync behavior with explicitly stubbed liveness and denied networking; they no longer assume a developer machine has no discoverable proxy. Final source-bound commands/results are archived with this work phase's receipt and reported on the PR.

Seventeen actual CLI scenarios ran with an injected management fixture and all sockets forbidden: help, snapshot, file and BOM/stdin apply, stale conflict, custom live add, observed-existing refusal, default selection, pacing read/scalar write, saved-but-pending edit, deletion confirmation and accepted deletion, live/sync conflict, stopped target, conflicting stdin sources and malformed JSON. Request traces verify fixed methods/bodies and redirect refusal; fixture state shows accepted writes, and application home files remain unchanged. Main inspected the partial JSON receipt and actionable stale-baseline stderr. All child processes ended and the temporary home was removed. This proves real CLI parsing/output/exit/transport behavior against a fixture, not live-provider acceptance; separate real server tests establish persistence/CAS semantics. Evidence lives under `.codexclaw/evidence/01a10024-8d6f-7500-b528-38212c4bc396/qa/parity-wp3/`.

## Limits and next work

Full/changed local suites were not repeated across concurrent worktrees; focused CLI, indirect source-oracle, real server and backend regressions cover the layer, with broader/platform proof required from the exact-head hosted CI. No live user configuration, secret, paid request, service restart or deployment was used. No skipped CI/platform check is counted as a pass.

Pacing PATCH and add preflight do not gain CAS, snapshots do not bind a future invocation to a process, and batch deletion does not become credential erasure. A contrary result in any of those contracts must reopen this phase. The rejected hypothesis was that backend applied/ok alone proved model synchronization; actual backend fixtures showed why the catalog evidence must survive. wp4 proceeds from the separate models/routing plan with a fresh P/A cycle. This layer is the child of PR #6526, not a new integration branch.

## Hosted CI follow-up

The first hosted run at 604086504b found two omitted regression consumers: the provider help example allowlist lacked pacing/snapshot, and the older headless-parity fixture returned generic ok:true for provider PATCH instead of the actual success/name/flags/catalog receipt. Corrected those two test fixtures without weakening production receipt validation or changing handlers. The two affected files plus file-size regression passed 115 tests/746 assertions. A new exact-head hosted run is required; the earlier failed run is retained as evidence, not relabeled as passing.
