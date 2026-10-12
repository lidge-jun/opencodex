# R1: [Feature]: Complete cross-layer send accounting for pre-output rate-limit replay

### Area

Proxy and routing

### What are you trying to accomplish?

Finish the explicitly deferred integration between adapter-local pre-output replay and OpenCodex request-wide send accounting, provider pacing and recovery telemetry.

### What prevents this today?

Public PR #5041 explicitly lists physical inner replay integration with the shared send budget, provider fetch wrapper and physical-attempt accounting as remaining work. At the pinned source, [src/server/responses/run-turn-execution.ts:162](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/server/responses/run-turn-execution.ts#L162) passes the budget/fetch seam, while [src/adapters/devin.ts:570](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/adapters/devin.ts#L570) does not thread it into the reset-retry wrapper.

### What should OpenCodex do?

Admit every actual inference send through the existing shared permit/observer path and count it once. Keep the zero-yielded-output replay boundary, cancellation and server-stated wait semantics unchanged. Reuse current spend reservation/refund and usage settlement semantics rather than adding another local counter.

### Example usage or interface

With a fake reset response followed by another attempt, the request-level used-send count and recorded physical attempts match actual fake-upstream sends. A refused next permit emits the existing withheld-recovery reason and makes no further inference request.

### Alternatives or workarounds

Removing safe replay discards the shipped recovery behavior. Incrementing budget.used directly misses reservation/observer/refund semantics. An adapter-only cap would preserve separate authorities.

### Additional context

Source snapshot: `7864869c31c41cca9830d93540238f17df8faafb` after fast-forwarding `dev` on 2026-09-19. This is source-grounded analysis, not a runtime test result.

This tracks a remaining item already disclosed in [#5041](https://github.com/lidge-jun/opencodex/pull/5041), not a new broad retry system. #5044/#5056 handle attribution when recovery is withheld and do not complete this adapter integration. Long-wait keep-alives and a cross-transition scheduled-wait allowance remain separate work.

### Implementation path

1. Thread `IncomingMeta.sendBudget` and `providerFetch` through `src/adapters/devin.ts`, `src/adapters/devin/cloud-direct/stated-reset-retry.ts` and the inference send in `src/adapters/devin/cloud-direct/chat.ts`. Inventory each actual inference send before choosing permit placement.
2. Acquire/commit/refund through existing `reserveDispatch` semantics exactly once per physical send; do not double-charge the initial outer slot.
3. Extend `src/adapters/base.ts` IncomingMeta callbacks only if needed to share the existing physical-send/recovery contract; wire caller, adapter, callback consumer and usage aggregation together.
4. Preserve auth, selected-account, pacing and no-replay-after-output boundaries.
5. Extend `tests/providers/devin-stated-reset-retry.test.ts`, `tests/providers/devin-stated-reset-hardening.test.ts`, `tests/adapters/adapter-inner-send-budget.test.ts`, `tests/adapters/adapter-inner-send-budget-wiring.test.ts`, and `tests/responses/responses-send-budget-counts.test.ts`; update `structure/adapters/registry.md`, `structure/transports/responses.md` and the adapter reference.

### Acceptance criteria and verification

- Shared cap, actual fake sends, per-attempt telemetry and spend settlement agree.
- Refused send performs no inference I/O and records why recovery was withheld.
- Aborted waits and post-output failures never replay.
- Initial send is neither omitted nor counted twice.
- Tests use fake send seams and isolated state; no live account calls.

Register new tests in both layout inventories, preserve size caps, and update the existing structure owners. User-facing policy changes need corresponding public documentation and non-contradictory translations. Run focused tests and exact-head hosted CI during implementation; no local suite was run for this analysis.

### Checks

- [x] I searched existing issues and documentation.
- [x] This request describes a concrete OpenCodex workflow rather than merely naming a desired technology.
- [x] I removed secrets and personal data.
