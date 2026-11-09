# Staged desktop update engine — draft unit

**Status:** pending the signed-supply and activation-admission units, architect
reflection and roadmap audit. This is a design draft, not an implementation
authorization.

## Objective and policy proposal

The planned desktop app would check its selected published channel, download a
signed update in the background, expose progress, and retain a verified stage
until the person chooses to restart or an enabled policy permits installation.
The design must retain the existing download-verification and ownership-aware
drain boundaries (`desktop/src-tauri/src/updater.rs:388`,
`desktop/src-tauri/src/exit.rs:546`).

Proposed defaults: background checks and signed auto-download on; automatic
restart/install off until the user enables it. GOAT defaults to restart when
idle (`docs/user/updating.md:128` at the reference revision), but OpenCodex's
existing drain must not be assumed to prove no request is in flight. This
conservative default avoids a surprise restart while still staging updates;
explicit opt-in may activate only after a tested idle/admission signal and a
fresh guarded drain. If a reliable idle signal does not exist, the enabled
policy must defer with an explanatory state, never silently approximate idle.
The user can turn off automatic download, turn off automatic installation, and
choose Later; manual actions remain possible. Finalize defaults and interaction
with quit after architect reflection and audit.

The pinned Tauri updater exposes `Updater::restore_update` for cached metadata;
it requires signed-version binding for restored metadata, and `Update::verify`
and `Update::install` verify cached bytes again. This was inspected in the
locally installed `tauri-plugin-updater` 2.14.1 crate (`src/updater.rs:666`,
`:896`, `:911`); the repository pins it at
`desktop/src-tauri/Cargo.toml:32` and locks the registry checksum at
`desktop/src-tauri/Cargo.lock:4285`. Therefore durable staging is a concrete
candidate: persist bounded raw metadata plus private staged bytes, restore with
the current configured updater, verify before showing ready, and verify again
at install. Reject signatures lacking the signed version on restoration; do not
serialize a caller-supplied `Update` or trust a saved ready flag. Cross-platform
filesystem ownership, bounded sizes, atomic publication and cache recovery
still need an exact design and negative tests.
Before relying on restoration, verify in release fixtures that the actual
signing tool emits the signed version required by `restore_update`, including
Windows re-signing; otherwise keep the update available for a fresh check
instead of representing the cached stage as ready.

The native staged engine owns acquisition in a new
`desktop/src-tauri/src/update_download.rs`. It creates the plugin `Update`
only from the verified release record's exact version, channel, target,
artifact digest/size, signature, approved source and delegated key. Reconstruct
and compare these bindings before each download, restoration and installation;
never accept caller-supplied `Update` fields as authority. Use the existing
pinned `reqwest` and `sha2` dependencies (`desktop/src-tauri/Cargo.toml:20`,
`:23`): read response chunks, count before extending a bounded buffer, hash as
they arrive and abort immediately if the signed size or an implementation
maximum is exceeded. Require exact final size and digest, then call the pinned
plugin's `Update::verify` on those same bytes before publishing ready. On
macOS/Linux, `Update::install` verifies them again at installation; on Windows
the verified guardian backend below performs the mandatory final verification
before its observed installer handoff. Reject
partial or oversized responses and remove only this operation's private
temporary file on cancellation/failure. A Content-Length header is advisory,
never the bound.

Production acquisition requires HTTPS and a source derived from the verified
release record's approved source/asset identity. Initially allow only the exact
`github.com/lidge-jun/opencodex/releases/download/<tag>/<asset>` source; permit
at most three HTTPS redirects to exact hosts `github.com`,
`release-assets.githubusercontent.com` or `objects.githubusercontent.com`,
without userinfo or non-default ports. Refuse an unlisted host rather than
silently widening this set. Send no management, link or user credentials to the
artifact service or redirect target. A loopback HTTP mock is accepted only by
injected test transport, never a production setting. Cap signed size at 1 GiB;
use a 10-second connect deadline, 30-second idle-read deadline and 20-minute
total deadline, with retryable bounded error codes. Test each hop and timeout,
missing/misleading lengths, exact-size boundary, abort cleanup and wrong target,
digest, signature or version. This is a proposed owner and acceptance contract;
the release-asset host set and platform implementation require audit.

