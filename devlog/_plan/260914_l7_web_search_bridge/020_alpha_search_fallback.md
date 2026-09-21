# 020 — /v1/alpha/search without ChatGPT forward auth

## Today

`handleSearch` calls `listOpenAiForwardSidecarCandidates(config)` and returns 400
when the list is empty, before considering any configured web-search backend. An
API-key-only deployment therefore cannot use Codex's built-in search at all.

## Response shape

The relay is verbatim today, so the proxy never had to know the schema. The
fallback does. Two independent sources agree: this repository's own fixture in
`tests/server/server-search.test.ts` asserts `{ encrypted_output, output }`, and an
external reimplementation records `{ "encrypted_output": null, "output": "...",
"results": [] }` with `output` carrying the text the client reads. The endpoint is
an internal alpha route with no published wire spec, so the fallback is written to
degrade rather than to be authoritative.

## The fix

When and only when no forward candidate exists, resolve an explicitly configured
`webSearchSidecar.backend` (anthropic, xai, gemini, exa) whose credential is
present, run the query through the executor that backend already ships, and adapt
the outcome to `{ encrypted_output: null, output, results }`.

- The verbatim ChatGPT relay is untouched whenever a forward provider exists.
- An unset or `openai` backend cannot serve this path — `openai` *is* the ChatGPT
  forward path — so that case keeps a 400 and says what to configure.
- A backend that fails returns its own diagnostic rather than the ChatGPT-auth
  message, which is what the issue asks for.
- No new config field. The fallback reads `webSearchSidecar`, which already exists.

