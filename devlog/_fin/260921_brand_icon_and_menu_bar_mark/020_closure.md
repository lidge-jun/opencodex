# Outcome

Three changes landed on `dev`, in this order:

| commit | pull request | change |
| --- | --- | --- |
| `a2d35a609e` | #5355 | the app icon and the menu bar mark, traced from the brand artwork |
| `5794348b0d` | #5356 | the alpha channel every generated icon needs |
| `917d690ecb` | #5361 | the dashboard and documentation favicons, from the same vector |

## Verified on screen

- **Finder and Dock.** Built locally with `bun run build:local`, signed with the Developer ID
  identity the installed app already carried, installed to `/Applications` and relaunched. Finder
  shows the mark on the system rounded rectangle: macOS masks the full-bleed square itself, which
  is what the square, unmasked source is for. The widget extension still registers with
  `pluginkit` under `com.opencodex.desktop.widget`, so replacing the bundle did not cost it.
- **Menu bar.** The status item renders the template mark with both prompt glyphs as holes,
  tinted by macOS, next to the usage label. Both that and the Finder icon are recorded in
  `assets/pr-screenshots/app-icon-finder-menubar.png`.
- **Browser tabs.** The two favicons were served over loopback HTTP and opened in a browser. Both
  read as the mark on a light tile at tab size. This is the claim `010_favicons.md` makes, checked
  in a tab rather than in a composite. `assets/pr-screenshots/favicon-browser-tab.png` is the tab
  strip itself, not a rendering of one.

## The defect the build caught

`bun run build:local` failed on the first head with
`error: proc macro panicked ... icon .../icons/icon.png is not RGBA`. The new backdrop is opaque,
and librsvg drops the alpha channel when nothing in a render is transparent; `generate_context!`
rejects a window icon that is not RGBA. Fifteen of the sixteen rasters were affected — only the
tray image, which has real transparency, kept its alpha.

Nothing in the repository could have seen it. The icon tests read dimensions and container
structure, and no test or hosted job builds the Tauri bundle. The generator now re-encodes, and
the colour type of every committed raster is asserted rather than trusted.

## CI at the head

`917d690ecb`, read at the exact SHA. Green: all four test shards, `gates`, `desktop shell`,
`macos 2/2`, `macos widget + bundle`, `docs site build`, `docker smoke`, `storage policy`,
`api usage`, all three `npm-global` legs, all three keyring legs, the three service legs.
Skipped, and named rather than counted: `macos control`, `structure gate`, the Windows shard
matrix placeholder.

The first attempt had one failure, and it did not belong to this unit: `macos 1/2`, on
`tests/server/memory-watchdog.test.ts` --
*serializes only an allowlisted Bun runtime provenance, omitting it otherwise (#848)* -- at 47.4s
against its own 20s timeout, with 13436 pass, 12 skip, 1 fail on that leg. That test makes eight
full `/api/system/memory` route calls and its own comment records the route costing roughly
600ms per read on shared runners, so it is timing fragile by construction. It passed at
`64b0eca2b0`, which already contained #5355 and #5356, and `917d690ecb` adds only favicon bytes
and a favicon generator. It also failed at `07e2ac9b41`, before any of this landed, and a focused
local run finishes in 377ms.

Re-running that job at the same SHA turned it green, and the aggregate `ci` check with it, so
exact-head CI for `917d690ecb` is green. The flake is real and still there: the fix is to stop the
test paying for eight route snapshots, not to widen the timeout again. That is separate scope.

## Left deliberately

- `docs-site/src/assets/logo-light.png` and `logo-dark.png` stay as they are. They are the artwork
  the vector was traced from, not derived assets.
- `og.png` stays, and carries a pre-existing mismatch worth its own scope: the configuration
  declares 1200x630 and the committed file is 1536x1024.

