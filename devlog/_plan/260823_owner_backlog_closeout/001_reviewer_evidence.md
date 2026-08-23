# 001 — Reviewer evidence, verbatim verdict blocks

Eleven read-only `gpt-5.6-sol` reviewers at high effort, priority tier, all
dispatched in parallel against `origin/dev` head `bf8bcfd3c` on 2026-08-23.
Each was told not to write, patch, merge, or touch the orchestration FSM. The
verdict blocks below are their closing output, unedited except for trimming
leading prose.

## PR #2439

```
VERDICT: PASS_WITH_NITS
RECOMMENDED_DISPOSITION: SQUASH_MERGE
RISK: low
NITS:
- tests/compatibility-manifest.test.ts:67 The graph guard skips every dynamic import, including a direct `import("../compatibility")` from a protected core file, creating a future false-negative. Current code has no such edge; consider mirroring the direct-dynamic-import check in `core-lab-boundary.test.ts`.
TESTS_RUN: `bun test tests/compatibility-manifest.test.ts` -> 6 pass, 0 fail; `bun test tests/core-lab-boundary.test.ts` -> 13 pass, 0 fail; `cd docs-site && bun run build` -> passed, 393 pages built
CI: `gh pr checks 2439` -> 23 passed, 1 intentionally skipped, 0 failed or pending at head `0225f2b9`
SUMMARY: The PR adds a strict V1 manifest schema/catalog and one canonical OpenAI Codex-forward contract for `gpt-5.6-sol`, backed by production-adapter fixtures and synchronized documentation. Export and call-site tracing found no dropped exports, import cycles, core-to-manifest/Lab edges, sensitive logging, or credential exposure. Focused tests, the documentation build, and exact-head cross-platform CI are green. The minor guard gap does not affect the current tree, so the PR should land after the required maintainer approval.
```

## PR #2437

```
VERDICT: PASS
RECOMMENDED_DISPOSITION: MERGE
RISK: low
NITS: none
TESTS_RUN: bun test tests/codex-history-provider.test.ts tests/codex-native-residue.test.ts tests/core-lab-boundary.test.ts -> 142 passed, 0 failed
CI: 23 passed, 1 expected matrix job skipped, 0 failed or pending
SUMMARY: The PR extracts manifest types, provenance validation, path identity, and backup IDs into a pure builtin-only leaf. Both callers preserve their existing filesystem, SQLite, mutation, and diagnostic responsibilities, with no dropped exports or import cycle. The core/Lab boundary remains intact, and no request-body, credential, or logging behavior changed. The PR is complete, focused, and safe to land.
```

## PR #2435

```
VERDICT: PASS
RECOMMENDED_DISPOSITION: SQUASH_MERGE
RISK: low
NITS:
- None.
TESTS_RUN: bun test --isolate --parallel=4 tests/responses-fetch-helpers-boundary.test.ts tests/fetch-header-timeout.test.ts tests/request-pacing.test.ts tests/upstream-http-version.test.ts tests/ws-upstream.test.ts tests/core-lab-boundary.test.ts -> 71 passed, 1 skipped, 0 failed across 6 files
CI: 23 checks passed, 1 conditional Windows shard skipped; aggregate Cross-platform CI succeeded on exact head be6ea98a019541256b0d59dd0c082ae86724dac3
SUMMARY: The PR removes stale runtime imports from src/server/responses/fetch-helpers.ts:1 while preserving its complete export surface and byte-identical helper implementations. The regression at tests/responses-fetch-helpers-boundary.test.ts:43 correctly pins the three permitted runtime edges and rejects computed dynamic-import bypasses. The focused transport tests and core/Lab transitive boundary guard pass, with no cycle, logging, credential, request-body, routing, or behavior change found. The PR targets dev, satisfies issue #2434, and has a complete template and green exact-head CI, so it should land.
```

## PR #2433

```
VERDICT: FAIL
RECOMMENDED_DISPOSITION: NEEDS_CHANGES
RISK: medium
BLOCKERS:
- src/server/responses/core.ts:1974 Native forward/pool passthrough already records `response.failed` in its eager or tee inspector, then this new call records the same physical terminal again; one 502 therefore adds two consecutive account failures and can soft-avoid or rotate a healthy credential earlier than configured.
NITS: none
TESTS_RUN: `bun test tests/combos.test.ts tests/combo-stream-preflight.test.ts tests/server-combo-failover-e2e.test.ts tests/core-lab-boundary.test.ts` -> 126 passed, 0 failed, 694 assertions
CI: `gh pr checks 2433` -> 23 passed, 1 skipped, 0 failed at head `3ec2b1a6c7`
SUMMARY: The PR adds bounded SSE preflight so failover combos can retry terminal failures before output, plus model-lifecycle HTTP 410 classification and synchronized documentation. Its stream commit boundary, attempt receipts, usage handling, marker preservation, and Lab isolation otherwise look sound. Focused exact-head tests and repository CI are green. It should not land until native account terminal accounting is made exactly-once and covered by regression testing.
```

