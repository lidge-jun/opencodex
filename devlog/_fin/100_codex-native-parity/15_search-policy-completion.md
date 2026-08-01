# 100.15 — Search Policy Completion

## Scope

Phase 100.2 implemented explicit routed search metadata and request-time sidecar regression tests.

Primary files:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/web-search.test.ts
```

## Implemented Behavior

Routed non-OpenAI catalog entries now set:

```text
web_search_tool_type = "text_and_image"
supports_search_tool = true
```

This is deliberate policy, not native-template inheritance.

Meaning:

- `web_search_tool_type = "text_and_image"` advertises the capability opencodex can actually provide
  through the default `gpt-5.4-mini` sidecar. The routed upstream model does not run OpenAI hosted
  image search directly; the sidecar runs it and verbalizes image results when the downstream model is
  text-only.
- `supports_search_tool = true` keeps Codex deferred `tool_search` available. It does not enable
  hosted web search by itself.

Hosted web search still depends on request-time sidecar prerequisites:

- Codex must send a hosted `web_search` tool;
- the request must be routed, not native passthrough;
- a forward ChatGPT provider must exist;
- incoming ChatGPT authorization must be present;
- `webSearchSidecar.enabled` must not be false.

If any prerequisite is absent, the hosted `web_search` tool remains suppressed and is not exposed to
the routed upstream model.

## Test Coverage

Added or extended tests:

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts
/Users/jun/Developer/new/700_projects/opencodex/tests/web-search.test.ts
```

Covered assertions:

1. routed catalog entries force `web_search_tool_type = "text_and_image"`;
2. routed catalog entries deliberately set `supports_search_tool = true`;
3. native bare GPT entries preserve native `text_and_image`;
4. template-less fallback routed entries still receive explicit search metadata;
5. `parseRequest()` stashes hosted web search while preserving normal function tools;
6. `planWebSearch()` activates only when all sidecar prerequisites pass;
7. `planWebSearch()` returns `undefined` predictably when prerequisites are absent.

## Verification

Commands:

```bash
bun test tests
bun x tsc --noEmit
git diff --check
```

Expected result:

```text
all pass
```
