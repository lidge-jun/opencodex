# Manual account selection must control dispatch

Loop: single-cycle satisfy-spec, C4 (credential/account allocation). Trigger: the user selected a healthy OAuth account in the dashboard, but every request was silently assigned to another account. Goal: disabled pools do not proactively reassign healthy requests; explicit selection wins; permitted automatic assignment is reflected in active-account state and dashboard. One cohesive PR targeting dev, pushed with `--no-verify` and merged as explicitly authorized. No stacks.

Boundaries: existing account/key owners, request credential pairing, dashboard account synchronization, regression coverage, matching public docs. No provider API changes, real-account configuration changes, paid inference probes, releases, service restarts, or unrelated refactors. Use existing dependencies and temp credentials. No token, cost, or wall-clock budget was set; no paid oracle is required. Completion requires fresh direct verification and actual remote merge; a pending PR is not DONE. Escalate only a genuine tool/access block or a necessary authority not already granted. Main reclaims a lane after two distinct worker failures; new worker scope requires a P amendment.

Memory: this numbered unit, `.tmp/manual-account-selection/` evidence, session-bound goalplan. The implementation and test map is in 010. One PABCD work-phase covers this single contract across its existing owners; frontend/runtime lanes are subtasks rather than separate deliverables.

## Evidence and rival hypotheses

GUI `useProviderAccountPools.ts:247` sends selected account to PUT `/api/oauth/accounts/active`. `oauth-account-routes.ts:322` calls `setActiveAccount`, which saves the selected id. `generic-account-failover.ts:185-196` defaults healthy proactive selection on when two accounts exist. `preferredInitialAccount` ranks by quota and can replace the selected healthy account. `responses/core.ts` resolves that other credential and logs it without updating stored selection. Provider quota reads stored active selection separately. Exact user-provided request IDs matched another account on attempt1, sendCount1, no retry. This is not an upstream429 recovery or a failed GUI save.

H1 failed persistence is disproved by stored selected id and successful route semantics. H2 only a2s roster cache is insufficient: quota ranking would choose the other account after the cache expires. H3 manual authority absent from the selector is supported by the complete route-to-store-to-request chain. We will prove H2/H3 with isolated real owner functions before implementation.

## Contract

- Presence of multiple stored accounts does not enable proactive healthy-request allocation. Absent generic OAuth proactive enablement is off; explicit false wins for proactive allocation. REACTIVE429 recovery remains mandatory whenever another usable account exists, regardless of the pool switch, per the latest explicit user correction.
- With a pool enabled, the healthy active/manual account stays eligible and preferred. A quota percentage alone below exhaustion must not replace it. On a real account-scoped refusal or known exhaustion, enabled rotation may choose another usable account.
- Committing an automatic account selection must be conditional on the selection generation that produced the request. A newer manual selection (including A→B→A) wins.
- The selected account and its access token/project/origin metadata travel together; unsupported/unknown quota is not exhaustion.
- Codex, Anthropic, and API keys keep their own established contracts, but any contradiction with these user requirements is repaired in the same PR. Their specific findings must be folded into010 before their edits.

Enforcement: runtime selectors plus guarded persisted active-account transition; execution surface covers first dispatch and every reactive replay. Known bypass: external callers can intentionally route exact account-targeting selectors, which remain their own explicit contract. Residual: concurrent requests can already be in flight on different credentials; dashboard reports the latest committed allocation, never retroactively cancels an already sent request. Wording: no claim that a UI highlight can reassign a request already upstream.

Verification: focused Bun store/management/selection/retry tests first; full `bun run typecheck` and `bun run test` before PR review-ready; relevant GUI tests/lint/build and a rendered state transition if frontend changes. Regression tests use synthetic identities only. Public SoT: `structure/05_gui-and-management-api.md` and existing account/pool guide pages. Final record includes rejected hypotheses, unmodified owners with proof, security/concurrency audit, and remote merge.

Latest steering: the user reports Codex works correctly. Preserve Codex routing/controller semantics and use its existing manual-selection behavior as the reference; include regression-only checks for Codex. Concentrate changes on the other quota-aware account paths where a concrete mismatch is established.

Latest explicit design instruction: GUI selection and pool selection must share one selection owner, as Codex does. Both must commit the same authoritative selection BEFORE dispatch; requests use the committed account. Do not bolt on a separate UI-only mirror or route around manual selection while pretending the old active account remains selected. A concurrent newer user selection wins. This strengthens the existing planned store-owned selection transaction and applies with pool on or off.

Latest correction: 429 automatic account switching is ALWAYS allowed, including poolOFF. Withdraw the planned reactive disable gate. Manual selection wins ordinary dispatch; a real429 may replace it using the same guarded selection owner, and the GUI follows that committed replacement.

Latest explicit verification restriction: do not run repository-wide tests. The earlier full-suite requirement is superseded. One attempted full run was interrupted by user at exit130; it is not completion proof. Resolve observed failures with their specific test files, run focused affected checks and typecheck, then push --no-verify and merge the single PR.
