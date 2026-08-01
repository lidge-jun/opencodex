# previous_response_id 400 + Anthropic prefill 400 — root cause & fix roadmap

## Loop-spec
- Archetype: spec-satisfaction repair (verifier: bun test + tsc, defines done)
- Trigger: Codex clients intermittently receive `{"detail":"Unsupported parameter: previous_response_id"}`
  (HTTP 400) and `Provider error 400: ... "This model does not support assistant message prefill..."`.
- Goal: no request path can 400 on these two upstream rejections; chains degrade safely instead.
- Non-goals: disk persistence of the response state store; GUI; docs-site; release/version bump.
- Verifier: `bun test ./tests/` (exit 0) + `bun x tsc --noEmit` (exit 0) + new regression tests.
- Stop condition: both fixes landed with regression tests green.
- Memory artifact: this unit folder; ledger in .codexclaw.
- Terminal outcomes: DONE expected; NEEDS_HUMAN if a fix requires Codex client behavior change.
- HOTL bounds: write scope = src/adapters/openai-responses.ts, src/adapters/anthropic.ts,
  src/server.ts, src/responses/state.ts, tests/, this devlog unit. gpt-5.5 subagents unlimited (user grant).

## Evidence (investigation, 5 explorers + local reads)

### Bug A — `{"detail":"Unsupported parameter: previous_response_id"}`
- Error body fingerprint `{"detail": ...}` is the ChatGPT Codex backend
  (`chatgpt.com/backend-api/codex/responses`), relayed VERBATIM by the passthrough branch
  (src/server.ts:486-493). Routed adapters wrap errors as `Provider error N: ...` instead
  (src/server.ts:606-610). So this error = native forward passthrough path.
- External: ChatGPT Codex REST backend categorically rejects `previous_response_id`
  (metapi#504, Locus#35; also rejects `metadata`, `max_output_tokens` — strict allowlist).
  Public platform `/v1/responses` DOES support it.
- codex-rs: HTTP `ResponsesApiRequest` has no `previous_response_id` field; only the WS
  `ResponseCreateWsRequest` carries it (prefix-continuation reuse). ocx's WS server converts
  `response.create` into an internal HTTP request → shared handleResponses → forward adapter
  → ChatGPT backend HTTP → 400 whenever the local expansion misses.
- ocx strips the field only when the in-memory store expanded it
  (src/adapters/openai-responses.ts:61 stripExpandedPreviousResponseId,
  src/server.ts:268 expandPreviousResponseInput). Misses forward it raw (locked by
  tests/openai-responses-passthrough.test.ts:128).
- Miss paths: proxy restart (in-memory Map), 1h TTL, 1000-entry prune, prior response not
  `completed`, prior turn served by native passthrough (rememberResponseState is NEVER called
  in the passthrough branch — src/server.ts:370-502), `store:false` guard
  (src/responses/state.ts:62) — and codex-rs sends `store:false` on non-Azure HTTP, so
  passthrough turns would be skipped even if wired.
- Only `openai-responses` (and its azure wrapper) serialize `_rawBody`; all routed adapters
  (openai-chat/anthropic/google/kiro/cursor) rebuild bodies and never forward the field.

### Bug B — Anthropic "assistant message prefill" 400
- `Provider error 400:` prefix = routed adapter wrap (src/server.ts:606-610); body is an
  Anthropic error. Emitters: providers on the anthropic adapter (anthropic OAuth, umans,
  xiaomi, cloudflare-ai-gateway, plus opencode-go models pinned to anthropic wire in
  src/server/adapter-resolve.ts:10-20 — minimax-m*, qwen3.*).
- src/adapters/anthropic.ts has NO trailing-role guard: a history ending with plain assistant
  text is sent as final `role:"assistant"` message → newer Anthropic models reject (prefill).
- Reachable tails: (1) previous_response_id expansion with empty/absent new `input`
  (src/responses/state.ts:44 appends prior output last), (2) interrupted/compacted replay
  ending on an assistant message, (3) web-search sidecar first iteration with assistant-tail
  history (src/web-search/loop.ts:153-199). Tail `function_call` is already safe (synthetic
  tool_result injection, anthropic.ts:369-395). Empty `messages` array is also possible & invalid.
- Repo precedent for the nudge: kiro adapter inserts user "(continue)" between consecutive
  assistant entries and as the fallback current message (src/adapters/kiro.ts:283,309-317).

## Work-phase map (dependency-ordered)
- Phase 1 (010): Bug A fix — forward-mode strip + passthrough state recording + regression tests.
- Phase 2 (020): Bug B fix — Anthropic tail guard + regression tests.
Phase 2 depends only on shared test conventions, not on Phase 1 code; ordered A-first because
A is the reported blocker and touches shared server plumbing Phase 2 must not conflict with.
