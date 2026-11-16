# Desktop supervision

This document describes durable Desktop ownership, takeover consent and live
supervision. `src/service/desktop-supervision.mjs` (types in
`src/service/desktop-supervision.d.mts`) owns the platform supervision probe,
including Windows system-directory acquisition, and `createSupervisionLatch`;
durable ownership and consent remain with the owners described below.

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
[background-service runtime ownership](../runtime.md#background-service-runtime-ownership) and not
here. The shell does not read the record: resolving a claim means reading every state path and
failing closed on an unreadable one, on a corrupt anchor and on paths that disagree, and a second
weaker implementation of a question core already answers is the mistake this tree has made before.
The bundled CLI answers ownership and takeover compatibility through `ocx resolve --json`
(`desktop/src-tauri/src/resolve.rs`, inside the launch sequence that
`desktop/src-tauri/src/startup.rs` drives).
It also answers how the live runtime's version compares to the bundled CLI's
(`versionSkew.relation`; future relation strings read as unknown without discarding the live answer), and the shell acts on the direction instead of reparsing the
warning: `proxy-newer` makes a supported takeover a downgrade, so the run attaches as a
guest with the versions, downgrade risk and verbatim CLI warning rather than asking consent to it. Every other guest path — held
consent, an unreadable owner, a blocked takeover, a declined prompt, a recovery — appends
the CLI's warning to its phase detail, and the consent panel shows it beside the subject.
Unknown ownership never means "nobody owns it". A supported offer shows the endpoint, home
and owner. After consent, the shell resolves again and refuses a changed answer without
invoking stop. It passes the approved token, endpoint and PID to the CLI's opt-in guarded
stop (`desktop/src-tauri/src/runtime_stop.rs`).
That command checks the evidence and manager-to-PID binding under its ownership mutation lease
before action; it stops the manager or approved PID, waits within a bounded deadline for PID
exit and endpoint silence, and only then requires definitive manager inactivity. A manager
that remains active or becomes unreadable produces terminal `manager-still-active`, not a stop
receipt. The shell also treats `approval-changed`, unreadable output and child timeout as
terminal before its own silence wait or claim. Only parsed `stopped` or validated exit-79
`history-incomplete` proceeds to the refused-probe receipt and `ocx service claim`
(`desktop/src-tauri/src/claim.rs`), which rechecks the approved subject and compatibility.
Declining attaches as a guest; a failed claim does not pretend a stopped runtime was restored.

Both `ocx stop` children Desktop runs — this guarded takeover and the exit/restart drain — receive
their deadline as `OCX_STOP_DEADLINE_MS` (decimal milliseconds from the child's start), computed in
`desktop/src-tauri/src/runtime_stop.rs` immediately before the spawn: the takeover passes the
remaining startup deadline minus five seconds, kept for the silence probe and the claim that still
run under it, and the drain passes its own deadline minus three seconds for spawning and parsing.
A value that would not be positive is not set. It is an environment variable and not the CLI's
`--deadline-ms` flag because an older bundled CLI rejects an unknown flag and ignores an unknown
variable, so mixed versions keep today's behavior. The drain's `runtime_stop::DEADLINE` is 75
seconds on Windows, where a registered service's checked stop does not fit in the 30 seconds other
platforms keep. The summary's additive `serviceStopReason` (`access-denied`,
`evidence-unreadable`, `unbound-wrapper`, `unverified-budget`; an unknown string is kept and
shown as it is) and `portHeldByForeign` are optional in `StopSummary`, change no verdict, and only
append an actionable sentence to the stop's description — an elevated terminal, a retry from a
terminal, a wrapper started outside the service, unreadable process state, or another program on
the port. No `Outcome` or `Proxy` value was added, and an older CLI's document reads as before.

Live supervision is a third independent fact, alongside liveness and durable ownership.
On macOS and Linux, the read-only probe verifies that the runtime's direct parent is
`opencodex-desktop` and the child executable is that app's sibling `ocx`; two complete
process snapshots must agree. The target runtime PID, `ocx.pid`, and the PID in
`runtime-port.json` must agree wherever present; mismatches make supervision unknown.
The attestation secret is never included in supervision evidence. On Windows, `ocx.pid` and `runtime-port.json` must both name the runtime PID; its direct parent must be a live `opencodex-desktop.exe`; both images must have drive-qualified paths, with the runtime matching the Desktop image's sibling `ocx.exe` case-insensitively; parent and child must share a session; and the parent must have been created strictly before the child.
Two snapshots must agree. Each acquisition is one bounded PowerShell `Win32_Process`
read of the runtime row and its parent's row, emitted as JSON. Both snapshots share a
six-second scheduling budget. Before each acquisition, the caller requires at least
250 ms remaining and assigns the PowerShell subprocess a timeout of at most three
seconds. Synchronous system-directory resolution occurs before that subprocess starts
and has no separate timeout, so these are not hard wall-clock bounds for the complete
inspection. Process evidence is
re-read on every probe; only a successfully resolved system directory is memoized, and
only for the process lifetime, so a failed resolution keeps the retry-on-next-call
recovery contract.

The directory is resolved before the child spawns and no longer comes from the
environment. `SystemRoot`, `windir` and `PATH` are caller-supplied on this path, and
the fixed `C:\Windows` fallback they used to feed was guesswork, so either could answer
a wrong or tampered `powershell.exe`. `src/service/desktop-supervision.mjs` picks by
runtime instead: on Bun, `bun:ffi` calls kernel32 `GetSystemDirectoryW` directly; on
Node, it derives the directory from `process.report.getReport().sharedObjects` and
accepts it only when `kernel32.dll` and `ntdll.dll` each appear exactly once,
drive-qualified, under one shared parent and below the report's 260-character
module-name buffer — a namesake at the limit may already be truncated and is refused —
and only after the candidate passes F_OK existence checks for both DLLs and
`WindowsPowerShell\v1.0\powershell.exe`. The report object also carries the process's
environment values, so the resolver reads only `.sharedObjects` and never logs,
serializes, stores or forwards the report. `bin/ocx.mjs` imports this module under
Node >=18, so it keeps no TypeScript or Bun-only imports; `bun:ffi` is reached through
`createRequire` inside the Bun branch alone. The Node lane assumes the diagnostic
report enumerates each loaded DLL by path — `getReport` has existed since Node 11.8.0
(<https://nodejs.org/api/process.html#processreportgetreporterr>, field layout in
<https://nodejs.org/api/report.html>) — and is verified positively only on Node
24.18.0 / Windows x64 and Bun 1.4.4 / Windows x64; the focused tests inject the
resolver and PowerShell output, and Linux CI runs no Windows acquisition, so neither is
native evidence. WoW64, ARM64, a real Desktop-positive supervisor, compiled packaging
and live installs remain unverified.

The spawned PowerShell receives a minimal environment — `SystemRoot` and `WINDIR` set
to the system directory's parent, `PATH` to the system directory alone and a fixed
`PATHEXT` — with nothing else inherited. Its script disables module autoloading and
imports `Microsoft.PowerShell.Utility` before `CimCmdlets`, because the CimCmdlets
manifest calls `Set-Alias`, which autoload-off cannot supply; the query and the JSON
conversion stay module-qualified.

Missing pid records, an unavailable or ambiguous report, a duplicated or truncated
namesake, an FFI failure and every other inconclusive read all answer `unknown` —
retaining `desktopSeen` when a Desktop image was observed — never proven `none`, and
callers do not fail closed on plain `unknown`. A Desktop image seen inside otherwise
failed evidence keeps the block; without it, an inconclusive read can still allow an
action a complete probe would have vetoed, which is the early-warning residual the
guard table below records. Windows Start at Login is not verified, so live supervision
never grants startup protection there.

Command guards use this live evidence independently of login registration and durable ownership.
Each guarded service command, Node/Bun update run and dashboard restart decision uses one
`createSupervisionLatch()` from `src/service/desktop-supervision.mjs`: `desktop` or
`unknown` with `desktopSeen: true` blocks; only a later positive `none` clears it. A later
plain `unknown` or `unsupported` cannot clear a prior block. Without a prior block, plain
unknown and unsupported preserve the existing durable-owner and liveness decisions.
Service install, repair, start and restart refuse before mutation, including registration staging.
Update gates re-read supervision before stop, package replacement, restoration and recovery;
Orchestrated plans classify a Desktop-owned installation as `desktop-app-owned` and
refuse apply; the package launcher handles orchestrated requests before Desktop handoff.
they refuse even for a separate npm/Bun install. Use the app updater for its bundle, or quit
Desktop before updating the CLI install. Service stop and uninstall remain available.
`src/service/desktop-command-guard.ts` carries that refusal for `src/service/cli.ts`,
`src/service/orchestration.ts` and `src/service/repair.ts`; the update lanes take the same
latch in `src/update/index.ts` and `src/update/restart-ownership.ts`, the update-restart
surface in `src/cli/update-restart.ts`, and stop guidance in
`src/cli/desktop-runtime-guidance.ts`.
These decisions follow [runtime ownership](../runtime.md#background-service-runtime-ownership).

Update recovery computes the Node install argv (including its backend read) and
the Bun direct-start runtime provenance before the final mutation authorizer.
The spawn arguments then use those prepared values; in-memory argv/environment
formatting is the only allowlisted work between that authorizer and process creation.
`tests/update/update-home-launcher.test.ts` and `tests/update/update-home-recovery.test.ts`
exercise refusal when preparation changes the home observation, plus stable-home starts.

The npm install argv that `updateCommand()` (and the Node launcher's own npm self-update) builds
always carries `--allow-scripts=bun`: npm 12 blocks dependency lifecycle scripts by default, and
bun's postinstall is what unpacks the bundled runtime, so a bare global install would leave the
next `ocx` unable to start (#8361). npm 8 through 11 accept the flag on global installs, so it is
not version-gated. The npm package replacement stages beside the live tree and stops the proxy
before the swap, which is also what releases `node_modules/bun/bin` on Windows; a manual
`npm install -g` under a live proxy still fails with `EBUSY`, so doctor prints the stop, install
and restart sequence for npm-owned installs instead of attempting it.

The bypass ledger classifies these guards as **early warning**, not enforcement:

| Guard | Surface / tier | Known limit and residual risk | Pass-through assertion |
| --- | --- | --- | --- |
| Service install/repair/start/restart | CLI before mutation / E3 | Older PATH CLIs or inconclusive evidence without Desktop seen can allow a second supervisor. | With no prior block, none/unsupported preserve ordinary command behavior. |
| Node/Bun update, including pre-stop and recovery | CLI / E3 | Same limits; Desktop can start after the last check inside the stop window, leaving a short race. | None preserves the ordinary update decision. |
| Dashboard restart veto | Server route / E3 | Older runtimes lack this guard. | None preserves the ordinary restart decision. |
| Stop guidance | Notice only / E1 | Desktop may restart the stopped proxy. | `stop --json` neither probes nor emits the notice. |

When ownership is `none`, `src/service/desktop-startup.ts` can report
`supervisor: { supervisorPid, runtimePid, app }` with `owned: false`. Restart safety
credits this live supervision only when that same app's Start at Login registration is
verified, the proxy is running, and the diagnostic is fresh and viable. This evidence
never creates or changes an ownership claim; unknown ownership and CLI-owned claims do
not enter the unowned diagnostic branch. Unverified login registration produces Desktop
recovery guidance with no recommended shell command.

Older runtimes cannot report this evidence. When an attested live startup verdict has
no desktop diagnostic but a local probe verifies Desktop supervision of that live PID,
status and doctor use the shared selector's local verdict; status JSON records
`startupSource: "local-supervision-override"`. The service summary uses that selected
verdict too. On Windows, the local reading may be owned or unowned but must bind to the same runtime and supervisor PIDs; macOS and Linux require an unowned local reading. A live verdict that already carries desktop diagnostics remains authoritative.

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
The behaviour is not macOS-only. The autostart plugin implements the macOS and Linux
registrations and reads or disables the current-user Windows Run entry. Shell enables
on Windows write a quoted executable path followed by `--autostart`, preserving the
plugin's registration name and Task Manager explicit-enable semantics. A Windows-specific
launch-origin migration marker revisits older registrations once, only when already
enabled; entries disabled in the tray or Task Manager stay disabled.

The macOS tray item and the macOS side of this migration judge the login item the way Startup
safety does; see [Desktop Start at Login](../desktop-start-at-login.md).

## Headless Windows Desktop update

`ocx update --desktop` (`src/desktop-update/`) updates a Windows Desktop installation from an
elevated non-interactive session (SSH, a Session 0 service) where the tray updater cannot run.
`install.ts` admits only the compiled `ocx.exe` beside `opencodex-desktop.exe`; anything else
exits 64, and the npm/pnpm Node launcher refuses `--desktop` before any package update.
`src/cli/dispatch.ts` routes the flag to `cli.ts` before the orchestrated grammar sees `--json`, and
`src/cli/preflight-exemptions.ts` skips the shim repair for it. `cli.ts` binds `headless.ts` to the network,
filesystem, Windows Installer, the runtime record and the terminal. Every dependency of
`headless.ts` is injected; the tests drive it with fixture keys, fake timers and fake runners.

Trust is the GUI updater's. `trust.ts` restates `plugins.updater.pubkey` and its endpoint from
`desktop/src-tauri/tauri.conf.json`, and `tests/update/update-desktop-headless-release.test.ts` fails when
they differ. `release.ts` takes the feed's `windows-x86_64` entry (a differing
`windows-x86_64-msi` entry refuses), requires the exact
`github.com/lidge-jun/opencodex/releases/download/v<version>/OpenCodex-<version>-windows-x64.msi`
asset, and verifies through the strict prehashed path of `src/update/minisign.mjs`: both
signatures over the exact trusted-comment bytes, a signed `version:` equal to the announced one
when present (the pinned plugin's check), and a signed `file:` naming this version's x64 MSI (a
prerelease may use its numeric core). The bytes must open with the OLE compound-file signature.
Only a version strictly newer than the running CLI's own is installed.

`acquire.ts` admits a first hop only on `github.com` under `/lidge-jun/opencodex/releases/` and
at most three manual redirects to that prefix, `release-assets.githubusercontent.com` or
`objects.githubusercontent.com`; it refuses non-HTTPS, userinfo and non-default ports, sends no
credentials, caps the feed at 256 KiB and the installer at 1 GiB counting before each chunk is
kept, and applies 10-second connect, 30-second idle-read and 20-minute total deadlines.
Content-Length only refuses early. The transport is injected; no production setting reaches a
loopback mock.

`headless.ts` holds the home's sync/update mutex for an apply (`--check` only reads), writes the
verified bytes (`wx`, 0600) into a fresh `mkdtemp` directory, reads them back and verifies again,
renames its own running `ocx.exe` to `ocx.exe.<pid>-<ms>.update-old` in the same directory (Windows
allows renaming a running image; otherwise the installer's Restart Manager closes this process and
its console and the install rolls back), then runs `msiexec.exe /i <msi> /qn /norestart /l*v <log>`
from `trustedWindowsSystemDirectory()`
(`src/service/desktop-supervision.mjs`) and waits for its exit code (`msi.ts`). 0 is installed,
3010 and 1641 installed with a reboot pending, 1618 busy, 1602 cancelled, anything else a
rolled-back failure whose log is kept and whose moved image is renamed back when no `ocx.exe`
replaced it. After an install the moved image is scheduled for deletion at restart, and each apply
first deletes earlier ones no process still maps. An installer still running after 15 minutes is left alone
and the outcome is uncertain (exit 3). The installed `ocx.exe --version` must then equal the target;
a 3010 install still reporting the old version asks for a reboot (exit 2).

`runtime.ts` starts no runtime when none answered before the install (`installed-stopped`) and
leaves one already serving the target alone. It acts only on a runtime this home attests
(`source: "runtime"` with a pid) that is older than the target and whose Win32 image
(`windowsProcessPair`) is this installation's `ocx.exe` or an image this updater moved aside there, by asking it for its bound in-place
restart through `requestBoundSystemRestart` with `respawnRunsInstalledImage`. That option lets a
CLI-newer skew proceed because every respawn runs the installed bytes: a Desktop child exits 75
and the app starts its sibling `ocx.exe`, a service child exits for its manager, and a detached
runtime relaunches its own image. The request carries a deadline wide enough for a connected
client's own restart budget. A connected client kept by its service answers 409
`restart_supervised_service`, and the installed `ocx service restart` (which confirms a different
serving pid or exits 1) is the owner path it names; an unproven service owner is left alone. A
connected-client runtime under the app answers 409 `restart_supervised_desktop` instead; only when `inspectDesktopSupervision` proves this
installation's `opencodex-desktop.exe` supervises exactly that pid does `drain.ts` run the installed
`ocx stop --json` with `OCX_STOP_DEADLINE_MS`, as the app's own update drain does, accepting the
`ocx-stop/1` result only when it and the exit code agree the runtime is down (or exit 79); the
app's supervisor then starts its sibling `ocx.exe` after its backoff. Success is a different pid in
this home's attested runtime record, on the replaced runtime's port, answering `/healthz` with the
target version within 240 seconds; a proxy found on the configured port without this home's record
(another home's, for example) neither counts as the runtime before the install nor as its
replacement. Another image, an unattested or newer runtime, an unknown version, a
refused restart, an unconfirmed drain or service restart, or a timeout is reported with the restart command and exit 2; nothing else is
stopped. The Desktop shell process keeps its pre-update image until it is relaunched.

`ocx status` on such an installation replaces the CLI-newer version warning with the installed
and serving versions and `"<dir>\ocx.exe" update --desktop` (`withDesktopSkewAdvice` in
`install.ts`, applied in `src/cli/status.ts`).
