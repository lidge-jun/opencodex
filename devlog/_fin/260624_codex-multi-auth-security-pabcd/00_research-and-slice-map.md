# 00 - Research And Slice Map

Date: 2026-06-24

Status: PABCD planning artifact.

## Goal

Turn `devlog/280_codex-multi-auth-security-patch-plan/00_patch_plan.md` into an implementation-ready Jawdev slice plan before writing security-sensitive code.

This pass is documentation/architecture only. Code changes start only after the plan/audit/check loop proves the slices are ordered correctly.

## External Evidence

| Claim | Source | How it affects this plan |
| --- | --- | --- |
| OAuth public clients must handle refresh-token rotation and replay/reuse hazards carefully. | RFC 9700, OAuth 2.0 Security Best Current Practice, https://www.rfc-editor.org/rfc/rfc9700.html | Refresh storage needs generation/CAS semantics and duplicate-grant protection. |
| Origin/CORS/CSRF checks are not authentication. | OWASP Cross-Site Request Forgery Prevention Cheat Sheet, https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html | Local management/data-plane APIs need a real secret when reachable beyond trusted loopback. |
| Selected-account routing must not silently fall back to inbound/main credentials. | Current local source anchors: `src/server.ts` `handleResponses()` pool override block, `src/server.ts` WebSocket upgrade block, and `src/adapters/openai-responses.ts` `buildRequest()` inbound-header copy behavior. GPT Pro review is advisory only, not primary proof. | Preserve future-thread failover; do not replay active turns or sidecar calls across accounts. |

## Evidence Limits

| Evidence | Status | Limit |
| --- | --- | --- |
| Current local source anchors | Primary evidence for this plan | Must be re-read during implementation because line numbers and call sites can move. |
| RFC 9700 and OWASP CSRF cheat sheet | External guidance | Used for security design principles, not as proof that this code is fixed. |
| GPT Pro caveat/full-source reviews | Advisory review input | Findings must be verified against local source before code changes. |
| `devlog/280_codex-multi-auth-security-patch-plan/00_patch_plan.md` | Source plan | The referenced review bundle path may be non-durable; implementation evidence must come from committed source/tests and fresh commands. |

## Current Source Anchors

| Risk | Current anchor |
| --- | --- |
| HTTP pool token failure falls open | `src/server.ts` `handleResponses()` pool override block |
| WS fallback to main | `src/server.ts` WebSocket upgrade block and `src/ws-bridge.ts` `selectForwardHeaders()` |
| Inbound auth copied unless override exists | `src/adapters/openai-responses.ts` `createResponsesPassthroughAdapter().buildRequest()` |
| Manual import trusts client identity | `src/codex-auth-api.ts` `POST /api/codex-auth/accounts` |
| Delete is non-atomic | `src/codex-auth-api.ts` `DELETE /api/codex-auth/accounts` plus `src/codex-routing.ts` maps |
| Refresh is alias-scoped/process-local | `src/codex-account-store.ts` `refreshLocks` and `getValidCodexToken()` |
| Unknown quota ranks as zero | `src/codex-routing.ts` `computeCodexUsageScore(null)`, `src/codex-quota.ts` |
| Config/account DTO leaks | `src/server.ts` `/api/config`, `src/codex-auth-api.ts` accounts response |

## Slice Map

| Slice | File | Purpose |
| --- | --- | --- |
| 01 | `01_audit-resolution.md` | Record parallel audit findings and B-phase doc resolutions. |
| 10 | `10_phase1-fail-closed-auth-context.md` | Stop pool-to-main fallback and define request auth context. |
| 20 | `20_phase2-account-lifecycle.md` | Make delete/refresh/affinity account lifecycle transactional. |
| 30 | `30_phase3-local-api-auth-safe-dto.md` | Add local API auth gates and redact config/account DTOs. |
| 40 | `40_phase4-manual-import-identity.md` | Disable or rebuild manual import around authoritative identity. |
| 50 | `50_phase5-routing-outcome-quota.md` | Classify outcomes and model fresh/stale/unknown quota. |
| 60 | `60_phase6-privacy-docs-verification.md` | Stable labels, durable-log redaction, devlog supersession, final gates. |

## PABCD Shape

This PABCD pass is a design/architecture loop:

- P: create the slice documents and source-backed plan.
- A: dispatch parallel audits for security, backend integration, tests, and docs.
- B: incorporate audit feedback into the plan documents only.
- C: verify docs, source anchors, git status, and commit evidence.
- D: summarize and leave the goal ready for the first implementation PABCD.

Release gate: patches 10 and 20 may be implemented first for isolation, but no branch is mergeable or externally testable with stored credentials until patch 30's default-deny local API authentication is also complete.

## Non-Goals

- No production code changes in this pass.
- No runtime proxy restart.
- No account/token/credential inspection.
- No push unless explicitly requested later.
