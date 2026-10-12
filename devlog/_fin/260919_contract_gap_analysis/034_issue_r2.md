# R2: [Feature]: Make explicit sibling instances honor the spend-ledger topology contract

### Area

Service lifecycle

### What are you trying to accomplish?

Align the supported local sibling-process workflow with the documented single-writer spend-ledger guarantee when a token ceiling is enabled.

### What prevents this today?

Public sibling-start work in #3188 allows an explicitly different port, while [src/lib/spend-reservation-ledger.ts:27](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/lib/spend-reservation-ledger.ts#L27) explicitly limits journal guarantees to one live proxy process. [src/cli/index.ts:413](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/cli/index.ts#L413) retains sibling support. These public topology contracts need an explicit product boundary.

### What should OpenCodex do?

Require every process that may initialize, append or compact the shared journal to participate in a state-directory writer lease, or provide a proven cross-process transaction boundary. Prefer a local single-writer lease first. Give a clear second-writer refusal and scalar ownership/health diagnostics. Do not suggest a shared database is necessary for ordinary local use.

### Example usage or interface

An operator starts a second explicitly ported instance under the same state directory. With an active enforced ledger owner it is refused clearly; an isolated state directory remains independent. An observe-only process must not write into an enforced owner’s journal merely because its own local config has no ceiling.

### Alternatives or workarounds

An append-only lock does not serialize in-memory reservation state and compaction. Silent per-process ceilings weaken the shared-directory meaning. Distributed state is deferred until a real multi-host requirement exists.

### Additional context

Source snapshot: `7864869c31c41cca9830d93540238f17df8faafb` after fast-forwarding `dev` on 2026-09-19. This is source-grounded analysis, not a runtime test result.

This is a supported-topology follow-up to [#3188](https://github.com/lidge-jun/opencodex/pull/3188) and the public single-process limitation in the ledger. #5032 made ceilings configurable but did not change topology. No new bypass reproduction is included.

### Implementation path

1. Add `src/lib/spend-ledger-owner.ts` or reuse a compatible process-identity lease primitive after source review.
2. Enforce ownership at the ledger construction/use boundary, covering CLI and exported startServer paths; CLI preflight supplies readable diagnostics but is not the only check.
3. Cover every shared-journal writer, including observe-only mode: permit only one writer unless cross-process serialization is proven. Siblings can retain independent journals/state directories, or explicitly non-writing observation. Enabling a ceiling after observe-only operation must retain or acquire valid ownership before any enforced dispatch.
4. Validate stale process identity beyond PID; refuse uncertain ownership; release on shutdown and every partial-start failure.
5. Expose only initialized/configured/degraded and bounded error counters, never scope/account/request IDs or journal paths. A diagnostic read must not initialize or prune the ledger.
6. Add isolated multiprocess ownership/rollback tests; update runtime/config/Responses structure owners and server configuration docs.

### Acceptance criteria and verification

- Two processes cannot simultaneously own an enforced journal.
- Two observe-only siblings and mixed observe-only/enforced siblings obey the same journal ownership rule; enabling a ceiling after observation cannot skip ownership.
- Independent state directories, stale-owner recovery and ambiguous-owner refusal behave explicitly.
- Shutdown and partial startup release ownership; config changes cannot enable enforcement without acquiring it.
- Public guidance distinguishes process restart durability from host power-loss guarantees.

Register new tests in both layout inventories, preserve size caps, and update the existing structure owners. User-facing policy changes need corresponding public documentation and non-contradictory translations. Run focused tests and exact-head hosted CI during implementation; no local suite was run for this analysis.

### Checks

- [x] I searched existing issues and documentation.
- [x] This request describes a concrete OpenCodex workflow rather than merely naming a desired technology.
- [x] I removed secrets and personal data.