## PR #2387

```
VERDICT: PASS_WITH_NITS
RECOMMENDED_DISPOSITION: SQUASH_MERGE
RISK: medium
NITS:
- tests/process-state.test.ts:6 Add durable EPERM and cheap-vs-destructive PID identity characterization.
- tests/config.test.ts:2216 Remove duplicated process-state characterization after preserving facade/path coverage.
TESTS_RUN: bun test tests/process-state.test.ts tests/config.test.ts tests/process-control.test.ts tests/proxy-liveness.test.ts tests/port-reclaim.test.ts tests/service.test.ts tests/update-job.test.ts tests/core-lab-boundary.test.ts -> 472 pass, 0 fail; bun test tests/stale-state-purge.test.ts -> 4 pass, 0 fail; synthesized current-dev merge -> 473 pass, 0 fail and typecheck passed
CI: gh pr checks 2387 -> 29 pass, 1 skipped, 0 failures
SUMMARY: The PR extracts OpenCodex-home paths, atomic writes, and PID/runtime-port ownership into three acyclic config leaf modules while retaining `src/config.ts` compatibility exports. Lifecycle, management, service, OAuth, and update callers now import process state directly without changing their destructive identity checks. No request-body/API-key logging, Bun incompatibility, dropped runtime export, import cycle, or core-to-Lab edge was found. It should land; the two test-ownership nits are non-blocking.
```

## PR #2380

```
VERDICT: PASS
RECOMMENDED_DISPOSITION: MERGE
RISK: low
TESTS_RUN: bun test tests/provider-config-validation.test.ts tests/management-provider-validation.test.ts tests/management-origin-tls.test.ts tests/server-auth.test.ts tests/core-lab-boundary.test.ts -> 187 pass, 0 fail; bun test tests/config.test.ts -> 153 pass, 0 fail; bun run typecheck -> pass
CI: gh pr checks 2380 -> 23 pass, 1 skipped, 0 fail or pending
SUMMARY: The PR moves 11 pure provider-validation helpers and three supporting constants into a focused leaf module. All function bodies match the original implementations, while src/config.ts retains every compatibility re-export and direct consumers use the narrower dependency. Auth/CORS behavior, logging, persistence, response shapes, and the core/Lab boundary remain unchanged. The current dev merge tree is clean, so the PR should land.
```

## Issue #2443

```
STATUS: REPRODUCES
RECOMMENDED_DISPOSITION: FIX_SMALL
EVIDENCE:
- bf8bcfd3c8a2cb1a352d4419351f634c3d3e75b4 Current local HEAD and live `origin/dev` match.
- src/lib/tool-argument-integers.ts:75-78 The number-typed native-integer allowlist contains only `timeout_ms`.
- src/lib/tool-argument-integers.ts:153-176 Numeric fields outside that allowlist retain their original serialized bytes.
- tests/tool-argument-integers.test.ts:328-335 The existing test explicitly requires `yield-time_ms:60000.0` to remain unchanged; the focused suite passes 33/33.
- src/bridge.ts:627-630 Streaming output applies that coercer; src/bridge.ts:1657-1662 does the same for non-streaming output. Fresh bridge reproduction emitted both `120000.0` and `8000.0` unchanged.
- a9cb7661ba04b78232dd5f4ba1085b5409dcf591 This is the latest commit touching the coercion owner and its test; it fixed only #2316’s `timeout_ms`.
FIX_PLAN:
- src/lib/tool-argument-integers.ts:69-78 Retain the global `timeout_ms` behavior, add a tool-scoped numeric-integer set for bare `wait` containing `yield-time_ms` and `max_tokens`, and update `coerceIntegerToolArguments`/`coerceValue` at src/lib/tool-argument-integers.ts:139-176 and src/lib/tool-argument-integers.ts:216-235 to accept and propagate tool identity. Preserve fractional values such as `1.5`.
- src/bridge.ts:627-630 Pass bare `currentToolCall.name` into the streaming coercion call only when no namespace exists.
- src/bridge.ts:1657-1662 Pass bare `realName` into the non-streaming coercion call only when `ns` is absent.
- tests/tool-argument-integers.test.ts:263-364 Add the exact `wait` number-schema regression without changing `src/server/responses/collaboration.ts:119-126`, which already records request-visible schemas.
TEST_PLAN: tests/tool-argument-integers.test.ts Assert both bridge paths rewrite `wait` values `yield-time_ms:120000.0` and `max_tokens:8000.0`, preserve `1.5`, and leave the same number-typed fields unchanged for another or namespaced tool; run `bun test tests/tool-argument-integers.test.ts` and `bun run typecheck` per src/AGENTS.md:24-26.
EFFORT: small
SUMMARY: Current `origin/dev` still forwards both rejected integral floats unchanged through the shared bridge path (src/bridge.ts:627-630, src/bridge.ts:1657-1662). The earlier fix only covered globally recognized `timeout_ms` (a9cb7661ba04b78232dd5f4ba1085b5409dcf591, src/lib/tool-argument-integers.ts:78). A three-file, bare-`wait`-scoped fix avoids changing Cursor’s sibling `yield-time_ms` or unrelated tools’ `max_tokens` (src/adapters/cursor/tool-definitions.ts:42-54). No Lab/core, auth, dependency, or logging boundary is involved; the protected core files are enumerated at AGENTS.md:37-44 and the proposed path remains Bun-native TypeScript under src/AGENTS.md:7-10.
```

