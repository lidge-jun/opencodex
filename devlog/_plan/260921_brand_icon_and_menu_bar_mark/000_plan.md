# Brand icon and menu bar mark

The shipped app icon is not the product's mark. `desktop/src-tauri/icons/*` derives from an empty
rounded-square ring that came in with the Tauri template, and the vector source written for it in
#5329 reproduced that ring faithfully — the measurement was right and the subject was wrong.

Two consequences, both visible on a Mac today. The artwork covers 21.4% of the 1024px canvas and
has transparent corners, so macOS 26/27 classifies it as a uniquely shaped icon, strips it onto a
default grey tile and scales it down; Finder shows a grey square with a small black ring in it.
And the menu bar carries the same ring, so nothing on screen says which product this is.

The real mark already exists in the repository. `assets/logo-light.png` is the mark on
transparency at 512px and `gui/public/favicon.png` is its app-icon composition at 128px: a light
squircle behind a dark six-lobed cloud that holds a `>` and a `_`, flanked by `{` and `}`, inside a
dashed orbit with a dot at top and bottom. Neither has a vector source, and `gui/src/icons.tsx`
holds only 24x24 line icons, so there is nothing to reuse — the vector has to be produced.

## Where the geometry comes from

The silhouette is measured, not redrawn. `assets/logo-light.png` is pure black with a shaped alpha
channel, so the outline is the alpha channel: upsample it 4x to 2048px, threshold at alpha 110,
trace with potrace, and map the result back into the 512-unit source space. That yields exactly
nine subpaths — cloud, two braces, four orbit arcs, two dots — and re-rendering them at 512px
disagrees with the thresholded source in **188 of 262144 pixels (0.072%)**, which is antialiasing
rather than a different shape.

The prompt glyphs cannot be traced. In the source they are engraved: alpha 217+ against a 206 body,
with a lit rim along one edge. Composited at 512px that reads as depth; at 128px and below it reads
as nothing, and an app icon spends most of its life at 32px. Thresholding the emboss produces a
ragged chevron because the lit edge falls below the threshold asymmetrically.

They are redrawn as flat geometry on the measured centreline instead:

| glyph | measurement (512 source space) | drawn as |
| --- | --- | --- |
| `>` | rows 214-238 give the upper arm centreline slope 0.5625; rows 254-278 give the lower arm slope -0.5833; the two meet at (214.6, 244); tips at y 196.5 and 292.5 | polyline `193.4 206.5 -> 214.6 244 -> 193.4 281.5`, stroke 22, round cap and join |
| `_` | x 253-324.5, y 271-293.5, ends semicircular | rect 71 x 22.5, rx 11.25 at (253.5, 271) |

Checked against the source: the chevron's predicted horizontal cross-section is 25.3px against 25px
measured, and the underscore's cap curvature lands within one pixel at both ends.

## Shape of the change

The glyphs are a **mask** rather than a lighter fill. Cutting them out of the mark makes the
backdrop show through, which is the flat reading of an engraved groove, and it is also what gives
the menu bar template real holes instead of a black blob.

The backdrop is a **full-bleed opaque square**, not a pre-rounded tile. Apple's current app icon
guidance asks for a square, unmasked, full-bleed 1024px source and applies the rounded-rectangle
mask and material itself; a baked corner fights that and shows as jagged edges. The 824px inner
tile with a transparent margin is the pre-Tahoe recipe, and the transparent margin is precisely
what triggers today's grey fallback.

Files:

- `desktop/src-tauri/icons/icon.svg` — replaced. Full-bleed `#fcfcfc` backdrop, mark in `#2c2c2c`,
  glyphs cut by `mask#prompt`, mark placed by `translate(2 26) scale(2)` so the orbit centre sits on
  the canvas centre and the ink keeps the 77% coverage the favicon composition uses.
- `desktop/src-tauri/icons/tray/icon.svg` — new. Same curves, no backdrop, black fill, orbit and
  dots dropped because at 22pt a dashed circle resolves into grey specks. viewBox is the ink bounds
  of what is left plus 6%, so the glyph fills the menu bar height rather than the source margin.
- `desktop/scripts/generate-icons.ts` — `render()` takes a source, and the run emits
  `tray/icon.png` at 44px (22pt at @2x) alongside the existing seventeen. Both `icons` and
  `icons:check` cover it.
- `tests/ci-workflows/build-desktop-icon-set.test.ts` — two additions. The tray raster has to be the
  size the generator declares and the generator has to actually render and report it, and the tray
  source has to carry the app icon's mask verbatim, wire it onto the mark, and draw distinct curves
  that all appear in `icon.svg`.

  Subset alone was too weak, and a review caught it: every interesting way of breaking the tray
  removes something, so a strict subset stays a subset. Dropping the mask, deleting the underscore
  or repeating a brace in place of the cloud each ship a black blob with green CI. Each of those,
  plus removing the generator's tray render and removing its `produced.push`, was applied and run:
  all five turn the suite red at 6 pass / 1 fail, and the restored tree is 7 pass / 0 fail.

Nothing in `desktop/src-tauri/src/tray.rs` changes: it already builds the tray with
`.icon_as_template(true)`, and the asset it includes is the file being replaced.

## Acceptance

1. `bun run icons:check` reports every generated artifact matching the source, tray included.
2. `tests/ci-workflows/build-desktop-icon-set.test.ts` passes, and its drift guard fails when the
   tray source is perturbed.
3. `icon.png` is fully opaque, and `tray/icon.png` is 44x44 with no non-black opaque pixel.
4. The change lands on `dev`, and a locally built and installed app shows the mark in Finder, the
   Dock and the menu bar.

## Recorded results

- silhouette trace vs source alpha: 188 / 262144 px (0.072%).
- `icon.png` opaque coverage: 21.4% before, 100.0% after.
- `tray/icon.png`: 44x44, 759 pixels with alpha above zero — 498 fully opaque and 261 antialiased
  — and no pixel with alpha whose colour is anything but black, which is what a template image has
  to be. Both prompt glyphs are transparent holes rather than white fill.
- `bun run icons` regenerated 18 artifacts; `bun run icons:check` reported 18 matching.
