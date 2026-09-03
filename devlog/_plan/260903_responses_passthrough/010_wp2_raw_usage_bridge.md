
## Close-out (D)

- Commit 1f0d820aa: OcxUsage.rawUsage + adapter extras capture (incl. zero-count metadata-only usage) +
  responsesUsage merge; 6 new tests in tests/responses-usage-passthrough.test.ts.
- Review: 5 subagent dispatches failed pool-wide (401/capacity/transport); direct independent audit PASS
  (ledger: rpt-wp2-* attests). Nuance accepted: zero-count-with-extras usage shows 0 tokens in display.
- Residual: unknown response.* event types dropped on translated paths (B3) — separate unit.
