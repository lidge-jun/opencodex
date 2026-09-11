# Live service-manager guard

## What happened

A translation task took the maintainer's running proxy down four times in one night, and nobody
connected the two for hours. The immediate cause was not a test: a delegated agent wrote a long
README through a double-quoted `python3 -c` string, and the README contains inline code spans such
as \`ocx service\`, \`ocx stop\` and \`ocx service uninstall\`. Inside a double-quoted shell
string a backtick is command substitution, so those ran.

Chasing that down surfaced a second, independent hazard that had been sitting in the suite the
whole time.

## The hazard

`tests/preload.ts` sandboxes `HOME`, `OPENCODEX_HOME` and `CODEX_HOME` on every invocation,
including a bare `bun test <file>`. That covers everything addressed by a path.

A service manager is not addressed by a path. `systemctl --user stop opencodex-proxy.service`
addresses a job by name and talks to the user manager that is already running.
`launchctl bootout gui/<uid>/com.opencodex.proxy` talks to launchd the same way. Neither consults
`HOME`, so a test that falls through to either one reaches the live service however well the home
is isolated.

Windows already refused this. `querySchtasks` in `src/service.ts` throws on every non-query call
while the test-home guard is armed, after a partially-faked service test replaced a real scheduled
task with a launcher inside a temporary test home — the test passed, and cleanup deleted the
launcher. macOS and Linux never got the equivalent, which left the person most likely to run this
suite, someone running opencodex on the machine they develop it on, as the one it can disrupt.

## The change

`sh()` is the choke point rather than each call site, so a `systemctl` or `launchctl` call added
later is covered without anyone remembering to guard it. The real `runLaunchctl` runner is guarded
too, since it spawns `/bin/launchctl` directly.

Three properties keep it from being disruptive in the other direction:

- Read-only verbs stay allowed. `launchctl list`, `launchctl print`, `systemctl --user show`,
  `is-active`, `is-enabled`, `status` and `show-environment` are what the diagnostics are built
  on, and observation cannot take a service down.
- An injected `spawnSync` stand-in is untouched, so the existing `runLaunchctl` and `startLaunchd`
  parsing tests keep working unchanged.
- Arming requires `OCX_TEST_HOME_GUARD=1`, which only this repository's test preload sets, so a
  user running `ocx service restart` is unaffected.

## Verification

Local execution was skipped deliberately: the suite is what reaches a live service manager, and the
machine this was written on is running opencodex. CI on the pushed head is the evidence.

## What this does not fix

The incident that started this was an agent executing README text through a shell. This guard would
not have stopped it. That belongs to how agents write files, and it is recorded in
`devlog/_plan/260910_readme_i18n_parity/020_phase2_locale_resync.md`.
