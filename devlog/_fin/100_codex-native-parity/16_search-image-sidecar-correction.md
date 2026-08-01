# 100.16 — Search Image Sidecar Correction

## Correction

After the Phase 100.2 implementation, user review caught an important distinction:

```text
gpt-5.4-mini supports native text+image web search.
```

The first 100.2 implementation normalized routed entries to:

```text
web_search_tool_type = "text"
```

That was too conservative for opencodex's actual web-search path.

## Final Policy

Routed non-OpenAI catalog entries should advertise:

```text
web_search_tool_type = "text_and_image"
supports_search_tool = true
```

This does not mean the routed upstream provider receives OpenAI hosted image-search tools directly.
The runtime path remains:

1. Codex enables hosted web search from catalog metadata.
2. opencodex parses and suppresses the hosted `web_search` tool before sending the request upstream.
3. opencodex exposes a synthetic `web_search(query)` function to the routed model when sidecar
   prerequisites are met.
4. The sidecar executes real hosted web search through the native ChatGPT forward provider, using
   `gpt-5.4-mini` by default.
5. If the routed target model is text-only, the sidecar verbalizes relevant image results and includes
   source URLs.

## Why `text_and_image` Is Truthful

Native Codex metadata marks `gpt-5.4-mini` as:

```text
web_search_tool_type = "text_and_image"
supports_search_tool = true
```

opencodex's sidecar uses that model for the real hosted search call. Therefore the catalog capability
is true for the opencodex route as a whole, even when the final routed upstream model only receives a
textual summary of image results.

## Verification Scope

Regression tests now assert:

1. routed catalog entries normalize `web_search_tool_type` to `text_and_image`;
2. native bare GPT entries still preserve `text_and_image`;
3. template-less routed fallback entries receive the same explicit metadata;
4. request-time sidecar prerequisites still control whether hosted search is actually executed.
