# 005 — Audit round 1 (wp1 roadmap)

An Opus reviewer was dispatched with eight verification questions and had not returned after
~9 minutes (previous audits in the sibling unit took 5–7); the main session ran the same
checklist directly. Its verdict is folded in at wp2 P if it lands later.

| # | Question | Finding | Fold |
|---|---|---|---|
| 1 | Route dispatch + registry/skill tests | management-api.ts:236 chain; route-registry.ts must declare the route; tests/skill-ocx.test.ts regenerates 01_management_surface.md from capabilities.ts → add the route to the ["integration","native"] capability and run bun run skill:surface | 010 amended |
| 2 | Credential predicate | isApiAuthRequired(config) (auth-cors.ts:285) + configuredApiAuthToken / config.apiKeys as assertServerAuthConfig does (auth-cors.ts:316) | 010 amended |
| 3 | i18n fallback | provider.tsx:25: DICTS[locale][key] ?? en[key] ?? key → en.ts only | 000 amended |
| 4 | surfaces/marks tests | marks test requires INTEGRATION_MARKS non-null for every OverviewClientId (cursor-color.svg exists); surfaces test asserts specific clients present, not an exhaustive list, so a new native card passes; extend it with a cursor assertion | 020 unchanged |
| 5 | Record<OverviewClientId> exhaustiveness | only INTEGRATION_MARKS (integration-marks.ts:44) — compile error until NATIVE_MARKS.cursor is added, which is the desired guard | 020 unchanged |
| 6 | UA recorder privacy | index.ts:1434 already reads user-agent for Claude admission; recorder stores only the UA string and a timestamp, no tokens/bodies; scripts/privacy-scan.ts has no user-agent rule | no change |
| 7 | readRuntimePort | src/config/process-state.ts:75 returns a state object (.port), fallback config.port | 010 amended |
| 8 | Reusable visible-id helper | none combines natives + routed; reuse visibleNativeSlugs(config) (metadata.ts:383) + uniqueCatalogModelsForRawPublicList(goModels) (aggregation.ts:440) with fetchAllModels(config) | 010 amended |

VERDICT (main): PASS — no blockers; four doc amendments applied.
