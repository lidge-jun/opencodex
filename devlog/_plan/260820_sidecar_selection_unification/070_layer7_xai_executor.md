# 070 — Layer 7: xAI executor + x_search opt-in (wp3) [rev 2, consolidated]

Branch: codex/sidecar-xai-executor (base: codex/sidecar-backend-union).

## New file: src/web-search/xai-executor.ts (research: 003; wire probes 2026-08-21 all HTTP 200)
```ts
export interface XaiSearchOptions { xSearch?: boolean; allowedXHandles?: string[]; excludedXHandles?: string[]; fromDate?: string; toDate?: string; }
export function validateXaiSearchOptions(o): string | undefined  // 20-handle cap, allow XOR exclude, ISO date shape
export async function runXaiWebSearch(query, providerName, provider, settings, options, abortSignal?): Promise<SidecarOutcome>
```
- Token: getValidAccessToken(providerName) (stored xai OAuth). 401/403 → error outcome with entitlement-distinct message. Never throws.
- POST https://api.x.ai/v1/responses (canonical; provider.baseUrl consulted only if it matches the api.x.ai origin, else pinned) with redirect: "manual".
- Body: { model: settings.model (default "grok-4.6"), input: [{role:"user", content: query}], tools: [{type:"web_search"}, ...(options.xSearch ? [{type:"x_search", allowed_x_handles?/excluded_x_handles?/from_date?/to_date?}] : [])], include: ["web_search_call.action.sources"], reasoning: { effort: settings.reasoning }, stream: true }. All shapes probe-verified (reasoning+tools 200; both tools in one request 200; handles+dates 200) — no contingency paths.
- SSE reducer (003 rules): text ← response.output_text.delta on message items; sources ← url_citation annotations ∪ web_search_call action.sources, deduped by url; tolerate BOTH custom_tool_call and x_search_call items; action optional on output_item.added (skeleton-first); bound raw bytes like parse.ts; reasoning deltas ignored.

## Config
- OcxWebSearchSidecarConfig gains xSearch?: { enabled?: boolean; allowedXHandles?: string[]; excludedXHandles?: string[]; fromDate?: string; toDate?: string }.
- PUT /api/sidecar-settings validates (400 on >20 handles, allow+exclude both set, malformed date); executor re-validates (defense in depth). GET echoes xSearch (no secrets involved).

## Dispatch wiring (the audited path)
- SidecarPlan gains xaiSidecar?: { providerName: string; provider: OcxProviderConfig }.
- planWebSearch "xai" arm becomes REAL (flips 060's inert undefined): enabled provider named/oauthId "xai" + getAccountSet active !needsReauth → plan with xaiSidecar; else undefined (fail-closed).
- src/server/responses/core.ts (~:3583, where SidecarPlan unpacks into WebSearchLoopDeps): pass backend + xaiSidecar through.
- loop.ts: WebSearchLoopDeps gains xaiSidecar; dispatch switch gains "xai" arm → runXaiWebSearch with cfg.xSearch options.
- backends.ts registry: { backend:"xai", isActive: stored xai OAuth usable, eligibleModel: candidate.provider === "xai" }.

## Tests: tests/xai-web-search.test.ts + loop integration
- validateXaiSearchOptions: 21 handles error; allow+exclude error; bad date error.
- SSE fixtures from live capture shapes: text assembly, source dedupe (annotations ∪ action.sources), custom_tool_call tolerated, absent action tolerated.
- 401 fixture → error outcome, no throw. PUT xSearch validation 400s.
- Loop-level integration: backend "xai" dispatches the xai executor (mocked), not runWebSearch.

## Verify (per-layer full gate): bun x tsc --noEmit && bun run test && live probe via the actual executor (attest evidence).

