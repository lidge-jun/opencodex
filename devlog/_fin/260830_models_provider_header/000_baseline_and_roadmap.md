# 000 — Models provider-row header: unreadable chip, overlapping name, meaningless controls

Reported against the running dashboard's Models page with a screenshot: "이부분도
존나 이상해 신규 2개 꺼짐, 펜, 스위치(이건 뭘하는지도 모르겠음), 사용자 지정창이랑
마지막 스위치는 뭔지도 모름".

Two distinct failures are stacked in one header, and they need different fixes:

- **Geometry** — the "신규 N개, 꺼짐" chip collapses into a rounded blob and the
  provider name paints on top of the active count.
- **Meaning** — three controls are operable but unlabeled: a sighted user cannot
  tell what they do. This half is not a layout bug and cannot be fixed by
  layout.

As with the sidecar unit, every defect below carries a measured baseline from a
CDP harness (`Emulation.setDeviceMetricsOverride`, dpr 2, live
`getBoundingClientRect`), so each claim is re-checkable.

## Baseline (ko, provider rows on `#models`)

Measured with `.tmp/uiux2/head.ts`, which settles on `innerWidth === target` and
on rendered provider rows before reading geometry. The proxy at 127.0.0.1:10100
supplies the live provider list through the Vite `OPENCODEX_PROXY_TARGET` proxy,
so these are real rows, not fixtures.

| width | provider | header h | name box w | chip lines | chip w |
|-------|----------|----------|------------|-----------|--------|
| 1440 | opencode-free | 44.8 | 96.5 | 1 | 92.1 |
| 1280 | opencode-free | 55.7 | 67.2 | **2** | 69.6 |
| 1280 | openai | 55.7 | **9.9** | **2** | 57.7 |
| 1100 | opencode-free | **115.1** | **0.0** | **6** | 34.1 |
| 1100 | cursor | **115.1** | **0.0** | **6** | 34.1 |
| 1024 | opencode-free | 75.8 | 96.5 | 1 | — |

The 1100 row is the screenshot state: a six-line chip 34.1px wide, a name box
measuring **zero**, and a header 2.6x its correct height. 1024 recovers because
the container query at `styles-models-workspace.css:517` moves the actions onto
their own row, which returns the toggle's width. The defect therefore lives in a
**band** (roughly 1040-1380 in this layout), which is why it is easy to miss at
either extreme.

## Defect 1 — the chip is a shrinkable flex item with no single-line floor

`.models-chip` (`styles-models-workspace.css:315`) declares
`display: inline-block` plus padding, border and `border-radius`, and nothing
else. Because it sits inside `.row models-provider-toggle`
(`Models.tsx:1226`) and `.row` is `display: flex` (`styles.css:1205`), the chip
is a **flex item**: its `inline-block` outer display is blockified and its
initial `flex-shrink: 1` applies. Measured computed values confirm it —
`white-space: normal`, `flex-shrink: 1`.

`inline-block` does not imply `white-space: nowrap`. The chip's only floor is
`min-width: auto`, which resolves to the text's **min-content** width — and for
Korean that is nearly one syllable, because CJK line-breaking permits a break
between Hangul syllable blocks. So `신규 2개, 꺼짐` legally becomes
`신규 / 2 / 개, / 꺼 / 짐`, and the fixed padding wrapped around that narrow
column is exactly the observed blob.

~~Fix: give the chip a single-line floor.~~ **Superseded.** Measurement showed the
chip is not independently broken: it is starved of width by a collapsed ancestor,
and it returns to one line as soon as that ancestor claims its intrinsic width. An
audit also found a chip-level floor unsafe across the eight other `.models-chip`
call sites. The shipped fix leaves the shared `.models-chip` primitive untouched;
it adds an ellipsis only to the toggle-scoped descendant — see `010` and `011`.

## Defect 2 — the name overflows a zero-width box instead of reflowing

The name span carries inline `whiteSpace: "nowrap"` (`Models.tsx:1232`) while
`styles-models-workspace.css:267` gives it `min-width: 0` and
`overflow-wrap: anywhere`. Those two fight: `nowrap` suppresses the wrapping
that `overflow-wrap: anywhere` was added to provide, `min-width: 0` lets the box
shrink to nothing, and the default `overflow: visible` means the glyphs keep
painting outside the box — straight across the sibling count.

