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

## Phase 60 Post-Commit Evidence

| Gate | Evidence |
| --- | --- |
| Commit | `e752fab` (`fix: redact codex auth privacy surfaces`). |
| Typecheck | `bun run typecheck` passed. |
| Focused privacy tests | `bun test tests/codex-account-label.test.ts tests/session-affinity.test.ts tests/codex-auth-api.test.ts tests/oauth-status-privacy.test.ts tests/codex-account-store.test.ts tests/debug.test.ts tests/server-auth.test.ts` passed with 90 pass, 0 fail. |
| Full tests | `bun test tests` passed with 344 pass, 0 fail. |
| GUI build | `cd gui && bun run build` passed. |
| Diff/status | `git diff --check` and `git diff --cached --check` passed; `git status --short` was clean immediately after the implementation commit and before this manifest append. |

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
