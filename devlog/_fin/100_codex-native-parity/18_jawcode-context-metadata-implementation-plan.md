# 100.18 — jawcode Context Metadata Implementation Plan

## Easy Summary

Phase 100.4 gives routed models real context-window metadata instead of accidentally inheriting the
native GPT catalog window. opencodex will not import jawcode at runtime. Instead, a build-time script
will read jawcode's static `models.json`, generate a tiny opencodex-owned snapshot, and the catalog
builder will apply exact provider/model matches to Codex catalog fields.

## Policy

Do:

```text
jawcode models.json -> generated opencodex snapshot -> exact provider/model lookup -> Codex fields
```

Do not:

```text
runtime import @jawcode-dev/ai
spread full jawcode model objects into Codex catalog
guess unknown provider/model metadata
```

Exact match behavior:

1. mapped provider + exact model id -> apply jawcode metadata;
2. mapped provider + unknown model -> keep current conservative/template metadata;
3. unmapped provider -> keep current metadata.

## Provider Mapping

Initial mapping:

```ts
const PROVIDER_ALIASES = {
  "xai": "xai",
  "anthropic": "anthropic",
  "google": "google",
  "gemini": "google",
  "moonshot": "moonshot",
  "kimi": "moonshot",
  "openrouter": "openrouter",
  "opencode-go": "opencode-go",
} as const;
```

This includes the user-confirmed correction that `opencode-go` exists in jawcode and maps directly.

## Codex Field Mapping

From jawcode:

```text
contextWindow -> context_window
contextWindow -> max_context_window
floor(contextWindow * 0.9) -> auto_compact_token_limit
input -> input_modalities
```

Do not map:

```text
maxTokens -> context_window
max_context_window_tokens -> context_window
```

`maxTokens` is output-token metadata, not context capacity.

## Diff-Level Plan

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/scripts/generate-jawcode-metadata.ts
```

Responsibilities:

1. Read jawcode model registry from:
   - `process.env.JAWCODE_MODELS_JSON`, or
   - `../jawcode/packages/ai/src/models.json` relative to opencodex cwd.
2. Filter to the unique jawcode provider ids used by `PROVIDER_ALIASES` only:
   - `xai`
   - `anthropic`
   - `google`
   - `moonshot`
   - `openrouter`
   - `opencode-go`
3. Project each allowed model to compact tuples:
   - provider
   - id
   - contextWindow
   - maxTokens
   - input
   - reasoning
   - wireModelId
4. Write:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/generated/jawcode-model-metadata.ts
```

The generated file must be deterministic: sorted providers and sorted model ids.
It must not emit the full jawcode registry; large unrelated provider catalogs stay out of opencodex.

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/src/generated/jawcode-model-metadata.ts
```

Generated exports:

```ts
export interface JawcodeModelMetadata {
  provider: string;
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  wireModelId?: string;
}

export function getJawcodeModelMetadata(provider: string, modelId: string): JawcodeModelMetadata | undefined;
```

The generated module also owns alias resolution:

```ts
const PROVIDER_ALIASES: Record<string, string> = {
  "xai": "xai",
  "anthropic": "anthropic",
  "google": "google",
  "gemini": "google",
  "moonshot": "moonshot",
  "kimi": "moonshot",
  "openrouter": "openrouter",
  "opencode-go": "opencode-go",
};

export function resolveJawcodeProvider(provider: string): string | undefined {
  return PROVIDER_ALIASES[provider];
}
```

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts
```

Add import:

```ts
import { getJawcodeModelMetadata, resolveJawcodeProvider } from "./generated/jawcode-model-metadata";
```

Add helper:

```ts
function applyJawcodeCatalogMetadata(entry: RawEntry, slug: string): void {
  const slash = slug.indexOf("/");
  if (slash < 0) return;
  const provider = slug.slice(0, slash);
  const modelId = slug.slice(slash + 1);
  const jawcodeProvider = resolveJawcodeProvider(provider);
  if (!jawcodeProvider) return;
  const meta = getJawcodeModelMetadata(jawcodeProvider, modelId);
  if (!meta) return;
  if (typeof meta.contextWindow === "number" && meta.contextWindow > 0) {
    entry.context_window = meta.contextWindow;
    entry.max_context_window = meta.contextWindow;
    entry.auto_compact_token_limit = Math.floor(meta.contextWindow * 0.9);
  }
  if (Array.isArray(meta.input) && meta.input.length > 0) {
    entry.input_modalities = meta.input;
  }
}
```

Call sites:

1. Template-backed routed path: call `applyJawcodeCatalogMetadata(e, slug)` immediately after
   `normalizeRoutedCatalogEntry(e)` and before `return normalizeServiceTiers(e)`.
2. Template-less fallback path: build the fallback object in a local `const entry`, call
   `applyJawcodeCatalogMetadata(entry, slug)`, then return `normalizeServiceTiers(entry)`.

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/package.json
```

Add script:

```json
"generate:jawcode-metadata": "bun scripts/generate-jawcode-metadata.ts"
```

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts
```

Add tests proving:

1. exact `opencode-go/deepseek-v4-pro` gets jawcode context metadata;
2. provider alias `kimi/kimi-k2.5` resolves through jawcode `moonshot`;
3. unknown provider/model keeps existing template/fallback context values and does not guess;
4. generated snapshot does not include unrelated providers outside the alias allowlist.

## Verification

Run:

```bash
bun run generate:jawcode-metadata
bun test tests
bun x tsc --noEmit
git diff --check
```

Expected:

```text
all pass
```

## Acceptance Criteria

1. No runtime dependency on `@jawcode-dev/ai`.
2. Generated snapshot is deterministic and committed.
3. Routed exact matches receive jawcode context metadata.
4. Unknown routed models are not guessed.
5. Existing catalog normalization/search/service-tier behavior does not regress.
