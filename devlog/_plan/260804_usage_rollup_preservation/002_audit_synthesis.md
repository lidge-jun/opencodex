# 002 — Audit synthesis (round 1, reviewer: Carver/sol, verdict FAIL)

Per-blocker RCA and accept/rebut decisions. All five blockers accepted; fixes
amended into 001/010/020 (marked "rev2").

## B1 crash safety — ACCEPT, redesign: commit-row authority

RCA: two independently-visible files (rollup, meta) cannot share one commit
point; the window between rollup-fsync and meta-rename double-counts, and a
partial segment append could be accepted by the "skip existing fromOffset"
rule.

Fix (rev2): **the cutline authority moves into the rollup file itself.** Every
group row carries `seg: fromOffset`; a fold appends group rows first and a
`{kind:"commit", seg, toOffset, rowCount}` row LAST, then fsyncs. A segment is
visible only when its commit row exists AND its row count matches; the
effective cutline is the max committed contiguous `toOffset`. Partial appends
(no commit row, or count mismatch) are permanently ignored garbage. Meta
becomes correctness-light (lineage, fingerprint, throttle stamp) and is
written AFTER the rollup fsync via the existing `renameAtomicFile()`
(config.ts:63, Windows-aware). Reader derives cutline and tail start from the
same single source, so no overlap window exists. Crash-injection tests at each
boundary (after rows, before commit; after commit, before fsync-visible meta).

## B2 distinct-request exactness — ACCEPT with precisely-weakened claim

RCA: buildModels/buildProviders dedupe requestIds range-wide and the overflow
"other" bucket unions requestIds across models; count-only rows cannot
reproduce unions. Production evidence (2026-08-04, 380,841 rows): exactly 3
duplicate requestIds, all hand-written test fixtures ("ok-a","ok-b","fail");
36 distinct models vs the 256-row cap.

Fix (rev2): fold processes WHOLE entries, so within-entry combo dedupe is
exact by construction (one entry → one day → one segment; per entry, each
distinct model key contributes requests+=1 with folded status). The exactness
claim is scoped: equality holds when (a) requestIds are unique across entries
— the writer's contract (request-log.ts ocx-<ts36>-<counter>) — and (b) the
model cap does not overflow with multi-model combo requests inside "other".
Outside that domain the rollup is additive (documented divergence, count may
exceed by duplicates). Property test pins exact equality in-domain; two
dedicated tests document the out-of-domain additive behavior.

## B3 requests7d — ACCEPT, fix by watermark: ROLLUP_MIN_AGE_DAYS = 9

RCA: min-age 2 meant the tail owns only ~2 days; requests7d and ms-precision
7d filtering would silently go day-grain.

Fix (rev2): fold only days ≥ 9 local days old. The tail always owns the whole
7d window (+2-day margin): `requests7d`, the 7d range, and lastUsedAt stay
tail-exact with zero merge changes for them. Day-grain boundary approximation
now applies only to 30d (days 9–30). At production rate (~4.5 MB/day) 9 days ≈
40 MB < 64 MiB; if traffic outgrows the window the residual gap is reported
via the existing truncation metadata (bounded regression, not silence).

## B4 cost fingerprint — ACCEPT, widen inputs + manual version

Fix (rev2): fingerprint = sha256 over stable-serialized {full generated
jawcode cost table, EXPECTED_PRICE_OVERLAYS, PRIORITY_MULTIPLIERS,
CONTEXT_TIERS} plus a hand-bumped `ROLLUP_COST_SEMANTICS_VERSION` constant
that estimator/canonicalization changes must increment (documented next to
the estimator). Any mismatch → rebuild from offset 0.

## B5 same-lineage mutation — ACCEPT, bounded detection + escape hatch

Fix (rev2): rebuild triggers: lineage tuple mismatch; live size < committed
cutline; boundary digest mismatch — each commit row stores sha256 of the last
4 KiB of its byte range, and the next fold run re-verifies the previous
committed segment's digest before appending. Hand-edits deep inside an
already-folded prefix are NOT auto-detected (fold-time-only verification);
documented: the rollup is a derived cache — delete both files to force a full
rebuild. This preserves the raw log's hand-editable contract with an explicit,
cheap policy instead of a silent one.

## Advisories — all accepted

0600 + recordOwnedConfigPath for BOTH files; uninstall-test coverage; reuse
`renameAtomicFile`; dir-fsync best-effort (no-op where unsupported, matching
platform reality); resolvedModel is display-only first-seen (identity stays
provider/model, matching buildModels); tz/DST/midnight/out-of-order tests;
research citations reworded as design analogies.

---

# Round 2 (same reviewer, verdict FAIL — B3/B5 closed, 4 remaining) 

## R2-1 retry-attempt identity — ACCEPT

RCA: abandoned uncommitted rows and retry rows share `seg = fromOffset`, so a
commit's `rowCount` can never match after a crash-retry (20 rows, commit says
10) — the retry deadlocks into permanent rejection.

Fix (rev3): every fold attempt gets a unique `attemptId` (`<foldedAt>-<rand>`)
carried by all its group rows and its commit row; the commit binds
`(seg, attemptId, rowCount, payloadDigest)` where `payloadDigest` is sha256
over the serialized group rows of THAT attempt. Validation counts only rows
with the commit's attemptId and verifies the digest. Abandoned attempts are
permanently invisible garbage; a partial trailing line in the rollup file
itself is dropped by JSONL framing (complete-line parse), which also covers
the crash-mid-append case.

## R2-2 synchronous validity gate — ACCEPT

RCA: `ensureRollupCurrent()` is async fire-and-forget, so a request racing a
price change could merge stale costs if validity were only checked in the
folder.

Fix (rev3): `readRollupSnapshot()` itself synchronously validates version,
lineage, and priceFingerprint against meta and the live raw file BEFORE
returning a snapshot; on any mismatch (or meta absent/corrupt) it returns
null — the route then serves raw-tail-only (legacy behavior, cutline 0) while
the background rebuild proceeds. Stale rollup data is structurally unreachable.

## R2-3 exactness wording — ACCEPT

`all` is "exact within the exactness domain" everywhere (001 range semantics,
020, docs-site). requestId uniqueness is stated as an assumption backed by the
current generator (`ocx-<ts36>-<counter>`), not a guarantee — a same-ms
restart collision is theoretically possible; out-of-domain behavior stays
additive-documented.

## R2-4 write scope for fingerprint — ACCEPT

`ROLLUP_COST_SEMANTICS_VERSION` lives in `src/usage/cost.ts` (beside the
estimator it versions). The generated module gains
`export const JAWCODE_TABLE_FINGERPRINT` computed by the generator at
generation time (packaged-runtime safe — no source-file reads at runtime).
Write scope for 010/020 adds: `src/usage/cost.ts` (constant only),
`scripts/generate-jawcode-metadata.ts` + regenerated
`src/generated/jawcode-model-metadata.ts`, `src/usage/expected-prices.ts`
(export `PRIORITY_MULTIPLIERS`/`CONTEXT_TIERS` if not already exported).

## R2 advisory — ACCEPT

7d wording: "tail-exact when `truncatedPrefixBytes === 0`"; the residual-gap
case degrades to today's truncated behavior, reported not silent.
