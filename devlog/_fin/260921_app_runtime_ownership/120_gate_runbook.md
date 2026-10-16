# Operating the installed-artifact gate

The gate from D9 part two lives in `.github/workflows/desktop-installed-gate.yml` with its
drivers under `desktop/scripts/`. It installs the real desktop artifact on one GUI machine
per platform, drives the ownership contract from `080_decisions_round2.md`, and uploads a
JSON report per job. This page is the operator procedure for its first live run. Registering
the runners is a maintainer action; nothing here is automated yet.

## Runners

One self-hosted runner per platform, each with a live GUI session (the gate drives real
windows and tray menus):

| label | machine needs |
| --- | --- |
| `opencodex-gate-macos` | macOS with a desktop session; the app's tray automation uses System Events, so the runner account needs Accessibility permission for `osascript` |
| `opencodex-gate-windows` | Windows with an interactive session; PowerShell and `msiexec` (system), Git Bash for the workflow shell |
| `opencodex-gate-linux` | A desktop session with a working tray (an AppIndicator/StatusNotifier extension on GNOME), `systemctl --user`, and non-interactive dpkg rights for install/remove (`sudo -n dpkg -i/-r`) |

Every runner also needs `gh` (artifact download) and `npm`/`node` (the gate stages the npm
runtime itself). Bun comes from the workflow's own setup action.

Two protections are part of the design, not optional hardening:

- Restrict each runner group so only this workflow can land on these machines.
- Add required reviewers to the `opencodex-desktop-gate` environment. Every dispatch then
  waits for a maintainer approval. The jobs check out the protected `dev` branch for the
  driver code — never the dispatched ref — so an approval is a review of inputs, not of
  smuggled code.

## GUI hooks

OS automation cannot reach everything the contract needs: the in-page consent dialog, the
Windows and Linux tray, and the deb update's elevation prompt. The operator installs audited
executable files in a hooks directory on each runner and sets the repository or organization
variable `OPENCODEX_GATE_HOOKS_DIR` to that directory. Dispatch inputs then select hooks by
file name only:

| input | the hook answers |
| --- | --- |
| `consent-hook` | the takeover consent prompt (accept) |
| `tray-click-hook` | left-clicks the tray icon |
| `tray-quit-hook` | opens the tray menu and chooses Quit |
| `tray-check-hook` | chooses Check for Updates (Linux update phases) |
| `tray-install-hook` | chooses the enabled Install update item (Linux update phases) |
| `elevate-accept-hook` | answers the deb update's authorization prompt, driving the accept path |

macOS has built-in defaults for the tray actions; Windows and Linux have none on purpose —
without a hook, the phase that needs it fails with a diagnostic rather than guessing. Hook
files run directly, never through a shell, and the workflow accepts names, never command
text.

## Running it

The gate is `workflow_dispatch` only. Inputs:

- `version` (required): the release whose artifacts are verified, e.g. `2.62.0`. The release
  must already exist with its desktop assets and updater signatures attached.
- `from-version` (required): an older release, strictly lower by semver. It stages the npm
  runtime that the app takes over and, on Linux, is the version the update phases start
  from.
- the hook names above, as needed per runner.

Artifacts come from the GitHub release itself, so the sequence is: publish (or draft) the
release, then dispatch the gate against it. Wiring publication to wait for a green gate is
lane E's release.yml surface and is tracked there.

A run that finds the machine dirty refuses before touching anything: an existing service
registration, a default-home state file, a running app, or a dormant installed package all
fail `preflight-isolation`, and a refused run makes zero mutating calls. Clean the machine
or use another one; do not retry until the probe goes green.

## Reading the report

Each job uploads `installed-gate-report-<job>` (also on failure). The JSON lists one entry
per phase with `status`, `detail` and `evidence`, in contract order:

`preflight-isolation`, `runner-readiness`, `stage-npm-runtime`, `install-artifact`,
`launch-and-take-over`, `runtime-identity`, `close-gesture`, `quit-gesture`,
`relaunch-consent`, `tray-quit-drains`, `update-verify` (Linux only), `cleanup`.

The first failing phase stops verification; cleanup always runs and its own failure fails
the report. `ok` is true only when every phase ran and passed, so a report that crashed
midway is red even if everything recorded is green. When a phase fails, its `evidence`
carries the observed state (healthz bodies, ownership records, elevation sightings, digests)
needed to tell a product defect apart from a runner problem.

Until the takeover and consent lanes land, the takeover and gesture phases fail against
current behavior — that is the gate doing its job, and the report names which contract item
failed.
