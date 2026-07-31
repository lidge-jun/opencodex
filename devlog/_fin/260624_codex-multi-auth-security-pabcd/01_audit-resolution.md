# 01 - Audit Resolution

Date: 2026-06-24

Status: B-phase audit-resolution record for docs-only PABCD planning cycle.

## Audits Run

| Lane | Reviewer/source | Scope | Verdict | Evidence limits |
| --- | --- | --- | --- | --- |
| Security | `multi_agent_v1` explorer `security-audit` | P0/P1 threat model and patch ordering | FAIL then resolved in docs | Read-only source/planning audit; no code executed. |
| Backend integration | `multi_agent_v1` explorer `backend-integration-audit` | Module seams, type ownership, circular dependencies, WS binding | FAIL then resolved in docs | Read-only source/planning audit; no code executed. |
| Testing | `multi_agent_v1` explorer `testing-audit` | Regression gates for P0/P1 and UI/privacy behavior | FAIL then resolved in docs | Read-only source/planning audit; no test suite executed. |
| Jawdev docs | `multi_agent_v1` explorer `jawdev-docs-audit` | Decade numbering, source-backed claims, audit evidence, implementation readiness | FAIL then resolved in docs | Read-only documentation audit. |

## Findings Resolved

| Finding | Source audit | Resolution | Changed docs |
| --- | --- | --- | --- |
| Missing audit-resolution artifact | Jawdev docs | Added this durable `01` artifact with audit lanes, fixes, limits, and readiness statement. | `01_audit-resolution.md` |
| Vague external evidence row | Jawdev docs | Replaced broad Codex/review wording with local source anchors and explicit advisory status for GPT Pro review input. | `00_research-and-slice-map.md` |
| Missing evidence limits | Jawdev docs | Added an evidence-limits table that downgrades non-durable review bundle paths and requires fresh implementation evidence. | `00_research-and-slice-map.md` |
| Sidecar upstream traffic not covered by fail-closed auth | Security | Added Phase 10 sidecar auth-context requirements for vision and web-search modules and tests. | `10_phase1-fail-closed-auth-context.md`, `devlog/280_codex-multi-auth-security-patch-plan/00_patch_plan.md` |
| Lifecycle cleanup would create `codex-auth-api`/`codex-routing` circular dependency | Backend | Added lower-level runtime state owner and lifecycle orchestrator before routing/API cleanup. | `20_phase2-account-lifecycle.md` |
| Account generation metadata lacks type owner and tombstone shape | Backend | Added `src/types.ts` credential-record ownership and tokenless tombstone model. | `20_phase2-account-lifecycle.md` |
| WebSocket binding remains raw-header/per-frame re-routing | Backend | Added `CodexSocketBinding`/`handleResponses` options plan and generation-aware invalidation. | `10_phase1-fail-closed-auth-context.md`, `20_phase2-account-lifecycle.md` |
| API auth scope too implicit | Security/testing/backend | Replaced selective route wording with default-deny `/api/*` and route-by-route auth matrix, plus data-plane predicate. | `30_phase3-local-api-auth-safe-dto.md` |
| Account DTO redaction missing from Phase 3 | Testing | Added `/api/codex-auth/accounts` safe DTO cases and raw-email/alias/token/header rejection requirements. | `30_phase3-local-api-auth-safe-dto.md` |
| Manual import duplicate verified-principal negative missing | Testing | Added same verified principal/workspace with different alias/display email rejection before credential write. | `40_phase4-manual-import-identity.md` |
| Outcome/quota tests too narrow | Testing/backend | Added export transition and required 403, non-auth 4xx, network reject, timeout, failed/incomplete/malformed stream, and fresh/stale/unknown/error/NaN/Infinity/out-of-range quota tests. | `50_phase5-routing-outcome-quota.md` |
| Stable pool label ownership wrong | Backend | Moved label generation ownership to `src/types.ts`/`src/codex-auth-api.ts`; routing only consumes labels. | `60_phase6-privacy-docs-verification.md` |
| UI masking gate optional | Testing | Made Codex Auth UI masking render/DOM verification mandatory and named the expected harness command. | `60_phase6-privacy-docs-verification.md` |
| Exact supersession docs missing | Jawdev docs | Listed concrete `270` and release-ready docs requiring supersession banners. | `60_phase6-privacy-docs-verification.md` |

## Findings Deferred

| Finding | Reason deferred | Required before implementation |
| --- | --- | --- |
| Exact inter-process lock primitive | Needs implementation design around current storage/home constraints. | Phase 20 must choose file lock, transactional store, or equivalent atomic cross-process mechanism before coding refresh CAS. |
| Exact GUI test harness package | Current GUI package lacks a dedicated test script. | Phase 60 must either add a GUI render test script or codify a Playwright/browser smoke command before claiming privacy verification. |
| Durable external review archive | Review bundle may include sensitive local context and is advisory, not primary evidence. | Use committed source/docs/tests and fresh command output as primary implementation evidence. |

## Final Readiness

After the B-phase document updates, this planning set is ready to seed the first implementation PABCD for Phase 10. It is not evidence that the product is secure or mergeable. Merge readiness requires implementing patches 10-60, running the listed tests/builds, and recording fresh verification evidence.
