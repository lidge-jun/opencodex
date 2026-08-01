# 361 — Cursor catalog SOT alignment + parallel tool-call serialization

Goal: harden the Cursor provider so (1) the static model catalog faithfully mirrors the
jawcode SOT (`../jawcode/packages/ai/src/models.json`, `cursor` provider) and the real
Cursor lineup, and (2) the model can call many tools at once without the turn dying.

SOT = jawcode models.json (authoritative mirror of Cursor's GetUsableModels). Where the
public web specs disagreed (e.g. some sources list 272k for gpt-5.2/5.5), the locally
maintained SOT dated 2026-06-30 was treated as authoritative per the user's instruction.

## Phase B1 — catalog limits (commit 8177b73)

Symptom: `composer-2.5-fast` missing from Cursor; several models showed wrong context
windows because `inferCursorContextWindow` diverged from the SOT on almost every family.

Fix (`src/adapters/cursor/discovery.ts`):
- Added `composer-2.5-fast` (200k, text-only, non-reasoning) — a real Cursor wire id.
- Pinned an explicit `contextWindow` on every base model to the SOT value, so the catalog
  never relies on the heuristic fallback:
  auto/composer*=200000, gemini-3-pro/3-flash/3.1-pro=1048576, gemini-3.5-flash=200000,
  gpt-5.1-codex-max/-mini,gpt-5.2-codex,gpt-5.3-codex=272000, gpt-5.2=400000,
  gpt-5.4/5.4-mini/5.4-nano/5.5/5.5-extra=200000, grok-4.3/grok-build-0.1=200000,
  grok-code-fast-1=256000, kimi-k2.5=262144, claude*=200000.
- Effort-tier advertisement (`supportsReasoningEffort`) left unchanged — it tracks
  selectable effort tiers (CURSOR_MODEL_EFFORT_TIERS), not the SOT reasoning flag, so
  bare-suffix models (gemini/grok/kimi/gpt-5-mini) keep no tier picker.

Tests updated: cursor-discovery, cursor-static-catalog, codex-catalog,
provider-registry-parity (old pinned 128k/1M/400k values -> SOT values).

## Phase B2 — parallel tool calls (commit 9ff7e23)

Symptom (live): "Cursor requested multiple parallel Responses tool calls but
parallel_tool_calls is false" (and the overlap variant) when the model requested many
tools at once -> the Cursor turn died mid-stream, leaving the caller with no response.

Root cause: `tool_call_start` was emitted early (toolCallStarted/partialToolCall) while
the Responses bridge tracks a single current tool call. Two interleaved opens would
cross-wire their args, so the adapter failed closed.

Fix (`src/adapters/cursor/protobuf-events.ts`, `live-transport.ts`):
- `recordToolCall` opens per-callId state silently (no outward event).
- `commitToolCall` emits each completed call as one atomic start -> delta -> end unit.
- Removed the parallel_tool_calls=false and overlap rejections (atomic per-call emission
  cannot cross-wire; the bridge closes the previous call when a new start arrives).
- Preserved early `openToolCalls` tracking so `turnEnded` still fails closed on a
  truncated (never-completed) call, and kept the no-arg/prelude drop + unknown-tool reject.
- Dropped the obsolete `suppressStart` native-exec option (under deferred start it would
  drop deltas with no current bridge call).

gpt-5.5 subagents: Rawls audited the B2 design (PASS with the "keep early state" condition,
which was honored); Anscombe verified both commits.

## Verification
- `bunx tsc --noEmit` clean.
- Targeted cursor + catalog suites: 0 fail.
- Full `bun test`: 1662 pass, 71 fail / 13 errors — all pre-existing and unrelated
  (logger env, cli hook install, cursor-agent CLI pool, stream-json fixtures), confirmed
  identical on the clean baseline via git stash. Pass count rose 1660 -> 1662.

## Deferred / out of scope
- `inferCursorContextWindow` heuristic still diverges from SOT for unknown ids, but every
  advertised model now pins an explicit window so the heuristic only fires for genuinely
  unknown ids. Not reconciled here to keep the change scoped.
- maxTokens (output cap) is not plumbed through CatalogModel; context window is the lever
  the routed catalog uses. SOT maxTokens recorded above for reference only.
