# 090 — What the stack gate caught, and why local green was not enough

Closing record for the publication phase. The five-layer stack went up green
on my machine and came back red from CI three rounds running. Every one of
those rounds found something real, and they were all the same shape.

## The defect class: a layer that only builds on top of its successors

`CustomLayerDialog` calls three i18n keys:

```
codexSet.custom.prevLayer
codexSet.custom.navPosition
codexSet.custom.nextLayer
```

The dialog landed in the **authoring** layer. The catalog entries landed one
layer higher, in **realtext**. Nothing locally noticed, because every local
check ran at the top of the chain where both halves exist.

CI checks out each PR's own head. At the authoring tip `bun x tsc` failed with
three TS2345s — the keys are not in `TKey` yet — and the thirteen downstream
jobs that depend on a build all followed it down. Thirteen red checks, one
cause, and the cause was invisible from the place I was testing.

The same shape produced three more failures:

| Symptom | Fix landed in | Was defined in |
|---|---|---|
| TS2345 x3 on the nav keys | authoring | realtext |
| `fr`/`zh-TW` locale gate on `navPosition` | realtext | authoring (after the move) |
| `react-compiler` EffectSetState, `only-export-components` | authoring | shell (files originate there) |
| `input[role="switch"]` queries matching nothing | scattered | the layer that made it a `<button>` |

Each fix belongs at the layer that **introduces the code it guards**, not at
the layer where the author happened to notice it.

## The check that would have caught all of it

```bash
for B in route shell authoring realtext docs; do
  git switch codex/prompt-layers-$B
  (cd gui && bun x tsc -b --force) && (cd gui && bun run lint)
  bun test ./tests/cli-headless-parity.test.ts
done
```

Running the suite once at the stack head proves the *merged* result works. It
says nothing about whether any intermediate commit does, and a stack is a
sequence of intermediate commits by construction. `DEV-STACK-03` already
states this — "builds and passes its own tests at its own tip" — and this unit
is what that rule reads like when it is ignored.

## Findings that were NOT ours

Worth recording so a future reader does not chase them:

- `origin/dev` itself fails 17 `react/react-compiler` findings and several
  `no-explicit-any`/`no-unused-vars` hits in `tests/`. react-doctor reports
  against changed files, so these matter only when the file is in the diff.
  The bar for this stack was **no new findings**, not a clean global report.
- One `enforce-target` failure on the docs PR was a cancelled job:
  `Canceling since a higher priority waiting request for pr-gate-comment-2682
  exists`. `enforce-pr-target.yml` and `pr-hygiene.yml` share the
  `pr-gate-comment-<n>` concurrency group, so a queued gate can be displaced
  by a later status re-check. The re-run passed on identical content.

## Two real user-facing bugs the round surfaced

Neither was on the plan; both came out of looking at the running UI.

**The dialog body could not be read.** `.api-code` sets `white-space: pre`,
and both it and `.codex-set-layer-dialog__text` are single-class selectors —
a specificity tie that source order decides. `styles.css` loads later, so
`pre` won, and a 307-byte permissions body rendered as two clipped lines
behind a horizontal scrollbar. Reading the layer text is the entire purpose of
that dialog. Chaining the selector (`.codex-set-layer-dialog__text.api-code`)
outranks it.

The guard asserts on the stylesheet, not a computed style: happy-dom applies
no cascade, so a computed-style assertion passes against the broken rule too.

**A failed probe was reported as measured truth.** The text probe response was
parsed without checking status, so a 500 carrying a `layers` key was adopted
verbatim — byte counts and prompt text the user would read as real. The narrow
case is the one that matters: an error with no `layers` already fell through
to the same "unavailable" branch, so the visible bug only appears when the
failing response happens to be layer-shaped. That is exactly the case the
regression test drives.

## Stack shape as landed

```
#2682 docs        → base #2681   docs-site guide + 7 locales
#2681 realtext    → base #2680   real prompt text, ordered stack
#2680 authoring   → base #2679   custom layers, presets, drift repair
#2679 shell       → base #2678   Codex Auth → Codex Set, taxonomy
#2678 route       → base dev     /api/codex-prompt
```

Merge bottom-up. After a parent lands, retarget its child to `dev` —
`pr-quality.cjs` only skips `wrong_base` while the parent PR is **open**, so a
child left pointing at a merged branch turns red the moment the parent closes.

