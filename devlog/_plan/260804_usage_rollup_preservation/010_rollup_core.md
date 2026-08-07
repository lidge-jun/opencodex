# 010 — Rollup core module (`src/usage/rollup.ts`) — rev3 (post-audit 002 R2)

One PABCD cycle. Write scope: `src/usage/rollup.ts` (new),
`tests/usage-rollup.test.ts` (new), plus the fingerprint enablers (R2-4):
`src/usage/cost.ts` (add `ROLLUP_COST_SEMANTICS_VERSION` constant only),
`src/usage/expected-prices.ts` (export `PRIORITY_MULTIPLIERS`/`CONTEXT_TIERS`
if not already exported), `scripts/generate-jawcode-metadata.ts` +
regenerated `src/generated/jawcode-model-metadata.ts`
(`JAWCODE_TABLE_FINGERPRINT` computed at generation time).

## Files

- `usage-rollup.jsonl` — append-only, next to `usage.jsonl` (`getConfigDir()`),
  0600 like the raw log, registered via `recordOwnedConfigPath`. **This file is
  the single commit authority** (002 B1): the effective cutline is derived from
  its committed segments, never from meta.
- `usage-rollup-meta.json` — correctness-light (lineage, fingerprint, throttle
  stamp). 0600, `recordOwnedConfigPath`, replaced via the existing
  `renameAtomicFile()` (config.ts) after the rollup fsync.

## Types (all exported for tests; field names final)

```ts
export interface RollupMeta {
  version: 1;                    // schema version; mismatch → rebuild
  lineageKey: string;            // dev\0ino\0birthtimeMs of usage.jsonl
  priceFingerprint: string;      // see below; mismatch → rebuild
  lastFoldAttemptAt: number;     // throttle stamp only
  updatedAt: number;
}
// Commit row: appended LAST in a fold, after all group rows, then fsync.
// Every fold ATTEMPT has a unique attemptId carried by its group rows and its
// commit row (R2-1). A segment is visible ONLY when a commit row exists whose
// attemptId-matched group rows satisfy rowCount AND payloadDigest. Abandoned
// attempts (crash before commit) are permanently invisible garbage; retries use
// a fresh attemptId so they can never collide. Cutline = max contiguous
// committed toOffset.
export interface RollupCommitRow {
  kind: "commit"; lineageKey: string; seg: number /* fromOffset */; toOffset: number;
  attemptId: string;             // `${foldedAt}-${rand}` — binds commit to one append attempt
  rowCount: number;              // group rows of THIS attempt
  payloadDigest: string;         // sha256 over this attempt's serialized group rows
  boundaryDigest: string;        // sha256 of the LAST 4 KiB of [seg, toOffset) raw bytes (002 B5)
  attributionSinceMs: number | null; // per-segment min; reader takes min over committed segments
  oldestTimestampMs: number | null;  // per-segment min
  foldedAt: number;
}
export interface RollupStatusCounts { reported: number; unreported: number; unsupported: number; estimated: number; }
export interface RollupTokenSums { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; reasoningOutputTokens: number; totalTokens: number; }
export type RollupSurfaceKey = "codex" | "claude" | "claude-desktop" | "grok";
export interface RollupDayRow {
  kind: "day"; seg: number; attemptId: string; date: string; surface: RollupSurfaceKey;
  statusCounts: RollupStatusCounts; attemptCount: number;
  tokens: RollupTokenSums;
  estimatedCostUsd: number; pricedRequests: number; unpricedRequests: number; unmeteredRequests: number;
}
export interface RollupModelRow {
  kind: "model"; seg: number; attemptId: string; date: string; surface: RollupSurfaceKey;
  provider: string;              // baseProviderLabel() already applied
  model: string;                 // usageModelIdentity() already applied
  resolvedModel?: string;        // display-only first-seen; identity stays provider/model (002 adv)
  requests: number;              // distinct requestIds this day×surface×model
  attemptCount: number;
  foldedStatusCounts: RollupStatusCounts; // foldAttributionStatuses() per request, then counted
  tokens: Pick<RollupTokenSums, "inputTokens" | "outputTokens" | "totalTokens">;
  estimatedCostUsd: number;      // attempt-attributed, matching buildModels cost pass
}
// providers stored explicitly: within-entry combo dedupe (one requestId across
// two models of one provider counts once) is applied at fold time per entry and
// cannot be recovered from model rows.
export interface RollupProviderRow {
  kind: "provider"; seg: number; attemptId: string; date: string; surface: RollupSurfaceKey; provider: string;
  requests: number; attemptCount: number; foldedStatusCounts: RollupStatusCounts;
  totalTokens: number; estimatedCostUsd: number;
}
export interface RollupKeyRow {
  kind: "key"; seg: number; attemptId: string; date: string; admissionKind: "configured" | "environment" | "loopback";
  apiKeyId?: string; requests: number; requestsWithTimestamp: number; lastUsedAtMs: number | null;
}
```

