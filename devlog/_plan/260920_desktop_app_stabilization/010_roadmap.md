# Roadmap — six items, four work phases

Status: LOCKED at wp1. Each later phase consumes one decade doc below and revalidates it at its
own P. The evidence in [000_local_build.md](000_local_build.md) is the ground truth; this file
turns it into an order of work.

## What the local build and run actually showed

Nothing about the usage feature was missing. `gui/dist` was five days old, so the bundle the
service served predated #5196 and could not contain the companion panel. `AGENTS.md` already says
the dashboard is served from `gui/dist` and lists `bun run build:gui`, so rebuilding after a
fast-forward was the existing procedure and skipping it was the mistake. After the rebuild the page
renders 74,974 requests, 18.66B tokens, 99% coverage, and a **menu bar and widget** section reading
"desktop app connected · just now".

That reframes the work: five of the six items are real defects, and the sixth is the guard that
stops this particular mistake from being silent.

## Order and why

| Phase | Items | Why here |
| --- | --- | --- |
| wp2 | release profile, stale dist, updater-key exit | Nothing else can be built or verified until the release profile compiles; the dist guard belongs with it because both are "the build lied about its state". |
| wp3 | Claude Desktop first-party reachability | Independent of the build, and already verified by hand, so it lands on its own evidence. |
| wp4 | SVG app icons, widget gallery verdict | Both need a signed-or-explained bundle, so they come after the build is trustworthy. |

## 020 — release profile, stale dist, updater key

`[profile.release] strip = "symbols"` is applied by cargo to build scripts and proc macros as well
as to the crate being built. A proc macro is a host dylib rustc loads by symbol, so stripping it
produces `can't find crate for ctor_proc_macro` — an error that names the macro and never mentions
the profile. `[profile.release.build-override] strip = false` is the fix, already committed with
its reason.

The stale-dist guard reports rather than repairs. The dashboard is a served artifact, so the honest
signal is "the bundle you are looking at is older than the source that produced it", surfaced where
someone will read it. Rebuilding automatically at startup would make a serving process do a build,
which is the wrong trade for a proxy.

The updater-key exit is smaller: a local build that produced both bundles should not end on a
failure line about a signing key it was never given.

## 030 — Claude Desktop first-party reachability

`resolveClaudeDesktopMode` returns `gateway` when a gateway apply marker exists, and an explicit
`desktopMode` wins over everything. Both rules are right on their own: neither should flip a
working install silently. Together they mean the help text calls first-party "(default)" while an
existing user can never arrive there without discovering `--first-party` unaided.

The fix is not to change the resolution. It is to make the choice visible at the moment an apply
happens, so a gateway apply says what it chose, that first-party exists, and how to switch.

## 040 — SVG app icons and the widget verdict

Icons today are a raster set with no vector source, so every size is an independent artifact that
can drift. One SVG source with a generation step makes the sizes derived rather than restated —
the same principle the test-layout registries follow.

The widget question is answered with evidence, not hope. The bundle carries
`PlugIns/OpenCodexWidget.appex` and the app is ad-hoc signed
(`Identifier=opencodex_desktop-b89067d97e1c189c`, `flags=0x20002(adhoc,linker-signed)`), so the
phase records whether the widget appears in the gallery under that signing and, if it does not,
what specifically rejects it.

## Constraints carried through every phase

Stacked PRs, all pushes `--no-verify`, CI tracked after the fact rather than waited on. No local
test suite. Builds and real launches are the verification, because this unit exists precisely
because a build that was never run locally was assumed to work.
