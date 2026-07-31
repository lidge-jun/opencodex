# Work-phase 4: Design-B endpoint sweep (260707)

## Investigation (cxc map + gpt-5.5 explorer Parfit, file:line-verified)
Design B makes codex's built-in `openai` provider hit the proxy, so every
is_openai()-gated endpoint client lands on us:

- P0 responses/compact (remote compaction v1): supports_remote_compaction()=is_openai()
  (model-provider-info lib.rs:394); Feature::RemoteCompactionV2 default OFF
  (features lib.rs:1209) -> auto-compaction posts /v1/responses/compact
  (codex-api endpoint/compact.rs:33). No proxy route -> GUI index.html 200 ->
  serde error ApiError::Stream (compact.rs:55) -> NO local fallback, turn hard-fails
  (compact_remote.rs:140, session/turn.rs:820).
- P0/P1 catch-all: serveGuiFile runs before the JSON 404 (server.ts:2501 vs 2507);
  extensionless unknown /v1/* paths return 200+HTML. Every uncovered endpoint becomes
  a confusing decode error instead of a clean 404.
- P1 (feature-gated, default off): alpha/search (StandaloneWebSearch), images/* 
  (ImageGenExt), memories/trace_summarize (MemoryTool, no active caller), realtime/*.
- OK: /v1/models shape matches ModelsResponse.

## Fix scope (B)
1. src/server.ts: guard — unknown /v1/* returns JSON 404 BEFORE GUI static serving.
2. src/server.ts: POST /v1/responses/compact route:
   - passthrough (native gpt): forward body to {provider.baseUrl}/responses/compact
     with selected forward headers, return upstream response verbatim.
   - routed: internal /v1/responses call with input+[compaction_trigger], stream:false
     (reuses v2 synthetic-compaction machinery), decode the ocx1 compaction item,
     return {"output":[{type:"message",role:"user",content:[{type:"input_text",
     text: SUMMARY_PREFIX + summary}]}]} — mirrors codex-rs local build_compacted_history.
3. tests: /v1 unknown-path 404 JSON; routed compact returns summary output; passthrough
   compact forwards.
Out of scope: implementing alpha/search / images / memories / realtime (default-off
features; the 404 guard gives them clean failures).

## Verification
bun test ./tests/ && bun x tsc --noEmit