## Issue #2152

```
STATUS: REPRODUCES
RECOMMENDED_DISPOSITION: FIX_SMALL
EVIDENCE:
- `96f288d595ee6a14d27bf2eacd3e1f983c704f27` The latest Windows dispatch still failed WP13 `E` with `namespace_unsafe` and `Restore truth` at its 45-second watchdog; no newer Windows dispatch exists because the leg is manual-only (`.github/workflows/ci.yml:537`).
- `8f04c9a526b3542e71141139f58419485e09946b` The three original symlink fixtures are already fixed by explicit Windows skips (`tests/update-npm-cache-preflight.test.ts:84`, `:96`, `:181`).
- `077668384a49cdb194a84dc67932920e46d19ce5` The Bun panic is already mitigated by a bounded crash-only retry keyed on stable signatures (`.github/workflows/ci.yml:622`, `tests/ci-workflows.test.ts:262`).
- `tests/helpers/codex-write-lock-child.ts:49` The `E` holder tight-spins for up to 45 seconds, consuming a core while the contender performs the PowerShell identity lookup; that lookup has a 30-second CI ceiling (`src/codex/user-identity.ts:43`) and maps failures to `namespace_unsafe` (`src/codex/codex-write-lock.ts:290`).
- `tests/codex-composed-acceptance.test.ts:745` `Restore truth` intentionally incurs approximately 11 seconds of SQLite contention before real CLI startup overhead, while its Windows watchdog remains 45 seconds (`tests/helpers/ci-watchdog.ts:21`).
- `bf8bcfd3c8a2cb1a352d4419351f634c3d3e75b4` Current-head Bun 1.4.0 local verification passed 19 focused acceptance/cache tests and 132 workflow tests, but macOS cannot disprove the Windows failures (`package.json:65`).
FIX_PLAN:
- `tests/helpers/codex-write-lock-child.ts:32` In the `withCodexWriteLock` commit callback, replace the tight `Bun.file(...).size` spin with synchronous `existsSync` polling plus short `Atomics.wait` intervals; retain the release-marker protocol and include the refusal message in child JSON diagnostics.
- `tests/codex-composed-acceptance.test.ts:690` Make only `Restore truth` explicitly skip on Windows, documenting that it verifies a platform-independent busy-envelope contract while its real CLI startup is not a latency assertion; keep `A-reduced` and `E` active.
TEST_PLAN: `tests/codex-composed-acceptance.test.ts` Windows must pass `A-reduced` and `E` and visibly skip only `Restore truth`; Linux/macOS must continue asserting the complete busy and converged restore envelopes. Run `tests/update-npm-cache-preflight.test.ts` and `tests/ci-workflows.test.ts` to retain the three symlink skips and crash-only retry contract.
EFFORT: small
SUMMARY: The original issue is partially fixed, but two WP13 failures survived the post-merge Windows verification at `96f288d595ee6a14d27bf2eacd3e1f983c704f27`. The symlink fixtures and Bun panic handling are already covered by `8f04c9a526b3542e71141139f58419485e09946b` and `077668384a49cdb194a84dc67932920e46d19ce5`. The remaining repair is test-only: remove incidental CPU starvation from the lock helper and skip one platform-independent restore contract on Windows (`tests/helpers/codex-write-lock-child.ts:49`, `tests/codex-composed-acceptance.test.ts:690`). Blast radius is two test files; it does not touch product code, `src/lab/`, core imports, workflows, credentials, or logging.
```

