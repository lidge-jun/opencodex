# 020 — Codex Set nav row carries the real Codex mark

## Current state

`gui/src/App.tsx` maps the `codex-set` nav entry to `IconKey`, a generic key
glyph from `gui/src/icons.tsx`. Every other nav row is a category icon, so the
one page that configures Codex itself is the one row that does not say Codex.

## Source of the mark

Located with the `aside-jun` skill driving a real signed-in browser, then
re-verified independently with `curl` against raw.githubusercontent.com so the
geometry is not taken on an agent's word:

`https://raw.githubusercontent.com/openai/codex/main/codex-rs/login/src/assets/success.html`

carries `<svg class="codex-mark" fill="none" viewBox="0 0 32 32">` with a single
path, `stroke="currentColor"`, `stroke-linecap="round"`, `stroke-width="2.484"`.
It is the mark the Codex CLI itself renders on its login-success page. The
geometry is a circle of radius 14.758 about (16,16) enclosing a `>` chevron and
an underscore — a terminal prompt inside a ring.

Two other variants were found and rejected:

- `#sidebar-codex` and `#codex` in `chatgpt.com`'s shell sprite are solid-fill
  marks whose ring is a six-lobed blossom drawn as an even-odd filled band.
  They are the "Codex in ChatGPT" flavor and they are fill-based, which does not
  match this icon set.
- `openai.com/codex` and the codex marketing pages carry only the OpenAI
  wordmark or the ChatGPT blossom, no Codex-specific glyph.

## Why the stroked variant is the right one

`gui/src/icons.tsx` is a single convention: `fill="none"`, `stroke="currentColor"`,
`stroke-width="2"`, round caps and joins, on a 24-unit viewBox. The
openai/codex mark is already stroked with round caps on `currentColor`; only its
viewBox (32) and stroke width (2.484) differ. `2.484` on a 32-unit box is
`2.484 * 24/32 = 1.863` at 24 units — within a hair of the file's `2`, so the
mark drops into this set at its native `0 0 32 32` viewBox and renders at the
same visual weight as its neighbors. Scaling by viewBox rather than rewriting the
path keeps the geometry byte-identical to the source.

## Change

- Add `IconCodex` to `gui/src/icons.tsx` as an inline SVG. It cannot use the
  shared `S()` spreader, which hardcodes `viewBox="0 0 24 24"` and
  `strokeWidth={2}`; it declares its own `viewBox="0 0 32 32"` and
  `strokeWidth={2.484}` while keeping `stroke="currentColor"` and round caps,
  so it still inherits color and sizing from the call site exactly like the rest.
- Point the `codex-set` `NAV` entry at `IconCodex`.
- `IconKey` stays exported and keeps its two consumers,
  `add-provider-form-pane.tsx` and `ProviderWorkspaceShell.tsx` — but it is
  *removed from App.tsx's import list*, not merely unused there.
  `gui/tsconfig.app.json` sets `noUnusedLocals`, which `tsc -b` enforces inside
  `build:gui`, so a leftover import fails the GUI build. Root `bun run typecheck`
  would not catch it: the root tsconfig includes `src`, not `gui/src`.
- `gui/tests/sidebar-codex-set.test.ts` asserts the NAV row's source text and
  pinned `Icon: IconKey` literally, so it fails on this change and CI runs it
  (`cd gui && bun test --isolate tests`). The assertion is relaxed to stop at
  `Icon:` rather than re-pinning the new name. That matches the intent already
  written into the same test a few lines above, where pinning the exact
  destructuring was removed for failing on changes it was never written to
  catch. The row's identity is its id and label key; which glyph it wears is not
  what this test is about.

No runtime asset fetch, no icon-library dependency, no theme-specific variant —
`currentColor` covers light and dark the way every other icon in the file does.

`...p` is spread last in the component so a future call site can still override
size, color, or aria attributes — matching how `S()` behaves for its neighbours.

## Verification

Live sidebar screenshot at the running dashboard in both themes, the focused
`gui/tests/sidebar-codex-set.test.ts`, plus `bun run typecheck`,
`bun run lint:gui` and `bun run build:gui`. NAV icons are rendered as bare
`<Icon />` and sized by `.nav-item svg { width:17px; height:17px }`, so a
32-unit viewBox scales in exactly like a 24-unit one — confirmed in the live DOM.
