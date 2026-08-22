# 020 — Layer 2: absorb PR #2131, backfill missing Responses output ids

Work-phase: wp3. Branch: `codex/absorb-responses-id-backfill`. Base: `codex/fix-bearer-admission-2132` (layer 1).
Absorbs: **PR #2131 by @bet4it**. Closes: PR #2131 as superseded, with attribution.

## Dependency edge (the only real one in this backlog)

#2131 adds `src/server/responses/responses-field-backfill.ts` and calls it from
`src/server/responses/core.ts` — the same file layer 1 edits. This is why it stacks rather
than sitting beside layer 1.

## Defect

Strict decoders (grok-build) reject Responses output items that omit `id` on
`message` / `reasoning` / `function_call`. #1941 landed earlier but some relays still omit it.

## Change to carry over

@bet4it's implementation, preserved in substance: synthesize stable `msg_ocx_N` / `rs_ocx_N` /
`fc_ocx_N` ids keyed on `output_index`, never overwriting an id that is already present.

## Correction to apply on top (audit finding, lane: quality)

An invalid or missing `output_index` collapses to `0`, so two unindexed items can both become
`msg_ocx_0` — duplicate ids, which is the exact class of bug this fixes. Replace the
collapse-to-zero fallback with a monotonic per-response counter so synthesized ids are unique
even when `output_index` is absent or malformed. Add the regression test that pins it.

Docs: the locale files in #2131 are uneven (EN/FR rewritten, JA/KO/ZH/TR only first sentence).
Carry only the EN change in this layer; locale parity is not this layer's thesis.

## Test plan (must fail RED first)

Carry @bet4it's tests (SSE `response.completed`, `output_item.done` via `output_index`, JSON
passthrough, preserve-existing-id, inherited `toString` type) and ADD:
- two items with missing `output_index` receive DISTINCT ids (fails on #2131 as written).

## Verification

Same gate as layer 1, plus explicit confirmation that layer 2's branch contains layer 1's
commit (`git log --oneline <layer1>..<layer2>` shows only layer-2 commits) and that the PR
base ref names layer 1's branch.

