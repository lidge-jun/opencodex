# 010 — PR #316: fix(anthropic): preserve terminal SSE frames

- **Status: ALREADY MERGED** during this review pass (af973e54 on `origin/dev`).
- Author: Ingwannu · base `dev` · CI all green at merge time.

## What it did

- New `src/lib/sse-decoder.ts`: spec-shaped SSE decoder that dispatches the final record at EOF
  even when upstream omits the trailing blank line/newline (Kimi-style Anthropic-compatible APIs).
- `anthropic.ts` parseStream rewritten onto the shared decoder; adds `reasoning_delta` /
  `reasoning` block support mapped to `thinking_delta`.
- Tests: chunk-boundary torture test + bridge/Claude-translation end-to-end assertions.

## Assessment (post-merge audit)

Content quality is high: decoder handles CR, comment lines, multi-line data, and cancels the
reader on early exit. The `reasoning_delta` widening is scoped to Anthropic-compatible providers
and cannot fire for real Anthropic (which never emits that delta type). No action needed.
