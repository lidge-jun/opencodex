# 040 — Phase 4 (#1409-adjacent): user-owned fields must survive a provider POST overwrite

**Attribution correction (audit blocker B4).** This phase proves and fixes a
real data-loss defect on the POST overwrite path. It does **not** prove that
path is what the #1409 reporter hit. See "Attribution" below. The PR therefore
does **not** carry `Closes #1409`.

Depends on: nothing in 010-030 (disjoint files). Ordered after 030 because both
touch management routes and keeping them in separate PRs keeps each diff small.

## The defect (proven)

The report blames "the upgrade", but the upgrade is only the trigger that makes
the user re-save a provider. The deletion happens on the **provider overwrite
path**, and the tree contains the proof.

`POST /api/providers` (`src/server/management/provider-routes.ts:353-364`):

```ts
enrichProviderFromCatalog(name, prov);
const { saveConfigPreservingClaudeCode: save } = await import("../../config");
// Overwriting an existing provider must not drop its multi-key pool: ...
const existingPool = config.providers[name]?.apiKeyPool;
if (existingPool && !prov.apiKeyPool) prov.apiKeyPool = existingPool;
// The same rule applies to user-configured price overlays: the dashboard's
// add/edit form does not send modelCosts, so an overwrite must not silently
// erase hand-edited per-model prices from Logs/Usage estimates.
const existingCosts = config.providers[name]?.modelCosts;
if (existingCosts && !prov.modelCosts) prov.modelCosts = existingCosts;
config.providers[name] = stripRegistryOnlyStaticHeaders(name, prov);
```

`enrichProviderFromCatalog` → `enrichProviderFromRegistry`
(`src/providers/derive.ts:405`):

```ts
if (!prov.modelContextWindows && seed.modelContextWindows) prov.modelContextWindows = { ...seed.modelContextWindows };
```

The dashboard add/edit form does not send `modelContextWindows`. So on an
overwrite the field is absent, the registry seed fills it, and the stored row
becomes the seed. For `opencode-go` the seed is:

```ts
modelContextWindows: { "kimi-k3": KIMI_K3_STANDARD_CONTEXT_WINDOW },
```

which is exactly the `{"kimi-k3": 262144}` the reporter found in place of their
`{"deepseek-v4-flash": 900000}`. The observed UI change (855k → 950k) follows
because with no override the catalog falls back to the registry
`contextWindow: 1000000` with a 900000 auto-compact limit.

**The two existing carry-overs are the shipped precedent.** `apiKeyPool` and
`modelCosts` are preserved with exactly this rationale — the form does not send
them, so absence must not mean deletion. `modelContextWindows` is the same class
of hand-edited user data and was simply never added to the list.

Confirmed in the GUI source: `buildProviderPayload`
(`gui/src/provider-payload.ts:83-108`) builds `ProviderPayload`, whose type
(`:71-81`) has no `modelContextWindows` member at all. The payload therefore
*structurally cannot* carry the field.

## Attribution: what this explains and what it does not

The reviewer verified that the dashboard's normal editing surfaces use `PATCH`
(`gui/src/pages/use-providers-crud.ts:82,99,125`), and that `Models.tsx:476`
sends `modelContextWindows` over `PATCH`. The POST overwrite branch is reached
only when the Add Provider modal submits a **duplicate provider name**.

So the confirmed reproduction is: re-add an existing provider through the Add
Provider modal → the user's `modelContextWindows` is replaced by the registry
seed. A genuine bug, worth fixing on its own merits.

The #1409 reporter's sequence was upgrade → daemon restart → later unrelated
full-config write, and the maintainer's comment names #1273's stale
whole-document writer as the leading hypothesis. Nothing found here rules that
in or out. **The honest disposition is to fix the proven defect and comment on
#1409 with what was confirmed, what was fixed, and what evidence is still
needed** — not to close it.

## Field-ownership matrix (locked at plan time, audit blocker B10)

A field needs carry-over when all three hold: (a) user-editable somewhere in the
product, (b) absent from `ProviderPayload`, (c) registry-seeded by
`enrichProviderFromRegistry`. Carrying over a registry-only field would freeze
stale registry metadata into user config — the opposite failure — so (a) must be
confirmed by reading the editing UI, never assumed.

