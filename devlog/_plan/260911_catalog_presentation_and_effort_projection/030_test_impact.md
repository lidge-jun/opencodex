# Test impact of the `max`/`ultra` exemption

From the explorer pass (`xai/grok-4.6`, read-only). This is the list B inverts, and
it is the reason the loop-spec verifier row now names three files the first draft
did not.

## Must invert — these encode the behaviour being removed

`tests/codex-integration/codex-catalog.test.ts`, `describe("Codex reasoning-effort capability clamp")` at `:7027`:

| Test | Line | Why it inverts |
| --- | --- | --- |
| the observed-state clamp is pure with respect to frozen runtime evidence | 7051 | expects `removedEfforts: ["max","ultra"]` and a default rewritten to `xhigh` |
| strips max and ultra when the installed Codex ladder stops at xhigh | 7077 | the exemption is precisely this case |
| falls back to the conservative universal ladder when every advertised effort is unsupported | 7095 | a `max`/`ultra`-only row must no longer collapse to `low/medium/high` |
| repairs an unsupported max default to the highest surviving xhigh rung | 7107 | `effort.ts:378`, the default-repair block CLAMP-01 also changes |

`tests/codex-integration/codex-runtime.test.ts`:

| Test | Line | Why it inverts |
| --- | --- | --- |
| clamp diagnostics include unsupported default_reasoning_level changes | 1005 (listed as 940 before the new Phase 1 tests shifted it) | runs the live clamp and expects `ultra` → `high` with `"ultra"` in `removedEfforts` |

## Must keep passing — assert these explicitly, they are the proof it is an exemption

- `preserves max and ultra when the installed Codex ladder includes them` — `codex-catalog.test.ts:7086`
- `is a no-op when the installed Codex binary cannot be probed` — `codex-catalog.test.ts:7115`
- `final clamp omits incompatible Reserve in-place without inventing efforts` — `reserve-catalog.test.ts:239`; `{xhigh}` vs `{medium}` still deletes the row. Fails only if the whole clamp is disabled, which is the mistake this plan is trying not to make.
- `partial effort intersection keeps only source efforts and a surviving default` — `reserve-catalog.test.ts:252`
- The four `#4207` cases in `tests/clients/client-catalog-compatibility.test.ts:37,51,76,97` — they do not mutate the catalog, and they fail **only** if CLAMP-02 is violated by also treating the two rungs as always compatible. They are the regression gate for the hub boundary.
- Runtime tests that seed `persistEffortClamp` themselves and therefore do not depend on live stripping: `codex-runtime.test.ts:601, 624, 815, 842` — line numbers verified stale by the A reviewer (the Phase 1 test insertions shifted them; the tests are found by name, not line).

## Out of scope — a different layer, do not touch

The wire clamp (`nativeEffortClamp`, `effort.ts:52`, consumed at
`src/server/responses/core.ts:2582`) still maps `max`/`ultra` down for natives that
only mock those rungs. Catalog advertisement and wire honesty are deliberately
split, as `structure/03_catalog-and-subagents.md:339` already records. Affected
suites that must stay green unchanged: `codex-v2-gate.test.ts:1821`,
`effort-policy.test.ts:434`, `reasoning-effort.test.ts:887`,
`openai-responses-passthrough.test.ts:559`, `claude-model-info.test.ts:63`,
`vision-reasoning-contract.test.ts:193`.

Likewise the construction-side exactness suites — `catalog-go-exact-efforts.test.ts`,
`codex-v2-gate.test.ts:111-126`, the none-only and combo ladder pins in
`codex-catalog.test.ts` — fail only if "unconditional" is misread as "always **add**
`max`/`ultra`". It is not: Go rows, Luna, combo rows, and none-only custom ladders
keep their exact ladders. Anything that grows Muse to include `max` or Luna to
include `ultra` is a defect, not the feature.

## New test file placement

`tests/test-layout.test.ts:20` forbids a root-level file that resolves to a migrated
domain. A new file needs matching entries in `scripts/test-layout/layout.json`
`explicit` and `tests/fixtures/test-layout-expected.json`; the `codex-integration`
regex seed already matches an `effort-*.test.ts` name until those exist
(`layout.json:34`).
