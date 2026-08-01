# Interview: Cross-Vendor web_search Sidecar Matrix

Date: 2026-07-12
Phase: I (INTERVIEW)
Status: user opinion recorded, clarifying questions pending

## User Opinion (verbatim intent)

1. Anthropic / Codex BOTH sides should be able to designate a web-search
   sidecar, mutually cross-compatible:
   - Codex client + sonnet sidecar -> search via Anthropic native
     web_search_20250305, results returned in Codex (Responses) format
     (web_search_call frames).
   - Claude Code client + luna sidecar -> search via ChatGPT passthrough,
     results returned in Anthropic format (server_tool_use +
     web_search_tool_result blocks).
2. Therefore: can an Anthropic sidecar be SEPARATELY designated (like the
   OpenAI one is today via webSearchSidecar.model)?
3. Images: record current state in devlog; ask user about unclear points.

## Repo Knowns (verified this session)

- Native Anthropic passthrough EXISTS (src/server/claude-messages.ts):
  genuine claude/anthropic model ids that no alias/modelMap claims are
  forwarded VERBATIM to api.anthropic.com with the caller's claude.ai OAuth.
  => Claude Code + native claude model: web_search already works natively
  (server_tool_use blocks intact, "Did N searches" correct). No work needed.
- Routed path (Claude Code + gpt model): sidecar runs (gpt-5.6-luna via
  ChatGPT forward), search happens, BUT results are injected as function
  tool_result text. outbound.ts:268 ignores web_search_call frames =>
  Claude Code UI shows "Did 0 searches"; server_tool_use.n_requests never
  increments. GAP 1: outbound must translate web_search_call begin/end +
  sources into server_tool_use + web_search_tool_result blocks.
- Codex client path: web-search sidecar is hardwired to the first
  authMode:"forward" provider (findForwardProvider) + a gpt model
  (DEFAULT_SIDECAR_MODEL gpt-5.6-luna). GAP 2: no way to choose an
  Anthropic-backed sidecar (claude model + web_search_20250305 via
  configured anthropic provider).
- executor.ts speaks ONLY Responses API (POST {forward}/responses, parses
  Responses SSE). An Anthropic sidecar needs a second executor speaking
  /v1/messages + web_search_20250305 + Anthropic SSE parsing.
- Sidecar result format is vendor-neutral INTERNALLY (WebSearchResult
  {text, sources[]} -> formatWebSearchResults tool_result text). The loop
  already emits web_search_call_begin/end adapter events with sources;
  bridge renders them for Codex (Responses). So Codex-format return is
  already handled by the existing bridge — an Anthropic sidecar plugs in at
  runWebSearch() level without touching the loop.

## Design Matrix (target)

| Client (inbound) | Main model route | Search backend | Return format |
|---|---|---|---|
| Codex CLI | native gpt (passthrough) | OpenAI server-side (no sidecar) | native |
| Codex CLI | routed (anthropic/gemini/...) | sidecar: openai OR anthropic (configurable) | Responses web_search_call (bridge, exists) |
| Claude Code | native claude (passthrough) | Anthropic server-side (no sidecar) | native (exists) |
| Claude Code | routed gpt/other | sidecar: openai OR anthropic (configurable) | Anthropic server_tool_use + web_search_tool_result (GAP 1: build) |

## Images: Current State

- Input images (client -> model): vision sidecar exists (src/vision/,
  planVisionSidecar + describeImagesInPlace in handleResponses). Claude
  inbound translates Anthropic image blocks -> input_image (inbound.ts:83).
  Claude Code path inherits the vision sidecar since it replays through
  handleResponses. Believed working.
- Search-result images (web -> model): GPT sidecar has describeImages
  (executor.ts) — when routed model is in noVisionModels, the search model
  verbalizes image results. Anthropic web_search_20250305: TO VERIFY —
  whether its results can carry images at all (likely text+citations only,
  no image hits). If so, an Anthropic sidecar needs no image handling.
- UNCLEAR (ask user): which image concern did they mean —
  (a) images inside web-search results, (b) input-image vision path for
  routed text-only models, (c) both audited end-to-end for the Claude
  inbound path specifically?

## Open Assumptions (pending answers)

- OA-1: Anthropic sidecar credential source undecided (forwarded claude.ai
  OAuth vs configured anthropic provider key vs both-with-priority).
  Billing differs: API key incurs $10/1k searches; subscription OAuth is
  plan-covered but only present on Claude inbound requests.
- OA-2: Config surface undecided (global webSearchSidecar.backend vs
  per-client override vs per-model).
- OA-3: Anthropic web_search image-result capability unverified.
- OA-4: Whether Claude Code's OWN inner WebSearchTool call (it spawns a
  sub-query with tool_choice web_search) flows through the same routed path
  — affects where the translation must live. Evidence so far: yes, it goes
  through /v1/messages like any call.

## Contradiction Scan (inline, round 1)

- C-1 (resolved): "sonnet as Codex sidecar" vs "sidecar must speak
  Responses" — no contradiction; translation happens proxy-side, the loop's
  adapter events are already client-format-agnostic.
- C-2 (low): user's matrix says "codex 응답형식으로 반환" for sonnet
  sidecar — the bridge already does this; recorded as no-new-work.
- C-3 (medium -> OA-1): cross use "anthropic에서 luna가 web서치" requires
  ChatGPT forward auth on a Claude-inbound request. Claude Code sessions do
  NOT carry ChatGPT OAuth; OCX main-account forward auth must be injected
  server-side. Feasible (authContext kind main/pool) but must be stated.
