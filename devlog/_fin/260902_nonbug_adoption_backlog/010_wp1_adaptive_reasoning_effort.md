# wp1 — #2731 adaptive reasoning effort (PR #2734)

Issue #2731, score 62. Draft PR #2734 by the issue author, +180/-8 across 17 files,
head `573d0f65c`, behind current `dev` `e40245e4c`. CI shows `hygiene` and
`enforce-target` failing.

## The two defects

**(a) No per-request tool rule.** `createOpenAIChatAdapter.buildRequest`
(`src/adapters/openai-chat.ts:1441`) computes
`mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning)` with no
access to tool presence. The only model-scoped switch is `noReasoningModels`, which
is all-or-nothing: it strips reasoning from every request, so a model that accepts
effort on plain turns but rejects it alongside function tools has to give up its
effort ladder entirely. The wire `tools` array *is* already in scope at
`openai-chat.ts:1452`; nothing reads it for this decision.

**(b) Empty ladders poison the combo intersection.**
`deriveComboCatalogModel` (`src/codex/catalog/aggregation.ts:126`) filters only
`undefined` ladders as wildcards:

```
const advertisedLadders = members
  .map(member => member.reasoningEfforts)
  .filter((ladder): ladder is string[] => ladder !== undefined);
const reasoningEfforts = advertisedLadders.length === 0 ? [] : intersectStrings(advertisedLadders);
```

An explicit `[]` — meaning "this target has no effort control" — survives into
`intersectStrings` (`aggregation.ts:74`) and empties the result. The empty result
then flows into `effectiveComboDefault` (`aggregation.ts:170`), so the combo also
loses its default. One no-effort target silences the picker for every sibling that
does support tuning. `tests/codex-catalog.test.ts:250` pins this as current
intended behavior, which is why the fix must be opt-in rather than a correction.

## What PR #2734 gets right

Both halves default to today's behavior:

- `normalizeComboConfig` (`src/combos/types.ts:361`) maps anything that is not the
  literal `"adaptive"` to `"strict"`, and the catalog branch only filters empty
  ladders under `=== "adaptive"`.
- `omitReasoningEffortWithToolsModels` is optional, and `modelInList` returns
  `false` for an absent or empty list.

A user who sets nothing observes an identical catalog and identical wire bodies.
That is the back-compat bar from the goal criteria, and the PR clears it on the
request path.

## Blocker: the GUI silently destroys the setting

`PUT /api/combos` replaces the stored combo wholesale
(`src/server/management/combo-routes.ts:170-172`: `nextCombos[id] = stored`).
The dashboard builds that body with an allowlist serializer, `toPutBody`
(`gui/src/combo-workspace-data.ts:496-527`), which enumerates `targets`,
`strategy`, `defaultEffort`, `imageInput`, `stickyLimit`, `alias`,
`nativeAlias`, `displayName` — and nothing else. `parseCombos`
(`combo-workspace-data.ts:222-232`) likewise never reads `reasoningEffortMode`.

So: a user hand-edits `reasoningEffortMode: "adaptive"`, later opens the dashboard
and renames the combo or reorders a target, and the save silently drops the field.
The picker they fixed goes empty again with no error and no diff they can see.
PR #2734 touches no `gui/` file, so it ships this hole.

This is the goal's UX criterion failing, not a nitpick: the opt-in is neither
discoverable nor durable.

## Second defect: the GUI has its own copy of the intersection

`intersectComboEfforts` (`gui/src/combo-workspace-data.ts:54`) reimplements the
same rule client-side and skips only `listed === undefined`. Even with the field
preserved, the dashboard's own effort dropdown stays empty under `adaptive`
because it never learns the mode. Fixing the server alone fixes the served
catalog and leaves the editor lying.

## Third: non-sparse persistence

`combo-routes.ts:139-152` destructures `alias`/`nativeAlias`/`displayName`/
`imageInput` out of the normalized object so defaults are not written, but
`reasoningEffortMode` stays in `normalizedBase`. Every combo save would therefore
stamp `"reasoningEffortMode": "strict"` into `config.json` for users who never
asked for the feature. Config churn on an untouched setting, against the file's
stated sparse convention.

## Plan

Adopt the PR's design — it is the right shape — and complete it in a
maintainer-authored branch that closes #2734 with credit.

### File change map

