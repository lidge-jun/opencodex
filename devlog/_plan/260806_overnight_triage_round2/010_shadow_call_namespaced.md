# 010 — Fix #1075/#1078: dashboard shadow-call select saves the bare id

Branch: `codex/1075-shadow-call-namespaced`, base `origin/dev` (no overlap
with the open stack — `dashboard-overview-sections.tsx` is untouched by
#1069–#1072).

## Defect

Two selects edit `shadowCallIntercept.model`:

- `gui/src/pages/Models.tsx:914` → `shadowModelOptions` →
  `activeModelOptions` (`models-shared.ts:87-99`) → `value: m.namespaced`. Correct.
- `gui/src/pages/dashboard-overview-sections.tsx:363` builds inline from
  `ModelInfo { id, provider }` (`dashboard-shared.ts:42`):
  `value: m.id`, `label: ${m.provider}/${m.id}`. Saves the bare id.

A bare id reaches `routeModel` (`src/router.ts:668`) via
`core.ts:1380-1400` and resolves to the native provider — interception
silently targets the wrong provider, and on reload the select matches the
first native entry with the same id (the reported "jump").

## Change (audit-corrected: use the canonical `namespaced` field)

The audit rejected `${provider}/${id}` reconstruction: `/api/models`
already returns a canonical `namespaced` per row (`model-rows.ts:24,44,74`),
where native OpenAI rows are deliberately BARE slugs and routed rows go
through the slug codec (`slug-codec.ts:28,33` — inner slashes encoded).
Reconstructing would mint noncanonical `openai/gpt-5.6-sol` and bypass
encoded aliases. Models.tsx already consumes `m.namespaced` correctly.

1. `gui/src/pages/dashboard-shared.ts:42`: add `namespaced: string` to
   `ModelInfo` (the API already sends it).
2. New helper in `dashboard-shared.ts`:

```ts
export function shadowCallModelOptions(models: ModelInfo[], current: string | undefined) {
  const out = [{ value: "", label: "—" }, ...models.map(m => ({ value: m.namespaced, label: m.namespaced }))];
  if (current && !out.some(o => o.value === current)) out.push({ value: current, label: current });
  return out;
}
```

3. Both consumers use it: `dashboard-overview-sections.tsx:363` AND
   `Models.tsx:914` (so unmatched legacy values render in both places —
   `Select` otherwise opens an unmatched value at index zero, `ui.tsx:50,225`).

Back-compat facts recorded honestly:

- Legacy values are preserved, never mutated; no server normalization
  (`config-routes.ts:395` keeps arbitrary strings — bare native selectors
  are legitimate and the PUT has no provider identity to reconstruct from).
- A legacy bare id that collides with a native slug (the reported case)
  is indistinguishable from an intentional native pick — NOT recoverable;
  the fix prevents new corruption, it cannot repair old collisions.

## Regression test (audit-corrected)

GUI tests are `bun:test`, not vitest. `gui/tests/shadow-call-model-options.test.ts`:

- native `namespaced: "gpt-5.6-sol"` stays bare;
- routed `namespaced: "subapi/gpt-5.6-sol"` stays routed;
- an encoded slug where `namespaced !== provider + "/" + id`;
- unmatched legacy fallback entry appended;
- wiring proof: a source-contract assertion in the style of
  `dashboard-contracts.test.ts:157` that BOTH consumers reference
  `shadowCallModelOptions` (a helper-only test stays green if the .tsx
  usage is reverted — insufficient alone).

## Verification

`bun run typecheck`, `bun run lint:gui`, `cd gui && bun test
tests/shadow-call-model-options.test.ts`, `bun run privacy:scan`.
GUI-mentioning PR → screenshot of the dashboard select showing namespaced
entries required in the PR body.
