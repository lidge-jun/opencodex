# 000 — gemini-tiered-wire-ids: Plan

## Objective

Google renamed Gemini model wire IDs. gemini-3.7-flash is now gemini-3.7-flash-tiered,
gemini-3.6-flash is now gemini-3.6-flash-tiered. gemini-3.5-flash is unchanged.
Evidence: live API 404 on gemini-3.7-flash, 200 on gemini-3.7-flash-tiered.

## Loop-spec

- Loop archetype: verifier-defined (API returns 200 or 404)
- Write scope: antigravity-models, registry, free-directory, google adapter, oauth, expected-prices, model-rename-migration, generated metadata, tests
- Budget: single PABCD cycle

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| 1  | 010 | Wire ID updates across all source + tests | none |

## Accept criteria

- gemini-3.5-flash works via OCX proxy (200)
- gemini-3.6-flash-tiered works via OCX proxy direct google (200)
- gemini-3.7-flash-tiered works via OCX proxy antigravity (200)
- bun run test passes
