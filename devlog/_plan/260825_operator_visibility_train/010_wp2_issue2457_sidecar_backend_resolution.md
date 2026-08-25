# 010 — WP2: the submitted sidecar backend is what the pair check validates (#2457)

## The change in one sentence

Both management write paths must validate the requested model against the
**backend the caller submitted**, not against a two-member subset with the
stored backend as fallback.

## Hunk 1 — `src/server/management/config-routes.ts` (`PUT /api/sidecar-settings`)

Before, at `:668`:

```ts
const effectiveBackend = body.webSearch.backend === "anthropic"
  ? "anthropic"
  : body.webSearch.backend === "openai" || body.webSearch.backend === null
    ? "openai"
    : config.webSearchSidecar?.backend ?? "openai";
```

After:

```ts
const submittedBackend = body.webSearch.backend;
const effectiveBackend =
  typeof submittedBackend === "string"
    && WEB_SEARCH_BACKENDS_UNION.includes(submittedBackend as typeof WEB_SEARCH_BACKENDS_UNION[number])
    ? submittedBackend as typeof WEB_SEARCH_BACKENDS_UNION[number]
    : submittedBackend === null
      ? "openai"
      : config.webSearchSidecar?.backend ?? "openai";
```

`WEB_SEARCH_BACKENDS_UNION` is already in scope at `:591`; an unknown literal
was already rejected there, so by this point a string is either a union member
or the request is dead.

## Hunk 2 — `src/server/management/agent-settings-routes.ts` (`PUT /api/claude-code`)

Before, at `:1121`: the five-arm ternary quoted in `001`.

After, reusing the local `allowedBackends` built at `:1081`:

```ts
const submittedBackend = section.backend;
const effectiveBackend =
  typeof submittedBackend === "string" && allowedBackends.includes(submittedBackend)
    ? submittedBackend as WebSearchBackend
    : submittedBackend === null
      ? config.webSearchSidecar?.backend ?? "openai"
      : stored?.backend ?? config.webSearchSidecar?.backend ?? "openai";
```

## The two null policies are different and both stay

This is the part a careless fix breaks. They are not the same rule:

| Route | `backend: null` means | Resolves to |
|-------|------------------------|-------------|
| `/api/sidecar-settings` | unset the global backend | `"openai"` (the resolver's own default for unset) |
| `/api/claude-code` | drop the Claude override | inherit `config.webSearchSidecar?.backend ?? "openai"` |

Do not unify them. A shared helper that collapses both to one fallback would
silently change what clearing the Claude override means.

## Shape decision

Two shapes were considered:

- **A (chosen):** inline the union membership check in both writers.
- **B:** extract `submittedWebSearchBackend()` into
  `web-search-sidecar-options.ts`.

B reads better as drift protection, which is exactly what failed here. But the
two null policies above cannot live in one helper, so B would extract only the
string arm and leave the divergent part behind — the appearance of unification
without the substance. A is five lines per route with the union named locally.
If a reviewer prefers B, the helper must take the null fallback as a parameter.

## What must NOT change

- `webSearchModelIsRejected` / `webSearchModelRejection`
  (`src/server/management/web-search-sidecar-options.ts:91`). The helper is
  correct; only its `backend` argument was wrong.
- The runtime executor: `src/web-search/index.ts`, `src/web-search/backends.ts`.
- The raw `config.json` escape hatch, which deliberately skips this gate.
- Vision sidecar validation, which has a different three-member union ending in
  `"routed"`, not `"exa"`.
- `GET /api/sidecar-settings` and its `webSearchModels` rows.

## Must still return 400 after the fix

These are the assertions that prove the gate was not merely widened:

1. `{ backend: "openai", model: "claude-haiku-4-5" }` — real mismatch.
2. `{ model: "gemini-3.7-flash" }` with backend omitted and stored `openai` —
   preserved-backend semantics survive.
3. `{ backend: "gemini", model: "gpt-5.6-luna" }` — inverse mismatch.
4. `{ backend: "zen" }` — still fails the union gate at `:591`.

## Regression tests

All in `tests/sidecar-settings-web-search-gate.test.ts`, which already mocks
`getAccountSet` and `listManagementModelRows`. A Gemini pair placed in
`tests/web-search-backend-union.test.ts` would still be rejected after the fix
because that file has no candidate rows — the pair check would correctly find no
matching row. Wrong file, false failure.

| Test | Setup | Assertion | Fails before? |
|------|-------|-----------|---------------|
| `PUT persists openai/luna -> gemini/gemini-3.7-flash` | stored `{openai, gpt-5.6-luna}`, `google-antigravity` oauth + healthy account set with `projectId`, management row `gemini-3.7-flash` | 200, config holds the Gemini pair | **Yes** — 400 today |
| `each leftover union member persists its own pair` (`test.each(["xai","gemini"])`) | matching candidate per backend | 200 each | **Yes** |
| `omitted backend still validates against the stored backend` | Gemini row live, PUT model only | 400, stored pair unchanged | No — guards the fix |
| `PUT /api/claude-code persists a gemini override` | stored override `{openai, gpt-5.6-luna}` | 200, `claudeCode.webSearchSidecar` is the Gemini pair | **Yes** — 400 today |

## Existing tests that must stay green

- `PUT rejects a backend/model mismatch and does not persist it` (`:139`)
- `PUT validates a backend-only update against the preserved effective model` (`:150`)
- `PUT persists the Anthropic auth-slot pair exactly as offered` (`:160`)
- `tests/claude-management-api.test.ts` sidecar round-trip (`:370`)
- `tests/gemini-web-search.test.ts` executor plan test (`:75`) — untouched, and
  its continued passing is the proof the executor needed no change.

## Acceptance

`bun test tests/sidecar-settings-web-search-gate.test.ts tests/web-search-backend-union.test.ts tests/claude-management-api.test.ts tests/gemini-web-search.test.ts`
green; `bun x tsc --noEmit` exit 0; `bun run privacy:scan` pass; new tests
demonstrated red before the patch.
