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

**It has never been instantiated.** No `OpenCodexWidget` process has run on this machine, so
nothing has yet asked the extension for a timeline. Registration says the system would offer it;
it does not say the gallery has rendered it.

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

**The verdict, then:** the widget is eligible and registered, unexercised here, and not shippable
until the release pipeline signs the host bundle with a Developer ID identity so the declared and
signed identifiers agree and the bundle is sealed. That is a release-signing requirement, recorded
rather than worked around.

Visual confirmation of the gallery itself was not obtained. The menu bar and Notification Center
are not addressable from the automation surface used here — every menu-bar coordinate is refused
as having no window — so this records the system state rather than a screenshot.

## Files

- `desktop/src-tauri/icons/icon.svg` — new, the single source.
- `desktop/scripts/generate-icons.ts` — new, renderer and `--check` verifier.
- `desktop/package.json` — `icons` and `icons:check` scripts.
- Seventeen regenerated raster artifacts under `desktop/src-tauri/icons/`.

## Acceptance

`bun run icons:check` passes on the committed tree, `bun run build:local` produces a bundle whose
`Contents/Resources/icon.icns` is the generated one, and the widget verdict above is recorded with
its measured identifiers.