Proposed persisted desktop policy v1, stored by the native owner under its
app-config directory as `update-policy-v1.json`, is a closed object with
`schema: 1`, monotonically increasing `revision`, `channel` (`latest`, `preview`
or `nightly`), `check` and
`download` (`automatic` or `manual`), and `install` (`manual`, `on-quit` or
`when-idle`).
Proposed first-install defaults are automatic checks and downloads, manual
install. Apply them only when an independent owner-controlled initialization
record establishes a genuinely new installation and the installed channel has
the verified provenance in `010`. A missing policy after initialization, or an
ambiguous initialization state, is a recovery error and disables automatic
effects; it is never treated as first install. Ambiguous or missing channel
provenance likewise disables automatic effects. Malformed or unreadable records
also disable automatic effects and report an error. Writes are serialized and
atomic; an unsuccessful write never updates effective policy. Every action
captures the revision and rechecks it before download and activation.

The proposed owner must durably reserve a strictly increasing revision before
publishing each policy, including a repair, under the same serialized mutation
boundary. A separate owner-controlled high-water record must survive a corrupt
policy and restart; interrupted writes may consume a revision but never reuse
one. If that record is missing, unreadable, corrupt or exhausted and a genuinely
new installation cannot be established independently, refuse policy mutation
and automatic effects rather than reset the counter. Recovery cannot assume a
revision from an unparseable policy. Tests must cover interruption at each
durable step, high-water loss, policy deletion after a manual choice, stale
requests and prepared actions after recovery, concurrent writes, and restart.

The planned native policy owner would also own the guarded local corrupt-policy
repair command in `050`. It would serialize repair with policy writes, verify
the current owner-issued observation, preserve recoverable prior data and use
manual defaults with an explicitly selected channel and a freshly reserved
revision above the durable high-water mark. A stale observation,
unreadable record or failed preservation refuses without changing policy.
Tests must cover repair, competing writes and owner restart before delivery.

Later records the exact staged candidate as deferred until the person explicitly
installs it or selects a newer candidate; it survives app restart and ordinary
quit. Ordinary quit must not silently install a deferred or manual candidate.
Enabling `when-idle` permits a non-deferred stage only after the admission unit
proves idle and performs the guarded handoff, including an eligible quit.
`on-quit` attempts installation only on an explicit quit. For either policy,
busy or unknown activity defers the update instead of forcing installation;
the ordinary requested quit follows its existing separate semantics. Later
prevents the candidate's automatic installation on quit as well as while idle.
A successful explicit install or a newer candidate clears the previous
deferral; failed targets remain suppressed for automatic retries until a
different candidate or explicit retry. These are proposed contracts for
review, not evidence of implementation.

Discovery and staging are separate state owners. If a later check fails,
returns no update, or returns the same candidate with no notes, retain a still
verified staged candidate, its ready/install action, Later decision and notes;
surface the check error separately and allow retry. Invalidate the stage when
channel or owner changes, a newly selected candidate, expired or failed
trust/identity verification, or an explicit discard requires it. A policy
revision change invalidates prior activation authority and requires revalidation;
it does not by itself erase a still-valid stage or Later. An invalid stage never
remains installable. Throttle native progress projection
to changed integer percentages or a one-second heartbeat; sidebar polling is a
separate display concern (`050`). Test the check-versus-ready races, stale
completion, deferred stage and retained notes.

## Proposed durable recovery contract

Before the first irreversible stop, atomically journal the candidate, prior
version, install owner, policy revision, operation ID and the pre-stop
Stop/Resume intent. States are `prepared`, `activating`, `observing`,
`installed-stopped`, `healthy`, `failed` and `uncertain`; a process restart never turns an
`activating` record into success without target-version and runtime-owner
readback. A failed target is suppressed until an explicit retry or a distinct
candidate. Record only bounded reason codes, no request data or credentials.

The candidate activation unit must establish a verified recovery path before
enabling unattended installation: retain a separately verified, signed prior
release artifact and the state needed to restore it, or refuse automatic
activation with a visible manual recovery action. If the recorded effective
intent requires a running runtime, a successful installer exit starts
observation; the exact target and owned runtime must answer health within a
bounded 30-second initial window, followed by a ten-minute probation for
runtime failure. If the person explicitly quit or the runtime was intentionally
stopped, verify the installed artifact and record `installed-stopped`; do not
start a runtime just to satisfy health. On the person's next deliberate start,
observe the exact target and start the health/probation window; retain signed
recovery material until it completes. `installed-stopped` is not `healthy`.
A failed trial/probation triggers the verified owner-led
recovery path; it cannot discard state written by another owner. If safe data
restoration cannot be proven, leave the outcome uncertain and require explicit
recovery rather than presenting a rollback as successful. Desktop platform
installer constraints, the actual persistent journal location and state
ownership need platform-specific design and test evidence before plan lock.

