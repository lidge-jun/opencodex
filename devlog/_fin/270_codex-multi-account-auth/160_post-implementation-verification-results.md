# 160 - Post-Implementation Verification Results

> Superseded security note (2026-06-25): This document predates the 280 security patch plan and Phase 10-60 hardening. Treat release-readiness, full-email UI, ordinal request-log labels, unauthenticated management API, fail-open fallback, and earlier account-boundary claims here as historical only. Current merge/deploy evidence is tracked under `devlog/280_codex-multi-auth-security-patch-plan/` and `devlog/_plan/260624_codex-multi-auth-security-implementation/`.

Date: 2026-06-24

Status: verified.

## Scope

This verification loop covered Codex multi-account auth behavior from devlog phases `00` through `150`, plus new routing safety requirements discovered during audit:

- 80% auto-switch semantics across 5h, weekly, and optional 30d quota windows.
- Consecutive non-200 upstream failover after a separate threshold, default 3.
- Thread affinity preservation across token refresh failures and upstream failover.
- Redacted runtime/API/browser verification without personal account exposure.

## Documentation Evidence

- `devlog/_plan/260624_codex-auth-verification-loop/00_goal-plan.md`
- `devlog/_plan/260624_codex-auth-verification-loop/10_loop1-devlog-code-audit.md`
- `devlog/_plan/260624_codex-auth-verification-loop/20_loop2-static-test-results.md`
- `devlog/_plan/260624_codex-auth-verification-loop/30_loop3-runtime-browser-results.md`
- `devlog/_plan/260624_codex-auth-verification-loop/40_loop4-routing-safety-results.md`

## Implementation Evidence

| File | Result |
| --- | --- |
| `src/codex-routing.ts` | New routing state, `usageScore=max(5h, weekly, 30d when present)`, thread affinity, request-log labels, and upstream failure streak handling. |
| `src/codex-quota.ts` | New quota cache/parser module with optional WHAM `tertiary_window` support. |
| `src/server.ts` | Routing logic extracted; token refresh failure no longer deletes affinity; HTTP passthrough records upstream outcome and optional tertiary quota headers. |
| `src/codex-auth-api.ts` | Reuses quota module, exposes `upstreamFailoverThreshold`, validates failover threshold separately from percent threshold. |
| `src/types.ts` | Adds `upstreamFailoverThreshold?: number`. |
| `src/ws-bridge.ts` | Allows tertiary Codex quota response headers. |
| `gui/src/App.tsx` | Adds stable `data-page` selector for locale-safe browser probes. |
| `gui/src/pages/CodexAuth.tsx` | Renders optional 30d quota row only when monthly quota exists; warning color follows configured threshold. |
| `gui/src/styles.css` | Keeps compact quota rows aligned with a forward-compatible label column. |
| `gui/src/i18n/en.ts`, `ko.ts`, `zh.ts` | Clarifies that auto-switch applies when 5h, weekly, or 30d reaches the threshold. |
| `tests/codex-routing.test.ts` | Covers usage score, 5h-triggered switch, non-200 failover, 2xx reset, disabled failover, API validation, and tertiary parser. |
| `tests/session-affinity.test.ts` | Keeps affinity/request-log coverage against extracted routing module. |
| `tests/codex-auth-api.test.ts` | Updates active-state contract for failover threshold. |

## Verification Evidence

Commands:

```bash
git diff --check
bun run typecheck
cd gui && bun run build
bun test tests
```

Results:

- `git diff --check`: pass.
- `bun run typecheck`: pass, `bun x tsc --noEmit`.
- `cd gui && bun run build`: pass, Vite production build completed.
- `bun test tests`: 245 pass, 0 fail, 706 expectations.

Runtime/API/browser:

- Proxy restarted on latest code with `bun run src/cli.ts stop` and `bun run src/cli.ts ensure`.
- `healthz`: status `ok`, version `2.1.8`.
- Redacted `/api/codex-auth/accounts?refresh=1` summary: HTTP 200, 5 accounts total, 1 main, 4 pool, 5 quota-bearing accounts.
- Active state summary: `autoSwitchThreshold=80`, `upstreamFailoverThreshold=3`; active account id redacted.
- Browser desktop probe `1280x900`: 10 quota rows, identical x positions across all row columns.
- Browser narrow probe `375x812`: 10 quota rows, identical x positions across all row columns, no horizontal overflow.

Independent verification:

- Backend plan audit passed before build.
- Backend B-phase verifier reported `DONE` after checking files, routing extraction, quota/failover semantics, affinity preservation, browser probe support, 30d optional behavior, redaction, and all static/build/test gates.

## External Evidence Status

| Claim | Source | Status |
| --- | --- | --- |
| OAuth public clients need replay-resistant refresh-token handling and rotation awareness. | https://www.rfc-editor.org/info/rfc9700 | sufficient |
| Codex auth/token refresh failures are a real class observed by users. | https://github.com/openai/codex/issues/25443 and https://github.com/openai/codex/issues/15502 | supporting |
| ChatGPT Business seats and model limits are documented independently of local WHAM telemetry. | https://help.openai.com/en/articles/8792536-managing-billing-and-seats-in-chatgpt-business and https://help.openai.com/en/articles/12003714-chatgpt-business-models-limits | sufficient |

## Residual Risks

| Risk | Status |
| --- | --- |
| Live WHAM 30d field/header naming is not observed in current runtime response. | Mitigated by optional parser/rendering; current runtime summary shows no monthly quota fields. |
| WS-specific upstream outcome hook was not separately added. | Current WS data plane calls `handleResponses`; HTTP passthrough status recording is shared through that path. |
| Full email values are still visible in live GUI cards by product design. | Verification docs and probes avoid recording screenshots/raw payloads; deployable UI should avoid test/personal fixtures. |
| `src/server.ts` remains over 500 lines. | Improved from previous size by extracting routing; further unrelated splits should happen in future dedicated refactors. |

## Release Readiness

Ready for local release verification. The running proxy is on the latest verified code, core gates pass, runtime/API/browser evidence is recorded, and no raw personal identifiers were added to docs or tests.
