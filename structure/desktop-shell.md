# Desktop shell

The `desktop/` tree owns the Tauri v2 OpenCodex desktop shell. Its Rust crate
discovers the loopback proxy, lazily retries management authentication, starts
the bundled `ocx` sidecar only when the configured endpoint is unreachable,
and owns the tray, autostart, single-instance, and window lifecycle behavior.

`desktop/ui/` is the startup surface. Once the runtime reports healthy the shell navigates the
webview to the proxy's loopback dashboard (`/#/usage`) rather than bundling or serving `gui/dist`
itself. The page renders what the shell tells it and probes nothing on its own; it asks
`startup_phases` for the state list rather than restating it, takes the current state from
`startup_snapshot` on load because the first states finish in milliseconds, and then follows the
`startup-phase` event. `startup_snapshot` always answers with a state; it used to be able to
answer with nothing, and the page returns early on a falsy progress, so the one case it could not
render — a shell with no startup state — arrived as silence rather than as a diagnostic. A shell
that cannot find its own startup state now reports that as a failure the user can read and copy.
It uses no `alert`, `confirm` or `prompt`: the embedded webview implements
none of the matching WKUIDelegate panel methods on macOS, so a platform dialog is declined without
drawing anything.
`withGlobalTauri` is on so that page can invoke without a bundler. Only the local app origin
carries a capability, so the loopback dashboard reaches no command: `capabilities/default.json`
declares no `remote` entry, and Tauri checks the ACL for any invoke from a non-local origin.

## Startup, quit and the tray

The window is created and shown before anything is registered, resolved, probed or started, and
`desktop/src-tauri/src/startup.rs` runs the whole sequence inside it as named states —
registering, resolving, probing, attaching or starting, waiting, then ready or failed — under one
30-second machinery deadline. Waiting for takeover consent suspends that budget; consuming the
answer extends the shared deadline before clearing the prompt. Calls use the remaining budget.
The failure state carries a retry, the
child's exit code and a copyable diagnostic naming the state, the endpoint, the configuration home
and the runtime's last output; `desktop/src-tauri/src/sidecar.rs` consumes the spawn event stream
into that record instead of discarding it, which is what makes an immediate sidecar exit
distinguishable from a slow start. The page asks for the state list and the run's progress rather
than reconstructing either, because the early states finish faster than a listener can attach.

The deadline is a promise that the screen stops changing, so something keeps it when the run does
not. The sequence publishes its first state before any lookup that can fail, and a guard bound to
that run reports a terminal state for it if the run returns without one or outlives the ceiling.
The guard checks consent and publishes expiry under the same lock. Terminal reports also reject
late progress and dashboard navigation, so a resumed probe cannot reopen a prompt after failure.
State publication and its synchronous event dispatch share a reporting gate, acquired before the
state lock and released before any await. An already accepted progress event cannot overtake failure.
The guard is idempotent and generation-scoped: it will not overwrite a result the run reported,
and one left over from an earlier run will not fail the retry that replaced it. It waits a short
grace past the ceiling so the run's own failure, which names the endpoint, the home and how the
child ended, is the diagnostic on screen rather than the guard's thinner one.

"Has not started" is a state of its own rather than the first phase. The sequence's state used to
be seeded with `registering`, so a shell that never began rendered exactly like one that had just
begun — on the surface whose whole job is to tell those apart. `not-started` is deliberately
absent from the phase list the page draws its checklist from: it is the absence of a run, so a row
for it would be a step that never completes.

The shell resolves nothing itself. Resolving runs the bundled `ocx resolve --json` and reads one
`ocx-resolve/1` document: the configuration home, the effective port, and a liveness verdict with
three answers rather than two. `live` enters the ownership and takeover-consent decision below;
`absent-proven` means every
recorded and configured endpoint was definitively dead, and **only that authorises starting a
runtime**. Everything else is unknown — a non-zero exit, a timeout, output that will not parse, a
schema this shell does not know, a missing binary — and unknown fails the state with a diagnostic
and a retry. It is never read as absence, because that reading is what put a second proxy next to
the one already running. This replaces a file that read `runtime-port.json`, fell back to 10100 and
started there, so a user with a configured `config.port` was started on a port they had not
chosen; the probe budgets that decision needs live in the CLI, where they were tuned.

