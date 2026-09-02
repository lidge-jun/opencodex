# 017 — Implementation review (late-arriving, folded at wp3)

The Opus implementation reviewer dispatched at wp2 C returned after the retirement window
(reported in 016). Its verdict was **GO-WITH-FIXES (blockers=1)**; the findings were real and
are folded here rather than discarded.

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | `contextCap ?? contextWindow` over-reports `context_length`: `contextCap` is the raw operator knob and is set even when the cap did not bite (`provider-fetch.ts:747`; fixture `codex-catalog.test.ts:5739` shows 64k window / 350k cap) | High | folded — commit `379d95fd7` uses `m.contextWindow`; regression test added and shown red before the fix |
| 2 | native rows always claim vision via `nativeInputModalities` fallback; routed rows omit the key when unknown (matches `config-export.ts:1323`) | Medium | accepted as-is; already documented in 010 |
| 3 | `api_types` shared mutable array leaked into every row | Low | folded — frozen constant, copied per row |
| 4 | no test drove the `contextCap` vs `contextWindow` divergence | Medium | folded — new test with `providerContextCaps: { kimi: 350000 }` |

Confirmed clean by the reviewer: no other strict row-shape assertions in `tests/`, GUI
`classifyExternalModel` reads keys by name, `toMatchObject` rewrites preserve cardinality,
values and `is_combo` absence, static import placement is consistent, privacy scan passes.

Layer 2 (`codex/cursor-private-inference-guide`) was rebased onto the new layer-1 tip
(DEV-STACK-02); `git log codex/cursor-local-models-schema..codex/cursor-private-inference-guide`
shows only the docs commit.
