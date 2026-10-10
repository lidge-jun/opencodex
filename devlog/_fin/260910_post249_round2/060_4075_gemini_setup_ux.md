# B4 — #4075 "model sync failed" hides the discovery dependency

Raw research: `_research/4075.md`.

## Verdict

Real, and the reporter's workaround is the real mechanism. `liveModels` defaults
to true (`src/types/provider.ts:397-401`), so a newly added Gemini key provider
discovers live; a failed `/v1beta/models` fetch is stored as
`discovery.status === "failed"` (`src/codex/catalog/provider-fetch.ts:1758-1773`)
and the Models header shows only an amber badge (`gui/src/pages/Models.tsx:1410`,
`:1450-1458`). The switch that changes it lives on Provider Settings
(`gui/src/components/provider-workspace/ProviderSettings.tsx:462-471`).

There is a second, sharper effect for a **new** key provider: it is stamped
`initialModelSelection.status = "pending"` (`src/providers/initial-model-selection.ts:65-67`),
failed discovery is `degraded` so initialization never finalizes
(`src/server/management/shared.ts:186-189`), and pending rows are forced
`disabled: true` (`src/server/management/model-rows.ts:184-191`) and dropped from
the Codex catalog (`provider-fetch.ts:2095`). Turning `liveModels` off makes the
seed authoritative and releases them — which is exactly what the reporter found.

The English UI never says "model sync failed"; that is the reporter's paraphrase of
`models.discoveryFailedBadge`.

## Chosen fix — copy and CTA only

Show the same guidance `EmptyProviderHint` already gives, but for a failed group
with rows too, not only when `rows.length === 0`
(`gui/src/pages/Models.tsx:1650-1651`, `gui/src/pages/models-provider-hints.tsx:17-28`).
One new i18n key across all nine `gui/src/i18n/*.ts` files naming the actual
control: discovery is on; turn off "Discover models from provider" in Provider
Settings to use manually added or static models.

Do not invent a per-provider hash — `hashBelongsToPage` has no `providers/<name>`
arm (`gui/src/app-routing.ts:106-114`) and `providers/workspace` is rewritten to
`providers` (`:159`). Use the existing `navigateHash("providers")`.

## Deliberately not in this PR

Both of these are maintainer policy, not copy:

- Flipping registry `google` to `liveModels: false` (`src/providers/registry.ts:1978`)
  changes seed behaviour for every Gemini install.
- Treating degraded discovery plus configured rows as authoritative enough to
  finalize `initialModelSelection` contradicts
  `tests/providers/initial-model-selection.test.ts:278-285`.

The copy change closes the issue as filed. The second bullet is what would make a
manually added model usable without turning discovery off; record it as a
follow-up issue rather than folding it in.

## Regression test

Layout domain `gui`. `tests/gui/models-discovery-failed-hint.test.ts` with matching
`layout.json` `explicit` and `tests/fixtures/test-layout-expected.json` entries.

Group with `liveModels: true`, `discovery: { status: "failed", reason: "http", httpStatus: 401 }`,
and at least one custom row. Before: markup has `models.discoveryFailedBadge` and
not the new string. After: it has both, plus the settings link.

Keep `gui/tests/models-provider-head.test.ts:103-157` in mind — header children
must stay element-wrapped, so a bare `{t(...)}` breaks it and a `<span>` does not.

## PR

`fix(gui): explain the discovery dependency when model sync fails` — branch
`lane-b/2-4075`, PR base `lane-b/1-3666`. Closes #4075.

The word `gui` in that title triggers the screenshot requirement in
`enforce-target`. Either attach a screenshot of the changed Models group or
retitle to `fix(models): …` and describe the surface without the token.
