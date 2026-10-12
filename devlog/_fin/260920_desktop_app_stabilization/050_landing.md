# wp5 — landing the stack

## Shape

Four pull requests, each based on the one below it, all ultimately targeting `dev`:

| PR | branch | what it carries |
|---|---|---|
| #5327 | `codex/260920-app-stabilization` | release profile, stale-dist report, `build:local`, the lockfile and test-layout repairs |
| #5328 | `codex/260920-claude-desktop-mode-visibility` | the first-party reachability message |
| #5329 | `codex/260920-app-icons` | one SVG source, the generator, the renderer-free CI guard |
| #5339 | `codex/260920-widget-entry` | the widget entry point, the login-item default, release signing |

They merge bottom-up. After each one lands, the next is retargeted to `dev` and its exact head is
read again, because a squash merge rewrites the parent and the child's base disappears.

## Two repairs in here are not ours

`dev` was already red when this stack was cut, in two independent places, and both were fixed
here because every branch cut from `dev` inherits them.

`tests/providers/stepfun-provider.test.ts` landed with no entry in either inventory and no regex
seed that resolves its name, so the membership oracle failed on `dev` and on everything branched
from it. Registering it under `providers` restores the gate for everyone.

`macos widget + bundle` failed with *A public key has been found, but no private key*. The job is
an unsigned build by design, so the key is correctly absent — but the committed config sets
`bundle.createUpdaterArtifacts` and `plugins.updater.pubkey`, so `tauri build` writes the updater
archive and then refuses to finish. That half is #5338's, which turns the artifact off for that one
invocation; this stack does not duplicate it.

Fixing the build revealed the rest of the job, which had never run. Its first assertion looked for
`Contents/MacOS/OpenCodex` — `productName` — while the bundle carries `opencodex-desktop`, the
crate name. That half landed separately as #5351, and better than the version written here: it
reads `CFBundleExecutable` out of the bundle instead of restating the name, so the check follows
the config rather than drifting from it. This stack's copy was dropped in favour of it.

What remains here is the assertion with no equivalent: that the WidgetBundle is actually linked
into the extension. The appex builds, signs and registers identically with the bundle dropped by
the linker, so nothing else in this job would have noticed the defect that shipped.

Three of this stack's incidental repairs turned out to be running in parallel with the
maintainer's own: the StepFun layout registration (#5335), the widget job's updater override
(#5338), and this executable assertion (#5351). Each was dropped here once the other landed. The
pattern is worth noting for the next batch — a repair found while passing through is worth
checking against open pull requests before it is written.

## What closes this

Each merge reads the exact head's check runs rather than a rollup, distinguishes a job the event
requested from one it skipped, and treats a missing, skipped, or cancelled job as not a pass. The
last merge is followed by reading `dev`'s own push run, because five of the eight defects found in
this unit were invisible until two changes met.

## Deliberately not changed here

Review asked for the public macOS install guidance to move with the release path, since
`README.md`, `guides/desktop-app.md` and `guides/macos-menu-bar.md` all tell the reader the app is
ad-hoc signed and not notarized, while this stack makes a real release refuse to run without a
Developer ID and the full notarization credential set.

Those pages are accurate today and will stop being accurate at the next release, not at this
merge. No release has ever published a macOS application, so rewriting them now would describe an
artifact nobody can download and would leave the Gatekeeper walkthrough — still correct for a
locally built app — reading as though it were obsolete. The pages move with the first notarized
artifact, which is also when someone can check the instructions against a real download.
