# 10 - Codex Multi-Auth Security Verification Manifest

Date: 2026-06-25

Status: Phase 60 implemented, committed, and post-commit verification passed.

## Scope

This manifest tracks the implementation evidence for the `280` multi-auth security patch plan. It supersedes the release-readiness statements in the historical `270` devlog set.

## Environment

| Field | Value |
| --- | --- |
| Branch | `dev` |
| OS | Darwin arm64 |
| Bun | `1.3.14` |
| Push/CI | Not run locally; no push was requested. |

## Implementation Commits

| Patch | Commit | Evidence |
| --- | --- | --- |
| Patch 1 - Fail-closed auth context | `1f0813c` | Pool token failure cannot fall through to inbound/main auth. |
| Patch 2 - Account lifecycle purge | `0efb547` | Delete purges account-bound runtime state. |
| Patch 2B - Credential generation CAS | `278873a` | Refresh completion is generation guarded. |
| Patch 2C - Lifecycle generations | `2204da8` | Account lifecycle is bound to generations. |
| Patch 3 - Local API auth and safe DTOs | `9490cfc` | Non-loopback APIs require auth; config/account DTOs are safer. |
| Patch 4 - Manual import disabled | `b9903be` | Unverified manual Codex import is disabled by default. |
| Patch 5A - Quota unknown policy | `820fd8c` | Unknown quota no longer ranks as zero usage. |
| Patch 5B - Outcome taxonomy | `35d28a0` | Caller/credential/quota/transient outcomes are separated. |
| Patch 5C - Sidecar outcomes | `cfc6e47` | Vision/web-search sidecar auth outcomes are recorded. |
| Patch 5D - Cooldown/failure window | `56c9369` | 429 cooldown and transient failure windows are enforced. |
| Patch 5E - Terminal stream outcomes | `e123339` | SSE/WS terminal failed/incomplete outcomes are recorded after stream completion. |
| Patch 6 - Privacy labels and redaction | `e752fab` | Codex auth account labels, OAuth status, debug frames, and durable errors avoid raw account identifiers. |
| Patch 7 - P1/P2 stop-audit closure | `d65877b`, `72d83d1` | Thread affinity TTL/LRU/generation, grant-scoped refresh locks, CI privacy scan, and item-level manifest mapping. |

## Item-Level 280 Requirement Matrix

| Requirement | Evidence | Status |
| --- | --- | --- |
| Pool token failure cannot fall through to inbound/main auth. | `1f0813c`; `tests/codex-auth-context.test.ts`; `tests/passthrough-override.test.ts`; `tests/sidecar-abort.test.ts`. | Implemented. |
| Account deletion purges account-bound runtime state and WebSocket bindings. | `0efb547`, `2204da8`; `tests/codex-auth-api.test.ts`; `tests/codex-websocket-registry.test.ts`. | Implemented. |
| Refresh completion cannot recreate deleted/replaced credentials. | `278873a`; `tests/codex-account-store.test.ts`. | Implemented. |
| Local API auth protects non-loopback management/data-plane routes. | `9490cfc`; `tests/server-auth.test.ts`. | Implemented. |
| Config/account DTOs avoid secrets and default account PII exposure. | `9490cfc`, `e752fab`; `tests/server-auth.test.ts`; `tests/codex-auth-api.test.ts`; browser smoke recorded below. | Implemented. |
| Manual import does not trust client-controlled identity by default. | `b9903be`; `tests/codex-auth-api.test.ts`. | Implemented as disabled-by-default; authoritative identity rework remains out of scope while disabled. |
| HTTP/WebSocket auth context consistency. | `1f0813c`, `d65877b`; `tests/codex-auth-context.test.ts`; `tests/server-auth.test.ts`. | Implemented. |
| Affinity lifecycle has TTL/LRU bounds and generation revalidation. | `d65877b`; `tests/codex-routing.test.ts`. | Implemented. |
| Refresh coordination is generation-guarded and grant-scoped. | `278873a`, `d65877b`; `tests/codex-account-store.test.ts`. | Implemented. |
| Outcome classifier separates caller, credential, quota, transient, sidecar, and terminal stream outcomes. | `35d28a0`, `cfc6e47`, `56c9369`, `e123339`; `tests/codex-routing.test.ts`; `tests/server-auth.test.ts`; `tests/sidecar-abort.test.ts`; `tests/ws-endpoint.test.ts`. | Implemented. |
| Quota unknown/stale/malformed state does not attract traffic as zero usage. | `820fd8c`; `tests/codex-routing.test.ts`; `tests/codex-auth-api.test.ts`. | Implemented. |
| Request labels and durable logs avoid raw account identifiers. | `e752fab`, `d65877b`, `72d83d1`; `tests/codex-account-label.test.ts`; `tests/debug.test.ts`; `bun run privacy:scan`. | Implemented. |
| Historical 270 release-readiness docs are superseded. | `e752fab`; nine 270 docs contain supersession banners. | Implemented. |
| Automated privacy scan covers source/docs/CI. | `d65877b`, `72d83d1`; `scripts/privacy-scan.ts`; `.github/workflows/ci.yml`; `bun run privacy:scan`. | Implemented. |

