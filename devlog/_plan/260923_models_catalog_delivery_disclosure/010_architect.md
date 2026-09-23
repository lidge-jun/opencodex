# Architect consultation (wp1)

- Handle: grok-4.7 subagent `01a0ca58-e95c-73b1-9d91-6f07e61251af` (Tesla). Earlier attempts: mimo `01a0ca43-d5eb-7953-a025-2bfc6be823fb` produced no proposal after ~25 min and was closed; two gpt-5.6-sol agents failed with HTTP 429 before starting.
- Combined proposal + reflection against 000_plan.md (one packet, because the plan already existed when a responsive architect became available).

| ID | Proposal | Main disposition |
|---|---|---|
| D1 | `ModelCatalogDelivery({ connected, catalogSyncedAt })`, reuse `formatFetchTime` (missing and unparsable both null), caller owns subtitle | Accepted |
| D2 | Closed `<details>`, summary = title + arrow-joined chips, body `<ol>` + hint; rely on global `:focus-visible` (styles.css:242); copy marker pattern styles.css:2041 | Accepted; no custom focus style |
| D3 | Delete 8 `models.catalogState.*`, add `models.delivery.*` in 10 catalogs, trim `models.subtitle`, mode-neutral `models.applied` (en.ts:746) | Accepted |
| D4 | CSS only in styles-models-workspace.css; drop inline styles | Accepted |
| D5 | Render beside subtitle only when `tab === "catalog"` (panels stay mounted hidden, Models.tsx:2654); pass `connected` from App.tsx:506 | Accepted |
| D6 | New gui/tests/models-catalog-delivery.test.tsx; no layout.json entry for gui/tests | Accepted |

Reflection: **ALIGNED**. Gaps and dispositions:

- "registered wherever gui test layout requires" is a no-op for gui/tests -> plan wording corrected.
- `tsconfig.app.json` includes only `src`, so typecheck does not compile the new test -> the test run itself is its verifier.

