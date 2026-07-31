# Remote compaction v2 fatal error on routed models — investigation

## Symptom (user screenshot, Codex iOS/app)
```
Error running remote compact task: Fatal error: remote compaction v2 expected
exactly one compaction output item, got 0 from 2 output items
```

## Mechanism (read from local codex-rs source, 121_openai-codex)
1. `core/src/compact.rs:66` — `should_use_remote_compact_task(provider)` returns
   `provider.supports_remote_compaction()`, which is `name == "OpenAI"` or Azure
   (`model-provider-info/src/lib.rs:394`).
2. opencodex Design B injects root `openai_base_url = http://localhost:10100/v1`
   (src/codex-inject.ts), so Codex talks to the proxy through its BUILT-IN
   `OpenAI` provider. Remote compaction therefore looks supported for EVERY
   routed model (anthropic, cursor, google, kiro, opencode-go...).
3. With feature `remote_compaction_v2` enabled, compaction sends a normal
   /responses request whose input ends with `{"type":"compaction_trigger"}`
   (`compact_remote_v2.rs:209`) and expects the stream to return EXACTLY ONE
   output item `{"type":"compaction","encrypted_content":...}`
   (`collect_compaction_output`, compact_remote_v2.rs:397: `compaction_count != 1`
   -> the fatal error above; "2 output items" = reasoning + message from the
   routed model).
4. opencodex today: `src/responses/parser.ts` has no branch for
   `compaction_trigger` — the item falls into the loose schema and is silently
   dropped. The routed adapter just answers the conversation normally, emitting
   message/reasoning items, never a `compaction` item -> count 0 -> Codex fatals
   and the thread cannot compact (it stays wedged at full context).

## Why passthrough works
Forward/passthrough mode sends the raw body to the ChatGPT backend, which
implements compaction natively and returns the single `compaction` item. Only
ROUTED providers break.

## Secondary bug found during the same read
After a SUCCESSFUL native compaction (openai/chatgpt path), later requests carry
`{"type":"compaction","encrypted_content":...}` in input
(`build_v2_compacted_history` keeps it in history). If the user then routes that
thread to a non-OpenAI model, our parser silently drops the item -> the entire
compacted history disappears from the routed model's context.

## Fix plan (proxy-side, no Codex changes)
1. Parser: recognize `compaction_trigger` -> flag `_compactionRequest` on the
   parsed request; recognize `compaction`/`compaction_summary` input items ->
   if `encrypted_content` starts with our marker (`ocx1:`), base64-decode into a
   plain user message "[conversation summary]" for routed models; if it is a
   real OpenAI-encrypted blob, degrade to a short "[earlier history was
   compacted]" note (we cannot decrypt it).
2. Routed compaction execution: when `_compactionRequest` and the target is a
   routed adapter, append a summarization instruction (mirroring Codex's local
   compact prompt), run the routed model normally, collect the text, and emit a
   synthetic SSE stream containing exactly one
   `response.output_item.done` item `{type:"compaction", encrypted_content:
   "ocx1:"+base64(summary)}` plus `response.completed`. Codex then stores it and
   replays it; our parser (step 1) decodes it on later turns.
3. Forward path: untouched (native compaction).
4. Tests: parser flag + decode paths, routed compaction end-to-end via mock
   adapter, forward passthrough regression.

## Status: investigation complete, implementation NOT started (user asked for
## investigation). All file/line references verified 2026-07-06 against
## /Users/jun/Developer/codex/121_openai-codex and current opencodex tree.