Proposed recovery actor: a verified, destination-owned guardian is started from
an isolated signed recovery payload **before** the native installer handoff.
The guardian and its journal live outside the replaceable app bundle and hold an
operation-specific lease. It observes installer termination and the exact
replacement's startup/health even if the old app exits. If initial health or
probation fails, it invokes only the verified retained recovery artifact through
the appropriate platform owner; it records `uncertain` when termination, owner
intent or state-write ownership cannot be established. A missing authenticated
previous artifact prevents unattended activation; an explicit manual path
shows the owner action rather than claiming automatic rollback.

On Windows, the guardian must survive the MSI handoff that ends the old app
(`desktop/src-tauri/src/updater.rs:397`), and wait for the installer process
and owned replacement. On macOS and Linux it survives the app relaunch and
observes the same journal. Rollback may select only the exact retained prior
signed artifact named by the operation record; normal channel sequence and
downgrade restrictions remain in force for ordinary selection. Guarded recovery
is a separate bounded exception, not permission to install an arbitrary older
version. The proposed owners are a new
`desktop/src-tauri/src/update_recovery.rs` coordinator and the separately signed
`desktop/update-guardian/` helper described below; packaging and platform
supervision still require proof before automatic activation.

The pinned updater's Windows handoff is a specific design constraint: in the
locally installed `tauri-plugin-updater` 2.14.1 source,
`src/updater.rs:1013–1050`, it calls `ShellExecuteW` and exits the app without
returning an installer process handle. Merely watching the old app exit cannot
prove that MSI/NSIS finished or that it is safe to start rollback. The
guardian must obtain a trustworthy installer completion observation through a
platform-specific, independently reviewed handoff; if that cannot be proved,
it records `uncertain` and never launches a competing installer. The unit must
choose and test the actual mechanism, including elevation cancellation and a
live installer after guardian death. Do not claim the current plugin exposes a
handle that it does not expose.

Build the guardian as a separately signed platform artifact and bind its exact
digest in the release record from `010`, rather than assuming a helper inside
the app bundle will survive replacement. The native owner verifies it before
copying it into an account-private update-operation directory outside the
bundle, verifies the copied bytes again, and launches it with a bounded
operation descriptor and no secret command-line arguments. The guardian owns a
durable journal and exclusive operation lease; the replacement app's startup
and any later owner retry reconcile that journal before starting another
installer. A process surviving application exit is not proof of survival
across logout or reboot: define a startup reconciliation path and leave an
interrupted operation `uncertain` until it observes the prior worker/installer
and owner state. No persistent service registration is implied by this plan.

| Platform/owner | Proposed recovery boundary | Evidence required before enabling |
| --- | --- | --- |
| macOS bundle | A verified guardian outside the `.app` observes the owned bundle replacement and version-bound startup, then applies only the retained verified prior artifact through the approved platform owner. | Signed/notarized helper execution from private storage, app replacement and restoration on the same and different volumes, permission/elevation refusal, guardian loss, Stop/Quit intent and data ownership. |
| Windows MSI/NSIS | A verified guardian outside the installed tree observes a bound installer operation and replacement process; rollback waits for confirmed installer termination. | Installer process/operation identification across elevation and app exit, job/session survival, cancellation, reboots, concurrent installer exclusion and exact-version readback. `ShellExecuteW` success alone is insufficient. |
| Linux AppImage | A verified guardian outside the image observes the owner-bound replacement and can restore the signed prior image. | Same-filesystem replacement/restore, permissions, interrupted write/rename and exact image verification; the pinned updater's internal temporary backup is not a durable probation guarantee. |
| Linux deb | The guardian uses the selected package owner and waits for verified package-manager completion; it never rewrites a system-owned tree directly. | Ownership and privilege checks, cancellation, manager-lock handling, signed previous package restoration and post-install health. If unavailable, report owner action and keep this parity item open. |

