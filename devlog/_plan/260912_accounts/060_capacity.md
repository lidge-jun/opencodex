# Estimate observed effective capacity without claiming an upstream limit

Cycle capacity depends on history. Source: `src/usage/log.ts` already persists accountLogLabel, timestamp, reported/estimated usage and per-attempt attribution; `src/codex/account-label.ts` owns safe labels. Use those existing records instead of storing credentials or duplicating request attribution.

NEW `src/codex/quota-capacity.ts`: a pure estimator receives copied raw history and account-attributed reported usage observations. For each short/weekly/monthly window, pair adjacent fresh percentage observations only when reset identity matches, time increases and percentage delta is positive. Sum reported token usage in that interval, count per-attempt records once, exclude estimated/local/unattributed usage and reset/refund crossings. Estimate tokens per full window as observedTokens * 100 / percentageDelta; aggregate defensible intervals with median and report sampleCount plus observed-token lower-bound caveat. No valid interval returns null, never zero or a fabricated capacity. Bounded scan is invoked on management request, never routing; estimation is informational and does not overrule live quota.

```ts
export type CodexCapacityEstimate = {
  window: "short" | "weekly" | "monthly";
  estimatedTokens: number;
  sampleCount: number;
  confidence: "observed-lower-bound";
};
```

MODIFY history read API/CLI projection to attach per-window estimates with sample count and caveat; expose an existing account-card detail surface only if it can be honestly rendered and verified. Field chain: pure estimator creation; API JSON serialization; existing typed CLI/client deserialization; explicit informational display consumers. No persisted estimate schema needed. Tests feed independently hand-calculated intervals, 0% delta, reset rollover, missing timestamps/identity, cross-account records, retries, estimated usage, and extreme numeric input. Sync quota/usage ownership docs and user configuration guidance. Full closure of #3376 requires both history and meaningful capacity; reset-first alone stays partial. Local suites NOT RUN; hosted final cumulative tip is the verifier.

A2 accepted: use readUsageSnapshotForManagement; if truncatedPrefixBytes>0, entriesTruncated, entriesDropped>0, missing revision, or invalid timing then return insufficient-evidence with no estimate. Treat each request as interval [timestamp, timestamp+durationMs] (request-log.ts:1039/1072); include only requests wholly contained in a quota-observation interval. Boundary-spanning requests contribute nothing. For included requests count reported physical attempts matching the exact pool label once; do not count both request total and attempts. Without attempts accept request-level reported usage only with matching label and no recovery ambiguity. Native main is excluded from token capacity because its historical label cannot establish identity after replacement. Current pool logLabel must be unique; legacy fallback labels/id reuse require insufficient evidence unless continuity is proven by history generation. Same-reset positive deltas only. Hand-worked boundary-spanning, truncation, missing identity and retry rows are mandatory regression fixtures.
