# 030 — Uniform control row: hover as emphasis, not as hiding

Extends the `260830_models_provider_header` unit. `010` shipped (toggle flex
basis + child shrink). `020` is written and NOT implemented. This doc is the
third reported defect on the same header, and it arrives with a user mandate
that the plan auditor initially rejected.

## The report

> 각 버튼이 뭘 의미하는지 설명좀해봐 이거 너무 많아서 그리고 일관성도 없음
> 규칙찾아서 좀 줄이고 깔끔하게 하고 싶은데 방법없나?
> 이렇게 많은곳도 있고 스위치만 달랑있는것도 있어서 호버도 만들고 싶음

Two claims, and the measurement below shows both are literally true: the row
carries 7-8 controls, and the count is not the same from card to card.

## Measured baseline

Harness: full CDP (`Emulation.setDeviceMetricsOverride`, dpr 2) against the live
proxy on 127.0.0.1:10100, reading `getBoundingClientRect` on the real provider
list. Raw capture: `evidence/030-baseline.json`.

| width | cards | control count | horizontal overflow | zero-width children |
|-------|-------|---------------|---------------------|---------------------|
| 780 | 10 | **7 or 8** | none | 0 |
| 1280 | 10 | **7 or 8** | none | 0 |
| 1440 | 10 | **7 or 8** | none | 0 |

Two findings, and they point in opposite directions.

**The count really does vary, and the actions row really does start at a
different x.** At 1280 the actions cluster begins at 684.1px on `anthropic`,
710.2px on `openai`, and 798.9px on `cursor` — a 114.8px spread across cards in
one list. Two independent conditionals cause it:

- `Models.tsx:1360` — `(capOn || nativeProviderGroup)` hides the cap `Select`,
  so a cap-off provider loses a ~74px control.
- `Models.tsx:1287` — `if (!preset) return null` drops the preset segmented
  control for any provider with no shipped preset.

So `openai` shows `1.05M` and `anthropic` does not; `anthropic` shows
`프리셋 / 전체` and `openai` does not. Neither is a bug. Both are invisible
rules, which is why the row reads as arbitrary.

**But there is no overflow and nothing is clipped.** `scrollWidth === clientWidth`
at all three widths, `overflowRight` is -13px everywhere (inside the card), and no
child measures under 6px. `010` did its job. The remaining defect is
*legibility of the rule*, not geometry — which changes what this phase is allowed
to do: it must not buy tidiness with a layout regression, because the layout is
currently correct.

## The conflict, and how it resolves

The user mandated hover ("호버는 일단 이거는 무조건해야되고"). The independent
plan auditor (xai/grok-4.6, read-only lane) returned **VERDICT: fail** against
the first draft, which had proposed hiding the alias pencil, the alias-defaults
switch, and the custom-add `+` until hover:

> hover-reveal of alias pencil / alias-defaults switch / custom-add creates a
> discoverability regression on expert controls; users must already know to hover
> to see them [...] the proposed Tier 2 items are exactly the ones `020` said
> needed visible text because they are undiscoverable at rest.
>
> TIER ASSIGNMENT YOU RECOMMEND: Tier 1: [everything]; Tier 2: none.
> hover-reveal is a density hack that fights the meaning problem `020` solved.

The auditor is right about the mechanism and wrong about the conclusion, and the
distinction is worth stating precisely because it is the whole design of this
phase: **the auditor rejected hover-as-gating. The user asked for hover-as-
affordance.** Those are different features that share a word.

- **Hover-as-gating** removes a control from the resting layout. It trades
  discoverability for density, and on a surface where `020` already established
  that three controls are unlabeled and opaque, it makes the opacity worse. This
  is what the auditor blocked, and it stays blocked.
- **Hover-as-affordance** leaves every control in the resting layout and uses
  pointer proximity to *explain* it — the row lifts its own labels and tooltips
  into view. Nothing is hidden, so there is nothing to discover.

Adopted: **no control leaves the resting layout.** Tier 2 is empty. The auditor's
Tier-1 assignment is adopted verbatim; its recommendation to land `020` first is
also adopted, which is why the label work moves ahead of this doc in the order.

**`020`'s label text is visible at rest. Hover only emphasizes; it never
introduces the label.** That sentence is the whole contract, and the second audit
round demanded it because an earlier phrasing here ("raises labels into view")
re-created the defect in a new place:

> If `050` rest-hides that text and reveals it on hover, blocker 1 returns as
> meaning-gating: a labeled control that is unlabeled until hover.

So the affordance is deliberately small: pencil idle-dim, and the `title`
tooltips `020` already specifies. Nothing in `050` may make `020`'s visible text
conditional on pointer state. If that leaves `050` with little label work, that is
the correct outcome — `020` already did it.

That also resolves blocker 3 without further argument: if no control is added to
or removed from the resting row, the 780px case cannot be made worse by
reserving space, because the space is already reserved by the control itself.

## Column alignment without placeholders

The first draft proposed reserving space with disabled placeholders. The auditor
killed that too, and its reasoning is the same one `011` already recorded:

> No shipped preset -> no control. Alignment comes from cluster order, not a dead
> segmented. [...] A disabled openai preset placeholder is that dead switch.

It also identified which conditional actually causes the jump the user sees. Not
the preset — the cap:

> The actual column jump is the cap `Select` gated on
> `(capOn || nativeProviderGroup)` at Models.tsx ~1360, not missing aliases.