The exit coordinator adds a distinct `quit-for-update` transition before a
normal UserQuit claims the drain. An eligible explicit Quit atomically records
the user's quit intent and claims this transition; an already claimed UserQuit,
newer Stop/Quit, stale stage or busy/unknown activity follows ordinary quit and
skips update activation. A runtime that was already stopped uses a separate
owner-bound absence proof and installation-wide participant fence; it does not
call the live `/api/update/activation` endpoint. An unknown or foreign runtime
still refuses. Tests cover already stopped, absent, running, busy, concurrent
Quit/Stop and quit ownership claimed before update admission.

Selected implementation direction: add a small independently signed Rust
guardian artifact per supported target under a new `desktop/update-guardian/`
crate, built and verified in the existing release workflow without adding a
trigger or permission. It reads a private versioned operation journal, acquires
the installation-scoped owner lease from `020`, verifies its own approved
operation identity and both signed target/recovery payloads, then records every
handoff transition before performing it. Its stable private operation directory
is under the Desktop owner's app-config directory, outside the replaceable
bundle. Startup reconciliation launches only the recorded verified guardian;
it never starts a second guardian while the original lease or installer status
is live or unknown. No automatic installation is enabled until packaged tests
show this helper survives the relevant application exit and preserves owner
intent on that platform.

For Windows, the selected direction is a guardian-owned MSI/NSIS launcher using
`ShellExecuteExW` with a requested process handle, after the native plugin's
`Update::verify` and a second guardian-side verification of the exact staged
installer bytes. The helper accepts only the signed target's approved installer
kind and fixed arguments; it must not accept a caller-supplied command. Observe
the returned handle, installer exit and platform installation state before any
health check or rollback. If elevation is cancelled before launch, restore the
prior intent; if launch succeeds but no trustworthy handle or completion state
can be established, retain the operation fence as `uncertain` and never start
another installer. Test elevated/unelevated execution and Windows Installer's
actual completion semantics. Because the current plugin's `Update::install`
does not return the Windows installer handle, this backend replaces that launch
only after preserving its mandatory exact-byte signature/version verification;
it does not disable or weaken verification. Any direct OS binding is pinned,
reviewed and covered by native CI.

The durable Windows milestones are `guardian-ready`, `app-exit-requested`,
`app-exited`, `installer-started`, `installer-exited`, `installed`, and either
`observing` or `installed-stopped`. The guardian proves its own readiness and
ownership before the app requests a coordinated exit; it waits for the exact
old app process to exit before launching the installer. It records and observes
the installer handle and completion before starting a replacement app, and
never calls the old immediate `complete_restart` while an installer is live.
If old-app exit fails, no installer starts; if UAC is cancelled before launch,
restore the prior intent. Lost replies, guardian death, handle absence or an
unconfirmed installer retain `uncertain` and prevent another installer. A
replacement starts only when the latest recorded intent requests it; a user
quit remains quit. Exercise every milestone with isolated process/installer
fixtures and packaged Windows proof before enabling the capability.

On macOS and Linux AppImage, retain the pinned plugin's verified `install` path
and have the independently running guardian observe its bound completion,
exact bundle/image identity and health; the guardian restores only the signed
previous artifact when ownership and data-write checks permit it. For Linux
deb, use a separately supervised approved package-manager operation with an
observable process and package-owner readback; a denied privilege prompt or
unknown process outcome remains explicit. Standalone `070` uses the same
signed guardian protocol for its executable owner, with per-platform replace
and restore adapters; it does not infer ownership from a path alone. Each
platform needs failing-first process-loss, reboot/reconciliation, UAC/privilege
and no-concurrent-installer tests before its automatic capability is enabled.

Bootstrap for an older installation requires a publisher-signed previous
artifact and authenticated metadata that bind the installed owner and exact
version to the retained recovery material. A version string alone is not
proof of installed bytes. If the old release has no verifiable recovery
material, automatic activation stays disabled until an explicit owner-guided
bootstrap establishes it; the signed-supply and release units must create this
path rather than silently treating unsigned historical bytes as rollback proof.
Tests inject failures before and after guardian launch, stop, installer handoff,
replacement startup and probation; they assert the number of concurrent
installers, the selected owner, and the observed signed recovery outcome.

## Proposed file map

