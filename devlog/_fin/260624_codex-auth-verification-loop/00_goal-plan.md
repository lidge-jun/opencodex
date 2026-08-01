# 00 - Codex Auth Verification Loop Goal Plan

Date: 2026-06-24

Goal objective:

Run repeated autonomous PABCD verification loops for opencodex Codex multi-account auth from devlog phase 00 through 150: audit implementation against documented intent, use current external research where relevant, execute tests/build/browser/API/runtime probes, fix any discovered regressions, document results in devlog, and leave the running proxy verified on the latest code without exposing personal account data.

## Classification

C4-level verification care for auth and token handling.

Reasons:

- Touches ChatGPT OAuth, access/refresh tokens, account identity, and credential storage.
- Uses private local credentials during verification.
- Must avoid personal account leakage in docs, tests, request logs, screenshots, and API output.
- Must verify both source code behavior and running proxy behavior.

## Source Inventory

Primary local source of truth:

- `devlog/270_codex-multi-account-auth/00_plan.md`
- `devlog/270_codex-multi-account-auth/01_interview-decisions.md`
- `devlog/270_codex-multi-account-auth/10_phase1-account-storage.md`
- `devlog/270_codex-multi-account-auth/20_phase2-passthrough-override.md`
- `devlog/270_codex-multi-account-auth/30_phase3-management-api.md`
- `devlog/270_codex-multi-account-auth/40_phase4-dashboard-gui.md`
- `devlog/270_codex-multi-account-auth/50_phase5-tests-and-hardening.md`
- `devlog/270_codex-multi-account-auth/60_phase6-chatgpt-oauth-flow.md`
- `devlog/270_codex-multi-account-auth/70_phase7-quota-capture-autoswitch.md`
- `devlog/270_codex-multi-account-auth/80_phase8-e2e-hardening.md`
- `devlog/270_codex-multi-account-auth/90_phase9-production-tests.md`
- `devlog/270_codex-multi-account-auth/95_oauth-flow-production.md`
- `devlog/270_codex-multi-account-auth/100_phase10-audit-phases-1-9.md`
- `devlog/270_codex-multi-account-auth/110_phase11-oauth-proper-implementation.md`
- `devlog/270_codex-multi-account-auth/120_phase12-production-verification.md`
- `devlog/270_codex-multi-account-auth/130_oauth-token-collision-fix.md`
- `devlog/270_codex-multi-account-auth/140_code-review-fixes.md`
- `devlog/270_codex-multi-account-auth/150_post-implementation-verification-inventory.md`

Code surfaces:

- `src/codex-auth-api.ts`
- `src/codex-auth-collision.ts`
- `src/codex-account-store.ts`
- `src/server.ts`
- `src/adapters/openai-responses.ts`
- `src/ws-bridge.ts`
- `src/oauth/chatgpt.ts`
- `src/oauth/index.ts`
- `src/oauth/store.ts`
- `gui/src/pages/CodexAuth.tsx`
- `gui/src/components/AddCodexAccountModal.tsx`
- `gui/src/styles.css`
- `gui/src/i18n/en.ts`
- `gui/src/i18n/ko.ts`
- `gui/src/i18n/zh.ts`
- `tests/codex-auth-api.test.ts`
- `tests/codex-auth-collision.test.ts`
- `tests/session-affinity.test.ts`
- `tests/codex-account-store.test.ts`
- `tests/chatgpt-oauth.test.ts`

External evidence candidates:

| Claim | Source | Evidence use |
| --- | --- | --- |
| OAuth public clients should use sender-constrained refresh tokens or refresh token rotation. | https://www.rfc-editor.org/info/rfc9700 and https://datatracker.ietf.org/doc/rfc9700/ | Justifies refresh-token collision/rotation caution. |
| Codex users have reported revoked/rotated refresh-token failure modes. | https://github.com/openai/codex/issues/25443 and https://github.com/openai/codex/issues/15502 | Confirms the refresh-token failure class is not hypothetical. |
| ChatGPT Business has seats, Codex access, and usage/flexible-pricing semantics. | https://help.openai.com/en/articles/8792536-managing-billing-and-seats-in-chatgpt-business and https://help.openai.com/en/articles/11487671-flexible-pricing-for-the-enterprise-edu-and-business-plans | Supports Team/Business member distinction and per-seat/shared-pool usage risk. |
| ChatGPT Business model limits are documented separately from local WHAM telemetry. | https://help.openai.com/en/articles/12003714-chatgpt-business-models-limits | Keeps public-plan limits separate from private local quota telemetry. |

## Loop Map

### Loop 0 - Planning and inventory

Output:

- This plan.
- Phase stubs for loops 1-4.
- Goal update evidence.

Acceptance:

- Plan exists under `devlog/_plan/260624_codex-auth-verification-loop/`.
- Plan references local devlogs, code surfaces, and external evidence.

### Loop 1 - Devlog-to-code audit

Output:

- `10_loop1-devlog-code-audit.md`
- Matrix mapping devlog 00-150 requirements to source files and tests.

Acceptance:

