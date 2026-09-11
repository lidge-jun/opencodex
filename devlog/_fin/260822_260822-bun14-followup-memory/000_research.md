# 000 — Bun 1.4 follow-up memory patches: research and claim ledger

Date: 2026-08-22
Unit: 260822_260822-bun14-followup-memory
Question: from today's viewpoint (bundled Bun 1.4.0, released 2026-08-19), which
ADDITIONAL memory patches are possible and worthwhile in opencodex?

## Method

Luna 5-lane discovery swarm (official releases / GitHub issues+PRs / JSC-runtime /
community / server-SSE-proxy), then Tier-2 proof by the main agent via `gh api`
against oven-sh/bun. App-side baseline re-audited against
devlog/_fin/260813_bun_canary_dogfood/050_memory_patch_roadmap.md and current src/.

## Claim ledger (Tier-2 proven unless noted)

| # | Claim | Proof | Status |
|---|---|---|---|
| C1 | No Bun 1.4.x patch release exists after v1.4.0 (2026-08-19). | `gh api repos/oven-sh/bun/releases` → latest tag `bun-v1.4.0`; bun-v1.4.1/2/3 404. | verified |
| C2 | Bun PR #36467 (TLS Bun.serve use-after-free on `server.stop(true)` sibling-socket close) merged 2026-07-31, sha 529adec09, and IS an ancestor of bun-v1.4.0 (`compare/bun-v1.4.0...sha` → status=behind). Already in our bundled runtime; no action. | gh api pulls/36467 + compare | verified |
| C3 | Bun PR #32662 (fetch: release buffered response body + error reader on streaming abort) merged 2026-07-22, sha 4b7241669, ancestor of v1.4.0. In bundled runtime. | gh api pulls/32662 + compare | verified |
| C4 | Bun PR #35093 (fetch: error body stream when fully-buffered response aborted) merged 2026-07-28, sha 789be97db, ancestor of v1.4.0. In bundled runtime. | gh api pulls/35093 + compare | verified |
| C5 | Bun issue #34917: `--max-old-space-size`, `BUN_JSC_gcMaxHeapSize`, `BUN_JSC_forceRAMSize` are NOT reliable heap caps on the 1.4 line; still OPEN (created 2026-07-21, closed:null). Container/OOM bounding must come from app-side watchdog + supervision, not JSC flags. | gh api issues/34917 | verified |
| C6 | `Bun.gc(true)` on 1.4 asks JSC to collect AND asks mimalloc to release fragmented non-JS pages (allocator shared with JSC since the 1.4 Rust/allocator work). | Bun docs (bun.com/reference/bun/gc) opened by L3; local probe `typeof Bun.gc === "function"` on 1.4.0. | verified (docs) |
| C7 | `bun:jsc` heapStats exposes `extraMemorySize`/`heapCapacity`; `Bun.unsafe.mimallocDump` exists on 1.4.0. | local probe on bundled 1.4.0: `{"heapSize":…,"heapCapacity":…,"extraMemorySize":…}`, mimallocDump:function | verified (executed) |
| C8 | `new Worker(url, {smol:true})` works on bundled 1.4.0 (selects JSC Small heap growth policy per Bun docs). | local probe: "smol worker OK" | verified (executed) |
| C9 | RSS retention after GC (issue #27514) and SSE-proxy reader-cancel segfault (#31159) were closed as DUPLICATES, not demonstrated fixed; #26321 (Windows file-stream RSS) duplicate-closed too. Continued A/B measurement remains necessary. | gh issue pages opened by L2/L5 | verified |
| C10 | Community: Bun 1.4 advertises up to ~35% memory reduction (allocator rewrite, thread-local page purging, lazy zeroing); no long-running independent RSS measurements yet. | Reddit announcements (L4), snippet-grade | lead |
| C11 | Medium post claims 1.4-era HTTP long-connection RSS still grew 280→340MB over 7 days; page returned 403. | unreachable | candidate — unverified |

## App-side baseline (what is already done — do not re-patch)

- 260813 roadmap patches #1–#4 ALL landed since: native-main hardened-identity LRU
  (src/codex/native-main-claim.ts:25-33), installation-salt LRU
  (src/lab/subject/installation-salt.ts:7-17), mode-hint capability LRU
  (src/codex/features.ts:1097-1106), Lab ledger event-id process index REMOVED
  (no `eventIdIndexByLedger` in src/lab/ledger/store.ts).
- `Bun.serve({ idleTimeout: 255 })` (src/server/index.ts:736) and per-request
  `server.timeout(req, 0)` for streaming (src/server/responses/fetch-helpers.ts:113)
  already implement the SSE-timeout guidance the swarm surfaced.
- eager-relay vs legacy-tee runtime gate: src/lib/bun-stream-caps.ts
  (MIN_FIXED_BUN_VERSION="1.4.0").
- Memory watchdog: warn-only ring sampler (src/server/memory-watchdog.ts), exposed at
  /api/system/memory with bun:jsc heapSize/heapCapacity/objectCount.
- 36-store bounded-memory audit closed (devlog/_fin/260813…/050): only remaining
  investigation is model-cache generation tombstones — needs an authority-token
  redesign, NOT an eviction patch; excluded from this unit.

## Gap analysis → patch set for THIS unit

What Bun 1.4 newly makes possible, that opencodex does not use yet:

1. **Diagnostics gap** — /api/system/memory and the watchdog ignore
   `extraMemorySize` (JSC-visible native memory) and the watchdog samples carry no
   JSC data at all. On 1.4, extraMemorySize is the counter that moved most
   (external-memory reporting fixes #31422/#32653/#34142). → doc 010.
2. **Reclaim gap** — nothing in the tree ever calls `Bun.gc`. On 1.4 a full
   `Bun.gc(true)` also purges mimalloc pages (C6) — the exact mitigation for the
   "heap shrinks, RSS stays" pattern (#27514) that JSC flags cannot deliver (C5).
   A config-gated, rate-limited watchdog relief hook is now worth having. → doc 020.
3. **Worker heap gap** — history/restore/policy workers are short-lived batch jobs;
   `smol: true` (C8) bounds their JSC heap growth policy at a small perf cost,
   reducing peak RSS during storage jobs. → doc 030.
4. **Proof gap** — every claim above is config/diagnostic-grade until measured.
   macmini-cf (arm64, bun 1.3.14 installed → good A/B host) runs the live
   measurement protocol. → doc 040.

Explicit non-goals: no Bun runtime patching/fork (upstream 1.4.0 already carries
C2–C4); no JSC env-var "caps" (C5 proves them unreliable); no smol for the main
proxy process (throughput cost, unmeasured); no model-cache tombstone work.