## Documentation Evidence

| Document | Purpose |
| --- | --- |
| `devlog/280_codex-multi-auth-security-patch-plan/00_patch_plan.md` | Parent patch plan and security review synthesis. |
| `devlog/_plan/260624_codex-multi-auth-security-implementation/10_phase10-fail-closed-execution.md` | Patch 1 execution plan. |
| `devlog/_plan/260624_codex-multi-auth-security-implementation/20_phase20-account-lifecycle-cleanup.md` | Patch 2 lifecycle cleanup plan. |
| `devlog/_plan/260624_codex-multi-auth-security-implementation/21_phase20b-credential-generation-cas.md` | Patch 2B credential generation plan. |
| `devlog/_plan/260624_codex-multi-auth-security-implementation/22_phase20c-account-lifecycle-completion.md` | Patch 2C lifecycle completion plan. |
| `devlog/_plan/260624_codex-multi-auth-security-implementation/30_phase30-local-api-auth-safe-dtos.md` | Patch 3 auth/DTO plan. |
| `devlog/_plan/260624_codex-multi-auth-security-implementation/40_phase40-manual-import-disable.md` | Patch 4 manual import plan. |
| `devlog/_plan/260624_codex-multi-auth-security-implementation/50_phase50a-quota-state-foundation.md` | Patch 5A quota plan. |
| `devlog/_plan/260624_codex-multi-auth-security-implementation/50_phase50b-outcome-taxonomy-foundation.md` | Patch 5B outcome taxonomy plan. |
| `devlog/_plan/260624_codex-multi-auth-security-implementation/50_phase50c-sidecar-outcome-recording.md` | Patch 5C sidecar plan. |
| `devlog/_plan/260624_codex-multi-auth-security-implementation/50_phase50d-quota-cooldown-failure-window.md` | Patch 5D cooldown/failure-window plan. |
| `devlog/_plan/260624_codex-multi-auth-security-implementation/50_phase50e-terminal-stream-outcomes.md` | Patch 5E terminal stream plan. |
| `devlog/_plan/260624_codex-multi-auth-security-implementation/60_phase60-privacy-labels-docs.md` | Patch 6 privacy/log/docs plan. |

## Verification Already Recorded

| Phase | Command Evidence |
| --- | --- |
| 50E pre-commit | `bun run typecheck` passed; `bun test tests` passed with 331 pass, 0 fail; `cd gui && bun run build` passed; `git diff --check` passed. |
| 50E post-commit | Focused suite passed with 81 pass, 0 fail; `git status --short` was clean after commit. |
| 60 plan audit | Backend plan audit failed once, revised plan passed, incremental login-status masking audit passed. |

