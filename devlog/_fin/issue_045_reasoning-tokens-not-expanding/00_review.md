# Issue #45 — Reasoning tokens not expanding in Codex UI

- **Reporter:** Rezhnn (Muhammad Annas Ibrahim)
- **URL:** https://github.com/<repo>/issues/45
- **Type:** Bug (response formatting)
- **Severity:** Medium — feature appears broken for routed models; no data loss.
- **Status:** FIXED (2026-06-29) — Approach A applied in src/bridge.ts. See 30_implementation.md.

## Report summary

Using any proxy/routed model (DeepSeek v4 flash free, Mimo v2.5 free), the Codex
app shows "Worked for Xs" but the reasoning section is empty when clicked — no
expandable thinking trace. Native OpenAI models (gpt-5.5) show a full expandable
reasoning trace. README advertises reasoning-token support, so the user expects
parity.

## Root-cause analysis

Codex renders the **expandable** reasoning trace from a Responses-API `reasoning`
output item's **`summary`** array (`summary_text` parts). The wall-clock
"Worked for Xs" label is driven separately (elapsed time / `reasoning_tokens`
usage), so it can appear even when there is no expandable summary content.

opencodex emits two different reasoning shapes depending on the upstream signal:

1. `thinking_delta` (e.g. Anthropic-style thinking) →
   `src/bridge.ts` `closeCurrentReasoning()` emits
   `response.reasoning_summary_text.delta/.done` +
   `response.reasoning_summary_part.added/.done` and a final item:
   ```
   { type: "reasoning", summary: [{ type: "summary_text", text }] }
   ```
   → **expandable** in Codex. (bridge.ts ~L177-195, `thinking_delta` case ~L256)

2. `reasoning_raw_delta` (from openai-chat `delta.reasoning_content`) →
   `src/bridge.ts` `closeCurrentRawReasoning()` emits
   `response.reasoning_text.delta` and a final item:
   ```
   { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text }] }
   ```
   → **summary is empty** → Codex shows the timer but has nothing to expand.
   (bridge.ts `closeCurrentRawReasoning` ~L197-206, `reasoning_raw_delta` case ~L278-296)

The openai-chat adapter maps an upstream `reasoning_content` field to
`reasoning_raw_delta`:
- streaming: `src/adapters/openai-chat.ts` ~L276 (`delta.reasoning_content` →
  `{ type: "reasoning_raw_delta" }`)
- non-stream: `src/adapters/openai-chat.ts` ~L330 (`msg.reasoning_content` → same)

So for chat-completions providers that DO return `reasoning_content`, opencodex
delivers it as raw reasoning **content** with an empty **summary**, which Codex
does not render as an expandable trace. This matches the report exactly.

### Two distinct sub-cases (both look identical to the user)

- **(A) Provider returns `reasoning_content`** (DeepSeek-R-style): opencodex emits
  a reasoning item with empty `summary` → timer shows, expand is empty. This is
  the **opencodex-side formatting gap** and is fixable.
- **(B) Provider returns no reasoning at all** (many free models, incl. likely
  "DeepSeek v4 flash free" / "Mimo v2.5 free"): there is no reasoning to show;
  "Worked for Xs" is just elapsed time. This is a **model limitation**, not an
  opencodex bug. The user's option 2 hypothesis is correct for these.

To confirm which sub-case applies, capture a raw upstream chunk for the affected
models (check whether `choices[].delta.reasoning_content` is ever present).

## Proposed solution (not applied)

Primary fix (covers sub-case A): make `reasoning_raw_delta` also populate the
reasoning item's `summary` so Codex can expand it. Two viable approaches in
`src/bridge.ts`:

- **Approach 1 (mirror to summary):** in the `reasoning_raw_delta` case, also
  emit `response.reasoning_summary_text.delta` and, in `closeCurrentRawReasoning`,
  set `summary: [{ type: "summary_text", text }]` alongside the existing
  `content`. Lowest-risk, makes routed reasoning expandable like native models.
- **Approach 2 (route reasoning_content through the summary path):** treat
  `reasoning_content` like `thinking_delta` for providers without a separate
  summary stream (gate by a provider flag, e.g. reuse/extend
  `preserveReasoningContentModels` or add `reasoningContentAsSummaryModels`).

Recommended: Approach 1 (unconditional) — non-OpenAI chat providers do not send a
separate condensed summary, so their full `reasoning_content` IS the human-visible
thinking and belongs in `summary`.

For sub-case B: document in README that the expandable trace requires the upstream
model to emit reasoning; free models that don't will only show the timer.

## Verification approach

- Unit test in `tests/`: feed an openai-chat stream containing
  `delta.reasoning_content`, assert the bridge emits at least one
  `response.reasoning_summary_text.delta` and a final `reasoning` item with a
  non-empty `summary[]`.
- Manual: run a reasoning-capable chat provider (e.g. a DeepSeek-R variant) and
  confirm the Codex app expands the trace.

## Effort & risk

- Effort: small (1 bridge case + 1 close helper + 1 test).
- Risk: low. Touches only reasoning-item shaping; does not affect text/tool flow.
- Reply to reporter: confirm sub-case A is an opencodex formatting gap (fix
  planned); sub-case B is a model limitation. Ask for a raw chunk sample to
  confirm which models emit `reasoning_content`.
