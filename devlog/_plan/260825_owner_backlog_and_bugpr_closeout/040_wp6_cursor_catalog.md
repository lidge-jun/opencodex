# 040 — wp6: Cursor catalog refresh (#2569)

Measured 2026-08-25 against a live logged-in account: `GetUsableModels` returns 204
wire ids normalizing to 34 base models; `CURSOR_STATIC_MODELS` carries 50 entries.

Missing from the catalog: `gemini-3.7-flash` (low/medium/high) and
`gemini-3.6-flash` (minimal/low/medium/high). `minimal` is not currently in
`CANONICAL_EFFORT_SUFFIXES`, which is derived from `CURSOR_MODEL_EFFORT_TIERS`
values — listing it in the 3.6 ladder admits it.

Drifted ladders: `claude-opus-5`, `claude-4.6-sonnet`, `gpt-5.5`, and the three
`gpt-5.6-*` families (live exposes a `none` tier the map lacks).

Unmodelled axis: a `-thinking` family whose suffix ORDER varies —
`{base}-thinking-{effort}` for Opus 4.7/4.8/5, `{base}-{effort}-thinking` for
4.6/4.5-opus, bare `{base}-thinking` for 4-sonnet/4.5-sonnet.
`isCursorModelAvailableForAccount` matches none of these, so they are invisible.

Static-only entries (13) survive as the logged-out/discovery-failure fallback and
should be pruned or re-justified. `glm-5.3` is a documented preemptive seed and stays.

Decision for this phase: add the two Gemini models with their real ladders, admit
`minimal`, refresh the drifted ladders, prune the stale static entries, and expose the
`-thinking` families as first-class base ids the way the `-fast` families were handled
in `831810c13`. Vision classification must keep the new Gemini rows on the native path
(`CURSOR_NO_VISION_MODELS` currently lists composer/glm only).

