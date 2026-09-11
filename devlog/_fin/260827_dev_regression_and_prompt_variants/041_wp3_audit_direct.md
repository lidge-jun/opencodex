# 041 — A-phase audit of the WP3 implementation, performed directly

The dispatched auditor (Mill) produced nothing across three bounded waits totalling ~11
minutes and was retired per DISPATCH-RETIRE-01. That is the same failure shape as Arendt
in 021 and the three stack reviewers in the parent unit, so the audit was performed
against the code instead. Every claim below cites the line that proves it.

## The seven checks

**1 — `default` is refused server-side, and reserved by the enumerator.** PASS, and by a
better mechanism than the plan described. `codex-prompt-routes.ts:392` rejects
`id === "default"` explicitly, but the load-bearing guard is
`prompt-layers.ts:516`: `BASE_VARIANT_ID = /^[a-z0-9]{6}$/`. "default" is seven
characters, so it cannot be a variant id at all — `readBaseVariants` skips a
hand-written `default.md` at `:539` by the same test that a write is validated by at
`:1030`. One rule, two directions. `tests/codex-prompt-base-variants.test.ts:97` drives it.

**2 — Write ordering is direction-dependent, as amended.** PASS.
`prompt-layers.ts:1052-1063`: on create/edit `durableWrite` runs before `commit()`
touches `config.toml`. On delete, `clearingKey` is computed at `:1047` *while the file
still exists* and the key is cleared inside the same `commit()`. The comment at
`:1044-1046` records why the first draft was wrong: deleting first made
`resolveBaseSelection` fall through to `external`, and the config half then refused to
touch a key pointing at a file already gone.

**3 — `resolveBaseSelection` is three-valued, and prefix-safe.** PASS.
`prompt-layers.ts:565-585`. Comparison is `resolved === resolve(join(dir, id + ".md"))`
— full-path equality against each *known* variant, not a `startsWith` on the directory.
So a sibling path that merely shares a string prefix cannot be misread as a variant, and
anything unrecognised falls to `external` at `:584`. A `resolve()` that throws also
lands on `external` (`:577`) rather than defaulting to the optimistic answer.

**4 — The base switch stays off the boolean allowlist.** PASS, structurally.
`git show HEAD -- src/codex/prompt-layers.ts | rg "^\+.*TOGGLE_KEYS"` is EMPTY: the
commit does not touch `TOGGLE_KEYS` (`:129`) or `isToggleId` (`:139`). `PromptLayerRow`
takes a separate `onSelectBase` prop, so the two write paths cannot be confused at the
call site, and `/api/codex-prompt/toggle` still refuses `base-instructions` with 409
`layer_not_toggleable` via the class check at `codex-prompt-routes.ts:343`.

**5 — The render-phase setState in `BaseVariantDialog`.** PASS, with the reasoning
written out because it looks wrong at a glance. The block compares
`(slot.variant?.id ?? null) !== editingId` and sets three states. It is React's
documented derived-state pattern: the comparison is against the value the same block
just wrote, so the second render pass fails the condition and stops. It cannot loop.
It *does* discard unsaved edits when the user steps to another slot — which is the
correct behaviour for a ring selector, since the alternative is carrying one variant's
draft into another's editor.

**6 — Every snapshot fixture supplies the new fields.** PASS. All six GUI fixtures that
construct the snapshot (`codex-set-{prompt-layers,custom-layers,presets,shell,stack,base-variants}`)
carry `baseSelection`. The seventh hit, `tests/codex-prompt-layers-read.test.ts:224`,
only *reads* `snap.modelInstructionsFile` off a real `readPromptLayers` result and never
constructs the DTO, so it needs no edit. Blocker 4 of 021 is discharged.

**7 — Auth on the new routes.** PASS, and it is not in this file. `codex-prompt-routes.ts`
carries no guard of its own because `management-api.ts:231` dispatches to it *after*
`principal` is resolved, so the new routes inherit exactly what the existing writers
have. Proved live: `curl` without a token returned `401 {"error":"opencodex admin token
required"}`, and the same request with the token returned 200.

## Live evidence captured this phase

The running dashboard at `localhost:10100` was inspected over CDP, since the plain
`--dump-dom` path returns an empty document for this SPA:

- `GET /api/codex-prompt` returns the three new fields:
  `baseSelection={"kind":"default"}`, `maxBaseVariants=2`, `baseVariants=[]`. This is the
  probe the handoff left unverified.
- The base row renders a real switch:
  `<button role="switch" class="toggle on" aria-checked="true" aria-label="Base instructions">`
  inside `[data-layer-id=base-instructions]`. Acceptance row 5 of 040.
- Clicking the row opens `dialog.codex-set-base-dialog` showing `1 / 2`, the read-only
  default with its stated reason, and `In use`.
- The next arrow steps `1 / 2 kind=default` → `2 / 2 kind=new`, and the authored slot
  shows the replacement warning. Acceptance row 6.

## Verdict

PASS. No blockers, no amendments. The four blockers 021 raised against the plan are all
discharged in the implementation. Remaining risk is entirely in the untested-here layer:
the assertions exist (14 server tests, 8 GUI tests) but have not been EXECUTED, because
local test runs are forbidden. That execution is B/C's work on `lidge-ai`, and it is the
only thing standing between this and a landable PR.

