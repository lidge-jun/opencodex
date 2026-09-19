# O1: [Feature]: Export existing request telemetry through an opt-in metadata-only scrape endpoint

### Area

Multiple areas

### What are you trying to accomplish?

Integrate existing logical-request, physical-send, terminal and latency facts with operator monitoring without reading raw request history or exporting private identifiers.

### What prevents this today?

[src/usage/log.ts:274](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/usage/log.ts#L274) already stores bounded operational facts, and [src/server/management/routing-analytics-routes.ts:24](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/server/management/routing-analytics-routes.ts#L24) serves JSON analytics. The pinned tree has no standard scrape exporter. The gap is export format and bounded aggregation, not absent observability.

### What should OpenCodex do?

Add an opt-in management-plane text exposition endpoint with documented counter/histogram lifecycle. Reuse existing completion/attempt facts, keep labels closed and bounded, and preserve independent management authentication.

### Example usage or interface

An operator scrapes aggregate logical requests, physical sends, terminal outcome counts, duration and TTFT. Protocol/result/recovery class may be labels; request/key/account/model IDs, raw errors, prompts and tool bodies never are. Metric names and route are design proposals.

### Alternatives or workarounds

Existing JSON analytics remains valid for interactive use. Raw request labels or scraping historical logs on every poll would make cardinality and cost unbounded. New timing instrumentation is outside this issue.

### Additional context

Source snapshot: `7864869c31c41cca9830d93540238f17df8faafb` after fast-forwarding `dev` on 2026-09-19. This is source-grounded analysis, not a runtime test result.

Closed #1217 owns durable stream-stage attribution and is not reopened. This proposal exports existing facts only; standard GenAI field mapping is deferred until verified.

### Implementation path

1. Add `src/server/metrics-registry.ts` with bounded in-memory counters/histograms and explicit restart semantics.
2. Feed it from existing lifecycle/completion/attempt seams in `src/server/request-log.ts`; avoid rescanning logs on scrape. Define incomplete/aborted and missing-TTFT denominators.
3. Add management route in `src/server/management/metrics-routes.ts` and register it in `route-registry.ts`.
4. Wire opt-in config type, validation/defaults, persistence/hydration and startup consumers; default remains off.
5. Add `tests/server/management-metrics-export.test.ts`; update management/config structure owners and `docs-site/src/content/docs/reference/management-api.md`.

### Acceptance criteria and verification

- One logical request with retries increments logical count once and physical sends by actual sends.
- HTTP 200 with failed terminal event is not counted as successful completion.
- Management credential required; data credentials do not grant access.
- Canary private strings and arbitrary IDs never appear in output; label series stay bounded.
- Disabled mode adds no exporter timer/network activity; restart/reset semantics and units are documented.

Register new tests in both layout inventories, preserve size caps, and update the existing structure owners. User-facing policy changes need corresponding public documentation and non-contradictory translations. Run focused tests and exact-head hosted CI during implementation; no local suite was run for this analysis.

### Checks

- [x] I searched existing issues and documentation.
- [x] This request describes a concrete OpenCodex workflow rather than merely naming a desired technology.
- [x] I removed secrets and personal data.
