# 070 — PR #154 absorb: GUI dialog overlay + focus ring

## 1. Scope and locked inputs

Absorb community PR #154 from immutable source head
`5e8f1aa1b679e3fd26d4bc01f298e49e47e5919d` (`codex/source-pr154-5e8f1aa1`)
onto local `dev` with maintainer repairs for the Sol FAIL findings. The unit's
full-suite gate lives in phase 080, not here. No push. Attribution per
`000_plan.md`.

Source delta (2 files, +26/−2):

- `gui/src/pages/Dashboard.tsx` — `focusTriggerQuietly` helper using
  `focus({ focusVisible: false })` in `useModalDialog` close/unmount paths.
- `gui/src/styles.css` — `dialog.modal-overlay` UA reset (border/margin/size)
  + transparent `::backdrop`.

CAUTION: `gui/src/pages/Models.tsx` carries an unrelated uncommitted user edit —
never stage or touch it.

## 2. Sol review verdict (2026-07-19, lane C)

`VERDICT PR#154: FAIL` — absorb proceeds only with repairs below.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | P1 | `focusVisible:false` applied unconditionally suppresses the focus indicator for KEYBOARD closes too (Escape / keyboard-activated close at Dashboard.tsx:630/949/1060) — a11y regression contradicting the PR's own claim | FOLD — track close origin: pointer-originated close → quiet focus restore; keyboard-originated (Escape/Enter/Space) → plain `.focus()` so :focus-visible paints |
| 2 | P2 | try/catch is not feature detection — engines ignoring the unknown dictionary member won't throw, leaving the sticky ring on older browsers (support: Chrome 145+/FF 104+/Safari 18.4+) | FOLD — accept as residual limitation with comment (fallback is the pre-PR behavior, not a new break); primary fix rides finding 1's origin tracking which works everywhere |

CSS reset reviewed clean: `dialog.modal-overlay` selector scopes the UA reset to
dialogs that ARE the overlay; other `.modal-overlay` divs unaffected.

## 3. Landing plan

1. Wibias-author pick of `5e8f1aa1` — source-faithful checkpoint.
2. Maintainer repair commit (+Co-authored-by): close-origin tracking for focus
   restore + comment on the focusVisible support envelope.

## 4. Verification

- `bun run typecheck` exit 0 (covers `src/` only) AND `cd gui && bun run build`
  exit 0 (GUI compilation owner).
- C-RENDER-GROUNDING + C-ACTIVATION: open the GUI dashboard and drive BOTH close
  origins separately —
  (a) pointer: open Request Logs error modal / Sub-agent help with mouse, close
  with mouse → observe NO focus ring on the trigger (screenshot);
  (b) keyboard: open with Enter, close with Escape → observe a VISIBLE
  `:focus-visible` ring on the trigger (screenshot).
  Also observe the overlay itself: no white UA frame, no double dim.
  Record both observations here at D.

## 5. D close-out (2026-07-19)

Landed: `bfdaa3e9` (Wibias pick) + `30782a87` (maintainer repair, input-modality
tracking). Gates: `bun run typecheck` exit 0; `cd gui && bun run build` exit 0.

Render-grounding (Vite dev server on :5199 proxied to live proxy :10100, driven
via Chrome CDP):

- Overlay: Sub-agent info modal shows the liquid-glass overlay with NO white UA
  frame and no double dim (screenshot `screenshot_1784455755124.png`).
- Pointer close (mouse click on Close): trigger regains focus with NO visible
  ring (screenshot `screenshot_1784455782387.png`).
- Keyboard close (Escape): trigger regains focus WITH the visible
  `:focus-visible` ring (screenshot `screenshot_1784455807236.png`) — the P1
  a11y repair observed firing.