| Field | User-editable | In POST payload | Registry-seeded | Carry over? |
|---|---|---|---|---|
| `apiKeyPool` | yes | no | no | already carried |
| `modelCosts` | yes | no | no | already carried |
| `modelContextWindows` | yes (`Models.tsx:476`) | **no** | yes (`derive.ts:405`) | **add** |
| `contextWindow` | yes (`Models.tsx:475`) | **no** | yes (`derive.ts:404`) | **add** |
| `modelInputModalities`, `modelMaxOutputTokens`, `modelReasoningEfforts`, `modelDefaultReasoningEfforts`, `modelReasoningEffortMap`, `reasoningEffortMap`, `noVisionModels`, `noReasoningModels`, `noTemperatureModels`, `defaultMaxOutputTokens` | confirm against the real editing surfaces in B | no | yes | only where (a) is confirmed |

`contextWindow` joins this phase because it fails the same three tests and is
edited on the same Models surface, one line above `modelContextWindows`.

### What is *not* the cause (checked, so nobody re-checks it)

- `derive.ts:405` is fill-only and correct in isolation: it only fills when the
  whole map is absent. The bug is that the map *is* absent on this path because
  the client never sends it, not because the fill logic is wrong.
- `router.ts:270-272` merges registry values *beneath* user entries
  (`mergeRecordFill`) and never overwrites.
- `provider-routes.ts:187-208` (the PATCH path) merges per key and preserves
  unmentioned entries. PATCH is already correct; POST is not.
- The stale whole-document writer in #1273 can make the loss *visible* later,
  but it is not required to explain the loss.

## Scope

IN

- `src/server/management/provider-routes.ts` — the POST overwrite carry-over.
- `tests/` — regression coverage for the overwrite path.

OUT

- `derive.ts` fill semantics.
- `router.ts` merge semantics.
- The PATCH path.
- #1273's whole-document writer (separate issue, separate unit).

## Diff-level change map

### Ownership must be sampled BEFORE enrichment (audit R2-1)

`enrichProviderFromCatalog(name, prov)` runs at `:353`, and
`enrichProviderFromRegistry` fills absent fields from the registry seed. After
that call, "the client omitted this field" and "the registry supplied it" are
indistinguishable. Any carry-over guard written as
`prov.x === undefined` after enrichment is therefore **dead code** — this was a
real defect in an earlier revision of this document, caught in audit round 2.

The correct shape samples ownership first:

```ts
// Sample request ownership BEFORE enrichment (audit R2-1): enrichment fills
// absent fields from the registry seed, after which an omitted field is
// indistinguishable from a seeded one, and a post-enrichment `=== undefined`
// guard can never fire.
const submittedContextWindow = Object.hasOwn(prov, "contextWindow");
const submittedModelContextWindows = Object.hasOwn(prov, "modelContextWindows");
enrichProviderFromCatalog(name, prov);
```

then restores from the stored row where the request did not own the field:

```ts
const existing = config.providers[name];
// The add/edit form cannot send these: `ProviderPayload` (gui/src/provider-payload.ts:71)
// has no member for either. Absence in the request means "not carried", never
// "the user deleted it" — deletion goes through PATCH with an explicit null.
if (!submittedContextWindow && existing?.contextWindow !== undefined) {
  prov.contextWindow = existing.contextWindow;
}
if (existing?.modelContextWindows) {
  prov.modelContextWindows = submittedModelContextWindows
    ? { ...existing.modelContextWindows, ...(prov.modelContextWindows ?? {}) }
    : { ...existing.modelContextWindows };
}
```

The `submittedModelContextWindows` distinction matters: when the client did not
send the map, the stored value must be the user's map alone. Merging the
registry seed on top would persist seed keys into user config as a side effect
of an unrelated save.

```ts
const existingCosts = config.providers[name]?.modelCosts;
if (existingCosts && !prov.modelCosts) prov.modelCosts = existingCosts;
// Same rule again for per-model context windows. The add/edit form does not
// send modelContextWindows either, so registry enrichment above would fill the
// absent field with the registry seed and the stored row would lose a
// hand-edited override (#1409: an explicit deepseek-v4-flash entry was replaced
// by the opencode-go seed for kimi-k3). Absence in the request means "the client
// did not carry this field", never "the user deleted their override" — deletion
// goes through the PATCH path, which sends an explicit null.
// SUPERSEDED by the ownership-sampling block above (audit R2-1). Kept only to
// show the shape that was wrong: this merges the registry seed into the stored
// row when the client omitted the map.
const existingWindows = config.providers[name]?.modelContextWindows;
if (existingWindows) {
  prov.modelContextWindows = { ...existingWindows, ...(prov.modelContextWindows ?? {}) };
}
```

