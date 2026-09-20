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

## The fix, and the wrong turn on the way to it

The first attempt was to delete the linker override and call the bundle from `main.swift`. That
made the bundle's symbols appear in the binary and did not work either — it replaced a silent
failure with a loud one. Every launch died:

```
EXC_BREAKPOINT (SIGTRAP)
  ExtensionFoundation  closure #1 in ... _EXRunningExtension._shared
  ExtensionFoundation  MainActor.assumeIsolated
  ExtensionFoundation  _EXExtension.bootstrap(with:)
  WidgetKit
  OpenCodexWidget      main
chronod: [com.opencodex.desktop::com.opencodex.desktop.widget] query failed - will try lazy
         reload later
```

Seventeen crash reports accumulated in `~/Library/Logs/DiagnosticReports` while the gallery stayed
empty, because `chronod` asks the extension for its descriptors and the extension never survives
long enough to answer.

**The extension needs both halves of what Xcode does, and each is useless alone.** `@main` on the
`WidgetBundle` is what keeps it in the binary; `-e _NSExtensionMain` is what makes the process
start as an extension rather than as a program. The original code had the second without the
first, this branch briefly had the first without the second, and only both together produce a
widget the system will talk to. With both in place the crash reports stop at zero and `chronod`
processes the extension normally.

`tests/clients/desktop-widget-entry.test.ts` asserts both, plus that no `main.swift` has come back
to compete with `@main`, and that the bundle carries a widget with a display name rather than an
empty body — the same failure by a third route.

The deployment target moved to macOS 14 at the same time, which drops the per-declaration
`@available(macOS 14, *)` guards and puts the binary's `minos` at 14.0, matching every working
widget on the machine this was measured on.

## The sandbox is not optional

While narrowing this down, the extension was rebuilt without `com.apple.security.app-sandbox` to
test whether the sandbox was implicated. It is required, and the system says so plainly:

```
pkd: Ignoring mis-configured plugin at [.../OpenCodexWidget.appex]: plug-ins must be sandboxed
```

An unsandboxed extension is not rejected at launch — it is never registered at all, so it vanishes
from `pluginkit` entirely. That also settles the snapshot path: the host writes into
`~/Library/Containers/com.opencodex.desktop.widget/Data/...` precisely because the extension reads
its own container, and that arrangement has to stay.

## What the public record says about this failure

The `_EXRunningExtension` crash is not unique to this repository, and finding the precedent
changed how much of the fix is guesswork. A forensic report on macOS 26.5 with Swift 6.3.2
describes the same trap from the same cause — a widget extension assembled from a SwiftPM
`.executableTarget` and wrapped into an `.appex` by hand — and records that neither Info.plist
shape avoids it, because SwiftPM has no app-extension target and therefore never applies the
entry-point setup Xcode's WidgetKit template provides. That project's resolution was to stop
using SwiftPM for the extension and build a real Xcode app-extension target instead.

Two other projects keep SwiftPM and supply the missing pieces by hand, which is the route taken
here: the linker entry (`-Xlinker -e -Xlinker _NSExtensionMain`) and the compiler's
extension-only mode (`-application-extension`, which is what Xcode spells
`APPLICATION_EXTENSION_API_ONLY`). Both are now set, and the extension launches and answers
`chronod` without a crash report.

Three things the same record settles that were open questions here:

- **Ad-hoc signing does not prevent gallery appearance.** Developer ID and notarization matter for
  Gatekeeper, not for gallery mechanics. The containing app does have to be launched once after
  installation, which is what makes the first-run behaviour in this branch load-bearing for more
  than the menu bar.
- **App Groups do not work under ad-hoc signing**, and the documented fallback is exactly what
  this repository already does — the host writes into the extension's own container.
- **`CFBundleVersion` must match between host and extension** or WidgetKit rejects timeline
  reloads. Verified on the installed bundle: both read 2.61.0.

If the gallery still refuses this extension after the entry point and the extension-only build,
the remaining known cause is the Xcode app-extension target itself, and that is a larger change
than this unit: it means adding an Xcode project for the widget and building it with
`xcodebuild` rather than `swift build`.