## Phase 60 Local Verification

| Gate | Evidence |
| --- | --- |
| Focused privacy tests | `bun test tests/codex-account-label.test.ts tests/session-affinity.test.ts tests/codex-auth-api.test.ts tests/oauth-status-privacy.test.ts tests/codex-account-store.test.ts tests/debug.test.ts tests/server-auth.test.ts` passed with 90 pass, 0 fail. |
| Typecheck | `bun run typecheck` passed. |
| Full tests | `bun test tests` passed with 344 pass, 0 fail. |
| GUI build | `cd gui && bun run build` passed. |
| Browser smoke | Disposable loopback proxy on port 10190 rendered Codex Auth. DOM check returned `hasRaw:false`, `hasMasked:true`, `title:"Codex Auth"` for the fixture raw email and masked email. |
| Privacy scans | Changed-file scan found only `example.test` fixtures, existing placeholder token field names, and historical before/negative-test strings. Source-only scan for ordinal labels, old refresh-error strings, and payload-preview patterns returned no matches. |
| Diff check | `git diff --check` passed. |

## Phase 70 Post-Commit Evidence

| Gate | Evidence |
| --- | --- |
| Commits | `d65877b` (`fix: bound codex affinity and refresh grants`); `72d83d1` (`fix: avoid privacy scan self-match`). |
| Independent verifier | Backend verifier returned DONE after reading implementation and running `bun run typecheck`, focused Phase 70 tests, and `bun run privacy:scan` before the script was tracked. |
| Post-commit privacy fix | After `d65877b`, tracked `scripts/privacy-scan.ts` self-matched its own `a@b.com` allowlist literal. `72d83d1` added the planned script-self fixture exception, and `bun run privacy:scan` passed afterward. |

## Phase 60 Post-Commit Evidence

| Gate | Evidence |
| --- | --- |
| Commit | `e752fab` (`fix: redact codex auth privacy surfaces`). |
| Typecheck | `bun run typecheck` passed. |
| Focused privacy tests | `bun test tests/codex-account-label.test.ts tests/session-affinity.test.ts tests/codex-auth-api.test.ts tests/oauth-status-privacy.test.ts tests/codex-account-store.test.ts tests/debug.test.ts tests/server-auth.test.ts` passed with 90 pass, 0 fail. |
| Full tests | `bun test tests` passed with 344 pass, 0 fail. |
| GUI build | `cd gui && bun run build` passed. |
| Diff/status | `git diff --check` and `git diff --cached --check` passed; `git status --short` was clean immediately after the implementation commit and before this manifest append. |

## Phase 70 Local Verification

| Gate | Evidence |
| --- | --- |
| Typecheck | `bun run typecheck` passed. |
| Focused P1/P2 tests | `bun test tests/codex-routing.test.ts tests/codex-auth-context.test.ts tests/server-auth.test.ts tests/codex-account-store.test.ts tests/codex-inject.test.ts` passed with 77 pass, 0 fail. |
| Privacy scan | `bun run privacy:scan` passed. |
| Full tests | `bun test tests` passed with 351 pass, 0 fail. |
| GUI build | `cd gui && bun run build` passed. |
| Diff check | `git diff --check` passed. |

## Deferred Cases

| Deferred case | Reason |
| --- | --- |
| Live upstream refresh-token replay/revocation semantics | Requires real upstream account credentials and provider behavior cannot be proven safely in local tests. |
| Multi-process stress beyond file-lock/CAS unit coverage | Current evidence covers transactional paths; high-volume multi-process soak was not requested. |
| Non-loopback production deployment | Local implementation enforces auth requirements, but no external deployment was performed. |
| Push/CI | Push was not requested; local gates are the available evidence. |

## Privacy Notes

- Do not add screenshots, raw account emails, local account aliases, bearer values, refresh tokens, access tokens, or local-user home paths to this manifest.
- `example.test` values in tests are fixtures, not real account data.