- Every implemented claim in 00-150 is marked `verified`, `superseded`, `needs-probe`, or `needs-fix`.
- No unresolved contradiction remains undocumented.

### Loop 2 - Static and test verification

Output:

- `20_loop2-static-test-results.md`
- Any code fixes discovered by tests/typecheck/build.

Acceptance:

- `git diff --check` passes.
- `bun run typecheck` passes.
- `cd gui && bun run build` passes.
- `bun test tests` passes.
- File length guard: touched source/test files stay under 500 lines or are split.

### Loop 3 - Runtime API/browser verification

Output:

- `30_loop3-runtime-browser-results.md`
- Screenshots or DOM/browser probe summaries without exposing account tokens or full personal identifiers.

Acceptance:

- Running proxy responds on port 10100.
- `/api/codex-auth/accounts?refresh=1` returns main + all pool accounts.
- Quota reset timestamps are present where WHAM returns them.
- Codex Auth quota columns align in desktop and narrow viewport probes.
- Login cancel/copy-link paths are verified at UI/API level where feasible.

### Loop 4 - Request routing and safety verification

Output:

- `40_loop4-routing-safety-results.md`
- Any fixes required for request-log pool labels, active account routing, auto-switch, or redaction.

Acceptance:

- Request logs distinguish main from pool ordinals without exposing account IDs.
- Active account selection is reflected in next-session routing state.
- Quota auto-switch uses `usageScore = max(5h, weekly, 30d when present)` and the existing percent threshold, default 80.
- Repeated non-200 upstream responses from the selected Codex account use a separate failure threshold, default 3 consecutive failures, and only affect next-session/new-thread routing.
- Existing thread affinity is not cleared by token refresh failures, upstream non-200 responses, quota exhaustion, or failover decisions.
- Redaction scan finds no raw token leakage or personal test fixtures introduced by this work.

### Loop 5 - Final synthesis

Output:

- `devlog/270_codex-multi-account-auth/160_post-implementation-verification-results.md`
- Final goal update.

Acceptance:

- Summarizes all loops, commands, evidence, fixes, residual risks, and release readiness.
- Leaves worktree clean except intentional untracked/ignored runtime artifacts.
- Running proxy is restarted on the latest verified code.

## Diff-Level Plan

### LOOP 0 CREATED

`devlog/_plan/260624_codex-auth-verification-loop/00_goal-plan.md`

Complete plan and loop map.

`devlog/_plan/260624_codex-auth-verification-loop/10_loop1-devlog-code-audit.md`

Loop 1 audit matrix.

`devlog/_plan/260624_codex-auth-verification-loop/20_loop2-static-test-results.md`

Loop 2 static/build/test evidence.

`devlog/_plan/260624_codex-auth-verification-loop/30_loop3-runtime-browser-results.md`

Loop 3 runtime/API/browser evidence.

`devlog/_plan/260624_codex-auth-verification-loop/40_loop4-routing-safety-results.md`

Loop 4 routing/safety evidence.

Loop 0 has already created the `_plan/260624_codex-auth-verification-loop/00` through `40` documents. Later loops must update those stubs rather than create duplicate files.

### NEW

`devlog/270_codex-multi-account-auth/160_post-implementation-verification-results.md`

Final verification synthesis.

`src/codex-routing.ts`

Extract routing helpers out of oversized `src/server.ts` before adding failover logic:

- `clearThreadAccountMap`
- `resolveCodexAccountForThread`
- `formatCodexProviderForLog`
- `computeCodexUsageScore`
- `pickLowestUsageCodexAccount`
- `recordCodexUpstreamOutcome`
- in-memory per-account upstream health map

`tests/codex-routing.test.ts`

Targeted tests for quota-window scoring, thread affinity, and non-200 failover:

- `computeCodexUsageScore` returns `max(5h, weekly, monthly when present)`.
- Missing 30d/monthly data is treated as 0.
- Existing 5h-only breach still switches even when weekly is low.
- Three consecutive non-200 responses on a selected account route the next new thread to the lowest-usage eligible account.
- A 2xx response resets that account's failure streak.
- `upstreamFailoverThreshold: 0` disables failure failover without disabling quota auto-switch.
- Existing thread ids stay pinned after upstream failures and token refresh failures.

### MODIFY - planned implementation surfaces

Potential surfaces:

- `src/types.ts`
- `src/config.ts`
- `src/codex-auth-api.ts`
- `src/codex-auth-collision.ts`
- `src/server.ts`
- `src/ws-bridge.ts`
- `gui/src/App.tsx`
- `gui/src/pages/CodexAuth.tsx`
- `gui/src/components/AddCodexAccountModal.tsx`
- `gui/src/i18n/en.ts`
- `gui/src/i18n/ko.ts`
- `gui/src/i18n/zh.ts`
- targeted tests under `tests/`

Planned implementation details:

