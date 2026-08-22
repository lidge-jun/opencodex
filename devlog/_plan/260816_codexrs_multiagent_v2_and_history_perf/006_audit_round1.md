# 006 — A-phase audit round 1: blockers and disposition

Reviewer: independent `explorer` subagent (gpt-5.6-sol, high effort), read-only, dispatched
2026-08-16 against revision 1 of this unit. Verdict: **FAIL**, 11 blockers.

Every blocker was re-verified by the main agent against real code before disposition —
none were accepted on the reviewer's word, and none were rejected without evidence.

| # | Sev | Blocker | Disposition |
| --- | --- | --- | --- |
| 1 | High | Verifier commands exit 1 in this checkout (`zod/v4` missing, `bun-types` missing); no exit-code receipts recorded | **FOLDED.** Root cause confirmed: `ls node_modules` → absent. Every decade doc now carries a receipts table and a `bun install` precondition; `000_plan.md` has a global environment precondition. |
| 2 | Medium | Four citations miss their content: `sync.ts:627/1087` reversed; `package.json` `test` is `bun scripts/test.ts` not `bun test`; `compact.rs:35` is `fn path()` not `CompactRequest::new`; `index.ts:1071` is a comment, code at `:1074` | **FOLDED.** All four verified wrong and corrected in place. |
| 3 | High | Phase 1 left `isEligibleV2SubagentEntry` (`sync.ts:105-108`) implementing the old equality rule, so Luna stays out of the roster | **FOLDED — the most important finding.** Confirmed: the predicate returns true only for `v2`/null/undefined. Phase 1 rewritten around it; `000_plan.md` now names both sites. |
| 4 | High | `CatalogModel.multiAgentVersion` is a ghost field — no creation path; `provider-fetch.ts:999` discards `multi_agent_version`; native management rows (`model-rows.ts:67`) and GUI type (`models-shared.ts:28`) omit it | **FOLDED.** Confirmed by reading each site. Phase 1 Change 3 now specifies the full chain with an `N/A + reason` for user config. |
| 5 | High | Phase 2's fail-closed contract is unimplementable: sync/restore use bulk updates (`history-provider.ts:750`, `:801`); `rememberOriginal` (`:340`) and the result contract (`:165-175`) missing from the chain | **FOLDED.** Confirmed. Phase 2 now specifies explicit row partitioning with id-scoped SQL, a `skippedUnknownMode` result field, and its consumers. |
| 6 | High | G5's impact is unreachable: preview output is consumed only by `cleanup.ts:2305`, and `cleanup.ts:673` refuses paginated threads first. Fixture recipe used `rg -rn` (`-r` = replace) | **FOLDED.** Confirmed both. G5 downgraded to **conditional** behind an explicit caller-reachability gate that may legitimately end in removing G5; commands corrected. |
| 7 | High | Phase 4 changed the writer to the canonical key while readers (`features.ts:243`) recognize only `max_threads`; conflict detector had no consumer; GUI (`Models.tsx:1341`) and locales keep the false boot-refusal copy | **FOLDED.** Confirmed `getLogicalMaxThreads` (`:1305`), the `:1496` postcondition, and `agent-settings-routes.ts:232`. Phase 4 rewritten with the full chain. |
| 8 | High | Fallback wrongly declared "orthogonal and correct": `selectAvailableSubagentModel` (`subagent-model-fallback.ts:269`) ignores capability and rewrites the model after the child tool surface is built (`core.ts:1768`). Also `collaboration.ts:349` fork guidance is stale | **FOLDED as new gaps G12 (compat-break) and G13.** Both confirmed. Now Phase 1 Changes 4 and 5. |
| 9 | Medium | Stated inter-phase dependencies are not real | **FOLDED.** Confirmed: Phase 4's link to Phase 1 was a shared doc file, and Phase 3 does not consume Phase 2's resolver. All phases now marked independent, with a *recommended* risk-first order stated separately. |
| 10 | High | LEXICO-SPLIT-01: research docs 001, 002, 005 contain implementation roadmaps | **FOLDED.** Prescriptive sections removed from the research docs, which now point to the decade docs. |
| 11 | High | Several decade docs are not independently executable: unresolved "export or duplicate", "audit then conditionally fix", "two possible outcomes", "likely no-op" | **FOLDED.** Phase 2's helper question settled (move to `src/codex/sqlite-columns.ts`, re-export). Phase 3's audit is now a bounded lock-and-regress with an explicit gate. Phase 5's decision rule is fixed in advance and its Guardian item is a concrete regression. |

## Rebuttals

None. Every blocker was verified as accurate.

## What the audit changed about the conclusion

Revision 1 would have shipped a Phase 1 that renamed the symptom and left the defect:
Luna would still have been excluded from the roster after "fixing" leaf semantics,
because the exclusion lives in the roster predicate, not the catalog stamp. The audit
also surfaced two gaps the five-lane research swarm missed entirely (G12, G13), one of
them a compat-break. That is the argument for the A gate being a real dispatch rather
than a self-review.

