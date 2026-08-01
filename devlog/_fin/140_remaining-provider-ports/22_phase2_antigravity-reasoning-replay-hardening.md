# 140.22 — Phase 2c: antigravity thoughtSignature reasoning-replay + stabilization close-out

> The Antigravity-specific hardening that has no Vertex analogue: **thoughtSignature reasoning
> replay**, plus the truncation/usage stabilization close-out. Copy-paste-ready. External SOT
> cross-check = `router-for-me/CLIProxyAPI` (`internal/runtime/executor/antigravity_reasoning_replay.go`,
> `internal/cache/antigravity_reasoning_replay_cache.go`, `internal/translator/antigravity/gemini/*`).
> See `05_reference-repos.md`.

---

## The quirk (why this phase exists)

Gemini-3 (and Claude-on-Antigravity) interleaved thinking is **stateless upstream**. Every model
content part in a CCA response carries a `thoughtSignature` (aliases: `thoughtSignature`,
`thought_signature`, `extra_content.google.thought_signature`). To continue a thinking/tool-call
chain across turns, the previous turn's signature **must be echoed back** on the matching model
content part in the next request. Miss it and upstream returns **HTTP 400** (invalid/missing
signature), breaking multi-turn agentic flows — the single biggest Antigravity footgun.

CLIProxyAPI handles this with a per-session **reasoning-replay cache**: it observes signatures on
the response stream, caches them keyed by `model + session`, and re-injects them into
`request.contents[ci].parts[pi].thoughtSignature` on the next request. It also reconstructs model
function-call parts before the matching `functionResponse`.

Important applicability split (cross-checked):
- **Gemini/Flash/Agent models → use the replay cache.**
- **Claude-on-Antigravity → does NOT use the cache.** It sanitizes signatures inline instead
  (drop empty/incompatible thinking blocks, strip non-model/non-thinking signature fields).

## Part 1 — Plain explanation

Antigravity needs us to "remember" a little cryptographic receipt the model attaches to each
thinking step, and hand it back on the next request. If we forget, the server rejects the whole
turn. This phase records those receipts per conversation and replays them, so multi-step tool/think
chains keep working instead of dying with a 400.

## Part 2 — Diff-level plan

### A) NEW `src/adapters/google-antigravity-replay.ts`

A small in-memory cache + observe/apply pair, mirroring CLIProxyAPI's accumulator. Keep it
self-contained and adapter-local (no server wiring needed beyond the google adapter).

```ts
interface ReplayItem {
  type: "thought_signature" | "function_call_part";
  contentIndex: number;
  partIndex: number;
  thoughtSignature?: string;
  // function_call_part only:
  name?: string;
  callId?: string;
  args?: unknown;
}

interface ReplayEntry { items: ReplayItem[]; expiresAtMs: number; }

const MIN_SIGNATURE_LEN = 16;          // CLIProxyAPI minAntigravityThoughtSignatureReplayLen
const REPLAY_TTL_MS = 60 * 60 * 1000;  // 1h
const REPLAY_MAX_ENTRIES = 10_240;     // evict batch 128 when exceeded

const replayCache = new Map<string, ReplayEntry>();

function replayKey(model: string, sessionId: string): string {
  return `${model}::session:${sessionId}`;
}

/** Observe one parsed CCA chunk's `response.candidates[0].content.parts`; record signatures + fn-calls. */
export function observeAntigravityReplay(model: string, sessionId: string, parts: unknown[]): void { /* … */ }

/** Re-inject cached signatures + function-call parts into the outgoing request.contents. */
export function applyAntigravityReplay(model: string, sessionId: string, contents: unknown[]): unknown[] { /* … */ }

/** Drop the entry when upstream rejects a signature (clear-on-invalid). */
export function clearAntigravityReplay(model: string, sessionId: string): void {
  replayCache.delete(replayKey(model, sessionId));
}

/** Gemini/Flash/Agent only — Claude uses inline sanitization, not the cache. */
export function antigravityUsesReplayCache(model: string): boolean {
  return !/claude/i.test(model);
}

export function __resetAntigravityReplayCache(): void { replayCache.clear(); }
```

Behavior to mirror precisely:
- Only record signatures with `length >= MIN_SIGNATURE_LEN`.
- Dedup function-call parts by `(name, callId, args)`; on apply, dedup re-injection by `callId`.
- TTL 1h; when `replayCache.size > REPLAY_MAX_ENTRIES`, evict the 128 oldest by `expiresAtMs`.
- Cache key = `model + ":session:" + sessionId` where `sessionId` is the stable id from Phase 21.

