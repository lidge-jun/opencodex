# 020 — Phase 2: anthropic error fidelity in the sidecar bridges

Evidence basis: `003_anthropic_400_research.md`. The bare `Provider error 400`
that made the incident undiagnosable comes from the web-search/images bridge
error path (`src/web-search/loop.ts:460-484`, `src/images/loop.ts:577+`),
which only formats the upstream body when the adapter implements
`formatErrorBody` (`src/adapters/base.ts:24`). The anthropic adapter lacks
it; openai-chat (`src/adapters/openai-chat.ts:34,729`), google
(`src/adapters/google.ts:314`), and kiro (`src/adapters/kiro.ts:1899`) have
one. Scope: error fidelity only. Any retry policy is deferred until the
ledger distinguishes real upstream 400 reasons in the wild (003 fix
direction 2).

## Diff-level plan

### MODIFY `src/adapters/anthropic.ts`

1. ADD exported `formatAnthropicErrorBody(status, headers, payloadText)` next
   to the other module-level helpers. Contract mirrors
   `formatOpenAIChatErrorBody` (`src/adapters/openai-chat.ts:34-44`):
   - JSON.parse the payload; on parse failure return `""` (HTML/non-JSON is
     never echoed).
   - Extract the Anthropic envelope `{ type: "error", error: { type, message } }`
     → render as `"<error.type>: <message>"`; tolerate a bare
     `{ error: { message } }` and a string `error` field the same way
     `extractErrorDetail` does.
   - Pass through `redactSecretString`, bound to 400 chars (bridge slices to
     400 again — keep the producer bound identical to the openai-chat one).
2. REGISTER it in the adapter object returned by `createAnthropicAdapter`
   (`src/adapters/anthropic.ts:773+`): `formatErrorBody: formatAnthropicErrorBody,`
   beside `name: "anthropic"`. The `ProviderAdapter` interface already
   declares the optional hook (`src/adapters/base.ts:24`) — no interface
   change, no other caller change. Both bridges pick it up through their
   existing `prepared.responseAdapter.formatErrorBody` checks.

### Tests — extend the anthropic adapter suite (or new `tests/anthropic-error-body.test.ts`)

3. Unit: `formatAnthropicErrorBody` on a real Anthropic 400 envelope
   (`{"type":"error","error":{"type":"invalid_request_error","message":"…"}}`)
   → `"invalid_request_error: …"`; on HTML → `""`; on JSON without error
   fields → `""`; secret-shaped content inside `message` is redacted.
4. Bridge integration: fake anthropic upstream returning a JSON 400 through
   the web-search loop → the client-facing JSON error response carries
   `Provider error 400: invalid_request_error: …` (not the bare status; the
   thrown `LoopError` is converted by `runWithWebSearch`,
   `src/web-search/loop.ts:657-662`). Follow the existing web-search loop
   test harness (find the suite covering `loop.ts` error paths and extend
   it).
5. Persistence integration: same fake 400 through `/v1/responses` with
   web_search enabled against a routed anthropic model → the usage entry's
   `upstreamError` contains the upstream message (proves the
   `relay.ts:429` → `request-log.ts:648` capture chain end to end; no
   production change expected in those files).
6. Pin the read-failure branch: upstream body that fails to read still
   produces the bare status-only message (today's deliberate behavior,
   `loop.ts:466-471`).

## Scope boundary

- IN: `src/adapters/anthropic.ts`, new/extended tests.
- OUT: `request-log.ts`/`relay.ts` (capture chain already works — test 5
  pins it), retry policy, combo classification, parser/state changes,
  formatErrorBody for other adapters that lack it (separate follow-up if
  wanted).

## Accept criteria (activation scenarios)

- Test 4 activates the exact bridge branch that produced the incident's bare
  message and proves the suffix now appears.
- Test 5 proves the ledger becomes diagnosable without manual log spelunking.
- `bun run typecheck` 0 errors; focused suites green; full `bun run test` on
  `ssh lidge` green against the warm baseline; `bun run privacy:scan` passes
  (redaction is part of test 3).
