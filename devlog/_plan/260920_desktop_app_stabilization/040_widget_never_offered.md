# wp5 — the widget registered, and offered nothing

## The symptom, and why it was not a signing problem

The extension installs, `pluginkit` lists it beside the system widgets, and the gallery does not
show it. The obvious reading was signing: a locally built host is ad-hoc signed, so of course the
system will not adopt its extension. That reading was wrong, and following it would have produced
a signing change that fixed nothing, because the released build is signed and notarized and the
widget is missing there too.

The actual defect is in the binary. `app/Package.swift` forced the executable's entry point:

```swift
.unsafeFlags(["-Xlinker", "-e", "-Xlinker", "_NSExtensionMain"]),
```

and `app/Sources/OpenCodexWidget/main.swift` held nothing but a comment explaining that the entry
was handled by that flag. So `OpenCodexWidgetBundle` — which `Views.swift` defines correctly,
with a display name, a description and three supported families — was never referenced by
anything, and no code ever handed it to the extension host.

Read off the shipped bundle:

```
LC_MAIN entryoff -> _NSExtensionMain
nm: SnapshotProvider present, OpenCodexWidgetBundle absent
Info.plist: NSExtensionPointIdentifier = com.apple.widgetkit-extension
            NSExtensionPrincipalClass   = (absent)
```

That combination is exactly consistent with the symptom. `pluginkit` registers from the
Info.plist, which is complete, so registration succeeds. `NSExtensionMain` then looks for an
`NSExtensionPrincipalClass`, which a SwiftUI widget does not declare because Xcode's `@main` on
the `WidgetBundle` is what connects it instead. Nothing errors. The gallery simply has no
configuration to offer.

## The fix

`main.swift` calls the entry that `@main` expands to, and the linker override is gone:

```swift
if #available(macOS 14, *) {
    OpenCodexWidgetBundle.main()
}
```

SwiftPM cannot use `@main` here — `@main` and a `main.swift` in the same target are mutually
exclusive — so the call is written out. After the change the entry is the Swift `_main` and the
bundle's symbols are in the binary.

`tests/clients/desktop-widget-entry.test.ts` holds this: no linker entry override in the manifest,
`main.swift` importing WidgetKit and calling `OpenCodexWidgetBundle.main()`, and the bundle in
`Views.swift` actually carrying a widget. It was driven red by reinstating the override.

## The signing defect underneath it

Fixing the entry point does not make a *released* widget adoptable on someone else's machine,
because the release pipeline never signed it.

`.github/workflows/release.yml` ran `build-widget.sh` with no `env:` block. `MACOS_SIGN_IDENTITY`
was set one step later, on the Tauri build, which never reads it. So the script took its
`codesign --force --sign -` branch every time, and the bundler does not re-sign anything under
`PlugIns/` — its nested-code walker handles `.framework`, `.xpc` and `.app`, not `.appex`. Every
release therefore shipped an ad-hoc extension with no team identifier inside a Developer ID host.

Three changes:

- The certificate is imported into a temporary keychain in a step **before** the widget build, and
  the keychain is deleted in an `always()` step so it cannot outlive a failed job.
- The widget build receives `MACOS_SIGN_IDENTITY`, and `build-widget.sh` now signs with
  `--options runtime` as well as `--timestamp`, both of which notarization requires.
- A step after the widget build asserts the result rather than printing it: strict verification,
  the configured team identifier, the runtime flag, and a secure timestamp. Without a configured
  team it says so and skips, so a fork's build still works and still cannot pretend to be signed.

This half cannot be proven here. It needs maintainer-held credentials, and the proof is a
notarized artifact installed on a machine that did not build it, launched once, with the gallery
then checked. That is recorded as the outstanding verification rather than claimed.

## Acceptance

The entry-point half closes when the locally built widget appears in the gallery on this machine.
The signing half closes when a release build's extension reports the team identifier, the runtime
flag and a timestamp, and a clean install offers the widget.
