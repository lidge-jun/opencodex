# Audit round 1 synthesis (reviewer: gpt-5.5 "Huygens", VERDICT: FAIL)

| # | Sev | Finding | Decision | Fold-back |
|---|-----|---------|----------|-----------|
| 1 | High | Live-call design violates bridge contract: bridge closes currentToolCall on text_delta/reasoning (bridge.ts:394,452); later deltas orphaned (bridge.ts:489) | ACCEPT | Redesign WP1 to buffer-ALL calls until flush; no live streaming of args. Text/reasoning pass through freely; calls emitted as complete start/delta/end sequences at flush (finish_reason / [DONE] / error / EOF). Deterministic, contract-safe; latency cost bounded by the turn itself. |
| 2 | High | routedProviderConfig backfill (router.ts:80,101) omits parallelToolCalls -> stale persisted xai configs never get the flag | ACCEPT | WP2 scope += src/router.ts merge; test: stale persisted xai config still yields parallel_tool_calls:true. |
| 3 | Med | No-name-ever flush emits empty-name function call; untested | ACCEPT | Documented parity decision: flush emits name "" (same as current start-with-empty-name behavior); add activation test T7 proving emission (not silent drop). |
| 4 | Med | c3 activation scenario cited compaction, but routed compaction deletes options+tools (responses.ts:241,245) | ACCEPT | Reword: parser-level parallel_tool_calls:false from request input (parser.ts:466) drives the false case. |
| 5 | Low | Stale anchors (233 not 216; registry 185; catalog 858); orphan content:null at openai-chat.ts:100 | ACCEPT | Anchors refreshed in 000/020; orphan branch explicitly in WP2 diff list. |
| OQ | - | Mistral officially supports parallel_tool_calls; why xAI only? | RECORD | Scope decision: xai is the only opted-in provider this unit (active use + verified docs); Mistral/OpenRouter follow-ups after live soak. Added to 000 non-goals. |
