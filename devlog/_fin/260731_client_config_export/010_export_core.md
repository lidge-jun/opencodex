# 010 — Phase 1: client-neutral export core

Foundation phase. Every later phase consumes this module; nothing here is
user-visible on its own. Verified by unit tests only.

Dependency position: first. `020` (CLI), `030` (API), `040` (GUI) all import from
here, and none of them may re-derive a config shape locally.

## Scope

IN
- NEW `src/clients/config-export.ts` — client-neutral types + registry + serializers.
- MODIFY `src/cli/opencode.ts` — re-export the OpenCode serializer from the new
  home; keep every existing export name working.
- NEW `tests/client-config-export.test.ts`.

OUT
- No CLI command, no route, no GUI (later phases).
- No change to launch behavior of `ocx opencode`.
- No OpenCode V2 schema (see `001` §2).
- No writing to any user config file, ever.

## Design

One pure function per client, one shared input type. The input is deliberately
narrower than `CatalogModel` so the serializers cannot reach for fields that do
not survive the `/api/models` boundary.

```ts
export interface ExportModel {
  /** Canonical proxy selector: `provider/id`, or bare slug for native. */
  namespaced: string;
  provider: string;
  id: string;
  displayName?: string;
  contextWindow?: number;
  inputModalities?: string[];
}

export interface ExportContext {
  baseUrl: string;          // http://host:port/v1
  models: readonly ExportModel[];
}

export type ExportClientId = "opencode" | "pi";

export interface ExportClientSpec {
  id: ExportClientId;
  /** Download filename; matches the destination file's own name (003 §5). */
  filename: string;
  /** Canonical destination for humans. Not written to. */
  destination: (env: NodeJS.ProcessEnv) => string;
  /** Env var the config references; the value is never serialized. */
  apiKeyEnv: string;
  /** Shell line the user runs before launching the client. */
  exportHint: string;
  build: (ctx: ExportContext) => unknown;
}
```

### `models` -> per-client emission

Shared precondition applied before either serializer runs: drop disabled rows,
drop duplicate `namespaced` (first wins, native leads), sort by `namespaced` so
output is byte-stable across calls. Stability matters because the GUI shows a
diffable preview and agents may checksum the payload.

### OpenCode serializer

Reuses the shipped logic verbatim. `buildOpencodeProviderBlockFromCatalog` moves
to the new module unchanged in behavior, and `src/cli/opencode.ts` imports it back
so the launcher path is untouched.

Output (V1, `001` §2):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "opencodex": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenCodex",
      "options": { "baseURL": "<baseUrl>", "apiKey": "{env:OPENCODEX_OPENCODE_API_KEY}" },
      "models": { "<namespaced>": { "name": "<label>", "limit": { "context": N, "output": min(32000, N) } } }
    }
  }
}
```

`limit` is omitted entirely when `contextWindow` is absent — existing rule, preserved.

### Pi serializer (new)

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "<baseUrl>",
      "api": "openai-completions",
      "apiKey": "$OPENCODEX_API_KEY",
      "models": [
        { "id": "<namespaced>", "name": "<label>", "input": ["text"], "contextWindow": N, "maxTokens": min(32000, N) }
      ]
    }
  }
}
```

Decisions, each traceable to `002` §4:

| Field | Emission rule | Why |
|-------|---------------|-----|
| `id` | `namespaced` | matches what the proxy actually routes |
| `name` | `displayName ?? namespaced` | same label rule as OpenCode |
| `contextWindow` | omit when unknown | never guess |
| `maxTokens` | `min(32000, contextWindow)`, omit when context unknown | same stand-in as OpenCode, same clamp |
| `cost` | **omit always** | we have no price data; zeros would assert "free", which is false for routed providers |
| `input` | from `inputModalities`, default `["text"]` | text is the one modality every routed model supports |
| `reasoning` | omit | `reasoningEfforts` is an effort list, not Pi's boolean; mapping would be a guess |

Pi's schema is UNVERIFIED against a real install (`001` §2). This phase's test
asserts our own contract, not Pi's acceptance. The B phase of whichever cycle
first ships Pi must diff against a real `~/.pi/agent/models.json` or mark the
feature experimental.

### Destinations

```ts
opencode.destination = env =>
  join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "opencode.json");
pi.destination = () => join(homedir(), ".pi", "agent", "models.json");
```

Reuses `opencodeGlobalConfigPath`'s existing XDG logic rather than reimplementing it.

## File change map

| Path | Action |
|------|--------|
| `src/clients/config-export.ts` | NEW — types, `EXPORT_CLIENTS` registry, both serializers |
| `src/cli/opencode.ts` | MODIFY — import the builder from the new module, re-export for back-compat |
| `tests/client-config-export.test.ts` | NEW |

## Accept criteria

1. `buildClientConfig("opencode", ctx)` output is byte-identical to what
   `buildOpencodeProviderBlockFromCatalog` produced before the move, for a fixture
   covering native + routed + missing-context rows. **Activation:** the test diffs
   against a checked-in golden captured before the refactor.
2. `buildClientConfig("pi", ctx)` emits a models ARRAY, omits `cost`, and omits
   `contextWindow`/`maxTokens` for a row with no context window.
3. Neither serializer's output contains `ocx_` anywhere. **Activation:** the test
   passes a context whose env would hold a real key and asserts only the reference
   string appears.
4. Output ordering is stable across two calls with shuffled input.
5. `bun run typecheck` clean; existing `ocx opencode` tests still pass.

---

## B-phase amendments (2026-08-01, stale check against the tree)

Verified against `src/cli/opencode.ts` at `77243d932` before implementing.

1. **Label rule is richer than `displayName ?? namespaced`.** The shipped
   `opencodeModelEntryLabel` emits `"<displayName|id> (<native|provider|routed>)"`,
   e.g. `gpt-5.6-luna (native)`, `Claude Opus 5 (anthropic)`. The moved function must
   preserve this verbatim; the doc's shorthand was wrong. Pi reuses the SAME label.
2. **`ExportModel` needs `native?: boolean`.** The label rule reads it, so the
   narrowed input type cannot drop it.
3. **`options` carries a conditional `headers` branch.** `opencodeProviderOptions`
   emits `x-opencodex-api-key` instead of `apiKey` on non-loopback binds
   (`shouldInjectApiAuthHeader`). The move must carry `OcxConfig` through, so
   `ExportContext` gains an optional `config` field for the OpenCode path.
4. **Golden captured pre-refactor** at `.tmp/golden-opencode.json` (gitignored
   scratch). Its content is inlined into the test as a literal so the assertion
   survives without the scratch file.
