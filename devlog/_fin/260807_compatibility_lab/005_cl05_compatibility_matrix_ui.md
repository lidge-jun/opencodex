# CL-05 implementation record - Compatibility Matrix UI

## Programme position

- **Phase:** CL-05 (read-only GUI)
- **Starting `upstream/dev` SHA:** `d517161aeaa3a974ad3c0360ff0c97b03b4c4520` (merge #1378 / CL-04)
- **Branch:** `feat/cl-05-compatibility-matrix-ui`
- **PR:** DRAFT → `lidge-jun/opencodex:dev` ([#1384](https://github.com/lidge-jun/opencodex/pull/1384))
- **CL-06:** not started

## Scope delivered

### GUI (`gui/src/pages/`)

- **Models → Compatibility tab** at `#models/compatibility` (not a standalone sidebar page)
- Legacy `#lab` hash redirects to `#models/compatibility`
- `CompatibilityMatrix.tsx` - read-only verdict matrix over CL-04 management APIs
- `compatibility-matrix-api.ts` - bounded paginated fetch helpers for `/api/lab/status`, `/api/lab/verdicts`, `/api/lab/subjects`, and detail reads
- `compatibility-matrix-shared.ts` - fail-closed DTO parsing, matrix grouping, and filters
- `styles-compatibility-matrix.css` - scrollable matrix + detail pane
- Compatibility Lab copy localized for all seven locales (`en`, `de`, `ko`, `zh`, `ru`, `ja`, `tr`)
- Component/layout tests in `gui/tests/compatibility-lab.test.tsx` and `gui/tests/compatibility-matrix-layout.test.ts`

### Behaviour

- Projection status cards (subjects, verdicts, observations, events, built-at)
- Subject × evidence-layer matrix with per-suite verdict badges
- Server-side verdict filters for evidence layer, verdict, and an exact Subject-ID picker, with paginated "Load more"
- Verdict detail pane (subject, all paginated observations, bounded evidence events, artifact metadata only)
- Verdict selection is presentation state only; it never changes matrix filters or pagination identity
- Empty/unavailable/incompatible projection states via existing data-surface contract; malformed successful API payloads fail closed as load errors
- Lazy mount with `active` / hidden-panel gating inside Models workspace
- No probe execution, projection rebuild, or evidence mutation

## Review remediation

The follow-up review pass addresses all validated CodeRabbit findings plus the independent lifecycle findings found while reviewing #1384:

- legacy `#lab` cold-load page alignment and delimiter-aware regression coverage
- repeated-cursor contract guards plus explicit truncation when advancing pagination reaches the browser-side safety cap
- strict verdict/detail DTO validation and malformed-200 handling
- bounded, partial-failure-tolerant event/artifact enrichment
- detail-selection and load-more stale-response protection
- first-page refresh/poll invalidation of appended cursor pages
- exact Subject-ID picker semantics instead of misleading free-text search
- localized closed-value labels and neutral evidence-event wording
- real button semantics for verdict-detail selection
- inactive-panel, selection/filter, pagination, localization, and routing regression coverage
- focused `compatibility-pagination-cap.test.ts` coverage proving a large advancing dataset is truncated rather than mislabeled as a broken contract
- Models-tab layout test updated from the removed standalone App/sidebar architecture

## Validation recorded before review remediation

- `bun x tsc --noEmit` - passed
- `bun test tests/lab-read-surfaces.test.ts tests/models-workspace-tabs.test.ts` - 33/33 passed
- `cd gui && bun test tests/compatibility-lab.test.tsx tests/models-workspace-panels.test.tsx` - 29/29 passed
- `cd gui && bun test tests/compatibility-matrix-layout.test.ts` - 2/2 passed in the full GUI gate
- `bun run lint:gui && bun run doctor:gui && bun run build:gui && bun run privacy:scan` - passed

The latest pagination-cap remediation adds `gui/tests/compatibility-pagination-cap.test.ts` and requires a fresh CI pass before acceptance; the earlier results above are retained only as baseline evidence.

## Acceptance blockers

- Fresh cross-platform CI on the remediation head must be green
- Independent acceptance review not performed

## Out of scope (confirmed)

- CL-06 routing profile compatibility fields, CL-07 fabric, CL-08 shadow/automatic/public publish
- New management APIs or CLI changes (CL-04 read surfaces are sufficient)
- Probe execution, projection rebuild triggers, raw artifact download in GUI
