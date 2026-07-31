# Phase 5 Cache Read/Write Telemetry Plan

## Part 1: Easy Explanation

The current request log shows one combined cache number. For Anthropic, that number can include both tokens read from a previous cache entry and tokens newly written into cache. This phase keeps the existing total for OpenAI Responses compatibility, but adds optional read/write detail where providers expose it. That makes rows like `cache 8961` interpretable: users can tell whether they got a real cache hit or only paid to create a new cache entry.

## Part 2: Diff-Level Plan

### MODIFY: `src/types.ts`

Before:

```ts
export interface OcxUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  estimated?: boolean;
}
```

After:

```ts
export interface OcxUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  estimated?: boolean;
}
```

Rationale:

- `cachedInputTokens` remains the total compatibility field.
- `cacheReadInputTokens` and `cacheCreationInputTokens` are optional provider-specific detail.
- Providers that only expose a combined cache number leave the detail fields absent.

### MODIFY: `src/adapters/anthropic.ts`

Before:

```ts
...(hasCache ? { cachedInputTokens: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) } : {}),
```

After:

```ts
...(hasCache ? {
  cachedInputTokens: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
  cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
} : {}),
```

Rationale:

- Anthropic is the provider that exposes read and creation separately.
- Recording zero for a reported side is useful because it distinguishes "reported zero" from "provider gave no detail".

### MODIFY: `src/usage-log.ts`

Before:

```ts
...(typeof usage.cachedInputTokens === "number" ? { cachedInputTokens: usage.cachedInputTokens } : {}),
```

After:

```ts
...(typeof usage.cachedInputTokens === "number" ? { cachedInputTokens: usage.cachedInputTokens } : {}),
...(typeof usage.cacheReadInputTokens === "number" ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
...(typeof usage.cacheCreationInputTokens === "number" ? { cacheCreationInputTokens: usage.cacheCreationInputTokens } : {}),
```

Rationale:

- Persist optional detail in `~/.opencodex/usage.jsonl` without changing existing rows or totals.

### MODIFY: `gui/src/pages/Logs.tsx`

Before:

```ts
interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}
```

After:

```ts
interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
}
```

Before `tokensTitle` only adds `cached=<total>`.

After:

```ts
if (typeof log.usage.cachedInputTokens === "number") parts.push(`cached=${log.usage.cachedInputTokens}`);
if (typeof log.usage.cacheReadInputTokens === "number") parts.push(`cacheRead=${log.usage.cacheReadInputTokens}`);
if (typeof log.usage.cacheCreationInputTokens === "number") parts.push(`cacheCreate=${log.usage.cacheCreationInputTokens}`);
```

Optional row text remains compact. Do not add more visible table clutter in this phase.

### MODIFY: `tests/adapter-usage.test.ts`

Update Anthropic usage expected values:

```ts
usage: {
  inputTokens: 20,
  outputTokens: 8,
  cachedInputTokens: 10,
  cacheReadInputTokens: 4,
  cacheCreationInputTokens: 6,
}
```

Update stream merge expected usage similarly when fixture contains both Anthropic cache usage fields.

### MODIFY: `tests/usage-log.test.ts`

Add assertions that `normalizeUsageValue` persists `cacheReadInputTokens` and `cacheCreationInputTokens` when present and omits them when absent.

### MODIFY: `devlog/_plan/260701_cache-audit-hardening/01_cache-surface-audit.md`

Append Phase 5 outcome after implementation:

- `cachedInputTokens` remains combined total.
- Anthropic now records optional read/write detail.
- Request-log tooltip exposes read/write detail when available.

## Non-Goals

- Do not change Responses bridge output; OpenAI Responses only has `input_tokens_details.cached_tokens`.
- Do not change usage summary aggregation in this phase.
- Do not add visible table columns; tooltips are sufficient for this pass.
- Do not invent read/write detail for OpenAI, Gemini, Kimi, or Antigravity when upstream does not provide it.

## Test Matrix

Run:

```bash
bun test tests/adapter-usage.test.ts tests/usage-log.test.ts
bun x tsc --noEmit
```

