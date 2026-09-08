# 010 — Phase 1: carry PR #3906 (Muse Spark Contributor Free web_search strip)

Branch `codex/a-stack-l1-muse-free`, based on `origin/dev` `942c02873`.
Carried commit `11c498b6c62ae9f7c5b0d25ca24fc6612f607a5c` by MohamadSabree8.

## Problem

`stripMuseSparkUnsupportedWebSearchFields` removes `search_content_types` and
`indexed_web_access` from a Codex `web_search` tool before it reaches the Zen
Responses wire, because that gateway 400s on them. The model guard only lists the
two paid contributor ids, so the two Contributor Free ids ride the same wire and
same gateway contract but keep the rejected fields.

## MODIFY map

`src/adapters/openai-responses.ts` — the constant at 2125-2128.

Before:

```ts
const MUSE_SPARK_WEB_SEARCH_STRICT_MODELS = new Set([
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
]);
```

After:

```ts
const MUSE_SPARK_WEB_SEARCH_STRICT_MODELS = new Set([
  "muse-spark-1.3-contributor",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor",
  "muse-spark-1.2-contributor-free",
]);
```

Nothing else changes. The consumer at 2148, its model guard at 2155
(`if (!MUSE_SPARK_WEB_SEARCH_STRICT_MODELS.has(modelId.trim().toLowerCase())) return body;`),
the destination guard at 2159-2164 and the call site at 2451 are untouched.

## TESTS

`tests/providers/muse-spark-web-search-compat.test.ts` — add free-tier cases that
mirror the paid-tier assertions already in the file:

- top-level `tools`: type stays `web_search`, `search_context_size` preserved,
  `search_content_types` and `indexed_web_access` absent (mirrors 81-87, 131-137);
- nested `input[].additional_tools.tools`: same removal (mirrors 106-114, 150-158);
- `web_search_preview` untouched for the free ids (mirrors 90-97, 140-147).

## Known limit (recorded, not fixed here)

`src/providers/registry.ts:1685-1690` maps only the paid ids in
`modelWireDefaults`, so the `-free` ids do not select the Responses wire
automatically; this fix applies when that wire is chosen explicitly. Changing the
registry is out of scope, matching the carried pull request.

## Verification (C)

No local command. The layer is verified by the single tip CI run described in 050.
Local suites: NOT RUN by instruction.
