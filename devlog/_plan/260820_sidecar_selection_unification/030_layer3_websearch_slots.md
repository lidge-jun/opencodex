# 030 — Layer 3: web-search candidate set + backend registry (wp4)

Branch: codex/sidecar-websearch-slots (base: codex/sidecar-picker-candidates).

## New file: src/web-search/backends.ts (probe/executor registry)
```ts
export interface WebSearchBackendDescriptor {
  backend: "openai" | "anthropic";
  hasExecutor: true;
  probe: "chatgpt-forward" | "anthropic-oauth"; // auth presence == probe for these two
  eligibleModel(candidate: SidecarCandidate): boolean;
}
export const WEB_SEARCH_BACKENDS: WebSearchBackendDescriptor[]  // openai + anthropic only (001/002: no other executor)
export function webSearchSidecarCandidates(config, auth, all: SidecarCandidate[]): SidecarCandidate[]
// = (picker-visible ∪ auth slots) ∩ (backend active: auth flag true + executor exists + model family matches)
// openai backend: native rows + Luna slot; anthropic backend: anthropicProviderName rows + Haiku slot.
```
Future backends (Gemini/Grok/Zen/Exa): descriptor probe contracts recorded in 002/031; NOT registered.

## Config/docs alignment (NO default-behavior change — B4)
- src/types/config.ts:787-796: fix the lying comment to match code ("unset resolves to openai").
- resolveSidecarBackend keeps EXACT contract: unset → openai, explicit-only anthropic (web-search-anthropic.test.ts:58 assertion UNTOUCHED).
- resolveVisionBackend UNTOUCHED (unset → anthropic-if-credential). L3 does NOT edit src/vision/index.ts.
- planWebSearch consumes resolveSidecarAuth for credential presence (replacing its inline findAnthropicSidecarProvider call) — presence only, not preference. resolveDefaultSidecarBackend is WITHDRAWN; dual-auth preference unification deferred to a follow-up issue.
- DEFAULT_SIDECAR_MODEL stays gpt-5.6-luna; DEFAULT_ANTHROPIC_SIDECAR_MODEL stays claude-sonnet-5; auth SLOTS stay Luna/Haiku (issue text).

## Tests: tests/web-search-candidates.test.ts
- No Codex login (provider present, no token) → openai side inactive → native rows + Luna absent; Haiku present when anthropic auth.
- Hidden Luna + Codex login → present. Model outside both backend families → absent.
- resolveSidecarBackend(undefined) === "openai" still green (existing test untouched).

## Verify: bun x tsc --noEmit && bun test tests/web-search-candidates.test.ts tests/web-search.test.ts tests/web-search-anthropic.test.ts

