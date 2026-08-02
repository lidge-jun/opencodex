# 020 — Fix #855: sync must drop models of deleted providers

Root cause (investigator Hume, verified): `preservedForeignRouted`
(`src/codex/catalog/sync.ts:474`) classifies every existing
`provider/model` row whose provider is absent from
`gatheredProviderNames` (currently enabled providers only, :576) as
foreign and preserves it — in both the partial-gather and the
empty-gather (:469) branches. The integration test at
tests/codex-catalog-sync-hardening.test.ts:253 locks in the faulty
assumption.

## Fix

Ownership signature: generated rows carry
`description: "Routed via opencodex → <slug> (...)"` (:329).

- Add a narrow helper validating that exact prefix including the row's own
  slug.
- Preserve an OCX-authored existing row only while its provider remains
  configured (keeps transient-fetch protection).
- Drop an OCX-authored row when its provider is gone.
- Keep preserving unmarked routed rows (Cursor / user tooling).
- Apply to both gather branches.
- Do NOT use `owned_by` (upstream ownership) or `comp_hash` (defaults to
  "opencodex" for every row, parsing.ts:299).

## Tests (tests/codex-catalog-sync-hardening.test.ts)

- Seed: marked `future-grok/old-model`, unmarked `cursor/composer-2.5`,
  native row; sync with only `openai/fresh-model` configured. Assert: old
  removed, cursor preserved, fresh present. (Red before fix.)
- Empty-gather variant: configured-provider marked rows survive transient
  failure; deleted-provider marked rows do not.