Registering runs first, before the runtime is touched. A login launch starts hidden, so a tray
installed only after a successful start would leave a failed start with no window and no icon. The
login item is registered in that state too, before the tray, so its Start at Login checkbox reads
the state first run leaves behind. A launch carrying the `--autostart` argument that the login
item passes back is the only one that starts hidden, and only where there is a tray to hide in: a
manual launch shows its window before the sequence begins, a login launch after the tray verdict.
Registering happens once per process, so a retry re-runs only the runtime half and cannot build a
second tray icon with its own refresh loop.

`desktop/src-tauri/src/exit.rs` owns what ends the process. Where there is a usable tray, closing
the window and the platform's quit gesture both hide; only the tray's Quit asks to end, and an
installed update asks for a coordinated restart. Where there is no usable tray, closing the window
is the quit. macOS needs one thing beyond the event loop: Tauri's default menu carries a predefined
Quit wired to Cocoa's `terminate:` and the pinned tao raises no cancellable event for it, so
`desktop/src-tauri/src/menu.rs` rebuilds that menu with an ordinary item on the same accelerator.

Every ending drains first, and so does the tray's Stop, which is not an ending: all of them take the
same phase, so Stop pressed twice, Stop then Quit, and Stop during an update are one execution over
one child rather than several racing. Ownership is re-established at the start of each drain rather
than read off a flag — the pid the endpoint reports has to be the child this app started — because
between the spawn and now the child can have exited and a service can have taken the port back, and
an owner's stop sent to that listener is a stop sent to somebody else's runtime. A listener that
cannot be identified is left alone.

A runtime counts as gone only when the child reports its own exit or the endpoint refuses a
connection; a timeout or an unauthorized reply is not proof. The stop itself is the bundled
`ocx stop --json`, not a management call from inside this process: the CLI's stop owns the
receipt-backed teardown, the drain, the Windows respawn verification and the client-configuration
restore, and an in-process endpoint cannot own its own teardown because launchd and systemd can
terminate the request handler during self-unload. The shell reads that run's `ocx-stop/1` summary
rather than inferring it, and treats a stop as done only when the CLI reported exit 0 **and** that
no proxy of this home is left running. A service that failed while the proxy happened to stop
satisfies the second and not the first, and it is exactly the case that may respawn the runtime a
moment later. Nothing kills the child.

A drain that does not complete within `DRAIN_DEADLINE` is **not** recorded as a drain. It becomes
`DrainFailed`, and an unidentifiable runtime becomes `OwnershipUnknown`. A user's quit still
proceeds from either — refusing to close when the user asked is the worse answer, and a standing
runtime is recoverable with `ocx stop`. A coordinated restart does not: coming back onto a runtime
that was never stopped puts the user on the old version while they believe they upgraded. A runtime
this app did not start is never stopped. A quit that arrives while the sequence is starting one is
held: the coordinator reserves the spawn rather than holding its lock across process creation, and
the quit is deferred until the child is owned and then drains it.

An in-app update downloads and signature-checks the package, confirms who owns the running runtime,
drains it and confirms the child is gone, and only then installs. The order is not cosmetic: the
pinned updater's Windows installer hands off to the installer process and ends this one, so a
restart asked for after `install` is never reached, and the package would be replaced under a
runtime still serving out of those files. A drain that did not complete refuses the install and
leaves the update pending.

The window may navigate to the `tauri://` scheme, to the loopback endpoint the sequence resolved,
and on Windows to `tauri.localhost`, which is where the pinned Tauri serves the app itself because
wry needs an http origin there. That is the one host and no port — not localhost generally, and not
a widening of what the loopback dashboard may reach.

