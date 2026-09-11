# 020 — Phase 2: carry PR #3886 (disable Responses Lite transport for Spark)

Branch `codex/a-stack-l2-spark-lite`, based on layer 1.
Carried commit `83c1d9b129b80d4f65a797fd61a2026deb8c8123` by cb8010d6.

## Problem

Issue #3885: with `x-openai-internal-codex-responses-lite: true`, the canonical
backend opens a `gpt-5.3-codex-spark` SSE response and closes it before a terminal
event, which the adapter reports as `response.incomplete` / `adapter_eof`. The same
request without that header completes.

## MODIFY map

`src/adapters/openai-responses.ts` — inside the canonical-forward block, before
the existing routing-hint work. Line numbers here are against the pinned base
`942c02873` (block at 2503-2513); layer 1 adds two lines above it, so on this
branch the block sits at 2505-2515.

After:

```ts
      if (isCanonicalOpenAiForwardProvider(provider)) {
        // Spark closes Responses Lite streams before a terminal completion. Select compatibility
        // from the final wire model so aliases cannot leave the caller or a static header enabled.
        if (isPlainObject(finalBody) && finalBody.model === "gpt-5.3-codex-spark") {
          for (const name of Object.keys(headers)) {
            if (name.toLowerCase() === CODEX_RESPONSES_LITE_HEADER) delete headers[name];
          }
        }
        const routingHeaders = new Headers(headers);
        applyCodexRoutingHint(routingHeaders, finalBody);
```

`finalBody` is computed at 2494-2502 and serialized at 2523 on the pinned base
(2496-2504 and 2525 on this branch), so it is the actual wire model.
`parsed.modelId` can differ; the existing test at 187-188 pins that distinction
deliberately. Keying on `finalBody.model` therefore also covers aliases. The loop
removes every case spelling, which matters because static provider headers merge
in at 2315 and 2353 on the pinned base (2317 and 2355 here) with arbitrary casing.

## Scope of the fix, and what it does not cover (audit finding 1)

The independent audit established a real boundary, verified against source:

- **Covered.** Removing the header fixes the reported defect on the HTTP header
  replay path, including the HTTP fallback: `prepareCodexHttpInit()` recomputes
  only the routing hint (`src/server/responses/codex-ws-request.ts:46-52`) and
  `httpInit` carries the header-deleted request forward (`:68`).
- **Not covered.** On the WebSocket path, `codex-ws-request.ts:30-33` writes
  `client_metadata[CODEX_RESPONSES_LITE_METADATA_KEY]` only when the header is
  present and reads `"true"`/`"false"`. Deleting the header leaves any
  pre-existing `client_metadata` Lite value in the body untouched, and that value
  reaches the frame at `:71` and the pool reuse key at
  `codex-ws-pool.ts:53-55`.

Setting the header to `"false"` instead of deleting it would also cover the WS
case, but that expands the carried author's diff beyond issue #3885 and changes
socket reuse identity. This phase carries the author's delete-only form and
records the WS metadata case as unresolved rather than silently expanding scope.
The tip pull request states this limit explicitly so the residual is visible.

## TESTS

`tests/codex-integration/codex-metadata-integrity.test.ts`, beside the mixed-case
test at 171: Spark wire model with a caller-provided Lite header, with a
mixed-case static header, and with `parsed.modelId` set to an alias while the
serialized model is Spark; `gpt-5.6-sol` keeps the header. Existing guards at 185,
211, 225 and 267 stay intact.

## Verification (C)

No local command. Verified by the single tip CI run in 050. Local suites: NOT RUN.