- Add `upstreamFailoverThreshold?: number` to `OcxConfig`; default to 3, validate as integer `0-20`, and keep it separate from `autoSwitchThreshold` percent validation.
- Extend quota data with optional `monthlyPercent?: number` and `monthlyResetAt?: number`.
- Parse WHAM `rate_limit.tertiary_window` into monthly quota when present; omit the 30d row when absent.
- Capture optional tertiary headers only when present, without assuming live WHAM currently sends them.
- Keep the existing quota auto-switch threshold semantic: `autoSwitchThreshold` is percent, default 80, disabled only when 0.
- Change auto-switch UI copy to explain that the threshold applies to the hottest known quota window: 5h, Week, and 30d if present.
- Render a third `30d` quota row only when monthly quota data exists; keep existing 5h/Week rows unchanged.
- Add `data-page="codex-auth"` to the Codex Auth nav button so browser probes do not depend on English, Korean, or Chinese nav text.
- Keep `src/server.ts` changes minimal: import routing helpers, record upstream outcome after HTTP upstream responses, remove affinity deletion on token refresh failure, and add WS hook only if the current WS path exposes an upstream status to count.
- Do not add tests to `tests/codex-auth-api.test.ts` unless it is split first; it is already at the file-length guard edge.

### DELETE

None planned.

## Verification Commands

```bash
git diff --check
bun run typecheck
cd gui && bun run build
bun test tests
bun run src/cli.ts stop
bun run src/cli.ts ensure
```

Runtime probes:

```bash
curl -s 'http://localhost:10100/api/codex-auth/active'
curl -s 'http://localhost:10100/api/logs'
```

Never paste raw `/api/codex-auth/accounts` output into devlog because it contains email fields. Redact or summarize it:

```bash
bun -e 'const r=await fetch("http://localhost:10100/api/codex-auth/accounts?refresh=1"); const d=await r.json(); const a=Array.isArray(d.accounts)?d.accounts:[]; console.log(JSON.stringify({status:r.status, accountCount:a.length, mainCount:a.filter(x=>x.isMain).length, poolCount:a.filter(x=>!x.isMain).length, quotaRows:a.map(x=>({role:x.isMain?"main":"pool", hasWeeklyResetAt:typeof x.quota?.weeklyResetAt==="number", hasFiveHourResetAt:typeof x.quota?.fiveHourResetAt==="number", hasMonthly:typeof x.quota?.monthlyPercent==="number", hasMonthlyResetAt:typeof x.quota?.monthlyResetAt==="number"}))}, null, 2));'
```

Browser probes:

```bash
cli-jaw browser start --agent
cli-jaw browser new-tab http://localhost:10100
cli-jaw browser resize 1280 900
cli-jaw browser snapshot --interactive
cli-jaw browser evaluate 'document.querySelector("[data-page=\"codex-auth\"]")?.click()'
cli-jaw browser wait-for-selector '.quota-row' --timeout 10000
cli-jaw browser evaluate 'Array.from(document.querySelectorAll(".quota-row")).map((el, row) => ({ row, cols: Array.from(el.children).map((child, i) => { const r = child.getBoundingClientRect(); return { i, cls: String(child.className), x: Math.round(r.x), w: Math.round(r.width) }; }) }))'
cli-jaw browser resize 375 812
cli-jaw browser wait-for-selector '.quota-row' --timeout 10000
cli-jaw browser evaluate '({ overflow: document.documentElement.scrollWidth - window.innerWidth, rows: Array.from(document.querySelectorAll(".quota-row")).map((el, row) => ({ row, cols: Array.from(el.children).map((child, i) => { const r = child.getBoundingClientRect(); return { i, cls: String(child.className), x: Math.round(r.x), w: Math.round(r.width) }; }) })) })'
```

If the redacted account summary reports zero quota-bearing accounts, record the DOM alignment probe as blocked by missing live quota precondition instead of pasting screenshots or raw account payloads.

## Risk Register

| Risk | Verification strategy |
| --- | --- |
| Browser OAuth flow requires live human account session. | Probe what can be automated; document manual-only parts explicitly. |
| Private WHAM response shape can change. | Verify current shape via local API and guard with tests for known fields. |
| 30d quota window is not confirmed in current local code or devlogs. | Treat 30d/monthly as optional forward-compatible data: parse/render/count it only when WHAM or headers provide it. |
| Team/Business identity semantics are partially inferred from observed behavior. | Keep external Business seat/usage evidence separate from observed token/account-id evidence. |
| Request routing verification can accidentally leak identifiers. | Use provider ordinal labels and masked/hashing diagnostics only. |
| Non-200 failover can break thread affinity if applied mid-thread. | Count failures per selected account, switch only future new-thread routing, and cover existing-thread affinity with tests. |
| `src/server.ts` is already over the file-length guard. | Extract routing helpers to `src/codex-routing.ts`; keep server edits to hook calls only. |
| Devlog is ignored by git. | Force-add only intentional verification docs. |

## Completion Criteria

The goal is not complete until:

1. Loop docs 10/20/30/40 and final 160 results exist.
2. Full test/type/build gates pass after any fixes.
3. Runtime proxy is restarted and verified on port 10100.
4. External-source-dependent claims are documented with URLs and evidence status.
5. Independent audit/review has challenged the final completion claim.
6. No personal tokens, raw account IDs, or full personal emails are newly exposed.