## The signing defect underneath it

Fixing the entry point does not make a *released* widget adoptable on someone else's machine,
because the release pipeline would not sign it.

`.github/workflows/release.yml` ran `build-widget.sh` with no `env:` block. `MACOS_SIGN_IDENTITY`
was set one step later, on the Tauri build, which never reads it. So the script took its
`codesign --force --sign -` branch, and the bundler does not re-sign anything under `PlugIns/` —
its nested-code walker handles `.framework`, `.xpc` and `.app`, not `.appex`.

**This has not harmed a release yet, and the reason matters.** No release has ever published a
macOS application: the last three carry no desktop assets at all, and the signing secrets did not
exist until after the most recent one was cut. `MACOS_SIGN_IDENTITY` reads a secret that was not
there, so the real-signing branch has never executed and the Developer ID path in the Tauri step
has never executed either. The bug is a mine rather than a crater — the next release is the first
one that would step on it. Saying otherwise would be inventing a history this repository does not
have.

**Signing one path is also not enough.** A bundler that did not place a file does not sign it, and
picking binaries by file extension misses the ones that have none. The durable form of the check
is to find Mach-O files by their magic bytes and require every one of them to carry the release
identity, rather than naming the paths that are expected to exist.

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

## The menu bar had the same shape of problem

Start at Login was purely opt-in. Nothing enabled it on first run, so an install left the user
with a menu bar item only for as long as the app happened to be running — and a menu bar app that
is not running has no menu bar item. After a reboot the app was simply absent.

`first_run::apply_start_at_login_default` enables it once per installation, keyed on a marker in
the app config directory, and runs before `tray::install` so the tray checkbox reads the state it
leaves behind. The marker is written before the login item is touched and is never removed, so a
user who turns the setting off keeps it off. Writing afterwards would let a failed enable retry
every launch and eventually flip the setting back under someone who had deliberately disabled it.

The marker distinguishes a fresh install from a user who opted out, but it cannot distinguish
either from an install that predates the marker. The desktop shell and the widget both landed the
same day this was written and no release tag contains them, so there is no such population; if
that changes, this needs a migration rather than a marker.

## What was verified here

Rebuilt, installed to `/Applications`, and launched:

```
LC_MAIN entryoff 5656 -> _main                    (was _NSExtensionMain)
nm: _$s15OpenCodexWidget0abC6BundleV4bodyQrvpQOMQ  present
pluginkit: com.opencodex.desktop.widget re-registered, parent bundle resolved
~/Library/Application Support/com.opencodex.desktop/start-at-login-claimed  written
~/Library/LaunchAgents/OpenCodex.plist                                      created
```

So the entry point is connected and the login item is registered, both on a real install rather
than in a test double.

## Verdict: it appears

The gallery was opened on this machine after the fix and OpenCodex is in it, between OKX and
PASS, with all three declared families rendering real data rather than placeholders:

```
com.opencodex.desktop::com.opencodex.desktop.widget:OpenCodexWidget:systemSmall
com.opencodex.desktop::com.opencodex.desktop.widget:OpenCodexWidget:systemMedium
com.opencodex.desktop::com.opencodex.desktop.widget:OpenCodexWidget:systemLarge
  "OpenCodex — Proxy status, today's usage, and quota at a glance."
```

Small shows the token count for the day, medium adds requests, cost and the account quota rows,
large adds the 24-hour per-model timeline. The list icon is the mark generated from `icon.svg`.

That settles the whole question the acceptance note left open, and it settles it the right way
round: the extension was never rejected by signing or by the sandbox. It had no widget in it, and
then it had one that could not start. Both are fixed, and the fix is a SwiftPM configuration
rather than the Xcode app-extension target the public record recommends — so the cheaper route
does work, provided all three of `@main`, the `_NSExtensionMain` entry and
`-application-extension` are present.

## Acceptance

The entry-point half is closed by the gallery observation above. The signing half closes when a
release build's extension reports the team identifier, the runtime flag and a timestamp, and a
clean install on a machine that did not build it offers the widget. That second half needs a real
release and is recorded as outstanding.
