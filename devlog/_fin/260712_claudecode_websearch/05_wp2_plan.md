# WP2 Plan — Anthropic web-search sidecar executor (diff-level)

Phase: P. Archetype: spec-satisfaction. Write scope:
src/web-search/{index.ts, loop.ts, anthropic-executor.ts(new)},
src/types.ts (config field), src/server/responses.ts (plan passthrough),
tests/web-search*.test.ts + new tests/web-search-anthropic.test.ts.
Out of scope: vision, claude-messages auth (WP3), GUI (WP5).

## Verified building blocks

- OAuth fingerprint exports exist: ANTHROPIC_OAUTH_BETA,
  CLAUDE_CODE_SYSTEM_INSTRUCTION (src/oauth/anthropic.ts:14-15),
  CLAUDE_CODE_HEADERS + claudeCodeSessionId (src/adapters/client-fingerprint.ts).
  web_search is exempt from the custom_ tool prefix (ANTHROPIC_BUILTIN_TOOLS).
- Token: getValidAccessToken(providerName) (src/oauth/index.ts:141) handles
  refresh; executor calls it per search (async ok).
- Adapter oauth request shape to mirror (src/adapters/anthropic.ts:588-680):
  system[0] = CLAUDE_CODE_SYSTEM_INSTRUCTION, Authorization Bearer,
  anthropic-beta, CLAUDE_CODE_HEADERS, X-Claude-Code-Session-Id,
  x-client-request-id, anthropic-version 2023-06-01, UA sdk/0.74.0,
  url = base.replace(/\/v1\/?$/,"") + "/v1/messages".
- Loop call site: src/web-search/loop.ts:402 (single runWebSearch call).

## Design

D1 Config: OcxWebSearchSidecarConfig.backend?: "openai" | "anthropic".
   Precedence: explicit backend wins; unset -> "anthropic" iff an enabled
   anthropic-adapter oauth provider WITH a stored credential exists, else
   "openai". Credential presence via sync oauth store read (getCredential
   pattern, cf. src/providers/quota.ts:171).
D2 Default anthropic sidecar model: "claude-sonnet-5" (user matrix example);
   cfg.model applies to whichever backend is active.
D3 SidecarPlan: { backend, forwardProvider?, anthropicProvider? {name,
   provider}, hostedTool, settings, maxSearches, ... }. openai backend keeps
   ALL existing gates (forward provider + ChatGPT auth). anthropic backend
   requires only the provider+credential; ChatGPT-login gate does NOT apply.
D4 New src/web-search/anthropic-executor.ts:
   runAnthropicWebSearch(query, providerName, provider, settings, signal?)
   -> SidecarOutcome. Body: model, max_tokens 8192, stream true,
   system [identity, BASE_INSTRUCTION(+IMAGE_INSTRUCTION)],
   messages [user query], tools [{type:"web_search_20250305",
   name:"web_search", max_uses:3}]. No thinking config (fast path).
   Never throws: {error} envelope like the gpt executor; sidecarEnter
   tracker + signalWithTimeout + fetchWithResetRetry reused.
D5 Parser parseAnthropicSidecarSSE(res): fold Anthropic SSE —
   text_delta accumulate; content_block_start web_search_tool_result with
   array content -> collect {url, title} hits (dedup); non-array content
   (error) ignored for sources; final -> WebSearchResult {text, sources}.
   Lives in anthropic-executor.ts (parse.ts stays Responses-only).
D6 loop.ts: WebSearchLoopDeps gains backend + anthropicProvider;
   runSearchCall dispatches by backend. recordSidecarOutcome (codex pool
   bookkeeping) only fires for the openai backend.
D7 responses.ts: thread new plan fields into runWithWebSearch.

## Tests

A1 planWebSearch backend resolution: explicit anthropic w/o forward provider
   -> plan exists (backend anthropic); unset + credential -> anthropic;
   unset + no credential -> openai (existing gates intact); explicit openai
   + credential present -> openai (explicit wins).
A2 executor request shape (mock fetch): url /v1/messages, system[0]
   identity text, beta header, fingerprint headers present, tools
   web_search_20250305 with name web_search, model default sonnet-5.
A3 parser fixture: server_tool_use + web_search_tool_result(2 hits incl.
   titleless) + interleaved text -> {text, sources[2]}, dedup by url.
A4 loop dispatch: backend anthropic routes to runAnthropicWebSearch
   (spy/mock), openai unchanged.
A5 regression: existing web-search tests green unchanged.

## Risks

R1 OAuth ToS surface — mitigated: request shape is byte-compatible with the
   existing routed-provider oauth path (same fingerprint constants), no new
   spoof surface beyond repo precedent.
R2 Anthropic streaming may emit web_search_tool_result content only in
   content_block_start (no deltas) — parser handles start-carried content;
   if delta-carried appears, hits fold at stop (buffer input_json ignored).
R3 planWebSearch sync credential check — use store read, not token refresh;
   executor handles expired tokens via getValidAccessToken at call time.

## Audit round 1 synthesis (Bacon/sol — VERDICT: FAIL, 6 findings, all accepted)

Evidence: .codexclaw/evidence/260712-wp2-plan-audit.md
- F1 ACCEPT (MAJOR): auto-backend credential check uses getAccountSet() and
  rejects an active account marked needsReauth (getCredential alone can pick
  a terminally invalid account). Executor still refreshes via
  getValidAccessToken at call time.
- F2 ACCEPT (MAJOR): sonnet-5 defaults to ADAPTIVE thinking when `thinking`
  is omitted — executor body MUST send thinking:{type:"disabled"}; a request-shape
  test asserts it. max_tokens 8192, tool name "web_search", and max_uses are valid.
- F3 ACCEPT (MAJOR): BASE_INSTRUCTION/IMAGE_INSTRUCTION are private in executor.ts —
  add executor.ts to WP2 write scope and export both constants so anthropic-executor.ts
  reuses them (single source, no duplication).
- F4 ACCEPT (MAJOR): WebSearchLoopDeps.backend gets a documented default of "openai"
  so the existing 18 runWithWebSearch() call sites stay green; the planWebSearch and
  stall-plan tests get explicit backend + credential fixtures and updated plan-shape
  assertions.
- F5 ACCEPT (MINOR): on429 stays main-route-only and unconditional for both backends;
  an anthropic sidecar HTTP 429 is a graceful SidecarOutcome failure — no OpenAI pool
  recorder and no main-route rotation fire for it. Add a dispatch regression covering
  the distinction.
- F6 ACCEPT (MINOR): the parser design is correct — Anthropic streams carry the full
  web_search_tool_result.content on content_block_start; drop the R2 delta-carried-hits
  fallback claim (unsupported, not implemented).
