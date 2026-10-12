# The dashboard and documentation favicons

The desktop app now renders its icon and its menu bar image from one traced vector. The two
favicons the product serves are still hand-made rasters with no source, and one of them is broken
in a way the file itself does not show.

`docs-site/public/favicon.png` is the dark variant of the mark: white on transparency, 192px,
36225 of 36864 pixels carrying some alpha but every one of them RGB `(255,255,255)`, exactly one
fully opaque pixel, corner `(255,255,255,3)`. Composited on white it is a white square. A browser
tab strip is light by default and Starlight names the favicon unconditionally, so the documentation
site effectively has no favicon in light mode. `favicon.ico` beside it carries the same artwork at
16, 32 and 48, also with no fully opaque pixel.

`gui/public/favicon.png` is the light composition and looks right at 128px, but it is a bitmap no
source can regenerate, and it is the shaded artwork rather than the flat mark: its engraved prompt
all but disappears at 16 and 32. Rendering the vector at 128 differs from it in 68% of pixels. That
is a visible simplification, not only a deduplication, and it is the same trade the app icon made.

This unit covers the favicons and nothing else. Starlight's `logo-light.png` and `logo-dark.png`
stay independent 512px rasters — they are the brand artwork the vector was traced from, not
derived assets. `og.png` also stays, and carries a separate pre-existing defect worth its own
scope: `docs-site/astro.config.mjs` declares it 1200x630 while the committed file is 1536x1024.

## Shape of the change

- `scripts/lib/icon-render.ts` — new. The renderer, the RGBA re-encode and the ICO packer move here
  out of `desktop/scripts/generate-icons.ts`, which keeps its size tables and imports them. Two
  generators sharing one renderer is the point; a second copy of the PNG re-encode would be a
  second place for the alpha bug to come back.
- `scripts/brand-favicons.ts` — new. Renders `desktop/src-tauri/icons/icon.svg` into
  `gui/public/favicon.png` (128), `docs-site/public/favicon.png` (192) and
  `docs-site/public/favicon.ico` (16, 32, 48) — the names, sizes and formats the two sites already
  reference, so no page or config changes. `--check` regenerates into scratch and compares bytes,
  the same contract the desktop set has.
- `package.json` — `favicons` and `favicons:check`.
- `tests/ci-workflows/brand-favicons.test.ts` — new, registered in `scripts/test-layout/layout.json`
  and `tests/fixtures/test-layout-expected.json`. Asserts the declared sizes match what the two
  sites ask for, that each committed favicon is that size with its alpha channel intact, that the
  ICO carries exactly the declared sizes as embedded PNGs, and that both favicons read on a light
  tab.

  That last one is why the test decodes pixels. An opaque corner alone is not enough: a plain white
  square has an opaque corner and is still invisible. So it requires an opaque light corner **and**
  at least 10% of the image to be opaque pixels whose luminance differs from that corner by more
  than 64 — the mark actually being there.

## Acceptance

1. `bun run favicons:check` reports every favicon matching the source.
2. The new test fails on both ways of being invisible, checked by applying each: the
   white-on-transparent artwork this replaces gives 3 pass / 1 fail, and a solid `#fcfcfc` square
   gives 3 pass / 1 fail. The generated favicons give 4 pass / 0 fail.
3. `bun run privacy:scan`, `bun run structure:check` and the two test-layout guards stay green.