Nothing positions these elements on top of each other: there is no `position`,
transform, or negative margin anywhere in the applicable rules. The count is
laid out normally *after* a box that measures 0px, so the collision is pure
overflow.

Why the header's own `flex-wrap: wrap` does not save it: the header's direct
children are only the toggle button and the actions container. Wrapping does not
propagate into descendants, and the toggle's inner `.row` has no `flex-wrap`,
so the chevron, name, chips and count are locked on one line and shrink against
each other.

The upstream enabler is `flex: 1` on the toggle (`Models.tsx:1229`), which
resolves to `flex: 1 1 0%` — zero basis, shrink allowed — combined with
`min-width: 0`. The toggle then accepts whatever the wide actions cluster leaves
it rather than forcing a wrap.

~~Fix: let the toggle's own row wrap.~~ **Superseded.** Inner wrapping is inert:
line construction inside the button runs after its used width has been assigned, so
wrapping redistributes 31px rather than asking for more. Measured: the candidate
left the name box at 0.0px, byte-identical to baseline. The shipped fix gives the
toggle a real flex **basis** so its content enters the header's wrap decision, and
removes every child's min-content floor so the row can always shrink back inside the
card — see `010`.

## Defect 3 — three controls carry no visible meaning (two switches and the `+`)

`Switch` (`ui.tsx:8`) accepts a `label` prop and spends it **only** on
`aria-label` (`ui.tsx:11`); its sole child is `<span className="knob" />`. So
every `Switch` in this codebase is, to a sighted user, an unlabeled toggle. The
user's "이건 뭘하는지도 모르겠음" is a correct reading of the UI.

Audit of the header controls in visual order:

| control | visible | aria-label | title | verdict |
|---------|---------|-----------|-------|---------|
| collapse button | chevron + name + count | (children) | — | OK |
| pencil | icon only | 공급자 별칭 편집 | yes | OK |
| default-aliases Switch | knob only | 기본 별칭 사용 | — | **OPAQUE** |
| 사용자 지정 창 | text | — | — | OK |
| `+` | `+` only | 커스텀 모델 추가 | — | **OPAQUE** |
| preset segmented | 프리셋 / 전체 | group only | — | OK |
| 모두 켜기 / 모두 끄기 | text | — | — | OK |
| cap Switch | knob only | 기본 {value} | — | **OPAQUE** |
| cap Select | number only | 기본 {value} | — | **OPAQUE** |

The pencil is fine precisely because it pairs an icon with `title` — that is the
pattern the opaque controls are missing.

Two aggravating details:

1. The cap Switch's accessible name is `기본 128k` — a *value*, not a function.
   Even a screen-reader user is not told this governs the context-window cap.
2. For routed providers with the cap off, `(capOn || nativeProviderGroup)`
   (`Models.tsx:1360`) hides the Select, so the only thing left is a bare
   toggle with no adjacent number to hint at its purpose. The worst state is the
   default state.

### Design constraint

This is a dense expert control surface: `DESIGN_VARIANCE 2`, `MOTION 1`, density
D6+. The domain gate is strict — no decorative kit, no motion, no new color. The
fix is *labels and reflow*, and the correct instrument is the existing
`title`-plus-icon pattern already proven by the pencil, plus a visible text
label where the header has room for one.

UX-LAZY-01 was applied to each control before relabeling it rather than after:
every one of them is a real per-provider setting with no correct global default,
so none can be deleted or absorbed. They need meaning, not removal.

## Roadmap

- `010` — let the toggle's content be seen, and make every child yield (geometry).
  Five designs; the first four were rejected by audit or stress measurement and
  `011` records why.
- `020` — control affordances: visible labels for the opaque controls, and a
  `Switch` that can render one.

Each is one PABCD work-phase and one stacked PR. `010` lands first because `020`
adds visible text to the same header and would otherwise be measured against a
layout that is still collapsing.

## Verification contract

- Re-measure the sweep at 1440/1280/1100/1024 in ko + ru + fr + en and require:
  chip `lines === 1` everywhere, name box width > 0, zero name/count overlap, and
  header height within one line-height of the 1440 baseline.
- A focused `gui/tests` regression per phase, driven red against current CSS
  first.
- Remote gates only (`ssh lidge` + `ocx-run`); the local full suite is forbidden
  by the user. Push `--no-verify`.
- Before/after screenshots at the failing width, per `AGENTS.md` enforce-target.



