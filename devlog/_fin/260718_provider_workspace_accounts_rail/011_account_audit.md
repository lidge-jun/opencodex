# Account-switcher A-gate synthesis

## Audit inputs

- The pre-roadmap account explorer independently traced list -> active id -> PUT -> persistence -> runtime credential selection and returned `VERDICT: READY` with nine concrete risk/activation findings.
- Fresh baseline command in this A phase:

  ```text
  bun test --isolate tests/oauth-accounts-api.test.ts tests/oauth-store-multi.test.ts
    tests/oauth-public-surface.test.ts tests/codex-auth-api.test.ts
    tests/provider-workspace-data.test.ts tests/provider-workspace-state.test.ts
  118 pass / 0 fail / 398 assertions
  ```

- Two account-plan-specific reviewer agents produced no result after three bounded waits each and were retired. This is the second same-packet dispatch failure, so the main agent reclaimed the audit under `000_plan.md` escalation rules.

## Feasibility and branch audit

1. `ProviderAuthSurface` is feasible from existing `WorkspaceItem`, `isAccountProvider`, `isLocalProvider`, `authMode`, `hasApiKey`, and `keyOptional`; no server field is invented.
2. Generic per-provider generation state is render-local orchestration owned by `Providers.tsx`; functional merges avoid the current subset-erasure bug. No global store is warranted.
3. Generic switch failure is reachable through non-2xx and rejected fetch. The plan preserves old state and adds `finally` recovery.
4. Codex false success is directly reachable because `setActive` currently ignores `res.ok`; the plan consumes the response only after `ok` and refreshes authoritatively.
5. Canonical-vs-custom forward is reachable using existing catalog fixtures and must use `isAccountProvider`, not `authMode === forward`.
6. `needsReauth` is already present in both generic and Codex DTOs; blocking mutation and exposing recovery is reachable.
7. Loading/empty/one/many states are reachable from delayed/failed/real responses. Anthropic has two live rows and Codex has four, supplying real many-state proof.
8. Existing React tab buttons can implement roving focus without a dependency. Browser QA is required because the package has no DOM harness and adding one is out of scope.
9. Identity-less one-slot providers remain honest: they expose their current returned row but are not described as a pool.
10. Account-tab scope fits one work-phase because server routes/stores are unchanged; all source edits remain inside the existing GUI owner chain plus one pure classifier.

## Additional blockers found by main audit and folded

1. **Stale tab state across provider changes.** `ProviderDetails` is reused without a key. Amendment: key it by provider name so tab/settings state cannot cross provider identity.
2. **OAuth/account status contradiction.** Independent requests can report stale `loggedIn=false` above real active rows. Amendment: non-empty authoritative account rows establish the panel's logged-in summary.
3. **Generic raw-id feedback leak.** `Providers.tsx:131,200-203` uses `email ?? id` in visible notices/confirms. Amendment: shared masked-email/ordinal label in every workspace feedback path.
4. **Codex raw-id confirm leak.** `CodexAccountPool.tsx:78,85-88` can use ids in labels/confirms. Amendment: use masked email or main-account copy only.

## Residuals

- The full embedded Codex pool remains denser than the generic OAuth row list. This is non-blocking for function and will be judged from the rendered Accounts tab; any density repair stays inside `CodexAccountPool`/workspace styles and must be added as a B deviation before editing.
- Account deletion focus restoration is not redesigned in this slice; existing confirmation remains. New accessible labels are required, and final keyboard QA must ensure focus is not lost after non-destructive account switching.

## Main audit judgment

All reachable auth-selection blockers now have exact owners and activation evidence. No backend contract or credential-store change is required. Formal reviewer delivery failure is recorded, not hidden; final C/D still requires fresh implementation review.

VERDICT: GO-WITH-FIXES (blockers=0)
