# 020 — WP3: base-instruction switch and the variant swipe selector

The user's ask, verbatim: "base 같은것도 끌수 있다면서 이런것도 스위치 달아야지
그리고 base 에서도 2-3번 옵션으로 변경할수 있도록하고 기본값은 변경안되도록 좌우
스와이프로".

Decomposed: (a) base gets a switch, (b) base can be swapped to option 2 or 3,
(c) the default option is never modifiable, (d) navigation between options is
left/right swipe.

## What makes this possible, and what makes it dangerous

`config.toml` has `model_instructions_file` (`config/src/config_toml.rs:236`,
`core/config.schema.json:775`). It REPLACES the base prompt outright — verified
upstream by `core/tests/suite/cli_stream.rs:295` and `:367`, which assert that the
CLI flag and the profile key both reach the outbound request.

So the mechanism for (b) exists. And the parent unit already refused to write this
key: `codex-set-prompt.tsx` states plainly that `model_instructions_file` "REPLACES
the entire base prompt, so wiring + to it would delete Codex's own instructions on
first save", and today the panel only REPORTS the key when something else set it.

That refusal was right for the `+` affordance and wrong as a permanent boundary.
Replacing the base prompt is exactly what the user is asking for here — but it must
be a deliberate, named, reversible act, not a side effect of adding a custom layer.
The design below is what makes it deliberate.

## Design

### The variant set

Three variants, exactly the "2-3번 옵션" asked for:

| # | Variant | Source | Editable | Deletable |
|---|---|---|---|---|
| 1 | `default` | Codex's own base prompt; NO `model_instructions_file` written | never | never |
| 2 | `authored` | a body the user writes, stored by us | yes | yes |
| 3 | `authored-2` | a second such body | yes | yes |

Variant 1 is not a copy of Codex's prompt. It is the ABSENCE of the key. That is the
whole trick, and it is what makes (c) structurally true rather than merely enforced:
there is no stored text for the default, so there is nothing to edit and nothing to
delete. Selecting variant 1 removes the key; selecting 2 or 3 writes it.

The alternative — shipping our own transcription of Codex's base prompt as variant 1
— was rejected. It would go stale on every upstream release, and a stale base prompt
is the single most damaging thing this panel could produce.

### Where the variant bodies live

`$CODEX_HOME/opencodex-prompt-base/<id>.md`, one file per authored variant, written
through the SAME durable path as the layer store (`durableWrite`, journal, lock).
`model_instructions_file` then points at the selected file with an absolute path.

Not inside `opencodex-prompt.json`: that file is a JSON store the layer composer
owns, and `model_instructions_file` needs a real file on disk that Codex reads
directly. Embedding the body in JSON would require us to materialize a temp file at
selection time, which is a second write path for no gain.

### The switch on base

`base` currently renders with no switch at all, deliberately
(`PromptLayerRow.tsx:88-96`: a disabled control claims a capability that does not
exist). After this change the capability DOES exist for `base`, so the rule is
honoured by giving it a real switch rather than by relaxing the rule.

What the switch means, stated in the UI and not left to inference:

- ON (default state) = Codex's own base prompt, key absent.
- OFF = the selected authored variant replaces it.

The user asked "base는 끄면 동작할만큼만 꺼지게 하던가" in an earlier turn. This is
that answer: base cannot be emptied, because a model with no base prompt is not a
working agent. It can only be SUBSTITUTED. The copy says so.

### The swipe selector

Lives in the base row's dialog, not in the row. Three affordances on one control,
because the ask names swipe but a settings page must also be operable without it:

- horizontal pointer/touch drag past a threshold moves one step
- ArrowLeft / ArrowRight when the control has focus
- explicit prev/next buttons, which are also what a screen reader announces

Reuses `CustomLayerDialog`'s existing `navigation` contract
(`{position, total, onPrev, onNext}`, already rendering "n / total") rather than
inventing a second navigator. That contract was built for stepping between custom
layers and its shape fits unchanged.

Variant 1 is reachable in the ring but its editor is read-only, with the reason
shown, not just disabled controls.

## Changes

### `src/codex/prompt-layers.ts`

- NEW `BaseVariant` type: `{ id: string; title: string; body: string }`, plus
  `BaseVariantSelection = "default" | string`.
- NEW `readBaseVariants(opts?)`: enumerate `opencodex-prompt-base/`, tolerate a
  missing directory as empty, and read `model_instructions_file` to determine the
  current selection. Reuses `readModelInstructionsFile` (line 447).