| Operation | Path | Before → after |
| --- | --- | --- |
| MODIFY | `desktop/src-tauri/src/updater.rs` | Six-hour check and one combined download/install (`:388`, `:448`) → a single owner for check, signed download with progress, staged readiness and guarded install. Preserve generation, claim and tray races (`:28`, `:291`); do not create a parallel installer or introduce a second scheduler. Extract siblings if size or ownership calls for it. |
| NEW | `desktop/src-tauri/src/update_policy.rs` | Typed, validated channel and download/install preferences; define explicit defaults, durable atomic persistence under the desktop app's own config directory, failure behavior and migration from no record. Resolve exact existing persistence convention before finalizing this path. |
| NEW | `desktop/src-tauri/src/update_stage.rs` | Own a staged exact version and the verified package bytes/metadata returned by the pinned updater; retain verification provenance and invalidate on channel or version change. Persist only if the plugin supports safe re-verification across restart; otherwise recover by rechecking and re-downloading rather than asserting an old stage remains verified. |
| MODIFY | `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/tray.rs` | Route UI/tray operations through the same engine and installation claim. New privileged commands remain guarded by the bundled update page; no new capability is granted to the dashboard origin. |
| MODIFY | `desktop/src-tauri/src/exit.rs` only if necessary | Preserve `prepare_restart` ownership, drain and stop confirmation; any idle evidence must be tested and checked again at admission, not inferred from a timer. |
| MODIFY | Desktop Rust tests and `tests/clients/desktop-update-surface.test.ts` | Add tests for state transitions, concurrent check/download/install, failures, settings and restart admission; use injected clock, updater and temporary app homes. Existing test/source registration rules apply to new domain tests. |
| MODIFY | `structure/desktop-shell.md`, `structure/companion.md`, `structure/ops/desktop-supervision.md`, `structure/runtime.md`, `structure/ops/service-and-sidecars.md` and any other affected owner identified in `structure/INDEX.md`; user docs | Review all mapped owners (`structure/INDEX.md:182`); update each whose documented contract changes. Sync relevant translations. |

## Required scenarios

1. Startup and subsequent checks use one bounded scheduler. Offline, timeout,
   stale or malformed feed shows a retryable failure or unknown, not current;
   a delayed older check cannot overwrite a newer result or active install.
2. A trusted test feed returns an exact signed update; progress becomes visible
   and readiness is emitted only after the pinned plugin verifies the bytes.
   Missing, corrupt, wrong-key, wrong-channel or superseded artifacts never
   become installable. Test signing uses a dedicated fixture key and isolated
   storage; never use production credentials or a real installation.
3. Auto-download disabled, auto-install disabled and Later each prevent the
   corresponding automatic effect. Changing a preference during a pending
   action is rechecked at its mutation boundary. Unknown or malformed settings
   fail safely and remain visible as an error.
4. Automatic install requires enabled policy, current verified exact stage,
   proven idle, the reservation handoff in `020_activation_admission.md`, a
   fresh admission recheck and `prepare_restart` success. An
   active request, foreign/unknown owner, failed drain, quit race or changed
   stage defers/refuses without replacing the package. Manual install still uses
   the same guarded drain.
5. A failed installation invokes the existing recovery owner and reports the
   failure; a restart returning on the old version is not called success. A
   failed target must not enter a tight automatic retry loop. Explicit retry
   is possible. Windows handoff and Linux package type stay covered.
6. With `on-quit`, an idle, non-deferred verified stage is offered to the
   guarded installer only at explicit quit. Busy or unknown activity skips the
   update; Later, manual mode and failed-target suppression prevent it. With
   `when-idle`, the same eligible quit path is available. Test quit races and
   verify no in-flight request is interrupted by update activation.

## Candidate verification

Run failing-first focused Rust tests and the desktop update-page tests against
isolated homes and a local mock update server; verify the real pinned plugin's
signature rejection as well as injected state-machine failures. Run root
`bun run typecheck`, `bun run privacy:scan` and `bun run structure:check`;
collect exact-head PR checks and an independent security review PASS. The
candidate `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml`
and platform-specific test commands must be grounded and cost-checked before
roadmap lock. No full root suite. A PR-branch `lane=all` requires an explicit
maintainer request on that PR; run it once on the exact intended head, never
redispatch after a head moves or rerun to green, and cancel owned superseded
runs. Ordinary full dispatches remain batch checks on `dev` under `AGENTS.md`.