`desktop/src-tauri/src/proxy.rs` is the local management client and has its own network policy,
separate from the updater's download client. It refuses redirects and system proxies, and it will
not send the management token until it has confirmed, from the unauthenticated health body, that the
instance answering is the one the shell bound to: the marker, the pid, and the port it addressed.
The binding carries a generation, so a request authorised under an earlier binding is not authorised
after the shell rebinds.

`desktop/src-tauri/src/tray_availability.rs` asks the session bus whether
`org.kde.StatusNotifierWatcher` reports a host registered; macOS and Windows answer yes without a
probe. Neither construction success nor the watcher's mere existence is the question — the pinned
Linux backend creates an AppIndicator and reports success with no host attached, and a watcher with
no host accepts registrations and draws nothing. Until the probe answers, Linux assumes no tray, so
a window closed in the first moments quits rather than vanishing, and the verdict is published only
once an icon actually exists — a tray that fails to build is a session with no tray, not a claimed
one. Where the answer is no, no tray icon is claimed, the window is shown on launch whatever the
launch origin, and closing it quits through the same drain. The update controls live in the tray
menu, so a session without one checks for updates in the background and has no place to install
them from.

Every tray menu setter dispatches to the main thread and waits for it, and the tray is built on the
main thread while holding the menu mutex, so the handles are copied out from under that mutex before
any setter is called. Holding it across a setter is a cycle, and the symptom would be an app that
stops answering Quit.

## Runtime ownership, from the app's side

`desktop/src-tauri/src/identity.rs` holds this installation's own install id: an opaque value minted
once into the app's config directory and never rewritten, exclusively so two launches racing each
other answer to the same one. It exists because the recorded claim names the owning *installation*,
so the app needs a value of its own to compare against; an id kept only in the shared record would
be whoever wrote it last, and a reinstalled app could not tell its own prior consent from another
installation's. The cost is that a reinstall which keeps the directory keeps its consent and one
that loses it asks again.