## Issue #1702

```
STATUS: REPRODUCES
RECOMMENDED_DISPOSITION: FIX_NOW
EVIDENCE:
- `bf8bcfd3c8a2cb1a352d4419351f634c3d3e75b4` fetched `origin/dev` HEAD; linked implementation commit `c8c4358a1f3690ca4cfed85dbcbc8c1711296cf4` is not its ancestor and PR #1704 closed unmerged.
- `gui/src/pages/Combos.tsx:110-117` loads only combos, config, and models; it never requests `/api/provider-quotas`.
- `gui/src/combo-workspace-data.ts:90-94` has no quota attention state, while `gui/src/combo-workspace-data.ts:215-235` derives attention without quota input.
- `gui/src/components/combo-workspace-detail-panel.tsx:125-161` saves without quota validation; `gui/src/components/combo-workspace-detail-panel.tsx:189-190` disables Save/Create only for clean edits or busy state.
- `gui/src/components/combo-workspace-add-modal.tsx:64-88` validates configuration only; `gui/src/components/combo-workspace-add-modal.tsx:217-219` disables Create only while busy.
- `src/server/management/provider-routes.ts:372-378` already exposes the required `/api/provider-quotas` endpoint; `src/providers/quota.ts:91-115` supplies percent windows, custom windows, USD credits, timestamps, and aggregation metadata.
- `tests/combo-workspace-data.test.ts:210-236` covers only empty, thin, and catalog-omitted attention. `gui/tests/combo-workspace-empty.test.tsx:112-120` currently clicks an enabled Create button; focused baseline runs passed 29 data tests and 2 UI tests.
FIX_PLAN:
- `gui/src/combo-workspace-data.ts:90-94` add tri-state `ComboQuotaState` and `all-targets-exhausted`; at `gui/src/combo-workspace-data.ts:215-235` add `providerQuotaStatesFromReports` and `comboQuotaState`, trimming provider IDs, treating finite usage/custom windows `>=100` or non-unlimited `creditsUsd.remaining <= 0` as exhausted, and treating missing, stale, malformed, or incomplete aggregate evidence as unknown. Exclude disabled targets when deciding whether every usable target is exhausted.
- `gui/src/pages/Combos.tsx:201-218` add a separate active-only quota resource for `/api/provider-quotas` using the existing client-resource polling support; poll while visible, discard stale/latest-failed evidence to unknown, and replace state after recovery. Pass the derived states at `gui/src/pages/Combos.tsx:329-342`.
- `gui/src/components/combo-workspace-types.ts:19-32` add the quota-state contract; thread it through `ComboWorkspace` at `gui/src/components/ComboWorkspace.tsx:19-32`, including `DetailPanel`, `OverviewPanel`, and `AddComboModal`.
- `gui/src/components/combo-workspace-controls.tsx:131-143` make `TargetEditor` render localized available/exhausted/unknown quota badges per target.
- `gui/src/components/combo-workspace-detail-panel.tsx:125-161` compute exhaustion from the live draft and usable targets; at `gui/src/components/combo-workspace-detail-panel.tsx:183-191` show the warning and disable Save/Create only while every usable target is known exhausted, automatically re-enabling after target or quota recovery.
- `gui/src/components/combo-workspace-add-modal.tsx:64-88,215-219` apply the same guard to modal Create. `gui/src/components/combo-workspace-overview-panel.tsx:15-29` pass quota state into attention so all-exhausted combos are visible from the overview.
- `gui/src/styles-combos-workspace.css:353-375,467-505` add accessible badge/banner layouts. Add matching keys to `gui/src/i18n/en.ts`, `de.ts`, `fr.ts`, `ja.ts`, `ko.ts`, `ru.ts`, `tr.ts`, `zh.ts`, and `zh-TW.ts`, as required by `gui/AGENTS.md:14-18`.
- `docs-site/src/content/docs/guides/combos.md:254-260` document quota badges, unknown-state behavior, and action recovery; mirror the note in the existing `fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`, and `zh-tw` combo guides.
TEST_PLAN: `tests/combo-workspace-data.test.ts` assert USD, percentage, custom-window, unlimited, stale/unknown, trimmed-provider, incomplete-aggregation, disabled-target, mixed-state, all-exhausted, and recovery derivations; `gui/tests/combo-workspace-empty.test.tsx` assert Create disables for all-known-exhausted and re-enables on recovery; `gui/tests/combo-workspace-dirty.test.tsx` assert the same transition for Save.
EFFORT: medium
SUMMARY: Issue #1702 still reproduces on `bf8bcfd3c8a2cb1a352d4419351f634c3d3e75b4`: the combo workspace neither fetches quota state nor gates its Save/Create controls (`gui/src/pages/Combos.tsx:110-117`, `gui/src/components/combo-workspace-detail-panel.tsx:189-190`). The abandoned `c8c4358a1f3690ca4cfed85dbcbc8c1711296cf4` implementation is not on `origin/dev` and added presentation without the required action gating. The landing fix should use explicit available/exhausted/unknown semantics and polling so missing evidence never disables controls and recovery re-enables them. Blast radius is GUI, focused tests, localization, styling, and combo documentation; the existing endpoint avoids runtime changes, so Bun-native, core-to-`src/lab/`, and secret-logging boundaries are not entered (`src/server/management/provider-routes.ts:372-378`, `AGENTS.md:31-48`).
```