- NEW `writeBaseVariant(...)` and `selectBaseVariant(...)`: same lock, journal and
  byte-verify discipline as `writeCustomLayers`. Selecting `default` REMOVES the key
  with the existing scoped line edit; selecting a variant writes an absolute path.
- EXTEND `PromptLayerSnapshot` with `baseVariants: BaseVariant[]` and
  `baseSelection: BaseVariantSelection`.
- EXTEND the allowlist with `model_instructions_file` at root — the ONLY new writable
  key in this work-phase, and it is upstream-defined, so `--strict-config` is safe.

Ordering requirement, learned from WP1 finding H4: the variant FILE is written and
verified BEFORE `config.toml` is pointed at it. Pointing first would leave the key
aimed at a file that may not exist, which is a worse failure than a written file
nobody references yet.

### `src/server/management/codex-prompt-routes.ts`

- GET: include `baseVariants` and `baseSelection` in the snapshot response.
- PUT `/api/codex-prompt/base` — write or delete a variant body.
- PUT `/api/codex-prompt/base/select` — change the selection.
- Both refuse `default` as a write or delete target, server-side. The GUI also
  prevents it, but a route that trusts its client is not a boundary.
- Both carry the same revision precondition as the existing writers.

### `gui/src/components/codex-set/BaseVariantDialog.tsx` (NEW)

The swipe ring, the read-only default, the editor for authored variants. Pointer
handlers use `pointerdown`/`pointermove`/`pointerup` with a horizontal-intent
threshold so a vertical scroll is never captured as a swipe.

### `gui/src/pages/codex-set-prompt.tsx`

- Base row gains `onToggle`; `PromptLayerRow` renders a real switch for
  `class === "base"` alongside the existing `config-toggle` branch.
- Opening the base row opens `BaseVariantDialog` instead of the read-only
  `PromptLayerDialog`.

### Tests

- `tests/codex-prompt-base-variants.test.ts` (NEW): default selection removes the
  key; variant selection writes an absolute path; write-then-point ordering holds;
  a `default` write is refused; revision mismatch is refused.
- `gui/tests/codex-set-base-variant.test.tsx` (NEW): the ring wraps, ArrowLeft and
  ArrowRight step, the default variant's editor is read-only, and Save is absent
  for it.

## Acceptance criteria, with activation scenarios

| # | Criterion | Trigger | Observable proof |
|---|---|---|---|
| 1 | base row has a real switch | load panel | `role="switch"` inside the base row |
| 2 | default cannot be edited | open dialog on variant 1 | no Save control; read-only reason shown |
| 3 | default cannot be deleted | attempt the delete route with `default` | route refuses |
| 4 | selecting default removes the key | select variant 1 after a variant was active | `model_instructions_file` absent from config bytes |
| 5 | selecting a variant writes the path | select variant 2 | key present with the variant's absolute path |
| 6 | arrows step the ring | focus the control, ArrowRight | position advances, wraps at the end |
| 7 | swipe steps the ring | pointer drag past threshold | position advances |
| 8 | file precedes pointer | inject a config-write failure | the variant file exists and the key is unchanged |
| 9 | vertical scroll is not a swipe | pointer drag mostly vertical | position unchanged |

Rows 3, 4, 8 and 9 are the ones with genuine activation scenarios: each drives a
branch that the happy path never enters. Row 8 needs fault injection, which is why
it is written as a test and not as a manual check.

## Verifier commands

```
cd gui && bun x tsc -b --force
bun x tsc --noEmit
bun test tests/codex-prompt-base-variants.test.ts
bun test ./gui/tests/codex-set-base-variant.test.tsx
bun test ./gui/tests/codex-set-prompt-layers.test.tsx
bun run lint:gui
```

## Bypass record (PLAN-BYPASS-NAMED-01)

This work-phase DOES add enforcement: the default variant's immutability.

- Tier: E2 (route-level runtime check) plus E1 (no stored body to mutate).
- Executing surface: the two PUT handlers, and the absence of a file on disk.
- Known bypass: editing `config.toml` by hand, or writing a file into
  `opencodex-prompt-base/` named `default.md` directly. Neither goes through us.
- Residual risk: a hand-written `default.md` would appear as a fourth variant.
  Mitigation: the enumerator reserves the id `default` and skips such a file,
  reporting drift instead.
- Wording downgrade: none. The claim is "this panel cannot modify the default",
  not "the default cannot be modified" — a user with a text editor owns their
  config, and pretending otherwise would be the lie.
- Final enforcement layer: structural, for our own write path — there is no stored
  default body, so there is nothing for a write to target.
