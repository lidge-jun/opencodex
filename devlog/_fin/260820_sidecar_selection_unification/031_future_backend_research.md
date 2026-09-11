# 031 — Future web-search backend research table (doc-only)

Recorded from issue #2188 research (2026-08-20, docs not live probes). These are NOT registered backends; each needs live probe + executor before entering WEB_SEARCH_BACKENDS (filter rule 2).

| Candidate | Protocol | Tool/endpoint | Probe contract before activation |
| --- | --- | --- | --- |
| Gemini | Gemini/Interactions | google_search grounding | API-key probe: grounding metadata + citations round-trip; simultaneous-tool limit check |
| xAI Grok | Responses | { type: "web_search" } | api.x.ai key probe: 200 + web_search_call item + allowed_domains behavior |
| OpenCode Zen | Responses | hosted web_search | POST …/zen/go/v1/responses probe (#1616 evidence 2026-08-13) re-verified fresh |
| Exa-class vendors | own Search API | JSON → SidecarOutcome mapping | not an LLM; separate lane from hosted-tool probes (#414) |

Each future descriptor must state: probe fn, executor module, eligibleModel predicate, id/citation wire mapping. Until then the union in config stays "openai" | "anthropic".

