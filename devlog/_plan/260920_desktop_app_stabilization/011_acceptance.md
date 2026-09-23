# Acceptance evidence per phase

The roadmap says what each phase does. This says what closes it, in terms of evidence that a
passing command or a rendered page does not by itself provide.

## wp2 — release profile, stale dist, updater key

**Release profile.** `cargo build --release` completes for the desktop crate. The regression is not
a test that runs cargo; it is an assertion that the release profile carries a build-override which
does not strip, because the failure mode is a profile setting and the symptom appears in an
unrelated crate. A test that only built something would pass on a machine whose rustc tolerates a
stripped proc-macro dylib, which is exactly how this reached `dev`.

**Stale dist.** The check compares the newest source timestamp under `gui/src` against the built
bundle and reports when the bundle is older. It closes when a deliberately stale bundle produces
the report and a fresh one does not. Reporting is the contract: the proxy must not start a build.

**Updater key.** A local bundle build that produced its artifacts ends by naming them, and the
missing updater key is stated as a skipped signing step rather than a failure. It closes when the
command's exit status reflects whether the bundles exist.

## wp3 — Claude Desktop first-party reachability

Closes when an apply that resolves to gateway says so, names first-party as the alternative, and
gives the exact command that switches. The resolution rules stay as they are: neither an explicit
`desktopMode` nor an existing apply marker may be overridden silently, because a working install
must not flip underneath its user.

The evidence is the apply output on a machine that already carries a gateway marker — this one.
A unit test asserting the string is not sufficient on its own, because the defect was that the
help text and the resolved behaviour disagreed, and only running the real path shows which wins.

## wp4 — SVG icons and the widget verdict

**Icons.** One SVG source exists and every raster size is generated from it by a committed script.
It closes when regenerating produces byte-identical output for unchanged input, so the sizes are
derived rather than restated.

**Widget.** The verdict is recorded either way. If the widget appears in the gallery under ad-hoc
signing, that is the finding. If it does not, the phase records what rejects it — the specific
system log line or the signing requirement — rather than reporting an absence. An unverified
"should work" closes nothing.

## What none of these accept

A green pull request is not evidence for any item here, because every one of them was invisible to
CI. The release profile failed only on a toolchain CI does not use, the stale bundle is a runtime
artifact CI rebuilds, the mode disagreement needs an existing install, and the widget needs a real
login session. Each phase therefore carries a local run alongside its hosted check.
