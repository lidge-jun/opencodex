# DONE — Design-B endpoint sweep (260707)

Audit: gpt-5.5 Dalton PASS-WITH-FIXES (all adopted); investigation gpt-5.5 Parfit
(7 findings, file:line evidence both sides).

## Root cause class
Design B makes codex's built-in `openai` provider (is_openai()==true) hit the proxy, so
every provider-gated endpoint client lands here. Worse: the GUI static handler served
index.html with HTTP 200 for ANY extensionless unknown path, so unimplemented endpoints
surfaced as serde decode errors ("failed to decode ... response") instead of 404s.

## Shipped
1. src/server.ts /v1/* guard: unknown /v1 paths → JSON 404 before serveGuiFile.
   Covers alpha/search (StandaloneWebSearch), images/* (ImageGenExt),
   memories/trace_summarize (MemoryTool), realtime/* — all default-off features that
   now fail cleanly instead of decode-erroring on HTML.
2. src/server.ts POST /v1/responses/compact (remote compaction v1 — the DEFAULT path,
   RemoteCompactionV2 is default-off; without this an auto-compaction turn on a routed
   model HARD-FAILED the session: compact_remote.rs has no local fallback):
   - openai-responses providers: verbatim forward to {baseUrl}/responses/compact with
     FORWARD_HEADERS (+ api-key override).
   - routed: internal /v1/responses turn with compaction_trigger appended (reuses the
     v2 summarizer machinery), decodes the ocx1 envelope, returns v1 replacement
     history: retained real user messages (20k-token budget, tail-truncated, mirrors
     codex-rs build_compacted_history_with_limit) + "SUMMARY_PREFIX\n<summary>" user
     message. Plain message items only — no compaction/ocx1 leakage (audit fix 2/3).
3. src/responses/compaction.ts: extractCompactUserMessages + buildCompactV1Output.
4. Tests: v1 helper unit tests (4, incl. budget truncation), /v1 404 guard integration,
   routed compact end-to-end against a mock Anthropic upstream.

## Verified OK (no action)
- /v1/models matches codex-rs ModelsResponse serde (Parfit finding 6).
- compact request body parses under responsesRequestSchema; compact path sends no zstd.

## Verification
bun test ./tests/ → 1550 pass / 0 fail (159 files); bun x tsc --noEmit → exit 0.
Not live until ocx restart (queued with image guard, compaction v2, WS 426 gate,
glm-5.2 vision sidecar).
