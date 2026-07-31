# 030 — WP3: google family (google, google-vertex, google-antigravity)

Pre-analysis: Averroes (sol explorer, 2026-07-10). Re-verify at WP3's P.

## Model delta (research 001)

defaultModel "gemini-3-pro" is stale for the GEMINI API surface: no stable
gemini-3-pro documented; gemini-3-pro-preview retired. Scope of change =
`google` (AI Studio) entry ONLY: default -> gemini-3.5-flash (stable, 1M ctx
Tier-2 proven, efforts minimal/low/medium/high default medium); add
gemini-3.1-pro-preview id + efforts low/medium/high, NO ctx entry (research 001
marks its context UNVERIFIED). `google-vertex` FROZEN entirely (default kept,
staleness note only — ai.google.dev does not prove Vertex availability).
Do NOT add 3.5-pro.
Antigravity catalog is backend-derived (separate); alias map mid->low,
high->gemini-3-flash-agent is surprising — verify, don't blind-change.

## Hardening targets

1. registry.ts (AMENDED A-round1): google (AI Studio) entry ONLY —
   defaultModel -> gemini-3.5-flash; add models/efforts metadata (3.5-flash 1M
   ctx; 3.1-pro-preview id+efforts, no ctx). google-vertex model data FROZEN:
   ai.google.dev evidence proves the Gemini API surface, not Vertex publisher
   availability (reviewer blocker 2). Vertex defaultModel gemini-3-pro kept
   with a staleness note pending Vertex-specific Tier-2 evidence.
2. google.ts:298 — AI Studio blank key sends unauthenticated request => throw.
3. AMENDED A-round1 (blocker 1 accepted): vertex key->env->ADC ladder is an
   INTENTIONAL, tested auth design (gcp-adc tests + comments; registry authKind
   cannot distinguish ADC-only users). NOOP with rationale — no throw. Only the
   error message on total-auth-absence path is already loud (existing throws for
   project/location).
4. google.ts:234 — antigravity silently substitutes default baseUrl => validate.
5. google.ts:348/401 — malformed antigravity envelope silently treated as flat
   Gemini => reject malformed envelope.
6. google.ts:398/432 — non-streaming raw.error not inspected; absent candidates
   emit done => inspect error, fail loudly.
7. OUT/defer: tool-schema permissive degradation (test-locked compat), SSE
   malformed-frame drop severity, text-only MAX_TOKENS success (visible behavior
   change — NEEDS_HUMAN if pursued).

## Tests
ADD: google (AI Studio) default-model registry assertion, missing-key rejection
(google/antigravity), malformed antigravity envelope rejection, non-streaming
error-object test. Vertex auth ladder: NO new tests needed — existing API-key +
ADC regression tests stay authoritative (item 3 NOOP). ~90 existing google tests
stay green.
