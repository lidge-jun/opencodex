# 100.14 — Search Policy Implementation Plan

## PABCD Cycle

This document is the P-phase artifact for Phase 100.2.

Goal:

```text
Make routed search catalog metadata deliberate instead of inherited from native OpenAI templates.
```

## Current Shape

Current request-time behavior is mostly correct:

- hosted `web_search` tools are extracted by the Responses parser;
- hosted `web_search` is dropped from routed upstream tools;
- `planWebSearch()` injects a synthetic function tool only when sidecar prerequisites are present;
- `tool_search` is already translated through parser/bridge as a client-executed tool discovery call.

Current catalog behavior is not explicit:

- routed entries can still inherit native `web_search_tool_type = "text_and_image"`;
- routed entries can still inherit `supports_search_tool` accidentally.

## Policy

For routed non-OpenAI catalog entries:

```text
web_search_tool_type = "text_and_image"
supports_search_tool = true
```

Reason:

- `web_search_tool_type = "text_and_image"` is truthful for opencodex's routed path because hosted
  search is executed by the default `gpt-5.4-mini` sidecar, and native Codex marks `gpt-5.4-mini` as
  text+image search capable.
- Routed upstream models still do not receive OpenAI hosted image-search tools directly. opencodex
  intercepts hosted web search, then the sidecar verbalizes image results for text-only routed models.
- `supports_search_tool = true` is deliberate, not inherited: opencodex already supports Codex's
  deferred `tool_search` surface through parser/bridge relaying.

If future evidence shows routed `tool_search` is unsafe for a provider class, this should become a
provider/model capability flag, not a copied native template value.

## Implementation Plan

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts
```

Add:

```ts
function normalizeRoutedSearchMetadata(entry: RawEntry): void {
  entry.web_search_tool_type = "text_and_image";
  entry.supports_search_tool = true;
}
```

Call it from `normalizeRoutedCatalogEntry()` after native-only selector stripping.

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts
```

Extend the native-like template to include `web_search_tool_type = "text_and_image"` and
`supports_search_tool = true`.

Add tests proving:

1. routed entries normalize `web_search_tool_type` to `text_and_image`;
2. routed entries deliberately keep `supports_search_tool = true`;
3. native bare GPT entries preserve `text_and_image`.

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/web-search.test.ts
```

Add request-time tests proving:

1. `parseRequest()` stashes hosted `web_search`;
2. `planWebSearch()` returns a plan only when:
   - hosted web search was requested;
   - route is not passthrough;
   - a forward ChatGPT provider exists;
   - incoming authorization exists;
   - sidecar is not disabled;
3. `planWebSearch()` returns `undefined` when these prerequisites are absent.

## Verification

Run:

```bash
bun test tests
bun x tsc --noEmit
git diff --check
```

## Commit

Commit message:

```text
fix: normalize routed search metadata
```
