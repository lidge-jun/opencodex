# 080 — Layer 8: Gemini CCA executor (wp4) [rev 2, consolidated]

Branch: codex/sidecar-gemini-executor (base: codex/sidecar-xai-executor).

## New file: src/web-search/gemini-executor.ts (probe: 002 LIVE PROBE)
```ts
export async function runGeminiWebSearch(query, providerName, provider, settings, abortSignal?): Promise<SidecarOutcome>
```
- Credential: getValidAccessTokenSnapshot(providerName) + projectId from the active stored credential. Missing projectId → error outcome naming re-login. Never throws.
- Destination PINNED to the registry canonical CCA endpoint exactly as src/server/images.ts:211 does — provider.baseUrl is NOT trusted for the OAuth-bearing request (mutable-URL credential leak). redirect: "manual".
- POST {pinned}/v1internal:generateContent (non-stream; grounded answers are short) with envelope: { model: wireModelId, userAgent: "antigravity", requestType: "agent", project, requestId: "agent-"+uuid, request: { contents: [user query], tools: [{google_search:{}}], sessionId: uuid, generationConfig?: { thinkingConfig: { thinkingLevel } } } }.
- Reasoning: settings.reasoning maps through resolveAntigravityEffortWireModel(settings.model default "gemini-3.7-flash", effort, pinnedBase) → { wireModelId, thinkingLevel }; thinkingLevel set when returned, NOT discarded.
- Headers: User-Agent: ANTIGRAVITY_REQUEST_UA (002: plain UA gets 404), Authorization Bearer.
- Mapping: candidates[0].content.parts[].text joined → text; groundingMetadata.groundingChunks[].web {uri,title} → sources; absent metadata → sources [].
- Imports: ONLY google-antigravity-wire (UA) + providers/antigravity-models (wire model) — auditor-verified lean, no google.ts drag, no cycle.

## Dispatch wiring (mirrors 070)
- SidecarPlan.geminiSidecar; planWebSearch "gemini" arm real (google-antigravity provider enabled + OAuth + projectId → plan; else undefined); core.ts handoff; loop.ts arm; registry { backend:"gemini", isActive: OAuth usable + projectId present, eligibleModel: candidate.provider === "google-antigravity" }.

## Tests: tests/gemini-web-search.test.ts + loop integration
- Fixture (002 capture) → text + sources; absent groundingMetadata → []; missing projectId → error; envelope assertion incl. thinkingConfig when effort maps; destination-pinning assertion (baseUrl override ignored).

## Verify (per-layer full gate): bun x tsc --noEmit && bun run test && live probe via executor.