Adopted, and it is a better fix than the one it replaces: **always render the cap
`Select`, disabled when the cap is off.** A cap-off card then occupies the same
slot as a cap-on card, so `anthropic` lines up with `openai` — with a real
control carrying a real value instead of a ghost. The preset control keeps
`if (!preset) return null`; a provider with nothing to curate still shows nothing,
because a dead segmented is worse than an absent one.

### What this does and does not fix, measured

The second audit round corrected an overclaim in the first draft of this section,
using the captured baseline. Both corrections are adopted:

> Always rendering the Select ADDS a control to 8 of 10 cards (not "replaces"
> one). At 780 that is extra wrap height, not overflow — `010` still holds — but it
> is not aggregate-neutral. After the Select is always present, anthropic still has
> the preset and cursor still does not, so the 1280 left-edge spread cannot go to
> zero.

Precisely, from `evidence/030-baseline.json`:

- **780px is the wrong proof for alignment.** Every card already reports
  `actsLeft: 281` there, because `@container (max-width: 720px)` has already
  wrapped the actions to full width. Alignment cannot regress or improve at a
  width where it is already uniform, so **the column gate lives at 1280 and 1440.**
- **The 114.8px spread is two missing pieces, not one.** `openai`/`kiro` carry a
  `custom-select`; `anthropic`/`openrouter` carry a `segmented`; the other six
  carry neither.

So the honest scope: always rendering the cap `Select` fixes the
**openai-shows-a-number / anthropic-does-not** mismatch the user actually
reported, and it costs wrap height at 780 rather than being free. It does **not**
drive the left-edge spread to zero, because the preset control legitimately
remains absent on providers with nothing to curate. **That residual
preset-driven delta is accepted, not fixed**, and the `050` gate must state it as
an accepted delta instead of asserting equal left edges.

## What this phase must NOT do

Also from the audit, and load-bearing:

- **No functional merge of `사용자 지정 창` into the cap control.** It opens
  per-model overrides (`openContextSettings`, `Models.tsx:538`); the cap
  switch+select is the provider-wide default. Those are different scopes. The
  cluster is **visual grouping only, three tab stops**.
- **Do not move the count out of `.models-provider-toggle`.** `010`'s child
  shrink rule and the element-wrapped-children test own that side of the row.
- **Nothing becomes hover-only.** Not the pencil, not the alias-defaults switch,
  not custom-add. The pencil may idle dimmed (`opacity >= 0.6`) and must stay in
  layout and in tab order, force-visible under `(hover: none)`.

## What actually reduces the count

The user asked to reduce, and one cluster is genuinely redundant. The context
window is **one setting wearing three controls** (`Models.tsx:1355-1394`):

1. a bare `Switch` whose accessible name is `기본 128k` — a value, not a function
2. a `Select` showing the number, conditional on that switch
3. a `사용자 지정 창` button opening the per-model modal

`020` already found (2) mislabeled and (1) opaque. Merging them into one
labeled cluster removes one control from every card and makes the conditional
`Select` a state of that cluster rather than an item that appears and vanishes.

`모두 켜기` / `모두 끄기` also read as overlapping with `전체`, but they are not:
the segmented control selects a curated *set*, the bulk buttons toggle
*visibility* of the current rows. Per UX-LAZY-01 neither can be deleted, so they
are disambiguated by label, not removed.

## Phase order

1. `020` — visible labels for the three opaque controls (already written; the
   auditor requires it first).
2. `040` — merge the context-window triple into one labeled cluster.
3. `050` — hover-as-affordance on the actions row: pointer/`focus-within`
   emphasizes controls that are already labeled and already present (pencil
   idle-dim, `020`'s tooltips), with `@media (hover: none)` keeping the resting
   state fully usable and `prefers-reduced-motion` making any opacity change
   instant.

   **No `min-width` floors on the conditional slots.** The first draft proposed
   them and the audit correctly identified that as the ghost placeholder in CSS
   form, contradicting this doc's own "no shipped preset -> no control" and
   reviving the child-floor move `011` already killed. An always-rendered
   `Select` needs no floor, and a floor for an absent preset is a dead slot.

## Verification contract

Inherited from `000`, with the column gate corrected by the second audit round:

- Re-measure at 780/1280/1440. Require `scrollWidth === clientWidth` and no child
  under 6px at every width.
- **Column gate at 1280/1440 only** — 780 is already uniform at `actsLeft: 281`
  and proves nothing about alignment.
- The cap-value slot must be occupied on every card. The remaining left-edge
  delta between a preset-carrying and a preset-free provider is recorded as an
  accepted delta, with its measured magnitude.
- 780 is allowed to gain wrap HEIGHT from the always-present `Select`; it is not
  allowed to overflow.
- Implementation guard, from the audit: the strings the existing tests pin must
  stay byte-exact — `className="row models-provider-toggle"`,
  `className="row models-provider-actions"`, `t("models.contextSettings")`, the
  720/768 wrap rules, and the toggle's `flex: "1 1 auto"`. A template-literal
  className or a hover wrapper around the actions row fails
  `gui/tests/models-provider-head.test.ts` even if the design is right.

Focused `gui/tests` regression per phase, driven red first. Remote gates only
(`ssh lidge`); the local full suite is forbidden by the user. Push `--no-verify`.

Dials: `DESIGN_VARIANCE 2`, `MOTION_INTENSITY 1`, density D6 — unchanged from
`000`. An earlier draft of this doc raised them to 3/2 to justify a hover
transition; the audit rejected that as motion inflation on an admin row, and it
was right. Any opacity change is instant under `prefers-reduced-motion`, and the
dials are not raised to license the affordance.
