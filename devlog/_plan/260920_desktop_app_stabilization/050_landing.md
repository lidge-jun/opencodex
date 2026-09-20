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
archive and then refuses to finish. Selecting bundle targets does not avoid it because the flag is
config rather than a target; the invocation turns the artifact off instead, leaving nothing to sign
rather than something signed badly.

## What closes this

Each merge reads the exact head's check runs rather than a rollup, distinguishes a job the event
requested from one it skipped, and treats a missing, skipped, or cancelled job as not a pass. The
last merge is followed by reading `dev`'s own push run, because five of the eight defects found in
this unit were invisible until two changes met.