## Issue #2392

```
STATUS: REPRODUCES
RECOMMENDED_DISPOSITION: FIX_SMALL
EVIDENCE:
- bf8bcfd3c8a2cb1a352d4419351f634c3d3e75b4 Current `HEAD` and `origin/dev`; worktree remained clean.
- src/server/responses/core.ts:1537 Regular Responses still implements the full local exception matrix through line 1576, including safe reauthentication logging and endpoint-only `ForwardAdmissionCredentialError`.
- src/server/responses/compact.ts:397 Compact independently implements the common matrix through line 414; `ForwardAdmissionCredentialError` remains separately handled at src/server/responses/compact.ts:337.
- d52032ebe9ee0ffb60f2cefe826c0011dff6a10c PR #2390 fixed compact substitution failures by adding one local 401 branch, but did not centralize mapping.
- src/codex/auth-context.ts:598 `CodexMainSubstitutionUnavailableError` remains the fail-before-I/O signal thrown at src/codex/auth-context.ts:638.
- tests/codex-envkey-admission-substitution.test.ts:169 Focused run passed 4/4, proving both substitution paths return before upstream I/O.
- tests/server-auth.test.ts:1552 Existing cooldown coverage checks only compact status; tests/server-auth.test.ts:1889 and tests/server-auth.test.ts:1900 check Responses/compact 409 status without byte-level parity.
- tests/core-lab-boundary.test.ts:19 Current core boundary run passed 13/13, including the transitive `src/lab/` guard for `src/server/responses/core.ts`.
FIX_PLAN:
- src/server/responses/codex-auth-error.ts:1 Add pure `mapCodexAuthContextErrorToResponse(error, { accountSelector, now })(): Response | undefined`, covering the seven common classes and returning `undefined` for unknown errors.
- src/server/responses/core.ts:1537 Keep the `CodexAuthContextError` safe-label log and explicit `ForwardAdmissionCredentialError` handling local, then delegate common response construction to the mapper and rethrow unmapped errors.
- src/server/responses/compact.ts:397 Replace the duplicated common matrix with the mapper; preserve admission handling at src/server/responses/compact.ts:337 and alternate-account selection behavior at src/server/responses/compact.ts:191.
- structure/01_runtime.md:32 Record the mapper as the shared Responses/compact HTTP-contract owner while leaving account selection, credential materialization, logging, and transport in their current modules.
TEST_PLAN: tests/responses-compaction-routing.test.ts:11 Add a table-driven characterization using its existing access to both handlers and auth spies at tests/responses-compaction-routing.test.ts:24; assert identical status, serialized error body, content type, cooldown/drain `Retry-After`, thread-affinity 409, zero upstream I/O for substitution, regular-only safe logging, and rejection of unknown errors.
EFFORT: small
SUMMARY: The structural issue still reproduces on current `origin/dev`: both endpoint paths maintain separate exception matrices at src/server/responses/core.ts:1537 and src/server/responses/compact.ts:397. The specific user-visible compact substitution gap is already fixed by d52032ebe9ee0ffb60f2cefe826c0011dff6a10c. The recommended change is a five-file, behavior-preserving extraction with endpoint-specific logging and admission handling left in place at src/server/responses/core.ts:1550 and src/server/responses/compact.ts:337. Because core is protected from transitive Lab imports and auth logging must remain pseudonymous, the new leaf must preserve the boundaries enforced at tests/core-lab-boundary.test.ts:19 and src/codex/account-label.ts:21.
```

## Note on capture

Two verdicts (Issue #1587, Issue #2443) arrived through the runtime's completion
notification rather than the wait return, and are recorded in
`000_inventory_and_roadmap.md` in table form with the same file:line evidence.