### Surfaces

`surface` filtering has four disjoint predicates (`summarizeUsage`): `claude` =
`claude|claude-desktop`, `grok`, `codex` = `undefined`, `all` = everything.
`RollupSurfaceKey = "codex" | "claude" | "claude-desktop" | "grok"` — store the
raw stored value (with `codex` for undefined) and let the reader apply the same
predicates. Folding `claude-desktop` into `claude` at write time would bake in
today's display rule; storing the raw key keeps the fold lossless w.r.t. the
filter axes.

### Price fingerprint (002 B4)

`priceFingerprint = sha256(stableStringify({ semantics: ROLLUP_COST_SEMANTICS_VERSION,
jawcode: JAWCODE_TABLE_FINGERPRINT, overlays: EXPECTED_PRICE_OVERLAYS,
priority: PRIORITY_MULTIPLIERS, contextTiers: CONTEXT_TIERS }))`.
`JAWCODE_TABLE_FINGERPRINT` is emitted by the generator at generation time
(packaged-runtime safe — no source reads at runtime).
`ROLLUP_COST_SEMANTICS_VERSION` lives in `src/usage/cost.ts` next to the
estimator: any change to estimator/canonicalization behavior not visible in
the hashed tables must increment it (documented in a comment there). Any
mismatch → `rollupNeedsRebuild()` → discard both files and refold from 0.

## Fold algorithm (`foldUsagePrefix`) — rev2

```
recovery preflight:
  read rollup file (complete JSONL lines only; a partial trailing line is dropped
  by framing); validate each commit row by (attemptId, rowCount, payloadDigest)
  against its attempt's group rows; committed cutline = max contiguous committed
  toOffset; rows of uncommitted/failed attempts are permanently invisible garbage
  verify previous committed segment's boundaryDigest against live raw bytes;
  mismatch OR live size < cutline OR lineage/fingerprint mismatch → full rebuild from 0
eligibleCutline(raw):
  scan forward from committed cutline in 1 MiB chunks (readExactly, same as log.ts)
  find the byte offset of the first row whose localDateKey(timestamp) >= (today - ROLLUP_MIN_AGE_DAYS)
  clamp so the fold only covers COMPLETE newline-terminated rows
  → { fromOffset: committed cutline, toOffset }
if toOffset <= fromOffset: NOOP
parse rows in [fromOffset, toOffset) cooperatively (yield every 1k lines)
accumulate day/model/provider/key groups using THE SAME helpers the display path
  uses: normalizeUsageEntry, usageAttributions, foldAttributionStatuses,
  usageDisplayTotalTokens, serviceTierContext + estimateComboCost/estimateRequestCost,
  baseProviderLabel, usageModelIdentity, localDateKey (exported from summary.ts)
append-boundary repair: if usage-rollup.jsonl does not end in "\n" (crash left a
  partial trailing line), truncate to the last complete newline before appending
  (ftruncate at lastNewline+1) — never append after a fragment
mint attemptId; append group rows (tagged seg=fromOffset, attemptId), THEN the
commit row binding (seg, attemptId, rowCount, payloadDigest); fsync(fd)
write meta (throttle stamp) via renameAtomicFile; dir-fsync best-effort
```

`ROLLUP_MIN_AGE_DAYS = 9` (002 B3): the tail always owns the full 7d window
plus a 2-day margin, so `requests7d`, the 7d range, and lastUsedAt stay
tail-exact. Day-grain boundary approximation applies only to 30d.

