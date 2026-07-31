# 060 — Unit Closeout (WP0-WP5b done)

Final state: all five roadmap phases + the chained probe-readonly hotfix
landed on origin/dev and are CI-green (run 30066807872 on WP5b tip).

| Phase | Commit(s) | A gate | C review |
|-------|-----------|--------|----------|
| WP0 roadmap | 1a882d89..80ef75cc | PASS r3 | n/a (docs) |
| WP1 adapter terminal truth | 0aed47ba | near-pass (1 folded) | PASS (2 Low noted) |
| probe-readonly (chained) | b6ece844 | near-pass (1 folded) | full suite 3918/0 |
| WP2 terminal singleness | 0a484af4 + 75141452 | near-pass (1 folded) | PASS (1 Low: web-search cancelled log) |
| WP3 chat incomplete fidelity | 5c6cc919 | PASS | PASS |
| WP4 heartbeat/stall | 29f2574e + whitespace fold | near-pass (1 folded) | PASS (1 Low folded in-cycle) |
| WP5a abort guard + queue cap | 366e3053 | near-pass (4 folded, split) | PASS (2 trivial Low) |
| WP5b pull-driven backpressure | 03ea4e59 | near-pass (1 folded) | PASS (post-hoc, notes below) |

## WP5b post-hoc C-review notes (Peirce, VERDICT: PASS)

- Live-delivery contract change is an honest adaptation, not a weakening:
  the old sync-burst distribution assertion measured the removed
  macrotask-yield machinery; the new assertion (first delta within 500ms
  while the producer is paused) re-states issue #114's user-visible
  contract more strongly. The large-burst mid-stream DISTRIBUTION property
  is now structurally guaranteed (per-event pull = no coalescing) rather
  than assertion-pinned — recorded here for audit traceability.
- TTFT/onFirstOutput semantics shifted from "upstream received" to
  "client demanded" — the inherent meaning of backpressure; ~0
  difference for eager clients. Recorded as intentional.
- Residual Low: bridge slow-consumer test asserts consumption <= 1 where
  the true expectation is 0 (won't catch a first-event-consumption bug).
  Candidate micro-fix for a future pass.
- WP2 residual Low carried: web-search success turns log "cancelled"
  (warn at loop.ts:554-556 fires on normal terminal since the bridge now
  cancels the source at terminal). Cosmetic, log-truthfulness follow-up.

## Carried-out-of-scope items (from 002)

- Class 6 (partial non-empty terminal reconstruction): conditional
  reachability, previously scoped OUT by bugfix-train 010 — unchanged.
- Class 10 (Windows tee vs eager-relay): blocked on upstream Bun fix
  verification, not local code.
- Class 13 (pre-header reset retry may duplicate upstream generation):
  policy decision, flagged to maintainers.
- Class 14 (replay-state eviction fails open): product decision, flagged.
