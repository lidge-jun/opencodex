# U3, U4, U5 — three carried contributor pull requests

Verified against `f1dfda8e48` and against each PR head on 2026-09-17.

All three originals have `maintainer_can_modify: true`, so pushing into the
contributor forks is technically available. This lane does not use it. Writing
into someone else's repository is a side effect the host did not ask for, and
`AGENTS.md` already documents the alternative: carry the work onto a `codex/`
branch with a `Co-authored-by` trailer in a branch commit, where it survives
the squash. The originals stay open and unmodified.

## U3 — Alibaba Token Plan catalog refresh (PR #4788, @oliver-mee)

Head `fce03915e04e9128ce65c4523358252e4bb6f5fd`, draft, closes #4787. Touches
`src/providers/registry/model-seeds.ts`,
`src/providers/registry/entries-extended.ts`, and three test files.

This is a reuse, not a rewrite. The values in it are gateway probes with dates
and a stated method — accept at N, reject at N+1 for every
`modelMaxOutputTokens` row — and that evidence cannot be reconstructed from
here without making live calls. Rebuilding the catalog from scratch would throw
away the only part of the change that is expensive.

What the carry does: replay the branch onto current `dev`, keep every catalog
value as the author probed it, and add the trailer. The author's own report
names the one thing to re-check after the replay —
`tests/providers/provider-registry-parity.test.ts` pins the Beijing contract and
is updated in the same commit, so a replay that drops that file leaves the
suite red.

Two questions the original review raised stay open and stay out of scope: the
per-tier split where a Personal Edition subscription sees Team rows and gets a
403, and the display alias for the long plan slugs. Both are registry design,
not catalog data.

## U4 — model capacity on the `/v1/models` top level (PR #4802, @Yum-wu)

Head `14c478cda201c82b9a5d9f3dd6460c7fcdab4c03`, ready for review, 24 added and
3 removed lines in `src/server/models-capabilities.ts` plus 33 added lines in
`tests/providers/cursor/cursor-local-models-schema.test.ts`.

The change mirrors `context_window` and `max_output_tokens` onto the top level
of each model row, beside the nested `capabilities` object Cursor reads, so a
client that reads only the top level stops seeing a model with no declared
capacity. Keys are omitted rather than zeroed when the value does not pass
`positiveInt`, which is the part that matters: a `0` or `NaN` on the top level
would be worse than an absent key.

The gap is the long-tier row. When a model has both `contextWindow` and
`longContextWindow`, the mirrored value follows `effectiveContextLength`, so
the top level advertises the long window. The submitted tests cover the flat
input and the empty input and never pin that case, which leaves the actual
policy decision unrecorded. The carry adds the assertion for the behaviour as
implemented, so the choice is visible in the suite rather than implied by it,
and a line to the module header saying the top-level keys exist for external
clients.

Whether the long window or the base window is the right thing to advertise is a
product decision for the host. This unit records the current answer; it does not
change it.

## U5 — custom-model context window validation (PR #4863, @codingbooo)

Head `e2d2017ba5ab50dbee1b787d45081febac50d3f9`, draft, 21 commits behind
`dev` as of the review. Touches `gui/src/pages/Models.tsx` (+10/-4) and adds
`gui/tests/models-custom-context-invalid.test.tsx` (+295).

The defect is a silent success. Typing `350k` into the Custom Model dialog —
the same k-suffixed form the UI itself renders through `fmtK` — produces
`Number("350k") === NaN`, so the field is dropped on add or sent as `null` on
edit, and the dialog closes with a success toast. The provider-level context
dialog in the same file already handles this through
`parseContextWindowDraft`, which returns `null` for empty, a number for a
positive safe integer, and `undefined` for anything else. The fix routes the
custom dialog through the same parser and surfaces `models.contextInvalid` in
the existing `customError` notice.

### The ratchet blocks the diff as written

`gui/src/pages/Models.tsx` is recorded in
`tests/fixtures/file-size-baseline.json` at 2792 lines and measures 2792 now.
`scripts/file-size-ratchet.ts` returns `GREW` for any file above its recorded
cap, and `tests/ci-workflows/file-size-ratchet.test.ts` fails on it. A net `+6`
is a CI failure, not a warning.

The carry therefore lands the same behaviour without growing the file. The
validation is one early return and a reuse of an existing parser and an existing
error string; expressing it within the lines the current block already occupies
is a formatting constraint, not a design compromise. Raising the baseline is not
an option — the baseline only ever moves down, by
`Math.min(cap, lines)` in `updateBaseline`.

### The screenshot gate

`enforce-target` requires a screenshot in the description of any PR whose title
or description mentions `gui`, and the original PR is already held in draft by
exactly this. Producing one means building and running the GUI, which this lane
is forbidden to do. The unit therefore stops with the branch pushed and the PR
open, and the missing screenshot is reported to the host as a blocker the host
has to clear.
