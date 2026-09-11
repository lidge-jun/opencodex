# 060 — Layer 6: backend union widening, INERT (wp2) [rev 2, post-audit]

Branch: codex/sidecar-backend-union (base: codex/sidecar-cli).

## Principle (audit F1): union ≠ activation. This layer is INERT for new ids.
- src/types/config.ts backend union: "openai" | "anthropic" | "xai" | "gemini" | "exa". Comment: unset ALWAYS openai; new ids explicit-only AND inactive until their executor layer lands.
- src/web-search/index.ts:
  - export type WebSearchBackendId = union above.
  - resolveSidecarBackend stays PURE: known id → itself, else/undefined → "openai".
  - planWebSearch: for "xai"|"gemini"|"exa" return undefined UNCONDITIONALLY in this layer (fail-closed inert — no plan means the normal routed path, identical to today's unknown-backend behavior). Each executor layer replaces its arm with the real credential-gated plan. This keeps L6 standalone-CI-green with zero dispatch risk (audit F1).
  - shouldResolveOpenAiWebSearchSidecar: verify unchanged semantics (backend !== openai → false) for new ids — add test.
- config-routes.ts + agent-settings-routes.ts backend validation strings widened (webSearch only; claude-code override webSearchSidecar.backend union widened in the SAME commit — audit F3 partial: binary types in claude-code section body).
- gui claude-code-types.ts / dashboard-shared.ts SidecarBackend type: NOT widened here (GUI backend selector redesign is explicitly deferred to a follow-up issue — new backends are config/CLI-explicit only; document in docs-site later layer). Audit F3 resolution: GUI cannot select new backends in this program; the write gate + options stay model-centric for openai/anthropic; for xai/gemini the model field is honored, for exa ignored. File a follow-up issue for the GUI backend selector at program end.
- exaApiKey config field: added here as OcxWebSearchSidecarConfig.exaApiKey?: string with: PUT accepts string (empty clears), GET NEVER echoes it (assert), redact.ts gains "exaApiKey" in its key list (audit F4) + structured redaction test.
- structure/04_transports-and-sidecars.md + 05_gui-and-management-api.md: update the two-backend claims (audit F7).

## Tests: tests/web-search-backend-union.test.ts
- resolveSidecarBackend(undefined)==="openai" pin; ("xai")==="xai".
- planWebSearch xai/gemini/exa → undefined (inert pin, will be flipped per layer).
- shouldResolveOpenAiWebSearchSidecar false for new ids.
- PUT backend "xai" ok / "zen" 400; exaApiKey set/clear; GET omits exaApiKey; redactSecrets strips exaApiKey.

## Verify (audit F7): bun x tsc --noEmit && bun run test (FULL) per layer from now on.