| File | Action | Change |
|------|--------|--------|
| `src/types/config.ts` | MODIFY | `OcxComboReasoningEffortMode`; `reasoningEffortMode?` on `OcxComboConfig` next to `defaultEffort` (:773) |
| `src/types.ts` | MODIFY | re-export the new type |
| `src/combos/types.ts` | MODIFY | field on `NormalizedComboConfig`; validate in `comboConfigIssues` (:175); normalize in `normalizeComboConfig` (:353) defaulting to `strict` |
| `src/codex/catalog/aggregation.ts` | MODIFY | under `adaptive`, drop zero-length ladders before `intersectStrings` |
| `src/adapters/openai-chat.ts` | MODIFY | `omitReasoningEffortWithTools` guard at :1428 and on the `gateway-object` branch |
| `src/types/provider.ts` | MODIFY | `omitReasoningEffortWithToolsModels?: string[]` beside `noStructuredOutputModels` (:506) |
| `src/config.ts` | MODIFY | zod schema (:516) + `nonBlankStringArrayConfigError` superRefine (:1216) |
| `src/server/auth-cors.ts` | MODIFY | `providerManagementConfigError` validation + `safeConfigDTO` exposure |
| `src/server/management/provider-routes.ts` | MODIFY | PATCH field handling + GET projection |
| `src/server/management/combo-routes.ts` | MODIFY | **NEW vs PR** — destructure `reasoningEffortMode` out of `normalizedBase`; persist only when `"adaptive"` |
| `gui/src/combo-workspace-data.ts` | MODIFY | **NEW vs PR** — `reasoningEffortMode` on `ComboItem`; read in `parseCombos`; emit in `toPutBody`; add to `baselineSyncKey` and the dirty comparison; teach `intersectComboEfforts` the mode |
| `gui/src/components/combo-workspace-detail-panel.tsx` | MODIFY | **NEW vs PR** — opt-in toggle directly under the Default-reasoning field |
| `gui/src/i18n/*.ts` | MODIFY | **NEW vs PR** — label + hint for all locales |
| `docs-site/.../combos.md`, `routing.md`, `providers.md` | MODIFY | as in the PR, minus the stale strategy list |
| `tests/codex-catalog.test.ts` | MODIFY | adaptive keeps sibling ladder; strict unchanged |
| `tests/combos.test.ts` | MODIFY | validation + normalization default |
| `tests/combo-management-api.test.ts` | MODIFY | round-trip; strict is NOT persisted |
| `tests/combo-workspace-data.test.ts` | MODIFY | `toPutBody` preserves the mode; GUI intersection honors it |
| `tests/openai-chat-hardening.test.ts` | MODIFY | tools present/absent, sibling model unaffected |

### UX decision

The control goes in the combo detail panel immediately below "Default reasoning",
because that is the field whose options the mode changes. Default state is the
current behavior. The hint says what turning it on does in one sentence, in the
user's terms: targets that have no reasoning control stop hiding the control for
the rest of the group.

No new top-level navigation, no new settings page. The concern already has a home.

### Scope boundary

IN: the two defects, GUI round-trip, sparse persistence, docs, focused tests.

OUT: `concreteComboRequestBody` per-target effort stripping (investigator concern
2) — that is a genuine gap but it is request-path routing behavior for combos
generally, not this issue's picker/wire problem, and folding it in here would
expand a +180 diff into cross-module routing work. Record it as follow-up.
OUT: an adapter-type guard on the provider key (concern 7) — it is a no-op outside
`openai-chat` today.

### Accept criteria

1. Unset config: catalog rows and wire bodies byte-identical to `e40245e4c`.
   Activation: run the existing strict-mode assertions in
   `tests/codex-catalog.test.ts` unchanged.
2. `adaptive` set: a combo with one `[]`-ladder member publishes the surviving
   sibling intersection instead of `[]`. Activation: new case asserting a non-empty
   ladder where the strict case asserts `[]`.
3. Tool-bearing request to a listed model omits `reasoning_effort`; the same model
   without tools still sends it; an unlisted sibling always sends it. Activation:
   three assertions in `tests/openai-chat-hardening.test.ts`.
4. Dashboard round-trip preserves `adaptive`. Activation: `toPutBody` on an item
   parsed from a combo carrying the mode still contains it.
5. A strict combo saved through the API writes no `reasoningEffortMode` key.

### Verifier

`bun x tsc --noEmit` (whole-project, reads every file above) plus the five named
test files run individually by path. The full suite is forbidden by the operator.
