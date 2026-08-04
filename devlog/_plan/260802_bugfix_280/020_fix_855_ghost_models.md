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

## Results (2026-08-02, wp3 executed on branch codex/bugfix-280)

- 6a3dd690 red regression (2 tests, red pre-fix; 8 existing tests green
  throughout — they use unmarked foreign rows).
- b60d7297 fix: isOcxAuthoredRoutedEntry ownership signature; ghost drop in
  both partial-gather and empty-gather branches; foreign rows preserved.
- Verification: codex-catalog + sync-hardening suites 127 pass 0 fail;
  typecheck green. Full tests/ run was attempted but exceeded ~57 CPU-min
  locally and was stopped; full-suite proof defers to CI after push.
- Reviewer repair rounds (Plato):
  - R1 FAIL: legacy June–July rows used provider-name signature → bc7feadb
    recognizes it + empty-gather transient-protection assertion.
  - R2 FAIL: legacy combo aliases ("→ combo (combo)." under vendor/* slug)
    missed → 8dffecca switches to the stable prefix alone as the ownership
    signal.
  - R3 FAIL: combo-alias regression was false-green (generic combo cleanup
    removed the row) → 6d5f5c99 configures a physical combo provider so the
    test depends on the matcher; red/green proven by reverting.
  - Final: PASS. Suites 129 pass 0 fail, typecheck green.
