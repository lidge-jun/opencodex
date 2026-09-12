# Finish automatic plan policy and visible exclusion reasons

Cycle eligibility; C3 selection policy. Depends only on roadmap, independent dev PR. #4238 already added excludedPlans; do not reimplement its selector. Source: routing.ts:1044-1090 and 1326; explicit fixedAccountId path auth-context.ts:826/915.

MODIFY `src/codex/routing.ts`: export the existing normalized policy predicate (or move the pure plan calculation into `src/codex/plan.ts` and reuse it). Add the predicate to BOTH configured-account fallback guards at preview :2152 and detailed resolve :2391. Before, an all-excluded pool returns its excluded active row; after, ordinary selection returns null/none. Explicit fixed routes retain existing auth, pause, entitlement checks. Native __main__ remains exempt, avoiding physical auth reads on selection-only paths.

```diff
- && !isCodexAccountPaused(config, active)
+ && !isCodexAccountPaused(config, active)
+ && !isCodexAccountPlanExcluded(config, active)
```

MODIFY `src/codex/auth-api.ts`: poolAccountDto adds optional `selectionExcludedReason: "plan_excluded"`, derived from the SAME predicate and config, never from credential health; include current plan already in DTO. MODIFY `src/cli/account-api.ts` AccountRow/CodexAccountDto mapping and `src/cli/account.ts` statusText to show `not-auto-selected(plan=<plan>)`. MODIFY `gui/src/components/codex-account-pool-types.ts`, pool-card badge in `codex-account-pool-cards.tsx`, and all locale catalogs: separate localized reason; do not mutate paused/needsReauth and do not disable explicit routing. Unknown plan and empty policy remain eligible; reauth renewal clears the reason dynamically.

Field chain: existing excludedPlans config create/save/load → same normalized predicate → account DTO JSON → CLI/GUI optional union → status and badge. No new config field or minimumPlan ordering. Enforcing tier: runtime automatic selection only; explicit fixed account intentionally bypasses this selection rule, not auth; residual unknown-plan and native-main exemptions documented, no hard account-block claim.

MODIFY existing `tests/codex-integration/codex-pool-plan-exclusion.test.ts`: replace last-account soft fallback test with none/preview none; test normalized plan update and explicit fixed route. Extend account API/CLI and card tests for reason and renewal clearing. Sync ownership docs and providers configuration pages that describe the old soft exception. Retain source attribution of #4238; no recarry of already-landed commits. Local tests/build/typecheck NOT RUN. Hosted CI plus rendered artifact from final tip supplies execution proof.

Exclusion reason derives from the routing config plan, not a display-only freshly observed plan if persistence failed. This preserves truth between selection and explanation.
