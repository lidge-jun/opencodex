# 010 — WP1: land PR #489 (strip unsupported forward-mode params)

Author: elppaaa. Head: `fix/strip-max-output-tokens-forward`. Size: +84/-0.

## Problem

In `authMode: "forward"` the ChatGPT backend enforces a strict parameter
allowlist and answers `{"detail":"Unsupported parameter: …"}` for anything
outside it. Codex CLI never trips this — it controls output length through
`reasoning.effort` — but third-party Responses API clients send
`max_output_tokens` (and sometimes `metadata`) because the public spec allows
them. Those requests fail against an otherwise working proxy.

## MODIFY map

### `src/adapters/openai-responses.ts`

NEW helper after `stripPreviousResponseId` (~line 461):

```ts
function stripUnsupportedForwardParams(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const hasMot = Object.prototype.hasOwnProperty.call(body, "max_output_tokens");
  const hasMeta = Object.prototype.hasOwnProperty.call(body, "metadata");
  if (!hasMot && !hasMeta) return body;
  const { max_output_tokens: _mot, metadata: _meta, ...rest } = body;
  return rest;
}
```

Call site inside `buildRequest` (~line 661), forward branch only:

```ts
 if (forward) {
   outBody = repairOrphanedInputItems(outBody, unexpandedMiss);
+  outBody = stripUnsupportedForwardParams(outBody);
 }
 else outBody = stripConflictingHostedTools(outBody);
```

Two properties worth keeping in review: the early return leaves the common Codex
path allocation-free, and the strip is scoped to `forward` so API-key mode still
honours `max_output_tokens`.

## TESTS

`tests/openai-responses-passthrough.test.ts` — new describe block
"OpenAI Responses forward-mode unsupported param stripping": forward mode drops
both fields, and the non-forward path keeps them.

## Integration method

`gh pr diff 489` applied on `dev`, committed with the author's `Co-authored-by`
trailer. The branch is `MERGEABLE`, so no conflict resolution is expected; if the
adapter has moved, re-verify the call-site line rather than force-applying.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/openai-responses-passthrough.test.ts` | pass, including the new cases |
| `bun run typecheck` | exit 0 |