`desktop/src-tauri/src/ownership.rs` mirrors the claim, the three answers a read can give and the
comparison, all of which are defined by
[background-service runtime ownership](runtime.md#background-service-runtime-ownership) and not
here. The shell does not read the record: resolving a claim means reading every state path and
failing closed on an unreadable one, on a corrupt anchor and on paths that disagree, and a second
weaker implementation of a question core already answers is the mistake this tree has made before.
The bundled CLI answers ownership and takeover compatibility through `ocx resolve --json`.
Unknown ownership never means "nobody owns it". A supported offer shows the endpoint, home
and owner. After consent, the shell resolves again and refuses a changed answer without
invoking stop. It passes the approved token, endpoint and PID to the CLI's opt-in guarded stop.
That command checks the evidence and manager-to-PID binding under its ownership mutation lease
before action; it stops the manager or approved PID, waits within a bounded deadline for PID
exit and endpoint silence, and only then requires definitive manager inactivity. A manager
that remains active or becomes unreadable produces terminal `manager-still-active`, not a stop
receipt. The shell also treats `approval-changed`, unreadable output and child timeout as
terminal before its own silence wait or claim. Only parsed `stopped` or validated exit-79
`history-incomplete` proceeds to the refused-probe receipt and `ocx service claim`, which
rechecks the approved subject and compatibility. Declining attaches as a guest; a failed claim
does not pretend a stopped runtime was restored.

### Desktop runtime ownership acceptance

The consent surface labels the exact ownership subject it is about to record. A relaunch of the
same desktop installation reuses consent when the recorded `owner` and app-local `installId`
still match; the generation is deliberately not part of that comparison, because the recorded
claim this app holds is its own consent, not a freshness token.
Package update and service repair also preserve that grant and its generation ceiling through
`preservedConsent`; they do not perform a new subject comparison. The write path is stricter than the relaunch
path: a different `owner`, different `installId`, moved `consentGeneration` or unreadable ownership record is not reuse
there — a pending approval is revalidated against the full
subject, so a grant, a release or a re-grant that moved the generation between the prompt and
the write cannot be claimed by the stale approval. On relaunch the same list narrows to the
comparison itself: a different `owner` or `installId` makes the app ask again, and an
unreadable record refuses closed rather than reading as unowned.
Uninstall or an explicit handback releases only the live claim and keeps the generation
ceiling, so a later grant cannot be mistaken for the old one. A runtime still attached to an
old package-owned registration is only attachable as a guest until an ownership-aware CLI
records protocol support; the shell must not treat that attachment as durable takeover consent.

`desktop/src-tauri/src/first_run.rs` turns Start at Login on once per installation,
before the tray is built so its checkbox reads the resulting state. A menu bar app
that is not running has no menu bar item, so leaving autostart off by default left an
installed app absent after a reboot. The marker in the app config directory is written
before the login item is touched and is never removed, so a user who turns the setting
off keeps it off; writing it afterwards would let a failed enable retry on every launch.
The behaviour is not macOS-only — the autostart plugin implements the Linux autostart
entry and the current-user Windows Run registration too.

The WidgetKit extension in `app/` needs three things that Xcode's app-extension target
would supply on its own, and SwiftPM has no such target: `@main` on
`OpenCodexWidgetBundle`, the `-e _NSExtensionMain` linker entry, and
`-application-extension` — the compiler spelling of `APPLICATION_EXTENSION_API_ONLY` — all
in `app/Package.swift`. Any one missing yields a widget that never appears: without
`@main` the linker drops the bundle and the extension registers with nothing to offer, and
without the entry override ExtensionFoundation traps during bootstrap. Nothing observable
distinguishes these from a working widget, because the bundle still builds, signs and
registers. `com.apple.security.app-sandbox` is also mandatory — `pkd` refuses to register
an unsandboxed plug-in at all — which is why the shell writes its snapshot into the
extension's own container rather than a shared App Group, which ad-hoc signing cannot use.

`desktop/scripts/prepare-sidecar.ts` maps Rust target triples to the standalone
Bun targets and prepares the external binary plus dashboard resources used by
Tauri. Generated files under desktop/src-tauri/binaries/ and
desktop/src-tauri/resources/ remain ignored.

The management API companion presence check in
`src/server/management/companion-routes.ts` accepts both
`OpenCodexMenuBar/` (legacy Swift companion) and `OpenCodexDesktop/` user agents.
This is presence telemetry only; management
authentication remains in the shared API boundary.
The desktop webview uses a Mozilla-compatible `OpenCodexDesktop/` user-agent
marker, which the GUI detects to identify the shell without using IPC.

## Release packaging and updater

Linux AppImage packaging uses `desktop/scripts/appimage-patchelf.py` to preserve
the compiled Bun CLI when linuxdeploy sets the executable RPATH. Only the exact
AppDir sidecar, still byte-identical to the prepared CLI, is exempt; other ELF
operations use the system patchelf. `desktop/scripts/verify-linux-sidecar.sh`
extracts the completed AppImage, compares its CLI bytes and runs its version command
on the hosted runner before any release asset is collected.
The macOS release combines both prepared CLI architectures with `lipo` into the
universal external binary Tauri expects, and checks that both slices are present.

The release workflow packages the desktop shell as `OpenCodex-<version>-macos.dmg`,
`OpenCodex-<version>-windows-x64.msi`, `OpenCodex-<version>-linux-x86_64.AppImage`, and
`OpenCodex-<version>-linux-amd64.deb`. Each artifact is collected with a `.sha256` file;
signed updater artifacts also carry `.sig` files. A pre-publication verification job
combines the standalone and desktop assets, derives the expected file set from the
packaging matrices, verifies every checksum and every updater signature, and writes
`latest.json` only when the updater key secret is configured, requiring all four
platforms to have updater signatures. Publication waits for that verification, and the
attachment job uploads the verified bundle only after the verification receipt names
the same version and commit.
Updater signature verification decodes Tauri’s outer-base64 minisign box, checks the
`ED` signature over the BLAKE2b-512 digest against the pinned key, and verifies the
trusted-comment signature. Missing or malformed fields fail before publication.
On macOS, in-app updates download `OpenCodex-<version>-macos.app.tar.gz`; the DMG is for
the first installation.

The Tauri updater public key and endpoint are checked in to
`desktop/src-tauri/tauri.conf.json`. Private updater and Apple signing credentials are
provided only as release secrets. Windows certificate signing is not wired yet, so MSI
users may see a SmartScreen warning.

The app's own version comes from `desktop/src-tauri/tauri.conf.json` and `Cargo.toml` (mirrored
in `Cargo.lock`), not from `package.json`, and the release workflow injects none. Those files move
together with `package.json` through `scripts/release-version-sources.ts`, and the release refuses
to build when they disagree with the requested version; see `ops/docs-and-release.md`.

