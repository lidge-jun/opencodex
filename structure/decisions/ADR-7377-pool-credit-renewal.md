# ADR-7377: decision recorded under "Pool credit renewal"

- Purpose: keep an explicitly opted-in credited pool account observable after its included usage
  fills, without requiring a dashboard/manual metadata read every five minutes (#7377).
- Constraint: response headers update aggregate usage but do not observe credit balance. Reusing
  aggregate freshness can therefore starve credit refresh while normal requests keep arriving.
- Alternatives: extend credit validity from traffic, add another polling loop, or reuse the existing
  sweep and bounded pool quota primer. Extending validity invents spendable balance evidence;
  another loop duplicates lifecycle/concurrency ownership.
- Decision: a pool-only prime reason selects exhausted, opted-in eligible accounts by the independent
  credit clock, bypasses aggregate cache freshness, and reuses generation-aware probe/backoff owners.
- Consequences: metadata work starts from three minutes of evidence age with a matching minimum
  per-credential retry gap. Native main keeps its separate passive/physical-identity path. Failed
  reads do not make an account selectable or authorize any inference. A network outage can still
  let credits expire; admission correctly remains closed until fresh evidence returns.
