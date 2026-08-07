# 001 — Roadmap: rollup sidecar as a rebuildable derived cache — rev2 (post-audit 002)

## The one architectural decision everything else follows from

**The raw log is never truncated, so the rollup is a derived cache, not a second
source of truth.** Any invalidation — lineage change (inode/birthtime), schema
version bump, price-table fingerprint mismatch — is answered by rebuilding the
rollup from the full raw file in a background cooperative parse. This dissolves
the two hardest problems found in research:

- *Cost freezing*: rollup rows may store fold-time cost numbers (including exact
  per-entry combo fail-closed decisions) because a price-table change flips the
  fingerprint and triggers a rebuild. Display-time retroactivity is preserved by
  rebuild, not by schema contortions.
- *Exactness*: the fold processes whole entries with the same functions the
  display path uses (`bumpStatus`, `addTokens`, `addEstimatedCost`,
  `usageAttributions`, `foldAttributionStatuses`), so
  `summarize(fold(prefix) ⊕ tail)` ≡ `summarize(prefix ⊕ tail)` within the
  exactness domain defined in 010 (unique requestIds across entries — an
  assumption backed by the current generator — and no multi-model combo
  overflow into "other"),
  enforced with a property test; out-of-domain behavior is additive and
  carries dedicated documenting tests (002 B2).

## Correctness boundary

- Cutline is a **byte offset at a local-day boundary** of the raw file:
  rollup covers `[0, cutlineOffset)`, the reader's tail starts at
  `cutlineOffset`. Disjoint byte ranges make additive merge structurally
  dedupe-free; a late-timestamped row after the cutline simply counts in the
  tail (still additive, never double-counted).
- **Single commit authority (002 B1):** the cutline is derived from validated
  commit rows inside `usage-rollup.jsonl` itself — group rows first, a
  `commit` row last, one fsync. Meta only carries lineage/fingerprint/throttle
  via the existing `renameAtomicFile()`. Reader visibility and tail start
  always agree because both derive from the same committed segments; a partial
  append (no commit row / rowCount mismatch) is invisible garbage and the
  retry re-folds the same range.
- Only *complete days* older than `ROLLUP_MIN_AGE_DAYS = 9` are folded
  (stability watermark; keeps the entire 7d window tail-exact, 002 B3).
  Fold-eligibility check and the fold run are throttled and cooperative (same
  yield discipline as `parseUsageTextCooperatively`).
- **Same-lineage mutation policy (002 B5):** rebuild on lineage-tuple
  mismatch, live size < committed cutline, or committed boundary-digest
  mismatch (last 4 KiB of each committed segment re-verified at the next fold).
  Deep hand-edits inside the folded prefix are answered by the documented
  delete-the-rollup-files escape hatch (full rebuild), preserving the
  hand-editable raw contract.

## Range semantics

- `all`: rollup days + tail — exact within the exactness domain (010; unique
  requestIds assumed, no combo overflow into "other").
- `7d`: tail-exact when `truncatedPrefixBytes === 0` — min-age 9 keeps the
  fold away from it; an extreme-growth residual gap degrades to today's
  reported truncation, never silently.
- `30d`: tail rows keep ms-precision filtering; rollup rows are day-grain, so
  the one boundary day partially inside the window is included whole (≤ ~24h
  overcount). This is steady-state behavior for days 9–30, documented in
  docs-site (002 wording fix: not an exceptional state).

## Row grains (one JSONL file, `kind`-discriminated)

1. `meta` (separate file): `version`, `lineageKey`, `priceFingerprint`,
   throttle stamp — correctness-light.
2. `commit`: `{ lineageKey, seg, attemptId, toOffset, rowCount, payloadDigest,
   boundaryDigest, attributionSinceMs, oldestTimestampMs, foldedAt }` —
   appended last; the segment's visibility gate and the cutline authority.
   `attemptId` binds the commit to one append attempt so abandoned crash
   leftovers can never collide with a retry (R2-1).
3. `day` rows: key `(date, surfaceKey)` → entry-grain status counts,
   attemptCount, token sums, cost sums, priced/unpriced/unmetered counts.
4. `model` rows: key `(date, surfaceKey, providerKey, model)` →
   distinct-request count, attemptCount, folded per-request status counts,
   token sums, cost sums (attribution grain, combo-aware — exactly what
   `buildModels`/day-model breakdown consume); `resolvedModel` rides along as
   display-only first-seen. Separate `provider` rows store the within-entry
   combo-deduped provider grain (not derivable from model rows).
5. `key` rows: key `(date, admissionKind, apiKeyId?)` → request count,
   lastUsedAtMs max (for `api-key-usage.ts`).

Cardinality: O(days × surfaces × models) — a few KB per day.

## Cost (002 B4)

Long-context tier selection depends on per-request `usage.inputTokens`
(`isLongContext`), so day-aggregated tokens cannot re-derive cost. The rollup
stores fold-time cost sums; retroactivity is preserved by rebuild: a wide
price fingerprint (full jawcode cost table + `EXPECTED_PRICE_OVERLAYS` +
`PRIORITY_MULTIPLIERS` + `CONTEXT_TIERS` + hand-bumped
`ROLLUP_COST_SEMANTICS_VERSION`) forces a full refold on any pricing or
estimator-semantics change.

## Reader merge

`readUsageSnapshotForManagement` gains a `fromOffset` mode: tail read starts at
`max(cutlineOffset, size - maxReadBytes)`. If `cutlineOffset < size - maxReadBytes`
the un-folded gap is reported as residual truncation (`truncatedPrefixBytes > 0`)
until the background fold catches up. `summarizeUsage` accepts optional rollup
contributions and merges them into totals/days/models/providers before the
display-time sort/cap steps. `historyTruncated` becomes false when rollup+tail
jointly cover the file.

## Implementation phases (1 decade doc = 1 PABCD cycle)

- **010** `src/usage/rollup.ts` core: types, fold, file IO, meta, fingerprint,
  rebuild, idempotent segments + focused tests.
- **020** reader merge: `log.ts` offset tail, `summary.ts` merge,
  `logs-usage-routes.ts` wiring + fold trigger, `api-key-usage.ts` merge,
  config flag `usageRollupEnabled` (default true) + tests incl. the
  fold⊕tail ≡ full property test.
- **030** real-data validation against the 157 MB production copy, docs-site,
  push + dev PR.

## Out of scope (documented for follow-ups)

- Raw-file truncation/archival policy (requires writer coordination; research
  lane 2 shows uncoordinated truncation is lossy).
- GUI changes beyond what the existing truncation metadata already drives.
- Go runtime (retired).