## Widget snapshot

The macOS desktop shell writes the WidgetKit snapshot to
`~/Library/Containers/com.opencodex.desktop.widget/Data/Library/Application Support/OpenCodex/snapshot.json`.
The schema version is `1`; the Rust writer refreshes it every five minutes after an
immediate first write. The WidgetKit appex reads this privacy-safe file and performs no
network access.

## The tray icon opens a usage popup

`app/Sources/NativeTray/` defines the macOS SwiftUI display model and AppKit panel library.
It accepts a versioned display-only snapshot and emits UI actions; it owns no network client,
runtime process or application loop. `NativeTrayTests` exercises its decoding and formatting.
The library is built separately from the WidgetKit extension.

A left click on the tray icon opens a small always-on-top window anchored to the icon, not the
dashboard. Reading the current numbers is the reason to look at a tray icon at all, and the
dashboard is still one menu item away. On Windows/Linux the web popup reuses the dashboard
session and management endpoints, with no additional IPC capability or admin token. The
macOS native collector uses the shell's existing authenticated client, described below.

Two platform facts shape it. A Linux tray host may deliver no usable click to the application,
so the same surface is reachable from a menu item there. And before the startup sequence has
resolved a runtime there is nothing to report, so a click with no proxy falls back to showing
the main window rather than opening an empty popup.

On macOS, `desktop/src-tauri/src/native_tray.rs` links the Swift library into the existing
Tauri process and borrows the existing status item's button on the main thread. A key-capable
nonactivating AppKit panel hosts SwiftUI; Apple Liquid Glass (`NSGlassEffectView`) owns its single
rounded surface on macOS 26+, with native popover material on older systems. A bounded native
scroll view keeps the header and footer reachable. This restores the keyboard-capable panel
mechanism used by the former native companion without restoring a second application or runtime owner.

The native collector uses the existing identity-bound `ProxyClient` for GET-only reads and
projects a versioned display DTO. Credentials and raw configuration never reach Swift. Closing
aborts the owned task and its bounded request group; generation and runtime-binding checks reject
late results. Swift callbacks only refresh, close, or navigate the existing dashboard window.
Native/web/widget filtering, title parity and corrupt-settings preservation follow the [companion usage contract](companion.md).

Windows keeps the Acrylic web popup; Linux remains opaque. The `VIBRANT_SURFACE` constant in
`desktop/src-tauri/src/popup.rs` connects that native webview builder to its
`data-tray-vibrancy="on"` hook. The macOS panel does not load that web route or its CSS.
The web popup constrains its document/root to the viewport and scrolls `.tray-page` inside it,
so the vibrant body's rounded clipping cannot trap the footer below a long account list.

Transparent Tauri windows on macOS require the `macos-private-api` Cargo feature and
`app.macOSPrivateApi` in `desktop/src-tauri/tauri.conf.json`. Enabling that API forecloses Mac App
Store submission; this shell ships as a Developer ID DMG, so its release channel accepts that
tradeoff.

The tray title keeps its existing period. The popup answers the detailed question, so the title
does not change meaning as a side effect of adding it.
