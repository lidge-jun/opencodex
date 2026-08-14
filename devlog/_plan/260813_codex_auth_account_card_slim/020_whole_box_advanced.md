# 020 — Whole-box advanced section

## Goal
Among boxes below the account pool, keep rotation strategy visible. Hide auto-switch, model-picker targeting, and Default-mode request_user_input behind one Advanced settings section that shows or hides WHOLE boxes. When open, those boxes stay fully expanded. No inner-box fold.

## Files
MODIFY gui/src/components/CodexAccountPool.tsx
MODIFY gui/src/pages/CodexAuth.tsx
NEW gui/src/components/CodexAuthAdvancedSettings.tsx (thin section wrapper)
MODIFY gui/src/styles.css
MODIFY gui/src/i18n/{en,ko,de,ja,zh,zh-TW,ru,tr}.ts
MODIFY gui/tests/codex-auto-switch-controller.test.tsx (open advanced before querying the threshold)
MODIFY gui/tests/codex-account-picker-setting.test.tsx only if page-level mount appears; component unit tests stay unchanged.

## Before
CodexAccountPool always renders CodexAutoSwitchSetting (once strategy resolves) and CodexPoolStrategySetting.
CodexAuth always renders CodexAccountPickerSetting and DefaultModeRequestUserInputSetting after the pool.

## After
Visible under the pool: CodexPoolStrategySetting (unchanged card).
Then a section header button (not a wrapping card): Advanced settings / 고급 설정, aria-expanded, no emoji.
Closed default: auto-switch, picker, request_user_input are unmounted or hidden as complete boxes.
Open: those three existing cards render in current order, fully expanded, no nested disclosure.

State: useState(false) on the page/pool owner. Do not persist. Do not use <details> if it would nest inside a settings card. A section button that toggles sibling boxes is allowed because the fold is the section, not a box interior.

Do not wrap the three cards in another .card. Section is a header + conditional fragment.

## Activation / accept
- Default mount of CodexAccountPool: threshold input absent until Advanced is opened.
- CodexAuth default: picker/request titles absent until Advanced is opened.
- Open: all three boxes present and their toggles visible without a second click.
- Strategy title remains visible while Advanced is closed.