### B) Wire observe/apply into the google adapter (cloud-code-assist only)

- **buildRequest (CCA arm):** before serializing the envelope, if `antigravityUsesReplayCache(model)`
  call `applyAntigravityReplay(model, sessionId, request.contents)` to re-inject signatures.
- **parseStream (CCA unwrap path):** as each chunk's `response.candidates[0].content.parts` is read,
  call `observeAntigravityReplay(model, sessionId, parts)`. The adapter therefore needs the stable
  `sessionId` available in `parseStream` — pass it via a per-request closure (the adapter is created
  per provider; thread the sessionId through `runTurn`/a request-scoped field, or recompute it from
  the parsed request the same deterministic way).
- **clear-on-invalid:** when a 400 with a signature-related message is seen
  (`safeVertexHttpErrorMessage` classifies it as `invalid request`), call
  `clearAntigravityReplay(model, sessionId)` so the next attempt starts clean.

### C) Claude-on-Antigravity inline sanitization (no cache)

For `claude*` models routed through Antigravity, instead of the cache:
- Strip thinking blocks with empty/invalid signatures from outgoing `request.contents`
  (mirror `StripEmptySignatureThinkingBlocks` / `StripInvalidBypassSignatureThinkingBlocks`).
- Drop signature fields on non-model / non-thinking parts.

Keep this a small pure helper `sanitizeAntigravityClaudeSignatures(contents)` with focused tests.

### D) Stabilization close-out (reuse Phase 11/12 modules)

- **Truncation fail-closed:** reuse `google-truncation.ts` (Phase 12). Antigravity `finishReason`
  lives under the unwrapped `response.candidates[0].finishReason`; the same MAX_TOKENS /
  MALFORMED_FUNCTION_CALL check applies.
- **Estimated usage:** Antigravity DOES return `usageMetadata` (renamed from `cpaUsageMetadata`
  upstream; the parser already unwraps `response`). So usage is `reported`, NOT estimated — do not
  add `google-antigravity` to `isEstimatedUsageProvider`. Pin with a test.
- **Error classification + redaction:** reuse `google-errors.ts` (Phase 11) with an Antigravity
  label; map 429 `RESOURCE_EXHAUSTED` + `ErrorInfo.reason` (`QUOTA_EXHAUSTED` → quota exhausted,
  `RATE_LIMIT_EXCEEDED` → rate limit) onto the existing split.

## Tests

- `tests/google-antigravity-replay.test.ts`: observe two chunks with signatures → cached; apply
  re-injects into matching `contents[ci].parts[pi].thoughtSignature`; signatures shorter than
  `MIN_SIGNATURE_LEN` are ignored; function-call parts dedup by callId; TTL expiry drops entries;
  `antigravityUsesReplayCache("claude-…")` is false; clear-on-invalid empties the entry.
- `tests/google-antigravity-claude-signatures.test.ts`: empty-signature thinking blocks stripped;
  signature fields removed from non-model parts.
- truncation: a CCA stream ending `response.candidates[0].finishReason:MAX_TOKENS` mid tool call →
  terminal error. usage: a `usageMetadata`-bearing CCA stream → `reported`.

## Verify

`bun x tsc --noEmit` clean + `bun test ./tests/` green. Minimal proof: observe→apply round-trip
re-injects a signature; a Claude request with an empty-signature thinking block is sanitized.

## Depends-on / enables

- Depends-on: Phase 21 (CCA wire + sessionId), Phase 11/12 (errors/truncation/usage modules).
- Enables: Phase 2 (google-antigravity) reaches the Cursor/Kiro hardening bar — closes the 140 track
  for the two Gemini-family ports.

---

## ✅ Implemented (commit `23806df`)

- NEW `src/adapters/google-antigravity-replay.ts` — `observeAntigravityReplay` / `applyAntigravityReplay`
  / `clearAntigravityReplay` / `antigravityUsesReplayCache` (Gemini-only, 1h TTL, 10240-entry bound,
  ≥16-char signatures, `extra_content.google.thought_signature` alias).
- `src/adapters/google-antigravity-wire.ts` — `sanitizeAntigravityClaudeSignatures` (Claude inline path).
- `src/adapters/google.ts` — per-request closure (model/session); buildRequest applies replay (Gemini)
  or Claude sanitize; parseStream observes signatures from the unwrapped model parts.
- Tests: `tests/google-antigravity-replay.test.ts` (9). Suite 1043/0, tsc clean.
- Final verification (glm-5.2 subagent): all 7 integration items PASS, no bug/concurrency/security risk.
