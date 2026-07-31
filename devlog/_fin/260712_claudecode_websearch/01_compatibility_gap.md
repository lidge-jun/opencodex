# web_search Compatibility Gap Analysis

Date: 2026-07-12
Status: GAP IDENTIFIED

## The Problem

Claude Code shows "Did 0 searches in 40s" despite search working.
The sidecar ran, results were injected, model answered with sources.
But Claude Code's UI counter shows 0.

## Root Cause

Claude Code's WebSearchTool expects Anthropic's NATIVE response format:
- server_tool_use (content_block)
- web_search_tool_result (content_block)
- text blocks with citations

The searchCount comes from UI.tsx getSearchSummary():
- Counts SearchResult objects in output.results[]
- SearchResult = { tool_use_id, content: [{title, url}] }

OCX sidecar returns results as:
- Function tool_result (text) injected into conversation
- Bridge converts to Responses SSE
- Outbound translates to Anthropic Messages SSE
- But as regular text/tool_use, NOT as server_tool_use/web_search_tool_result

## The Two Paths

### Path A: Anthropic Native (best for Anthropic models)

Claude Code calls the Anthropic API with:
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]

Anthropic returns natively:
  content: [
    { type: "server_tool_use", id: "...", name: "web_search", input: {query: "..."} },
    { type: "web_search_tool_result", tool_use_id: "...", content: [{title, url, ...}] },
    { type: "text", text: "..." }
  ]

Claude Code's WebSearchTool.ts parses these directly.
searchCount increments for each web_search_tool_result block.
"Did N searches in Xs" shows correctly.

### Path B: OCX Sidecar (current - for non-Anthropic models)

Claude Code sends web_search_20250305 tool.
OCX inbound.ts converts to {type: "web_search"} Responses format.
planWebSearch() activates sidecar.
gpt-5.6-luna does real search via ChatGPT passthrough.
Results injected as function tool_result text.
outbound.ts converts back to Anthropic format.
But as regular assistant text - NO server_tool_use blocks.
Claude Code sees it as regular tool output, not web search.
searchCount = 0.

## Solution Options

### Option 1: Pass-through for Anthropic models (recommended)
When model routes to an Anthropic provider:
- Do NOT intercept web_search_20250305
- Pass it through as-is to Anthropic API
- Anthropic handles search natively
- Response comes back with proper server_tool_use blocks
- Claude Code parses them correctly
- "Did N searches" works

Implementation: In planWebSearch() or earlier, check if
the target provider is Anthropic. If so, skip sidecar entirely.

### Option 2: Translate sidecar results to Anthropic format
When sidecar completes, translate the results into
server_tool_use + web_search_tool_result blocks in outbound.ts.
More complex, works for all models, but fragile.

### Option 3: Both (ideal)
- Anthropic models: pass-through native web_search
- Non-Anthropic models: sidecar + format translation

## Codex (OpenAI) web_search

The Codex/OpenAI Responses API has its own web_search tool:
  tools: [{ type: "web_search" }]

This is handled server-side by OpenAI when using passthrough.
For routed models, the sidecar handles it.

Can Codex web_search work in Claude Code?
- Not directly: Claude Code sends Anthropic format
- OCX already translates web_search_20250305 -> {type:"web_search"}
- The sidecar works but results don't match expected format
- Fix is the same: translate output format

## Key Code References

Claude Code (consumer):
- src/tools/WebSearchTool/WebSearchTool.ts - makeToolSchema() creates web_search_20250305
- src/tools/WebSearchTool/WebSearchTool.ts - makeOutputFromSearchResponse() parses results
- src/tools/WebSearchTool/UI.tsx - getSearchSummary() counts SearchResult objects

OpenCodex (proxy):
- src/claude/inbound.ts:294 - converts web_search_* to {type:"web_search"}
- src/claude/outbound.ts:268 - IGNORES web_search_call frames
- src/web-search/index.ts - planWebSearch() sidecar activation
- src/web-search/loop.ts - runWithWebSearch() sidecar loop
