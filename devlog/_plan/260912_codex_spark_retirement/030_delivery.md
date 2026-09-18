# Verification and delivery record

Status: Draft PR #4334 prepared for the announced retirement. NO MERGE, auto-merge, release, deployment or live service/config change is authorized.

## Source
Primary source verified through Aside: https://x.com/thsottiaux/status/2098300998968357218, Tibo, 2026-09-11 06:41:57 UTC. “Next week” is the timing given; no exact cutoff was announced.

## Implemented behavior
Spark is absent from native membership, observations and restore outputs. Exact retired rows cannot re-enter from a full-shaped bare/cache/account-selector row; future unknown native observations still work. Spark-specific adapter/Lite/tool compatibility branches are removed while generic mechanisms remain.

Dedicated Spark quota collection, routing scope and preference are removed. Old Spark windows are tombstoned before presence/ingestion/hydration/reset observations and Direct/Pool projections. Spark-only quota is unknown (null), not spare shared capacity. Retired-model response headers and reset-derived 429 evidence do not change shared quota state; actual Retry-After/account credential/transport handling and shared/Reserve isolation remain.

The old settings field is inert in persisted passthrough config and cannot reactivate the removed control. UI state, API calls, toggle, CSS and translations are removed. Historical costs, usage, benchmark rows, generic unknown families and other providers including Muse Spark are preserved.

## Independent reviews
All native agents were dispatched with model/effort overrides omitted, inheriting the main session as explicitly requested.
- A plan review: Hegel PASS after source-review refinements.
- Catalog/compatibility post-build review: Kant PASS, then corrected two missed test assumptions after CI failures.
- Quota/security/UI contract review: Zeno PASS on 8398f2abb7..0a0fd2a225, no concrete blockers.

## CI repair
First full remote workflow run 34671771774 at 0a0fd2a225 found test fixture failures:
1. Two-pass retirement regression serialized complete duplicated instructions/catalog/cache rows to captured stdout. The failure wrapper discarded spawn error/signal. Full snapshots now go to the fixture directory with the same complete comparisons, plus preserved subprocess diagnostics. Capture overflow is the supported static diagnosis; the original log did not retain enough subprocess evidence to claim it proven.
2. Astra without long-window opt-in emits context/max 272000 and compaction 244800. The test mistakenly asserted the raw pin's 872000 ceiling.

No production change was needed for those failures. Re-run on the repaired final head is required; prior-head green or pending jobs are not substitutes.

## UI evidence
Source dashboard artifact: run 34671771774, artifact 10291125984, commit 0a0fd2a225614fb0c80ad3e125dfa7243879c87b, GUI tree 08717a046c2b2550c8ed08499511e5edc6aa2801.
The built artifact is served unchanged with synthetic fixture API/bootstrap data on loopback; no local product build and no live proxy are used. Parent visually inspected desktop and mobile captures: no Spark switch or quota rows, surviving main/pool quota and actions visible. Fixture request ledger supplies interaction evidence. Screenshot commits do not change the GUI tree; artifact provenance must match that tree on final delivery.

## Limits and completion gate
Local product tests/typecheck/build/install: NOT RUN by user instruction. Only static source/diff inspection and rendered remote-built fixture UI ran locally. Exact final-head hosted CI and unmerged Draft PR state are checked by .tmp/spark-retirement/check_remote.py; failures/pending checks return nonzero. The final chat report carries the final SHA/run result because writing it back into this file would create another untested head.

