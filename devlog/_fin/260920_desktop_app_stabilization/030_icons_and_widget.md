# wp4 — one vector source for the icons, and a verdict on the widget

## Why the icon set needed a source

`desktop/src-tauri/icons/` carried eighteen raster files and no vector. Every size was an
independent artifact: nothing tied `Square107x107Logo.png` to `icon.png`, nothing could tell
whether one of them had been hand-edited, and adding a platform size meant drawing it again. The
`.icns` and `.ico` containers hid the problem further, because a wrong member inside them is not
visible in a diff at all.

The fix is a single `icon.svg` plus `desktop/scripts/generate-icons.ts`, exposed as
`bun run icons` and `bun run icons:check`. Fifteen PNGs render through `rsvg-convert`, the
`.icns` is assembled by `iconutil` from its ten members, and the `.ico` is written directly with
six PNG-embedded entries (16, 32, 48, 64, 128, 256). `--check` regenerates into a temporary
directory and compares byte for byte, so a hand-edited PNG fails instead of silently disagreeing
with the source.

## The geometry was measured, not redrawn

A redrawn mark would have been a different icon wearing the same name. The shape in `icon.png`
was measured instead: it spans 58..453 on both axes, the stroke is 48 wide, and the outer corner
turns at radius 135. A centred stroke therefore sits at `x=82 y=82 w=348 h=348` with
`stroke-width=48`, and the corner radius was swept to find the closest match. `rx=127` reproduces
the original to within **430 of 262144 pixels at 512×512 — 0.164%**, which is antialiasing along
the curve rather than a changed silhouette.

The mark stays pure black on transparency. Both macOS and Windows composite it over their own
backgrounds, so a baked background would appear as a card on one of the two.

## The widget question

`OpenCodexWidget.appex` is bundled, and the acceptance note requires a verdict either way rather
than an absence.

**The extension registers, and that part is settled.** `pluginkit` lists it from the installed
application with the parent bundle resolved and no disabled or ignored marker:

```
com.opencodex.desktop.widget(2.61.0)
            SDK = com.apple.widgetkit-extension
  Parent Bundle = /Applications/OpenCodex.app
    Parent Name = OpenCodex
       Platform = macOS
```

That record is structurally identical to a system widget queried the same way, so the earlier
working hypothesis — that ad-hoc signing keeps the extension from being adopted at all — is wrong
and is recorded here as wrong. Registration is not the obstacle.

**And it does not appear in the gallery.** The gallery was opened on this machine and checked:
OpenCodex is not among the offered widgets. No `OpenCodexWidget` process has ever run here
either, so nothing has asked the extension for a timeline. Registration and adoption are two
different things, and only the first of them holds.

**What the signing state actually costs.** The host bundle carries the linker-signed placeholder:

```
host app   Identifier = opencodex_desktop-b89067d97e1c189c
                flags = 0x20002(adhoc,linker-signed)
           Info.plist = not bound
      Sealed Resources = none
appex      Identifier = com.opencodex.desktop.widget
                flags = 0x2(adhoc)
```

The host's `CFBundleIdentifier` is `com.opencodex.desktop`, but its *signed* identity is the
placeholder, its `Info.plist` is not bound into the signature, and it seals no resources. Locally
that is tolerated because the machine built the bundle itself. A distributed copy has no sealed
host for the system to validate the extension's containment against, and nothing binds the
declared identifier to the signed one.

**The verdict, then:** the extension is registered and the gallery does not offer it. The host
bundle is the thing that fails a requirement — its signed identity is not the identity it
declares, and it seals nothing — so nothing downstream can establish that this extension belongs
to `com.opencodex.desktop`. Until the release pipeline signs the host with a Developer ID
identity, the widget ships but cannot be added. That is the finding; it is not worked around here,
and no part of the icon work depends on it.

## What the icon check does and does not cover

`bun run icons:check` compares all seventeen generated artifacts — fifteen PNGs, the `.ico` and
the `.icns` — byte for byte against a fresh render. It needs `rsvg-convert` and `iconutil`, and
when `iconutil` is missing it now says the `.icns` was not compared and fails, rather than
reporting a pass over a file it never looked at.

That check does not run in CI, and claiming otherwise would be the easy lie here. The renderer is
not pinned, so two machines with different librsvg builds produce different bytes with nothing
wrong; asserting byte identity on a hosted runner would be asserting the runner's renderer
version. What CI runs instead is `tests/ci-workflows/build-desktop-icon-set.test.ts`, which needs
no renderer at all and reads its expectations out of the generator: every declared size committed
at exactly that size, the `.ico` directory carrying exactly the packed sizes with each payload a
real PNG of its declared dimension, the `.icns` walking cleanly end to end with one image member
per declared entry, and nothing hand-added beside the generated set. It was driven red on a
resized raster and on a stray file before being trusted.

So the split is: shape is enforced everywhere, byte identity is enforced wherever the toolchain
exists.

## Files

- `desktop/src-tauri/icons/icon.svg` — new, the single source.
- `desktop/scripts/generate-icons.ts` — new, renderer and `--check` verifier.
- `desktop/package.json` — `icons` and `icons:check` scripts.
- Seventeen regenerated raster artifacts under `desktop/src-tauri/icons/`.
- `tests/ci-workflows/build-desktop-icon-set.test.ts` — new, the renderer-free structural guard,
  registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.

## Acceptance

`bun run icons:check` passes on the committed tree over all seventeen artifacts,
`build-desktop-icon-set.test.ts` passes and has been shown to fail on a wrong-sized raster and on
a stray file, `bun run build:local` produces a bundle whose `Contents/Resources/icon.icns` is the
generated one, and the widget verdict is an observation of the gallery rather than an inference
from registration.
