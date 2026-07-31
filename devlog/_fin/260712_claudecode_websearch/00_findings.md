# Claude Code web_search: How It Works Through OpenCodex Proxy

Date: 2026-07-12
Status: FINDINGS COMPLETE

## Executive Summary

Claude Code supports web search when routed through the OpenCodex proxy.
The mechanism is a sidecar loop that intercepts web_search tool calls from
non-OpenAI models and executes them via a gpt-5.6-luna mini model through the
ChatGPT passthrough backend.

Key constraint: Native Claude models (Anthropic API) cannot call web_search
server-side. The sidecar handles this transparently.

## Architecture: web_search Sidecar

### Flow (Claude Code -> OCX Proxy -> routed model)

```
Claude Code sends:
  POST /v1/messages  (Anthropic Messages API)
    tools: [{ type: "web_search_20250305", ... }, ...]

OCX Proxy (inbound.ts):
  1. toolsToResponses() detects type.startsWith("web_search")
  2. Converts to { type: "web_search" } in Responses format
  3. parser.ts extractHostedWebSearch() stashes the config

OCX Proxy (responses.ts):
  4. planWebSearch() checks conditions:
     - _webSearch exists (tool was requested)
     - NOT passthrough (non-OpenAI model)
     - forward provider exists (ChatGPT backend available)
     - sidecar not disabled
     - Authorization header present (ChatGPT login)
  5. If all pass -> buildWebSearchTool() adds synthetic function tool
  6. runWithWebSearch() runs the agentic loop

Sidecar Loop (loop.ts):
  7. Send request to routed model (e.g., gpt-5.6-sol via OpenAI)
  8. Model calls web_search function -> intercepted
  9. Sidecar spawns gpt-5.6-luna with REAL web_search tool
     via ChatGPT passthrough (forward provider)
  10. Search results injected as tool_result
  11. Loop until model answers (max 3 searches/turn)
```

### Key Files

| File | Role |
|------|------|
| src/claude/inbound.ts:294 | Converts Anthropic web_search to Responses format |
| src/web-search/index.ts | planWebSearch() - decides if sidecar activates |
| src/web-search/synthetic-tool.ts | buildWebSearchTool() - synthetic function tool |
| src/web-search/executor.ts | runWebSearch() - executes via gpt-5.6-luna sidecar |
| src/web-search/loop.ts | runWithWebSearch() - agentic search loop |
| src/server/responses.ts:868 | Integration point in request handler |

### Configuration (opencodex.toml)

```toml
[webSearchSidecar]
enabled = true              # default: true
model = "gpt-5.6-luna"      # sidecar model (default)
reasoning = "low"           # sidecar effort (default)
maxSearchesPerTurn = 3      # max searches per turn (default)
timeoutMs = 200000          # sidecar timeout (default)
```

## Activation Conditions

The sidecar activates when ALL of these are true:

1. _webSearch exists - Claude Code sent a web_search tool
2. NOT passthrough - Model is routed (not native OpenAI/ChatGPT)
3. Forward provider exists - At least one authMode: "forward" provider
4. Sidecar not disabled - webSearchSidecar.enabled !== false
5. Authorization present - incomingHeaders.get("authorization") exists

### When It Fails

- No forward provider: sidecar cannot run
- No auth header: forward backend won't authenticate
- Disabled: webSearchSidecar.enabled = false

## Claude Code CLI Behavior

When Claude Code runs via `ocx claude`:

1. Claude Code sends Anthropic Messages API requests
2. OCX proxy translates to Responses API internally
3. If model is routed to non-OpenAI (e.g., gpt-5.6-sol via OpenAI adapter):
   - web_search is handled by the sidecar loop
   - Model sees web_search as a regular function tool
   - Sidecar executes searches via gpt-5.6-luna
4. If model IS the native ChatGPT passthrough:
   - web_search runs server-side natively
   - No sidecar needed

### Native Claude Models (Anthropic)

When using native Anthropic models (claude-opus-4-8, claude-fable-5):
- Anthropic API supports web_search_20250305 tool natively
- When routed through OCX, inbound translator converts to Responses format
- The sidecar loop handles it identically to other routed models
- Native Anthropic web_search is NOT used; sidecar proxies via gpt-5.6-luna

## CCR / ccswitch / LiteLLM Comparison

### CCR (Claude Code Router)
- Third-party proxy that routes Claude Code to other models
- No web_search sidecar mechanism
- Models must handle search themselves

### LiteLLM
- Generic LLM proxy with model translation
- No built-in web_search sidecar
- Would need custom middleware

### OpenCodex Advantage
- Built-in sidecar gives routed models web search capability
- Uses existing ChatGPT passthrough for real server-side web_search
- Transparent to the model - sees web_search as a function tool
- Configurable sidecar model, effort, timeout, max searches

## Recommendations

### For Claude Code CLI users
1. Ensure ChatGPT/Codex login is active - Required for the sidecar
2. Forward provider must exist
3. web_search works automatically when conditions are met
4. Check sidecar status in OCX dashboard logs

### Documentation Updates Needed
1. Add web_search sidecar section to claude-code guide
2. Document activation conditions clearly
3. Add troubleshooting for when web_search does not activate
4. Note that native Anthropic web_search is bypassed in favor of sidecar

### Potential Improvements
1. Fallback to native Anthropic web_search when sidecar fails
2. Dashboard visibility - show web_search sidecar status in logs
3. Config validation - warn when web_search conditions are not met