Crash behavior: a crash before the commit row leaves uncommitted garbage rows
that are never visible and never block a retry — the retry re-folds the same
range under a NEW attemptId, so abandoned rows can never satisfy (or poison)
a later commit's rowCount/payloadDigest (R2-1). A crash after fsync but before
the meta stamp costs only an early next throttle check. There is no state in
which reader-visible rollup data and the derived tail start disagree, because
both come from the same committed cutline.

Hand-edits deep inside an already-folded prefix are NOT auto-detected (only the
committed boundary digest is re-verified at fold time). Documented policy: the
rollup is a derived cache — delete both files to force a full rebuild.

## Read API

```ts
export interface RollupSnapshot {
  cutlineOffset: number;         // derived from committed segments
  attributionSinceMs: number | null; oldestTimestampMs: number | null;
  days: RollupDayRow[]; models: RollupModelRow[]; providers: RollupProviderRow[]; keys: RollupKeyRow[];
}
export function readRollupSnapshot(): RollupSnapshot | null;  // null = absent/invalid/lineage-mismatch
export async function ensureRollupCurrent(): Promise<void>;   // fold-if-eligible, throttled (min 10 min between attempts), single-flight
export function resetRollupForTests(): void;
```

**Synchronous validity gate (R2-2):** `readRollupSnapshot()` itself validates
version, lineage (against the live raw file), and priceFingerprint BEFORE
returning; any mismatch or absent/corrupt meta returns null, and the caller
serves raw-tail-only (cutline 0, legacy behavior) while the background rebuild
proceeds. Stale-cost data is structurally unreachable regardless of the async
fold's timing.

Reading includes only rows whose `seg` has a validated commit row; groups with
the same `(kind, date, surface, …key)` across committed segments merge
additively (delta-not-snapshot rule). Uncommitted/duplicate-seg rows are
dropped (first committed wins).

### Exactness domain (002 B2)

`summarize(fold(prefix) ⊕ tail) ≡ summarize(prefix ⊕ tail)` holds exactly when
(a) requestIds are unique across entries — an ASSUMPTION backed by the current
generator (`ocx-<ts36>-<counter>`, request-log.ts); a same-millisecond restart
collision is theoretically possible — and (b) multi-model combo requests
do not overflow into the 256-row "other" bucket. Within one entry, combo
dedupe is exact by construction (fold processes whole entries). Outside the
domain the merge is additive: duplicate hand-written requestIds may count more
than once, and "other" unions degrade to sums. Both divergences carry
dedicated documenting tests. Production check (2026-08-04, 380,841 rows): 3
duplicate ids, all hand-written fixtures; 36 models vs the 256 cap.

## Tests (tests/usage-rollup.test.ts)

1. Fold of a 3-day fixture produces day/model/provider/key rows equal to
   hand-computed aggregates (incl. combo attempts, claude-desktop surface,
   unpriced model, estimated status).
2. Crash injection: (a) truncate the rollup file to cut the commit row (crash
   mid-append) → rows invisible, retry folds the same range under a new
   attemptId, totals exact and abandoned rows ignored; (b) abandoned attempt
   followed by successful retry → validation counts only the committed
   attempt's rows (the R2-1 collision case); (c) commit row with
   rowCount/payloadDigest mismatch → segment rejected; (d) meta missing →
   snapshot null, raw-tail fallback, rebuild path; (e) partial trailing group
   row (no newline) followed by retry → append-boundary truncation repairs the
   file, the retry's first row survives intact, and its commit validates.
3. Lineage mismatch → snapshot null, refold from 0 rebuilds.
4. Price-fingerprint mismatch → rebuild resets cutline to 0; boundary-digest
   mismatch (prefix edited in place) → rebuild; live size < cutline → rebuild.
5. Cutline never lands mid-line; partial trailing line never folds.
6. Min-age watermark: rows younger than 9 local days never fold (tz-aware).
7. Property test (in-domain by construction — the generator emits unique
   requestIds; out-of-domain cases live in the two documenting tests): for a
   randomized fixture, summarize(foldPrefix ⊕ tail) equals
   summarize(allRaw) for range "all" — this lands in 020 when the merge exists,
   but the fixture generator is written here. Generator must include combo
   attempts, duplicate requestIds across days (out-of-domain documenting case),
   out-of-order timestamps, and fold-boundary-day entries.
