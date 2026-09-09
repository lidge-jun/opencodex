# 021 — A-phase audit: blockers folded into 010 and 020

The dispatched plan auditor (Arendt) produced nothing across four bounded waits, so it
was retired per DISPATCH-RETIRE-01 and the audit was performed directly against the
code. Same failure shape as the three reviewers in the parent unit's stack phase.

## Verified as written

- `gui/tsconfig.json` really is `{"files": [], "references": [...]}`, so
  `bun x tsc -b --force` is the correct gui typecheck and `--noEmit` there checks
  nothing. 030's verifier list stands.
- `121_openai-codex/codex-rs/ext/` genuinely has no `git-attribution` directory;
  `120_codex-cli/codex-rs/ext/git-attribution` exists. 000's framing holds.
- `core/config.schema.json` in 120_codex-cli contains NO `attribution` key. The
  `runtime-conditional` classification in 010 is correct — there is nothing to write.
- No test asserts an inventory count of 15. The one `toHaveLength(15)` in the repo is
  `gui/tests/integrations-overview-rows.test.ts:226`, about integration rows, not
  layers. `tests/codex-prompt-route.test.ts:117` asserts against
  `LAYER_INVENTORY.length`, which moves with the addition.
- Only `prompt-layer-copy.ts` keys a `Record` by `LayerId`. No other exhaustive map
  or switch consumes it, so 010's four edits are the complete chain.

## Blocker 1 (HIGH) — 010 breaks two table-driven guards

`tests/codex-prompt-route.test.ts:174-188` iterates EVERY non-config-toggle descriptor
and asserts the toggle route returns 409 `layer_not_toggleable` with a matching
`layerClass`. `tests/codex-prompt-route.test.ts:190-201` asserts every descriptor has
exactly one class and that `base`/`runtime-conditional` rows carry `key: null`.

These are not broken by the addition — they EXTEND to it automatically, which is
better than the plan claimed. 010 said it would add a new assertion that the id is
absent from `TOGGLE_IDS`; that assertion is redundant with test 5, which already
drives the actual route.

Amendment to 010: drop the proposed new `TOGGLE_IDS` assertion and instead assert the
descriptor SHAPE only. Record in the test comment that test 5 already covers
refusal, so a future reader does not re-add a duplicate guard. Acceptance row 5 is
satisfied by an existing test rather than a new one — state that explicitly rather
than writing a second test that proves the same thing.

## Blocker 2 (HIGH) — 020's central claim is FALSE as the panel stands today

The claim: variant 1 is the absence of `model_instructions_file`, so "default" is
structurally immutable and honest.

The hole: a user who set `model_instructions_file` BY HAND before ever opening the
panel has no variant of ours selected, and 020's `readBaseVariants` would report
selection `default` because the key points at a file that is not in our directory.
The UI would then show "Codex's own base prompt" while the base prompt is in fact
replaced. That is precisely the lie the parent unit avoided.

What already exists and must not be discarded: `codex-set-prompt.tsx:591-595`
renders `codexSet.custom.baseReplaced` — "model_instructions_file is set to {path},
so something outside opencodex has replaced the base prompt" — translated in all ten
locales. That notice is the honest state today.

Amendment to 020: the selection is THREE-valued, not two.

- `default` — key absent.
- a variant id — key present AND resolving inside `opencodex-prompt-base/`.
- `external` — key present and pointing anywhere else.

In the `external` state the swipe ring is DISABLED and the existing `baseReplaced`
notice is shown, with an explicit adopt-or-leave choice mirroring the custom-layer
adopt flow at `codex-set-prompt.tsx:553-585`. We never silently retarget a key
someone else set. New acceptance row: with a hand-set foreign path, selection reads
`external`, the ring is disabled, and the notice is present.

## Blocker 3 (MEDIUM) — the base switch contradicts an existing test

`tests/codex-prompt-layers.test.ts:50-55` asserts `base-instructions` is class `base`
and `isToggleId("base-instructions") === false`. 020 adds a switch to that row.

The test is RIGHT and stays. `isToggleId` governs the `config.toml` boolean allowlist,
and base is still not a boolean toggle — it is a variant selection. The switch calls
the new base-select route, not `/api/codex-prompt/toggle`.

Amendment to 020: state that the base switch does NOT route through `onToggle` and
must not add `base-instructions` to `TOGGLE_KEYS`. `PromptLayerRow` gets a separate
`onSelectBase` prop rather than reusing `onToggle`, so the two write paths cannot be
confused at the call site. Add an acceptance row: the toggle route still returns 409
`layer_not_toggleable` for `base-instructions` after this work-phase.

## Blocker 4 (MEDIUM) — six GUI test fixtures need the new snapshot fields

`modelInstructionsFile` appears in six fixtures
(`codex-set-prompt-layers`, `codex-set-custom-layers`, `codex-set-presets`,
`codex-set-shell`, `codex-set-stack`, plus the route tests). Adding required
`baseVariants` and `baseSelection` to `PromptSnapshotDto` breaks all of them at
compile time.

Amendment to 020: the file-change map must name all six fixtures. This is the exact
shape of the stack failure recorded in the parent unit's `091` — a type added at one
layer and its fixtures updated at another — so the fixture edits ship in the SAME
commit as the type change.

## Residual, accepted

010's acceptance row 6 (probe reports `not-exposed`) cannot be driven to a positive
`ok` state, because a diff-rendered section emits nothing on an unchanged turn. It is
verifiable only in the negative: the probe must never fabricate a body. Recorded as a
negative-only row rather than deleted.

## Verdict

GO-WITH-FIXES, blockers=4, all four folded into 010/020 above. Fix order in 001's
Disposition is dependency-correct: H1 is availability and blocks nothing else, H5 is
an auth boundary on the same routes H3/H4 fix, and H6 can eat a branch the stack
itself needs.
