# The three clients still on a monogram

Continuation of `004_brand_mark_provenance.md`, which closed six clients. After
that pass `CLIENT_MARKS` covers nine of twelve; `hermes`, `gajae` and `mcode`
still render `label.slice(0, 1)`.

004 recorded `gajae` and `hermes` as monogram-only because neither publishes an
SVG with path geometry. That verdict stands on its own terms and is now
superseded by a wider rule: raster-to-vector conversion is authorized, so "the
vendor ships no SVG" no longer ends the search. Every mark below is traced from
the product's own raster asset rather than redrawn.

All three were located 2026-08-31 through the `aside-jun` skill driving a
signed-in Aside browser, then re-fetched and verified locally.

## mcode — MiniMax Code

A genuine first-party SVG exists and 004 simply had not found it.

- Source: `https://raw.githubusercontent.com/MiniMax-AI/MiniMax-01/main/figures/minimax.svg`
- 1255 bytes, `viewBox="0 0 490.16 411.7"`, one `<path>` filled by a three-stop
  linear gradient (`#e4177f` to `#e73562` to `#e94e4a`).
- It is the standalone symbol — the interlocking wave glyph with no wordmark
  beside it. The docs-site asset (`mintcdn.com/minimax-zh/.../logo/light.svg`)
  is the 129x32 horizontal lockup and was rejected for that reason: a wordmark
  in a 20px square renders as unreadable letter mush.
- Publisher mark rather than product mark. MiniMax Code ships no mark of its
  own and MiniMax is its publisher, so this is the closest first-party asset.
- Committed unmodified apart from dropping the Chinese-language `<title>` and
  layer-name metadata the authoring tool left behind. The gradient id is
  renamed: `未命名的渐变_6` means "unnamed gradient 6", it collides across
  inlined documents, and a non-ASCII id in a shared namespace is a trap.
- Multi-color, so it must NOT enter `MONOCHROME_CLIENT_MARKS`: masking would
  flatten the gradient to one ink.

## hermes — Hermes agent

No usable SVG upstream; traced from the product's own application icon.

- Rejected first: `website/static/img/favicon.svg` is 113 bytes and its whole
  body is one `<text>` element. 004 already recorded this.
- Rejected second: `https://nousresearch.com/safari-pinned-tab.svg` (12746
  bytes, potrace output). Its first path is `M40 2560 l0 -2560 2520 0 2520 0 0
  2560 0 2560 -2520 0 -2520 0 0 -2560z` — the full 512-unit frame. Rendered at
  20px that is a black square with a hairline hole, which is worse than a
  monogram.
- Accepted: `apps/desktop/assets/icon.png` from `NousResearch/hermes-agent`,
  574273 bytes, 1024x1024 RGBA, artwork bounded at (101,108)-(924,914). This is
  the icon the Hermes desktop application ships, so it is the product's own
  mark, not the publisher's.
- Quantizing the opaque pixels shows two inks: a light plate (340877 px) and
  black art (241765 px), with ~20k px of antialiasing between them. It is a
  single-ink illustration on a rounded plate.
- Traced with `potrace -s --flat --turdsize 8 --alphamax 1.0 --opttolerance
  0.2` over the mask `alpha > 128 AND mean(rgb) < 110`, which keeps the black
  art and discards the plate. One path, squared to `viewBox="0 0 823 823"` by
  centering the 823x806 trace.
- `fill="currentColor"`, and it MUST join `MONOCHROME_CLIENT_MARKS`. A 20px
  render on `#0d1117` confirmed the untinted mark is invisible in dark mode —
  the same failure `prime`, `opencode` and `kimi` already have.

## gajae — Gajae Code

No SVG anywhere upstream, confirmed twice; traced from the mascot.

- Searched and found empty: `assets/`, `public/` (404), `docs/`, plus
  `assets/logo.svg`, `assets/favicon.svg`, `public/logo.svg`,
  `public/favicon.svg`, `docs/logo.svg` (all 404), and every published
  `@gajae-code/*` npm tarball at 0.15.6 (no SVG entries). `docs/brand-assets.md`
  lists the active marks as PNG only.
- Accepted source: `assets/character.png`, 3190496 bytes, 1550x2048 RGBA,
  transparent background.
- It is a vertical lockup: the mascot occupies y < 1650 and the `gajae-code`
  wordmark sits below it. Rows 1650-1682 are fully transparent, which is the
  seam the crop uses. Only the mascot is traced; a wordmark would not survive
  20px.
- The artwork is upscaled pixel art, so tracing at source resolution follows
  every staircase and produced a 1.3 MB SVG. Downsampling to a 128px box with
  Lanczos plus a 0.6px Gaussian first, then tracing, gives ~31 KB. That is
  larger than any existing mark (`zcode.svg`, 11037 bytes) because this one is
  an illustration rather than a glyph.
- Seven color layers, k-means++ seeded at 3 for determinism, painted
  largest-area first. The committed file's fills are `#1d0a04`, `#561203`,
  `#981001`, `#e3770c`, `#d32e02`, `#8f3a04` and `#02ac61` — read off
  `gajae-code.svg` rather than off an earlier tuning run, whose centers differed
  because it quantized at a different target size. The smallest layer is the
  visor green and a fixed area floor would have dropped it, so the floor is a
  fraction of the opaque area instead.
- Multi-color, so NOT in `MONOCHROME_CLIENT_MARKS`.

## Rule this pass establishes

A mark may be traced from the product's own raster asset when no vector exists,
provided the trace follows the source pixels rather than redrawing them, the
conversion parameters are recorded, and the result is verified by rendering at
the size it will actually be used. Tracing a wordmark into a square slot is
still refused, and so is a full-frame silhouette plate.
