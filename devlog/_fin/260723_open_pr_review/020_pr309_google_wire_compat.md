# 020 — PR #309: fix(google): eliminate Antigravity request-shape 400s

- Author: HaydernCenterpoint · base `dev` · +833/−106, 9 files, CI green (incl. CodeRabbit).
- Scope: `src/adapters/google-*` only. No GUI, no workflows, no auth/token surface.

## What it does

1. **Allowlist schema sanitizer** (`google-tool-schema.ts` rewrite): switches from a
   blocklist (`DROPPED_SCHEMA_KEYS`) to Google's documented allowlist subset
   (type/nullable/required/format/description/properties/items/enum + anyOf collapse,
   local $ref inlining). Root forced to `{type:"object", properties:{}}`; try/catch containment.
2. **New `google-wire-compiler.ts`**: whole-body compile pass —
   - `toolNameCodec`: invalid tool names (`^[A-Za-z_][A-Za-z0-9_-]{0,63}$` violations, e.g.
     MCP `server.tool` dots) get deterministic sha256-suffixed wire names, with a
     `restoreToolName` inverse applied on `tool_call_start` events (stream + non-stream).
   - thinking-level clamping to Google's `minimal|low|medium|high` set.
   - `repairGoogleInvalidRequestBody(body, errorPayload)`: one-shot 400-replay repair keyed
     off error text (schema / thinkingConfig patterns).
3. **`google-http.ts`**: on a 400 (once per request), reads the display-safe error payload,
   attempts body repair, replays with `attempt--` (replay excluded from transient retry budget).

## Review findings

- Adapter instance per request (`resolveAdapter` is called per request in
  `server/responses.ts:1165`), so the closure-scoped `restoreGoogleToolName` mutable binding is
  safe — no cross-request leakage. Verified against dev source.
- The 400-replay loop is bounded (`compatibilityReplayUsed` flag), aborts respected, response
  body cancelled best-effort. Good hygiene.
- anyOf collapse widens un-collapsible unions to `{}` — lossy but fail-open in the safe
  direction (unconstrained beats provider-wide 400). Documented in comments.
- Risk: allowlist rewrite intentionally drops keywords the old path preserved
  (e.g. `minimum`/`maximum`, `additionalProperties`). Google ignores unknown keys it accepts, so
  behavior change is minimal for Gemini, but tool schemas become less constrained upstream.
  This is the documented trade for eliminating the 400 class.
- Vertex + Antigravity paths both compile; replay-cache signature application happens AFTER
  name compilation (comment explains signatures key on provider-visible names) — correct order.

## Verdict: **MERGE-READY**

Well-tested (4 test files touched/added), evidence-driven, right layering. Suggest merging after
#304 lands or rebasing check — no file overlap with #304 (kiro) or #307 (catalog), so order-free.
