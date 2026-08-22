# 090 — Layer 9: Exa executor + top validation (wp5) [rev 2, consolidated]

Branch: codex/sidecar-exa-executor (base: codex/sidecar-gemini-executor).

## New file: src/web-search/exa-executor.ts (probe: 002 — non-LLM lane)
```ts
export async function runExaWebSearch(query, apiKey, settings, abortSignal?): Promise<SidecarOutcome>
```
- POST https://api.exa.ai/search, headers x-api-key, redirect: "manual" (Bun forwards custom headers across redirects). Body { query, numResults: 5, contents: { text: { maxCharacters: 1000 } } }.
- Mapping: results[] → sources [{url, title}]; text = per-result "Title — snippet (url)" digest (Exa returns no prose; the routed model synthesizes). resolvedSearchType/costDollars ignored.
- ALL upstream error strings pass redactSecretString; a canary-key test asserts the key never reaches the outcome.

## Key handoff (audited path)
- core.ts reads config.webSearchSidecar.exaApiKey at plan-unpack; WebSearchLoopDeps.exaApiKey?: string; SidecarPlan carries only exaConfigured: true. loop.ts "exa" arm → runExaWebSearch(query, deps.exaApiKey, ...).
- redact.ts "exaApiKey" entry + GET-never-echo landed in 060; this layer adds the runtime canary test.

## GUI stance (fixed in 060)
- No GUI backend selector this program; exa is config/CLI-explicit. exa has no model candidates (eligibleModel: () => false); webSearchModels for openai/anthropic backends unchanged. Follow-up GUI-selector issue filed at program end.

## Docs
- docs-site guides/sidecars.md + reference/configuration/server.md: new-backends section (explicit-only, credentials, x_search opt-in, exa key). English only.

## Final verification (top of stack)
- bun run typecheck && bun run test (FULL) && bun run privacy:scan && bun run lint:gui.
- Live executor probes for all three backends as attest evidence; gh pr list chain → goalplan c6.

## Tests: tests/exa-web-search.test.ts — fixture mapping, error non-throw, canary-key redaction.

