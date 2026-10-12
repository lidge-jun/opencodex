# 150 — Closeout

Every lane in this unit is on `dev`, and `dev` is green at `71d02e3619` with the aggregate
`ci` check passing. This records what landed, and the two findings worth carrying forward.

## What landed

| Change | Commit |
|---|---|
| Lane A — CLI resolve and stop contracts (#5383) | `c2a4b1`-era, see 090 |
| Lane B — desktop shell (#5384) | see 090 |
| Lane C — ownership state (#5386, #5400, #5406) | `2fb2dfb947` and follow-ups |
| Lane D — dashboard consent surface (#5387) | see 090 |
| Lane E — release pipeline (#5388, #5405) | `34ddb4d5fd` and follow-up |
| Lane F — installed gate and Linux updates (#5391) | see 090 |
| Bootstrap surface as one page the policy can name (#5445) | `1e233a4bd1` |
| Tray usage popup, glass surface, widget vocabulary (#5452) | `8f94a6fee9` |
| Tray left click reaches the popup (#5462) | `f2ebc5a8d6` |
| Startup surface cannot wait forever (#5451) | `71d02e3619` |

`#5436` by JayYun98 was carried rather than merged and is closed as superseded, with the
`Co-authored-by` trailer on the branch so the attribution survives the squash. Issue `#5416`
is closed by `#5445`.

## The popup surface, and the constant that holds it together

The popup uses the native material on macOS (active HUD window, 12-point radius) and Acrylic on
Windows, both through Tauri's own effects builder. Linux stays opaque because blur there belongs
to the compositor.

That asymmetry is the whole design problem. A transparent stylesheet on an opaque window does not
degrade gracefully — it paints a hole where the panel should be. So the platform verdict is a
single `cfg` constant, `VIBRANT_SURFACE` in `desktop/src-tauri/src/popup.rs`, and it drives both
the transparent native builder and the `data-tray-vibrancy` attribute the page selects on. Neither
side restates the other.

Nothing in either toolchain connects a Rust constant to a CSS attribute selector, so
`tests/gui/gui-tray-vibrancy-surface.test.ts` reads `popup.rs` and `tray.css` together and fails
if they drift. Transparent windows on macOS also require the `macos-private-api` feature and
`app.macOSPrivateApi`; that forecloses Mac App Store submission, which this Developer ID DMG
channel does not use.

## The defect static review could not see

The popup shipped in `#5452` with a left-click handler that could never run to a visible effect on
macOS or Windows.

`tray-icon` calls `NSStatusItem.setMenu` whenever a menu is attached. AppKit then pops that menu
on mouse-down, before the crate's own click handler — the one that reads `menu_on_left_click` —
is reached. `show_menu_on_left_click(false)` sets an ivar that never gets consulted. The menu item
that opens the popup was Linux-only, so on the two platforms where the icon click *is* the
interaction, there was no way in at all.

Every reading of the code says it works. The handler exists, the event fires, and the wrong
surface simply appears on top of the right one. It took building the bundle and clicking the icon.
The fix makes the menu item unconditional and anchors it on the tray icon's rect;
`show_menu_on_left_click(false)` stays because it does what it says on Windows.

Two smaller things fell out of the same round. `cargo fmt --check` had been failing, and it gates
clippy and the Rust tests, so neither had run on the popup since it landed on its branch — a
clippy error was waiting behind it. And React Doctor is configured with no comment, no review
comment and no commit status, so its nine blocking findings existed only inside a job summary
nobody opens.

## Carried forward

**The bundle can ship a stale app.** `bundle/macos/OpenCodex.app.tar.gz` is not refreshed by
`build:local`, so a directory holding a fresh DMG can hold a day-old archive beside it. Local
verification has to take the `.app` out of the DMG. The same class already bit the sidecar:
`prepare-sidecar` builds the standalone binary only when the file is missing.

**A freshly compiled standalone binary is killed on macOS** until it is re-signed with
`codesign --force -s -`; from the parent that looks like "exit no exit code".

**The installed gate refuses a symlinked prefix.** Running the bundle from a temporary directory
is rejected because that path resolves through a symlink, which is correct and worth knowing
before blaming the build.

**Windows installed-bundle verification is still blocked.** The verification machine has no
interactive login session, so `link.exe` dies with `0xc0000142`. That needs credentials.

**`macos 1/2` sits close to its budget.** `platform-macos` allows 20 minutes and recent runs took
8, 13 and 14; one run crossed the line and GitHub reported the expiry as a cancellation, which
reads like infrastructure noise and is not. Rerun that job rather than widening the limit —
`gh run rerun --failed` does not act on a cancelled job, so it needs `--job`.

**`privacy:scan` never runs on the commits that add devlog content.** The scan lives in the
`gates` job, and `gates` is gated on the `ci` paths filter, whose allowlist does not include
`devlog/**`. A devlog-only change therefore skips it and the aggregate check still goes green.

That is the one change class where the scan matters most. `AGENTS.md` says reading `devlog/` is
"what makes a public devlog safe rather than merely visible", and this pull request — which adds
sixteen devlog files to a public repository — was proven only by a hand sweep for addresses, mesh
names, accounts and absolute user paths. The fix is not to add `devlog/**` to `ci`, which would
start the cross-platform suite for a prose edit; it is to give the privacy scan its own trigger,
the way `docs-site/**` already has its own build gate. Raised separately.
