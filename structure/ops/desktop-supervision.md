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