Merge direction matters: existing user entries form the base and anything the
request *did* send wins per key. That preserves a hand-edited
`deepseek-v4-flash` while still letting an explicit submitted value update a
key, and it survives registry enrichment because enrichment ran before this
line and only ever filled an absent map.

### The same audit applied to the neighbouring fields

`enrichProviderFromRegistry` fills these fill-only fields the form may also omit:
`modelInputModalities`, `modelMaxOutputTokens`, `modelReasoningEfforts`,
`modelDefaultReasoningEfforts`, `modelReasoningEffortMap`, `reasoningEffortMap`,
`noVisionModels`, `noReasoningModels`, `noTemperatureModels`, `contextWindow`,
`defaultMaxOutputTokens`.

The matrix above locks the decision for `modelContextWindows` and
`contextWindow`. For the remaining fields, B confirms condition (a) by reading
the editing UI before extending the carry-over — speculative carry-over of
registry-only metadata would freeze stale registry values into user config.
Fields that are purely registry metadata are deliberately left alone.

`contextWindow` carry-over:

```ts
// SUPERSEDED and PROVEN DEAD by audit R2-1: enrichment already assigned
// prov.contextWindow from the registry seed, so this guard never fires.
// Use the ownership-sampling block above instead.
const existingContextWindow = config.providers[name]?.contextWindow;
if (existingContextWindow !== undefined && prov.contextWindow === undefined) {
  prov.contextWindow = existingContextWindow;
}
```

`stripRegistryOnlyStaticHeaders` runs after and is unaffected.

## Activation scenario (C-ACTIVATION-GROUNDING-01)

1. Seed config with
   `providers["opencode-go"].modelContextWindows = { "deepseek-v4-flash": 900000 }`.
2. `POST /api/providers` with the body shape the dashboard form sends for an
   edit — `name`, `adapter`, `baseUrl`, `apiKey`, `defaultModel` — and **no**
   `modelContextWindows`.
3. Read the persisted config.

Before the change: `{"kimi-k3": 262144}` — the override is gone.
After: `{"deepseek-v4-flash": 900000}` — the user's map is restored intact.

The registry seed is deliberately **not** persisted here (audit R3-2): the
client did not send the map, so the stored row must be the user's map alone.
Registry values still reach the runtime through `router.ts`'s
`mergeRecordFill(registryEntry.modelContextWindows, provider.modelContextWindows)`,
which fills seed keys *beneath* user entries at resolve time. Persisting seeds
into user config as a side effect of an unrelated save is the behavior this
phase removes, not one it should reproduce.

Observable effect proving the branch ran: the persisted map contains the user's
key, which is unreachable in the pre-change code for this request shape.

Second activation (submitted map): the same POST **with**
`modelContextWindows: { "kimi-k3": 300000 }` → persisted
`{"deepseek-v4-flash": 900000, "kimi-k3": 300000}` — the submitted key wins and
the untouched user key survives.

## Accept criteria

1. Overwrite without `modelContextWindows` preserves the existing user entry.
   The persisted map is exactly the user's map, with no registry seed keys
   added. (Red before the change.)
2. Overwrite **with** an explicit `modelContextWindows` value for a key updates
   that key and still preserves the other user keys.
3. Overwrite without `contextWindow` preserves the existing user value.
   (Red before the change.)
4. Creating a brand-new provider still receives the registry seed (no
   regression in enrichment).
5. The PATCH path's existing delete-by-null behavior is unchanged — an explicit
   null still deletes.
6. `apiKeyPool` and `modelCosts` carry-overs still behave as before.
7. `bun run typecheck` exit 0; provider/management suites green on `ssh lidge`.
8. The PR flags the management write-boundary change for the security review
   `src/AGENTS.md` requires (audit blocker B12).

## Verification commands

```bash
bun x tsc --noEmit
bun test tests/management-provider-validation.test.ts tests/management*.test.ts tests/config*.test.ts
```

(There is no `tests/provider-routes*.test.ts`; an unmatched glob aborts the run under zsh.
The management-provider validation suite is where this path's coverage lives.)

## Delivery

Branch `codex/1409-preserve-context-window-overrides`, PR against `dev`,
referencing `#1409` **without** `Closes`. A comment on #1409 records the
confirmed POST reproduction, the fix, and the outstanding attribution question
(#1273).
