# Background Service And Sidecars

Native result continuations and function-result injection follow [the mode-specific result and control contract](../transports/streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](../transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

Service endpoints are unchanged by the Responses
[core module ownership](../transports/responses.md#core-module-ownership). This surface retains its existing behavior.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

Service startup and restore use the [catalog retirement policy](../catalog.md#shared-catalog);
retirement does not itself change service registration or user-selected model configuration.

Shared parsing and streaming follow the [request-copy](../transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](../transports/byte-accounting.md#stream-buffer-accounting) contracts. Response-attached WebSocket telemetry follows the [stage record identity contract](../transports/responses-wire-shapes.md#passthrough-sse-stream-shapes-314).

## Background service command selection

A bare `ocx service` is an idempotent install-or-repair command. Managed runtime logging follows the [service log contract](service-logging.md). Argument validation happens before
any platform status probe. macOS and Linux choose from the registration file's proven presence;
Windows combines the Task Scheduler and WinSW probes into `installed`, `absent`, or `unknown`.
Only proven absence enters registration. A query failure refuses the bare command with status
guidance, because treating `unknown` as absent can rerun elevated `schtasks /create` against an
existing task. Explicit `ocx service install` remains the operator-owned registration request.

`src/lib/windows-elevation.ts` formats scheduler exec failures without echoing child stderr; generic failures retain the numeric exit status. Delete, run and end access denials name the exact command to run from an elevated terminal. `src/service/windows-scheduler.ts` also classifies an owned-task delete exiting 1 as denied when a fresh probe proves the task survived; absent, unreadable and failed probes do not establish that classification. `src/service/windows-ops.ts` retains service assets until deletion is proven complete. `tests/windows/windows-scheduler-errors.test.ts` exercises these paths with injected runners.

`src/config/serving-runtimes.ts` records successfully serving installs and lets only a
non-sibling managed-service start defer to a verified strictly newer recorded command. The
census gate recognizes launchd, systemd, and current or repaired WinSW definitions through
`OCX_SERVICE_MANAGED=1`; the Windows Task Scheduler wrapper uses `OCX_SERVICE=1` with its
wrapper-protocol marker. Legacy WinSW definitions carrying only `OCX_SERVICE=1` do not
delegate until `ocx service repair` rewrites the XML. The census update uses the shared
cross-process config mutation lock; recorded paths must resolve to files owned
by the current user without group/world write permission on POSIX. Candidate
execution additionally requires a live service-manager registration whose generated
definition names the current homes; environment markers alone never authorize a census
probe because Bun can load them from a project dotenv file. For WinSW, whose SCM
registration is machine-wide, the gate also requires trusted `sc.exe qc` to report that
definition's own executable as the registered `BINARY_PATH_NAME`, and refuses on any query
failure or mismatch. Candidate probes are
newest-recorded first, capped at four three-second attempts; a failed probe
falls through within that cap, and a failed launch or any pre-bind child exit (0 and the
stay-out code included) leaves this install serving: its own lease-held bind fence then
re-applies every stay-out condition, so a deliberate stand-down is still honored. A one-hop
marker prevents recursive delegation; post-bind exits
propagate to the manager. The
foreground parent forwards SIGINT, SIGTERM and SIGHUP until the child exits, shares one
five-second SIGKILL escalation timer across repeated signals, and clears that timer and
its handlers on settlement. Signal exits preserve `128 + signalNumber`. A parent killed
without running handlers is not covered by this forwarding mechanism.

> Decision record: [ADR-0028](../decisions/ADR-0028-background-service-command-selection.md)

## Guarded CLI update restart

`src/cli/system-restart-client.ts` freezes the newer-CLI candidate's runtime identity, physical homes and diagnosed hostname, which later reads must match exactly. An omitted hostname corresponds to the default loopback bind; a present empty or whitespace-only runtime hostname refuses before stop with fixed, sanitized owner-specific recovery guidance. For a detached standalone proxy, the guidance conditions `ocx stop` on independent ownership and bind verification and acceptance of possible forced termination, requires independent exit, supervision and port checks before `ocx start`, and directs uncertain cases to the owner or administrator. The serialized child handoff is validated before stop; replacement checks compare bind scope while retaining exact record rereads and attestation. `src/cli/update-restart-home.ts` captures the service-record digest from
`src/cli/update-restart-service-record.ts`: all ordered `serviceStatePaths()` candidates, including confirmed absences and the authoritative position, plus the launchd plist or
systemd unit. State and ownership resolve from those captured bytes. Each present regular file contributes SHA-256 content and bigint device, inode, size, nanosecond mtime/ctime,
mode, uid and gid. The opened descriptor must be regular and match device/inode before any read. Each record is limited to 1 MiB, read in bounded chunks with growth beyond that limit
refused. Descriptor stats bracket the read; a final pathname stat must agree. Symlinks, inconsistent reads, malformed state, unreadable candidates and membership drift
refuse. Homes compare canonical path plus exact bigint `dev:ino` (`fileId`); rounded doubles merge NTFS ids above 2^53. Aliases stay equivalent. Lock, PID and runtime records are excluded.

`src/cli/update-restart.ts` requires known versions and a detached POSIX target with PID-1
parent, no ownership claim and no client/sibling role. An installed record without a claim
admits only with positively inactive supervision. `src/cli/update-restart-supervision.ts`
probes both launchd domains even without a plist; only exit 112/113 establishes absence.
Systemd requires loaded or not-found, inactive and MainPID zero. Unknown evidence refuses.
Manager executables resolve only from /usr/bin/systemctl then /bin/systemctl on Linux, or
/bin/launchctl on macOS; they must be regular, executable and not world-writable. The
supervision and retained PID-bound checks share the resolved path. Linux commands use an
explicit environment from `src/service/systemd.ts`: when XDG_RUNTIME_DIR is missing and
/run/user/<uid> exists, it is set in that subprocess environment; inherited bus addresses
are preserved. Restart probes do not mutate process.env. Each command uses at most two seconds
and the remaining transaction deadline, which is checked again after execution.

The ownership mutation lease covers stop and the single spawn. Every parent `checkHome`
recaptures the original fingerprint and supervision: after acquisition, immediately before
stop, after shutdown, after the async Bun-readiness wait, before spawn and throughout
replacement observation, including success publication. Drift is terminal, never recaptured
as a new baseline. The executable must pass `REAL_BUN_MIN_BYTES` before stop; after a
confirmed shutdown it may wait within the same deadline before repeating launch checks.
`src/cli/update-restart-transport.ts` attests and stops on one direct TCP connection without
reconnect, PID signals or port reclamation. Predecessor exit, runtime-record removal, port
availability and definitive endpoint absence precede spawn. Success requires the child PID,
endpoint, fresh attestation and exact known version, without generic restart recovery.

`src/cli/update-restart-child.ts` requires marker schema 1 and a 64-character lowercase hex
digest before preflight or lease acquisition. It strips parent lease delegation and takes
its own lease, validating the frozen homes, digest, supervision, version, endpoint and
deadline before and under that lease, before/after bind, before PID and runtime publication,
and at completion. Rollback retains custody until exit; the deadline ends an unfinished child.
Windows, claimed, supervised and uncertain targets remain ineligible for this update path.

## Windows selected-runtime write preflight

Before service install/repair or a Windows Codex shim mutation, the selected Bun executable must create and remove an exclusive nonce-named directory inside the config root: admission runs that exact lexical path with `-e`, no shell, a hidden window and a five-second timeout, and only a matching nonce acknowledgment admits. Failure refuses with `OCX_RUNTIME_PREFLIGHT_FAILED` (`spawn`, `timeout`, `create`, `remove` or `protocol`) and never discovers another runtime; the Node launcher may pick a validated PATH Bun before CLI startup when bundled Bun is unusable, and durable admission only probes that resulting selection.
The frozen selection feeds scheduler rendering, the WinSW entry and the install-state writer. `installServiceSafely` refuses live Desktop supervision before selection or admission, then admits once before cleanup and uses internal commit functions; repair refuses Desktop before diagnosis, checks ownership and auth before admission, and admits before native repair or scheduler stop; direct public installers keep their own admission gate.
The fresh scheduler path captures root absence and freezes the runtime at entry, stages and registers its definition, removes staging and claims config ownership, then probes with `rootWasAbsent: false` immediately before `prepare()`; a refused probe rolls back the new registration before service-manager cleanup or asset/state publication. Healthy or disabled shims do not probe; refused automatic restore defers with guidance and startup continues. Non-Windows admission performs no spawn or filesystem work, selection stays pre-dotenv and `cliEntry` stays I/O-free. That cleanup (`prepareServiceInstall`) ends every recorded, conflicting and requested manager, then — Windows only — issues the same best-effort launcher/wrapper termination `ocx stop` performs, scoped to this install's canonical script and launcher tokens (an `schtasks /end` survivor can respawn the proxy mid-install; this layer guarantees neither that the wrapper actually exited nor that the new instance comes up), then stops the tracked standalone listener; a refused or unverifiable manager stop aborts before that cleanup runs.

An absent root reaching admission is created with an exclusive non-recursive mode-0700 mkdir under an existing parent and left empty for later ownership claiming; the preflight never deletes the config root (refusal, concurrent creation, contents and replacements are all preserved). Existing roots must be real directories, not files or symlinks/junctions, and probe cleanup is non-recursive.
A standalone selection is admitted in-process only when its path equals `process.execPath` exactly (standalone is executable packaging, not Desktop ownership); that path has neither child isolation nor a timeout, so synchronous filesystem operations may block, and other standalone selections refuse. Recovery is an operator-selected trusted `OPENCODEX_BUN_PATH` before launching ocx, or an `npm install -g --allow-scripts=bun @bitkyc08/opencodex` reinstall followed by retry; no runtime discovery or probe memo is added. The flag is part of the contract, not advice: npm 12 blocks dependency lifecycle scripts by default and bun's postinstall is what unpacks the binary, while npm 8 through 11 accept the flag on a global install (#8361).

## Windows npm tray update badge

The npm Windows tray owns six installed ICOs: online, warning, and offline base safety glyphs plus one blue-dot variant of each. Its hidden `ocx __update-badge` child reads the package cache without refreshing or writing it. The tray samples no more often than every 60 seconds, caps stdout and stderr at 16 KiB each, requests termination after 12 seconds or a pipe overflow, and reaps the child on later Windows Forms ticks before allowing another launch. A successful badge observation expires after 180 seconds; failed reads do not extend it. The **Update available** item opens the dashboard and never installs a package. Shutdown requests child termination, waits at most 500 ms, and disposes the probe before tray UI disposal.

## Windows startup ownership listing reuse

One proxy startup asks service-home ownership twice before listen: once before cache invalidation and
again immediately before native-main lifecycle preparation. The second targeted Task Scheduler query
is a deliberate race check and remains mandatory. On a localized host, however, the same nonzero
targeted answer can require a full task listing with a 20-second ceiling; running that identical
enumeration twice made a measured 12.3-second fallback cost roughly 25 seconds before listen.

> Decision record: [ADR-0029](../decisions/ADR-0029-windows-startup-ownership-listing-reuse.md)

## Windows config-directory handle release

`src/server/index.ts` resolves `server.stop(true)` only after the config-directory hardening flight
and every async ACL hardening flight and deadline-surviving `icacls.exe` runner under that home have settled. `src/config/paths.ts` owns the
barrier: a timeout verdict alone does not make the home removable. The contract is exercised by
`tests/server/server-stop-config-hardening.test.ts`.
`src/lib/windows-secret-acl.ts` retains removal ownership for an entire async harden, including principal lookup, successive ACL commands, retries and diagnostics, as well as tracking runners that outlive their deadlines. The exact-path timeout indicator keeps its existing meaning for atomic-file fallback. The Bun regression in `tests/windows/windows-secret-acl-removal-flight.test.ts` holds a normal command and verifies that removal remains blocked between successive commands. Required-mode failures keep their sanitized ETIMEDOUT/EICACLS semantics and additionally carry a bounded `aclFailure` record — fixed step and stage enums (`deadline_before_spawn`/`spawn_failed`/`runner_rejected`/`runner_watchdog`/`child_result`), measured elapsed and requested budget, success, exit code, and an allowlisted spawn code — copied field-by-field so no path, argv, SID, or child output crosses into the thrown error. Each field is read from the cause exactly once and that same primitive is both validated and copied, so a changing getter cannot pass validation with one value and publish another; a getter or Proxy trap that throws drops the whole record while the sanitized required-mode error is still thrown; `tests/windows/windows-secret-acl-diagnostics.test.ts` covers the boundary. Lifecycle acquisition opts into `verifyExistingRuntimeDirectory` before mutating its shared Windows runtime root. `src/lib/windows-owner-acl.ts` verifies a protected private DACL with the serving user's inheritable Full Control; an Administrators-owned runtime directory also qualifies when that group is enabled in the serving token, independently of its default owner. The ordinary private secret-file/pairing policy is unchanged. Verification is bound to unchanged device/inode/ctime and the original deadline, creates no hardening memo, and never falls through to the legacy name-only shortcut. Refusal retains required hardening and fail-closed errors. The root check does not certify descendants; the lifecycle database is hardened separately. Regression coverage is in `tests/windows/windows-lifecycle-root-acl.test.ts`.

Removal ownership captures lexical and canonical path identities before each work item or child starts, including Windows short names and directory aliases; deadline survivors retain the same identities. A deleted temporary file is captured through its existing parent. Unreadable identity at capture stays conservatively matched until settlement. Removal compares the requested root against those retained identities, so deleting or retargeting an alias cannot release the original root early. The same Bun regression verifies aliases changed mid-flight still block removal. Matching covers captured and current alias destinations; a second retarget by a writer of the protected directory is out of scope.

## Service-manager probe

CLI status and doctor give the attested startup-health read the isolated probe budget plus
1.5 seconds (6.5 seconds on POSIX, 16.5 seconds on Windows), covering the endpoint's child
settlement grace. The read client passes the same deadline to the direct local transport, so its
default 10-second exchange bound does not cut the Windows read short. Identity/proof validation
and local fallback on timeout remain mandatory.

`src/service-manager-probe.ts` (`inspectServiceManagerInstallation`) reports what the platform
service manager has installed for opencodex, read-only and fail-closed. It reads the service
definition itself and parses the `CODEX_HOME` and `OPENCODEX_HOME` values embedded in it, because
installation writes the definition before the state file: an interrupted reinstall can leave the
two naming different homes, and on macOS a logged-out user can have the plist on disk with no GUI
domain to query (`gui/` 125 is unreachable only when a bounded read of the complete IOConsoleUsers roster excludes the UID; unreadable evidence or `user/` 125 stays unknown, #7697). The probe returns what it saw and does not decide ownership; callers such as
`src/integrations/native/ownership-preflight.ts` compare the homes. Every command it runs is
read-only and time-bounded, so it is safe while the proxy runs under that same manager.
Systemd home parsing in `src/service/systemd-env.ts` decodes the generated quoted escapes and
doubled percent signs, with legacy simple bare assignments retained. Unknown escapes, unresolved
specifiers, malformed quotes, resets and duplicate home assignments make the whole definition
unknown in both online and offline probes; they never become omitted homes for ownership comparison.
Non-comment physical line continuations also make the definition unknown before directive matching;
the generated format uses single physical lines, while systemd otherwise folds continuations first.
Directive names are matched literally like systemd's parser: only an exact `Environment` is
decoded, while env-bearing siblings (`EnvironmentFile=`, `PassEnvironment=`, `UnsetEnvironment=`),
escaped or malformed directive names, and `.include` all invalidate the definition instead of
being skipped, because a directive the parser ignored could still change the environment the
unit applies.
On Windows, the generated-wrapper check accepts package installs that invoke the source CLI.
A standalone wrapper that invokes `start` directly must carry the generated protocol and runtime
markers, one quoted `OCX_BUN` assignment, and no `OCX_CLI` assignment in either quoting form.
Its executable lines and control-flow order must match the standalone script emitted by
`src/service/windows-taskxml.ts` or exact prior forms retained for read-only upgrade recognition:
the preceding backup-log variant and the forms before the Bun-placeholder size gate, with either
old or fixed backup logging. The generator never emits those legacy variants. Added jumps, exits, calls,
labels, altered logging commands, or partially combined variants make the probe unknown.
When Task Scheduler reports a registered task, the probe also requires its action to contain exactly
one Exec with the generated `wscript.exe` command and exact `/b /nologo` launcher arguments.
A foreign command or additional action makes ownership unknown even if the wrapper and homes agree.
Its executable must be absolute, end in `.exe`, and agree with `bunPath` in every readable service
state record for the scheduler backend with `cliPath: null`. Missing, malformed, or contradictory
state leaves the probe unknown; it cannot authorize unattended native Codex writes.
The state records a lexical executable path, not an install-time file identity or digest. A
retargeted junction or replacement at the same path is therefore outside this probe's evidence;
resolving the path only at probe time cannot establish which file the installer recorded.

## Stable service launcher (launchd and systemd)

Systemd installation resolves the first absolute `ocx` PATH candidate that is both a regular file
and executable, keeps that path lexical so a version-manager shim remains an indirection, and
records the same single resolution in the service definition and service state. Definition
construction (`buildUnit`) never performs PATH discovery itself: callers provide either the resolved launcher or an explicit direct Bun/CLI
fallback, keeping diagnostics and tests independent of the host PATH. Launchd always uses the
package-local Bun and CLI pair selected by the trusted install or repair invocation. Its `ProcessType=Interactive` avoids default daemon CPU/I/O throttling for user-facing requests; install/repair upgrades older definitions once. The Interactive-only migration preserves the previous normalized PATH. With a readable probe, changed bytes require an accepted bootstrap and a matching command; terminal failure attempts to restore the previous plist and retains any backup; a job still loaded from the expected command is left running, with the previous plist restored on disk only. Without this run's backup (an unreadable previous plist or a failed write) any older `.plist.prev` is removed before anything else changes, and the repair fails if it cannot be, so a pending rollback never uses another run's bytes. An unknown initial probe refuses before a new plist or backup is written. A probe becoming unknown after bootstrap causes no further eviction or rollback: an accepted bootstrap warns and returns an unverified reload, while a refused bootstrap throws with the new plist and any backup retained for manual verification (`tests/service/launchd-repair.test.ts`). An owner-only `.plist.pending` sidecar records unconfirmed definitions before publication, across invocations and token rotation. Pending repairs cannot use a command-only no-op or cached-definition kickstart, and preserve any original `.plist.prev` successfully created for readable rollback attempts. Retrying registration requires a checkable initial probe, sometimes a GUI login; backup creation is best-effort and a fresh install has no previous definition. Only an accepted bootstrap and matching probe clear pending state. Pending state is meaningful only beside an installed plist; a fresh install removes orphaned recovery files before publication. Full uninstall checks the plist and both sidecars, even without the plist. Fresh-install recovery cleanup, pending-marker removal and uninstall cleanup ignore only ENOENT; other errors in these steps do not delete install state and report failure (`tests/cli/uninstall.test.ts`). After verified repair writes install state, removing `.prev` is best-effort and its failure does not change the reported success. It never hands
credential-bearing service state to a mutable PATH launcher, and a `launcherPath` recorded by an older install is reported stale so `ocx service repair` re-bakes trusted package paths. Launchd and systemd repeat shell-quoted resolved homes after login-profile initialization; Task Scheduler embeds absolute homes instead of runtime profile-variable references; WinSW uses the canonical default-home resolver so `~/.codex` junctions match service state. The systemd ExecStart word also writes `$` as `$$` and `%` as `%%`, because systemd expands variables and specifiers before `/bin/sh` applies its quotes; Environment= escapes only specifiers. Every launchd live-job comparison uses the complete command including the home assignments, so a job loaded from an older plist without them reads as stale and repair reloads it. Outside an install, the expected assignments come from the installed plist's `CODEX_HOME`/`OPENCODEX_HOME`, then from install state, and only then from the current environment, so `status` or `start` from a shell that exports other homes still recognises a job matching the plist on disk. `src/service/plist-xml.ts` writes CR, LF and tab in plist strings as character references, because a conforming XML parser reads a literal CR as LF, and refuses characters XML 1.0 cannot represent, naming the field but never echoing its value. Task Scheduler `set "NAME=value"` lines double only `%`: a caret or `!` inside the quotes is literal under DisableDelayedExpansion (`tests/service/service-definition-escaping.test.ts`).

Service launchers reject recorded and newly discovered paths inside shell-local `fnm`, `nvm`,
`mise`, `asdf`, or `volta` multishell directories. Systemd, launchd, Windows Task Scheduler,
and native WinSW definitions remove those entries from their rendered PATH while keeping other
environment values. WinSW uses the same pure filter in `src/lib/transient-service-path.ts`
without importing the service state module. Launchd
repair compares the full plist after normalizing its previous PATH: a PATH cleanup or any other
definition change reloads the live job through the guarded eviction and bootstrap path.

Launcher mode omits the package-local Bun provenance pair because an upgrade may delete that
versioned tree. Only a pre-Bun, proof-bound `OPENCODEX_BUN_PATH` with durable source `override` is
carried through; `bin/ocx.mjs` rediscovers bundled or validated PATH Bun, stamping PATH selection as
`process` via `src/lib/bun-path-runtime.mjs`. The API-auth token remains file-backed and is loaded only by
the service shell at start. On macOS, `start` and detailed `status` compare the live launchd job
against `expectedLaunchdCommand`, which still follows a `launcherPath` recorded by a pre-pinning
install rather than re-walking PATH, so such a job is never misreported as an older plist (#3464). On macOS, `src/service/launchd.ts` waits up to 125 probes at 200 ms intervals for an evicted job to disappear before repair bootstraps its replacement. The bounded 25-second window accommodates the proxy drain and launchd shutdown; exhausted or unreadable registration retains the existing diagnostic failure path (`tests/service/launchd-repair.test.ts`). A teardown `launchctl print` cannot see — a job booted out by hand an instant earlier is already unregistered while its process is still exiting — is waited out by the recovery round: up to 50 bootstrap attempts at 500 ms intervals, retried only on the transient `5`/`37`/`Load failed` shapes, so `bootout` followed by one `ocx service restart` or `repair` serves on the first call (#8362).

> Decision record: [ADR-0030](../decisions/ADR-0030-stable-service-launcher-launchd-and-systemd.md)
> Decision record: [ADR-0100](../decisions/ADR-0100-stable-service-launcher-launchd-and-systemd.md)

## Service child ownership gate

The verbs are only reachable through `ocx service`, but the process managers spawn
`start` directly, so `handleStart` in `src/cli/index.ts` asks the same question through
`src/service/service-child-ownership.ts` before startup work and again inside the
ownership mutation lease held by `bindAndPublishStartOwnership`, before port selection or
listener bind. The supervised-child classification is kept from the first check; the
recorded owner is read fresh under the lease, so a desktop claim committed between checks
cannot be overwritten by PID or runtime publication. Before either runtime branch,
`recoverStartStateUnderOwnershipLease` (`src/cli/start-owner-fence.ts`) holds that same
lease and rechecks the owner before stale PID cleanup, cross-home sibling detection, or startup journal recovery;
an owner claim committed during the early probe cannot be followed by shared Codex writes.
When that lease is still busy after its wait, `acquireOwnershipMutationLease`
(`src/service/ownership-mutation-lease.mjs`) names the holder in its error and on the error's
`holder` field. That means the owner's PID, whether it is alive, a live holder's executable name
when POSIX `ps` answers within a second (the shared Node/Bun Windows path omits image lookup), and the owner's age on the clock stale recovery
uses, plus the 30-second reclaim rule. `ocx service status` prints the same holder line whenever
the lease directory exists. That read never reclaims.
The connected-client branch, which returns into `startClientRuntime` before the server path,
takes the same lease through `startClientRuntimeUnderOwnershipLease`
(`src/cli/client-start-fence.ts`), rechecks there, and releases once the client runtime has
published its PID and runtime records (`afterPublish`). A child carrying
`OCX_SERVICE_MANAGED` or `OCX_WINDOWS_WRAPPER_PROTOCOL` resolves the recorded owner and
exits the supervisor's stand-down code on a foreign or unknown answer: `42` inside the
marker-protocol Windows wrapper, `0` elsewhere — the legacy `ERRORLEVEL NEQ 0` loop reads
`0` as a clean stop; systemd's `on-failure` and launchd's `SuccessfulExit=false`
keepalive do not restart it. The launchd plist restarts on an unsuccessful exit or signal,
including the exit-1 supervised restart handoff described below. A handled SIGTERM, SIGINT or
SIGHUP would otherwise end in a clean exit and be left down, so the launchd-managed job (macOS
with `OCX_SERVICE_MANAGED=1`) exits `128 + signal` from both the server and client-runtime
signal shutdowns (`src/lib/handled-signal-exit.ts`); every other run keeps exit 0.
`launchctl bootout` and `ocx service stop` unload the job first, so that cannot resurrect a
deliberate stop. Existing launchd jobs retain
their old keepalive definition until `ocx service repair` rewrites and reloads the changed plist.
New WinSW XML stamps `OCX_SERVICE_MANAGED=1`; parent command-line inference applies only to
legacy registrations whose XML lacks that marker. Bare `OCX_SERVICE=1`
is never the marker because `ocx claude`, `ocx codex`, and `ocx opencode` companions carry it too; Codex's client-token loading separately requires a managed loopback destination. A
marker-less Windows registration is still recognised by the parent's command line naming
this install's wrapper script, launcher or WinSW host as a complete token in any position,
and an unreadable parent command line is no evidence and proceeds. POSIX keeps the
explicit-marker path: a companion reparented to init can look service-spawned, and
`systemd --user` children are not init's, so a ppid check would refuse some companions
while still missing user units. Known limits: a legacy POSIX registration written before the
marker, and a Windows child whose parent command line cannot be read, are not classified as
supervised, so until `ocx service repair` rewrites their definition they can still start
over a desktop claim. `detachedStartEnvironment` strips `OCX_SERVICE` and both
supervisor markers before spawning ensure/tray children, because a marker inherited from the
service child's own environment would otherwise answer the gate as a managed job.

## Sidecars

Web search and vision sidecars run only when the main request needs that capability and a usable
sidecar authority exists. Vision has two possible backends; web search's config union additionally
admits `xai`, `gemini`, and `exa`. xAI is a live explicit-only backend through stored Grok OAuth;
Gemini and Exa remain inert until their executors ship. Selection differs per sidecar:

| Sidecar | Backend selection | Default model | Activation |
| --- | --- | --- | --- |
| `web-search/` | Explicit configuration only: unset always resolves to the OpenAI forward path. No backend — Anthropic or otherwise — is auto-selected from credential availability (doing so once sent OpenAI model ids to the Anthropic API). Explicit xAI requires usable stored Grok OAuth and may add hosted `x_search`; explicit Gemini/Exa remain fail-closed until their executors land. | `gpt-5.6-luna` (OpenAI), `claude-sonnet-5` (Anthropic), `grok-4.6` (xAI) | Hosted `web_search` requested by a non-passthrough routed model. |
| `vision/` | Explicit configuration wins for both backends. Only an unset backend auto-selects: Anthropic when a usable Anthropic OAuth provider exists, otherwise the OpenAI forward authority. An explicitly selected backend whose authority is unavailable produces no plan rather than falling back. | `claude-sonnet-5` (Anthropic), `gpt-5.6-luna` (OpenAI) | Request carries images and the routed target is not positively proven image-capable (`requiresVisionPreprocessing`). |

The asymmetry is in the unset case only: vision may describe an image with whichever model can see
it, while a hosted search tool is tied to a provider-specific tool contract, so search never infers
Anthropic from credentials alone.

On the OpenAI path there is one deterministic `openai` sidecar candidate and its current account mode
owns credential selection; API-key OpenAI is not a ChatGPT forward sidecar candidate.

`src/sidecar/` holds what both sidecars share. `src/sidecar/auth.ts` decides whether ChatGPT or
Anthropic auth is present for sidecar purposes, from config and stored account state and never from
request headers; per-request usability stays with the executors. `src/sidecar/candidates.ts` builds
the candidate set both sidecars start from: a model may be offered as a sidecar backend only when
the management model picker would show it, except the fixed slot model of a logged-in side. Vision
then removes provably text-only models, and web search keeps only models whose probed backend has an
executor (`src/web-search/backends.ts`).

Sidecar failures must degrade to text markers or skipped capability, not abort the main request.

### Grok snapshot module ownership

The client-specific tracker lives in `grok-responses-snapshot-repair.ts`; the
provider-opt-in tracker remains in `responses-snapshot-repair.ts`. Their unchanged
object guard, JSON block encoder and retained-item shape live in the dependency-
free `responses-snapshot-codec.ts`. Core imports each tracker directly. No existing
snapshot export moves, and neither tracker imports the core dispatcher. The Grok
marker selects compatibility behavior and conveys no authenticated client identity.

Manual and automatic OAuth/API-key selection commit through their shared selection owners before
dispatch. Selection revisions fence stale retries and reselection; request identity includes the
actual committed account/key. Generic proactive selection is opt-in and preserves a healthy active
account, while reactive429 recovery remains enabled even with the pool off. Post-commit selection
events immediately invalidate dashboard roster state; see`structure/gui-and-management-api.md`.

### Incomplete quota terminals

A native forward response that ends with quota or rate-limit evidence in an
`incomplete` terminal records account quota failure and spawn-fallback health.
Structured `incomplete_details.reason` and error codes are accepted without a
message; ordinary output-limit, filtering, steering and stall incompletes do not
cool an account. Cyber-policy classification retains precedence. The terminal is
not replayed after output, and fixed-account request selection remains fixed.

Remote compact requests release the server request-idle timeout only after a complete
JSON object with a valid model has been read. Partial or invalid uploads retain
the listener guard; admitted compaction then uses the upstream operation's own
deadlines and client cancellation.

Buffered routed compaction treats nonempty text and reasoning deltas as progress
without exposing partial summary text. Comments, empty deltas and gateway
keepalives do not reset the adapter-event stall watchdog. The default stall
timeout stays 300 seconds; encrypted compaction content is preserved unchanged.

Native compact response buffering also enforces a body-byte inactivity deadline
using `stallTimeoutSec` (300 seconds by default). Nonempty chunks reset that
deadline; a stalled body returns HTTP 504, client cancellation retains HTTP 499,
and cleanup does not wait for a stuck upstream cancellation promise. The 32 MiB
response ceiling and the original body bytes are preserved.

A canonical upstream WebSocket refused-create error can become an HTTP 4xx only
before the response is committed and after stream correlation checks. Permitted
quota headers are bounded and rebuilt without upstream framing headers; the JSON
response is not cacheable. Post-commit and 5xx errors keep the no-resend path.

When encrypted agent-task recovery refuses a routed task, its existing 400 error
can include a bounded `recovery_reason`: `unsupported_envelope`,
`admission_denied`, `recovery_unavailable`, `caller_cancelled`, `input_changed`,
`recovery_http_rejected`, `recovery_timeout`, `recovery_aborted`,
`recovery_transport_error`, or `recovery_invalid_output`.
HTTP rejection requires an observed non-success response. Invalid output includes
invalid UTF-8, oversized bodies, malformed or incomplete recovery streams, and
invalid or conflicting assignments. A caller's cancellation takes precedence over
an owned deadline, which takes precedence over decode/transport failures.
`recovery_aborted` describes a shared recovery cancelled independently of that caller.
Shared-flight waiters receive the same underlying failure unless individually cancelled;
only successful plaintext is cached. Diagnostics contain no upstream error or payload text.
The field is omitted when no classified recovery result exists, and existing combo
branches that return the original target failure keep that response.
`recovery_unavailable` includes cache/singleflight capacity and does not prove an
upstream request was attempted. No retry or broader envelope acceptance is enabled.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Voice diagnostic metadata

`src/server/live.ts` owns optional `OCX_LIVE_FRAME_LOG` diagnostics for both sideband directions.
The JSONL schema contains only `ts`, `dir`, `kind`, `bytes`, and `fffd`. It never stores frame
content or transcript excerpts, and logging failures do not affect transparent frame delivery.
Binary detection decodes only the supplied buffer view; malformed UTF-8 can itself produce U+FFFD,
so the flag does not identify the peer responsible for corruption. Existing diagnostic files are
not rewritten. Audio devices, WebRTC media negotiation, captions and spoken handoff delivery remain
client responsibilities.

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../dashboard-and-usage.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](../dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.

Connected CLI usage follows the [client-scoped hub usage contract](../dashboard-and-usage.md#usage-accounting); local management and account data remain separate.

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration.

Auxiliary listener startup failures report their own effective address and do not trigger public-port retries; the synchronous rollback contract is described in [Runtime](../runtime.md#lifecycle).
Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../dashboard-and-usage.md#combo-editor-routing-quota).

Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-accounts.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity.

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

Provider summary defaults are evaluated per routed Responses request without changing service lifecycle or sidecar activation. See [runtime](../runtime.md).

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-accounts.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

Account quota surfaces use [safe probe diagnostics](../transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](../transports/responses.md) documents this boundary, and native Chat also honors explicit per-axis capability declarations; in the default `decide` mode an initial JEV null choice separately strips caller effort.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](../transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](../transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](../transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](../gui-and-management-api.md#fast-selector-rows-setting).

The service loads the optional `compactionRouting` block from persisted configuration.
[Responses ingress](../transports/responses-failover.md#compaction-routing-overrides) applies it to individual compaction
requests whose trigger the block names.

Standalone binaries use `src/lib/standalone.ts` to recognize hostless `file:` module URLs
whose decoded pathname begins at Bun's `$bunfs` or Windows `~BUN` virtual root. The helper
decodes one URL layer, so encoded Windows tildes work while network-host and nested source
paths do not impersonate a bundled module. `src/service/state.ts` composes durable service
commands as `<execPath> start`, without a source-tree CLI path. The copied `gui/dist`
directory is located by `src/server/gui-static.ts`;
`OPENCODEX_GUI_DIST` remains an explicit override.

## Bun updater ownership transaction

For orchestrated Bun installs, `src/update/orchestrated-entry.ts` starts an exact-version child and classifies its recorded outcome against passive tree and live runtime verification. For npm/pnpm, `src/update/orchestrated-node-driver.mjs` obtains a bounded Bun plan, shares admission decisions with the Bun driver, starts the same launcher with the pinned version, and independently verifies the installed or previous tree and any restarted runtime. The npm/pnpm Node child uses `src/update/orchestrated-identity-probe-entry.ts` to recheck the attested identity and plan token before mutation, and records the installer outcome after recovery. For pnpm, the parent also passes the canonical selected executable, package, global group and bin directory in the expectation, plus the canonical store, lexical store path and virtual-store directories for a global-store owner; the child re-resolves that owner and refuses a missing or changed identity before stop or package mutation. Older expectations remain valid for npm and Bun only. Orchestrated and legacy update workers hold the sync/update mutex from preflight through recovery and the final marker; a parent watchdog reports an orchestrated overrun without killing the child. The ordinary ownership lease may still be released for service-manager recovery. `src/update/orchestrated-arguments.mjs` parses the orchestrated update grammar for Node and Bun; `src/update/orchestrated-outcome.mjs` classifies verified child outcomes without treating an uncertain child as settled; `src/update/orchestrated-tree.mjs` checks the active npm/Bun package tree without touching retained backups; `src/update/orchestrated-plan.ts` constructs a fail-closed plan from observed install, owner, runtime and version facts. `src/update/orchestrated-token.mjs` hashes an explicitly selected, canonical install and runtime identity; runtime attestation secrets are excluded from the digest input. `src/update/orchestrated-identity.ts` and `src/update/orchestrated-live-identity.ts` require an attestation proof and an unchanged runtime record before returning a serving identity, and accept a source entry only when it is exactly `<root>/src/cli/index.ts` (on Windows `/` and `\` count as the same separator; dotted or doubled forms stay unknown); older records can only prove an executable mismatch or remain unknown. `src/update/sync-update-mutex.mjs` uses a separate, non-reentrant home-scoped lease that records whether sync or update holds it. The Node sync launcher publishes its child PID as delegate; reclamation waits for both PIDs to die, and a new Bun child waits at most two seconds to verify its own PID before mutation. An older Desktop child cannot verify the publication: if the launcher is killed between spawning it and publishing its PID, that child can outlive the stale lease. Parents hand the child its result destination through `createOrchestratedResultChannel()`: a fresh temp directory holding one exclusively created capability file, whose token goes to the child in `OCX_UPDATE_RESULT_CAPABILITY`. `parseOrchestratedChildArgs` deletes that variable from the environment it parses, so probes, installers and other subprocesses never inherit it; the Node launcher re-adds it only to the Bun CLI process that continues the same validated child. Before any write, the child accepts only a canonical, single-link, non-symlink regular file (owner-only on POSIX) whose entire content is that capability document, then publishes every record through the descriptor it validated (truncate, then write at explicit offsets). On Windows the canonical-path equality (`realpathSync.native`) rejects symbolic links and junctions in the destination path, tested in both Node and Bun; other reparse-point kinds are not separately probed. The parent reads only the file identity it recorded. It unlinks that file and removes the directory (non-recursively) only on POSIX, and only when every ancestor is owned by the user or root and is not group- or other-writable unless it is root-owned and sticky; otherwise, and always on Windows, it leaves the channel in place, holding at most its own capability or result record. Two same-user races remain accepted: replacing an entry inside the owner-only channel directory between identity check and removal, and replacing an entry in the OpenCodex home between marker checks and publication. Both require write access that already carries the user's authority, which assumes the home and its ancestors cannot be replaced by another principal; that precondition is stated, not enforced. `src/update/orchestrated-session.mjs` publishes preflight and mutation outcomes, holds that lease through final outcome and marker publication, and fences mutation on deadline and identity checks. `src/update/ownership-transaction.ts` holds one mutation lease across the Bun updater's awaited
stop, package replacement and recovery work. The parent never puts its token in the global
environment. Fixed stop/service/direct-recovery children can join it; package-manager and
ancillary children receive environments without the capability. Refusals return through the
lease boundary before exiting, and thrown failures release it after owner-aware recovery. Before installer launch the mutation marker carries a 15-minute fence from worker start; a dead worker, timed-out or killed installer, or unconfirmed exit retains that fence, while live or uninspectable recorded installers remain fenced independently. For POSIX npm, pnpm and Bun installs, `src/update/posix-install-supervisor.mjs` starts a gated process-group leader, publishes its PID and group ID before allowing the installer to run, and terminates the group on the 180-second deadline. On normal installer exit and confirmed group disappearance, finalization clears the fence. Process groups cannot contain detached descendants: an escaped descendant can outlive a normally exiting installer and continue after the fence clears, an accepted residual; it can also outlive a timeout fence. Windows uses the Job Object supervisor in `src/update/npm-install.mjs` and clears the fence only after normal exit and an empty job. Before the supervisor receives its request, `src/update/windows-installer-marker.mjs` records its PID as `installerPid` on a marker awaiting an installer. Because the job is kill-on-close and only the supervisor holds its handle, that PID is the Windows process-tree witness (#8524). `inspectUpdateMarker` reports an unconfirmed Windows installer free once the fence has passed and both the launcher PID and that supervisor PID are gone. A confirmed exit drops the Windows-shaped witness, so a finished update leaves no PID for a reused number to hold; a recorded installer PID is otherwise probed on every platform. A supervisor whose PID cannot be recorded receives no request and reports an unstarted installer. A live earlier supervisor keeps its witness and the new run stays unconfirmed. An unconfirmed marker without a witness, such as one written by an older release, stays uncertain. The inspection reports that case through its `detail` out-parameter, and only a refusal it causes prints `staleUpdateMarkerHint`: the marker path and a reversible rename, after the unchanged `update-in-flight` line. This covers the legacy session start through a non-wire `staleMarker` flag and the sync guards through `refuseSync`.
Replacement and recovery inspect both the captured endpoint and the freshly read runtime record.
Malformed or unreadable records remain unknown. Recovery requires the same complete owner
identity and proven-dead liveness; unknown or transferred ownership never starts another proxy.
Live supervision is re-read separately from durable ownership before stop, package replacement,
service restoration and direct recovery. Each service command, Node/Bun update run and dashboard
restart decision shares one `createSupervisionLatch()` from `src/service/desktop-supervision.mjs`:
`desktop` or `unknown` with `desktopSeen: true` blocks; only a later `none` clears it.
Plain unknown/unsupported evidence preserves existing decisions unless an earlier block remains; `src/update/runtime-ownership.mjs` denies all three update authorities and failed-update recovery
when blocked. A restoration refusal after a completed package swap does not undo that update.
Service install, repair, start and restart refuse before mutation, including Windows XML staging,
when live Desktop supervision is verified; `ocx stop` shows the Desktop notice. Windows probe acquisition and residual limits: [desktop supervision](desktop-supervision.md#runtime-ownership-from-the-apps-side).
The lease is released before any service-manager-mediated start (`service repair` in recovery
or the post-install refresh): the manager's `ocx start` child cannot join it, and holding it
through the repair's health wait keeps that proxy from starting (#5760). The recovery decision
is made again after the release, and the lease is re-acquired before each fallback's ownership
re-read so a claim landing in the unleased window is vetoed rather than killed unleased.
Direct recovery retains the lease until readiness or its bounded deadline. If acquisition fails, Node and Bun return false before owner inspection or spawn and print static manual repair/start guidance without the error's details.
`src/update/index.ts` rechecks service-home authority in the mutation caller after its final ownership or recovery-plan await, before proxy stop and each service repair. Service mutations also require `homePolicy.serviceAllowed`; a previously installed registration disappearing before full stop refuses, while recovery uses guarded direct start. No await separates these final checks from the control command. The dashboard worker in `src/update/job.ts` also checks service permission before stopping wrappers after its service import. Package replacement retains its separate stable-unknown package-only policy.
The normal successful manual-runtime update still prints the existing restart hint. All three update lanes use the shared latched mutation gate described in [Update Supervised Recovery](update-supervised-recovery.md#service-home-authority), including fresh checks between blocking control calls and before terminal success.
Every updater lane makes the same exception where the service manager starts the proxy outside
the updater's process tree, so that proxy has to take the lease itself; held through the
repair's health wait, the lease kept it from starting, and recovery fell through to a second,
directly started proxy (#5760). The npm launcher in `bin/ocx.mjs` releases the lease before a
post-failure service recovery, as a successful update does, and makes the recovery decision
again after the release. The Bun updater releases before `service repair` in both the recovery
branch and the post-install refresh — the port reclaim that authorizes kills already ran under
the lease — and re-acquires before each fallback's ownership re-read, so the re-read and any
direct start stay serialized with a claim that landed in the unleased window; after the package
swap, a lease that stays claimed is reported with manual recovery steps and a non-zero exit. The
dashboard restart worker in `src/update/job.ts` releases the lease immediately before `ocx
service repair` and re-acquires it at the direct-start fallthrough, waiting long enough to
outlast one service-wrapper respawn, then re-runs the durable-owner and live-supervision veto under it before
mutating the port, because a claim could have landed during the now-unleased refresh window. A
lease that stays claimed fails closed: nothing is started, and the job is marked failed, since
the refresh before it produced no serving proxy; an ownership veto ends as succeeded only after a fresh service-home check. CLI refresh and final fallback vetoes give home refusal precedence too.

On Windows, `src/update/npm-invocation.mjs` reads copied shell-location keys case-insensitively,
with exact-key precedence, no ambiguous alias selection, and the same absolute-path checks.
Scoop admits only `%USERPROFILE%\scoop\apps\nodejs{,-lts}\current` and `current\bin` PATH entries
from outside the installation. Home, junction, PATH entry, npm candidate and cwd resolve to
physical paths: `current` stays inside its Scoop app and npm inside the admitted entry.
`current\bin` may resolve to `%USERPROFILE%\scoop\persist\nodejs{,-lts}\bin`; cwd inside that
persistent bin is excluded too. The fixed persist suffix uses the physical home, accepting 8.3
home aliases without trusting a redirected persist subtree. Unreadable paths fail closed.
Other Scoop apps, version-directory entries (`NO_JUNCTION`), custom home-root Scoop installs,
arbitrary descendants and cwd inside the resolved Node installation are not admitted.

The Windows npm staging runner (`src/update/npm-install.mjs`) keeps a 180-second install budget and a separate 10-second join budget. Before cleanup or verification, it requires proof that the full installer tree exited, including when npm returns status zero.
After that barrier and stage verification, the transaction's synchronous replacement callback rechecks home authority, owner, supervision and dead liveness before the live swap. A denied callback returns `authorize`, removes only the owned exited stage and leaves the old package usable; failure guidance classifies this as an untouched install. The same callback runs after synchronous npm staging. Pinned restart preparation separately checks current service permission inside its wrapper callback after the fresh home gate, so confirmed absence grants foreground cleanup without a global service stop.
On Windows, `src/update/npm-install-job.ps1` creates the root atomically inside a private kill-on-close Job Object using `STARTUPINFOEX` and `PROC_THREAD_ATTRIBUTE_JOB_LIST`. It stays suspended until local exit-proof handling is armed. `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` admits only stdin and npm's stderr, excluding the Job and supervisor result pipe; attribute lists and value buffers are freed. Windows 10+ Job List support is required: attribute setup or extended creation failure returns `EINSTALLJOIN` with a clear prerequisite and native error, without starting an unsupervised installer or retrying a legacy creation path. Timeout terminates the job, checks zero active members and waits for the root handle. The updater and recovery stay outside this job; a watchdog bounds supervisor startup/protocol failure.
Missing exit proof retains the complete stage and marker. npm output drains before a successful join returns; failed supervision stops forwarding it. Windows timeout diagnostics retain `ETIMEDOUT` and the budget; stage failures retain owner-aware recovery through the untouched launcher. POSIX keeps the legacy synchronous install and status-only transaction; complete-tree timeout cleanup remains open there because process groups do not contain detached descendants.
The npm transaction creates each staging directory exclusively and may clean that fresh path while the creating process still owns it. On POSIX it also creates the stage's `lib` directory, because npm's strict script policy plans the global tree before creating the prefix layout (#5760).
A later update only reports staging leftovers. It does not recursively delete them from a marker: the marker is not an authorization secret, and a neighbouring writer could replace a previously checked pathname with a link before traversal.

Before any tray or proxy stop, `src/update/npm-cache-preflight.mjs` checks npm's cache on every
platform (#6288). The cache root, or the nearest existing folder npm would create it under, must
resolve to a directory. A file in its place is `cache_root_not_directory`, and a link or Windows
junction whose target is gone is `cache_root_dangling_link`; both abort with fixed guidance that
names neither the path nor npm output. Windows runs only this root check, because it has no uid
or Unix owner bits, while POSIX also runs the bounded ownership/mode walk. Windows skipped the
gate entirely before #6288, so there only those two root reasons block; an unresolvable npm cache
path, a worker timeout or any other inconclusive result returns `windows_skip` and the update
proceeds unpinned as before. POSIX keeps failing closed on them. The npm launcher
resolves `npm config get cache --global` once, from the home directory and with the environment
staging uses, checks that path and passes it to the stage as `--cache`. Global mode and the home
directory keep a project `.npmrc` in the caller's cwd from choosing the pinned cache, matching the
`npm install -g` stage that never reads project config. On Windows a resolved path containing
`" % ! ^ & | < >` is refused rather than escaped, because `npm.cmd` re-parses `%*` after our
cmd.exe quoting; the update then proceeds unpinned. The pin is required: `--prefix <stage>` moves npm's
globalconfig to `<stage>/etc/npmrc`, so a `cache=` from the operator's global npmrc would
otherwise be dropped and staging would use npm's default root, which the pre-flight never
checked (`tests/update/update-npm-cache-preflight.test.ts`,
`tests/update/update-transactional.test.ts`).

The probe ceilings are module-load constants in `src/server/proxy-liveness.ts`: 750 ms for the
shared default and 1500 ms (three attempts) for `SERVICE_STOP_LIVENESS` and
`START_OWNERSHIP_LIVENESS`. `OCX_PROBE_TIMEOUT_MS` (whole milliseconds, 1 to 30000) only raises
them for hosts whose loopback connects are slowed by a security layer; each ceiling keeps its floor,
so an override can never shorten the budgets that prevent a duplicate proxy, and a value above the
30 s ceiling is ignored so the single-shot stop deadline (`timeoutMs * attempts + 250` in
`src/service/orchestration.ts`) stays bounded. `tests/server/probe-timeout-env.test.ts` reads the
constants in child processes.

In Bun installs (`src/update/index.ts`), `runConfigPreflight` opens `config.json` and checks the same descriptor's bytes using passive diagnostics before stopping the proxy. Imported-text diagnostics suppress configuration-derived sanitizer warnings for this check; normal diagnostics and loading retain their warnings. The check writes no recovery backups. An unreadable entry (including a dangling symlink), descriptor close failure, or configuration requiring diagnostics fallback or salvage aborts with code 1 before tray handoff or `ocx stop`. Recovery guidance distinguishes unreadable paths from readable invalid files and explains that validation does not edit the file. Reparable configs and readable symlinks to regular files pass; a genuinely missing config is allowed. The check does not prevent later edits. npm/pnpm flows (`bin/ocx.mjs`) keep their existing stop sequence.
The npm and Bun updaters confirm the stop with the plain-ESM tri-state probe `src/update/proxy-liveness-probe.mjs`, decided by
`src/update/stop-decision.mjs`. A refused dial is `dead`. A dial that is only dropped or times
out, which is what a listener bound to a tailnet address produces once it is gone, falls back to
one transient exclusive bind of the same host and port, only when the host is a literal IP address
(a name can resolve differently for the dial and the bind, so it stays `unknown`): success is `dead`,
any failed bind (`EADDRINUSE`, `EADDRNOTAVAIL`) is `unknown` and still aborts the update. The probe's ceiling is
its dial timeout plus a 1500 ms child-spawn limit, after which the answer is `unknown`. A
successful bind records that nothing held the port at that instant; it does not claim the
endpoint can never restart. Focused coverage is `tests/update/update-stop-classification.test.ts`.

`src/update/index.ts` first recognizes compiled POSIX and Windows module URLs with `src/lib/standalone.ts`, the same standalone marker used by runtime status. These installs report `installer: "standalone"`, `canUpdate: false`, and `reason: "standalone_install"` with Desktop Check for Updates or release-binary reinstallation guidance; package registry lookup, package-update prompts and automatic refresh timers stay off. The Desktop bundle updater remains separate. Regression coverage is `tests/update/update-standalone.test.ts`. For package installs, `src/update/install-detection.mjs` examines both lexical and resolved package paths. An enclosing mise installation owns its nested npm/aube package only when the adjacent `.mise.backend.toml` identifies the containing tool alias and the canonical `npm:@bitkyc08/opencodex` backend. That verified outer owner takes precedence over the inner npm layout. Two verified owners whose tool roots differ only by a symlinked ancestor (macOS `/var` -> `/private/var`) are compared by canonical directory and count as one install. An unreadable or contradictory ownership boundary on either path takes precedence over a verified owner on the other path, refusing mutation without inventing a tool name or recovery command. One boundary is not OpenCodex's at all: on Windows, npm -g under a mise-managed Node puts the package directly in `<mise>/installs/node/<version>/node_modules`, whose adjacent record is Node's own (`short = "node"`, `full = "core:node"`). That exact record with the package directly in the runtime's global `node_modules` is an npm install and falls through to npm detection; any other backend, alias or deeper layout stays fail-closed (`tests/update/update-mise-node-runtime.test.ts`). `ocx update`, dashboard update checks, and update workers expose `installer: "mise"`; checks remain read-only, while mutation is refused with `mise upgrade <verified-alias>` before any proxy stop, package write, or worker creation. The package-tree integrity guard remains active for mise packages, and the managed Linux service additionally follows its mise package launcher onto an upgraded version ([package-tree integrity fence](docs-and-release.md#package-tree-integrity-fence)).

## Restart handoff

Ordinary signal shutdown passes the CLI's idempotent exit cleanup to `drainAndShutdown` in `src/server/lifecycle.ts`: its drain-finally block calls the synchronous-only `() => undefined` hook before listener stop. Promise-returning hooks are outside this contract; there is no asynchronous cleanup wait. Listener stop and startup-lifecycle release still run if cleanup throws. Restart callers omit that hook and retain their existing routing-preservation decisions; receipt-backed stop deferral remains owned by the stopping client. After verifying a matching receipt, `performStopTeardown` records a dedicated process-lifetime exit deferral; exit cleanup consults it before restoring native Codex/Grok, including when the API's own drain ends in `process.exit`. A query flag or connected-client capability does not set it. API and signal restoration repeat the [connection ownership guard at each write](../runtime.md#remote-hub-hardening-ownership); an unproven API boundary returns 409 before scheduling shutdown, and signal cleanup reports failure while preserving shared configuration. `tests/fixtures/api-stop-exit-runner.ts`, exercised by `tests/service/stop-deferred-teardown.test.ts`, runs the actual API handler, listener drain and process-exit cleanup in one child. `tests/service/shutdown-drain.test.ts` covers the hook with a real loopback listener and the CLI signal handler.

During drain, `src/server/index.ts` rejects new data-plane work with HTTP 503 and `src/service/linux-linger.ts` observes boot lingering without changing it; enabled, disabled and unknown states receive distinct install advice. Desktop startup distinguishes enabled next-login registration from current loaded state, preserving identity/disabled/supervisor checks. `src/cli/hub-disable.ts` changes persisted hub settings only, prints Desktop/service/manual restart guidance and reminds the operator to review external publishing to old ports.
an explicit JSON envelope: `error.type` is `server_error`, `error.code` is
`server_restarting`, and `error.message` is "OpenCodex is restarting; retry this request."
The response keeps `Content-Type: application/json`, `Retry-After: 5`, and the
receiving listener's CORS policy, including on the unauthenticated loopback listener.
Codex maps a 503 with `server_is_overloaded` to `ServerOverloaded` ("Selected model is at
capacity"); current Codex retries it only when retry advice survives mapping, and older
clients do not retry it at all. `server_restarting` falls through to retryable
`UnexpectedStatus` in either case and never reports a restart as model capacity. This drain-only
response bypasses the shared provider-overload mapping in `src/lib/errors.ts`.
`tests/codex-integration/issue-452-empty-503.test.ts` pins its body and both listeners' CORS.

`src/server/management/system-routes.ts` accepts an optional JSON `drainGraceMs` on the authenticated restart API: an integer from 1 to 60000, with omission retaining the 60-second default. Invalid
input starts no drain. `src/server/management/system-restart.ts` fixes the selected grace at first acceptance; repeated requests cannot shorten it. The response-flush delay stays 200ms for every
caller. A grace shorter than 200ms cancels and releases active turns at the accepted deadline via
a separate timer, cancelled by a pending restart veto. Cleanup, listener stop and process exit
still wait for the response-flush delay; grace of at least 200ms arms no extra timer. The cleanup
watchdog stays 60 seconds and replacement readiness stays 70 seconds. Short grace is an explicit
API opt-in; dashboard, CLI, tray, join and automatic restarts keep their default. An interrupted
turn may have an unknown upstream outcome and is not automatically replayed.
`tests/server/system-restart-admission.test.ts` covers this contract and active-turn preservation.

A dashboard drain-and-restart (`src/server/management/system-restart.ts`, including a join into a Child) and the
client runtime's standalone recycle (`src/client/runtime.ts`) use `src/server/restart-replacement.ts`. Every child
carries `OCX_RESTART_PARENT_PID`; `handleStart` consumes it before probing and honors only its real parent PID.
If that parent still answers, `decideStartWithLiveOwner` returns `await-parent`: `src/cli/restart-handoff.ts` waits
up to 30 seconds, re-probing each second, then refuses a surviving owner. An ordinary start probes once without a marker.

After completed drain and successful listener stop, the unsupervised dashboard parent prepares its sibling handoff,
then `src/server/restart-parent-ownership.ts` retires only its own PID/runtime records under the ownership mutation
lease before spawning and waiting for child health. Foreign PIDs, mismatched runtime ports, malformed, linked or
unreadable records and incomplete removal refuse the handoff. Only ENOENT proves a missing record. The lease is
released before spawning, so child recovery and publication can acquire it. The normal fence still refuses live and
unknown owners; no child marker bypasses it. Exact-PID exit cleanup preserves the successor's records.
`tests/server/system-restart-ownership.test.ts` covers refusal controls and real processes, drain, alive-parent endpoint
refusal, replacement health and parent exit; its fixture does not start providers or exercise dashboard HTTP authentication.

A completed-drain health wait retries a replacement that exits before answering at most twice within one 70-second
readiness budget; spawn errors are not retried. A parent-exit handoff (drain deadline, failed or rejected drain,
listener-stop fallback) resolves as soon as the child spawns, because the parent must exit to release what the child
waits for. It cannot watch for early exit. The child's `await-parent` wait and link-mode port reclaim cover the known
transient causes. Other early exits leave the port unserved until another `ocx start`, while Codex keeps pointing there.

Replacement output goes to `<configDir>/restart-handoff.log`: private mode 0600, opened without following symlinks,
recorded as an owned path and bounded at 256 KiB. Handoff empties an already-full file. `OCX_RESTART_HANDOFF_LOG=1`
tells `handleStart` to arm `armRestartHandoffLogCap`, an unref'd 60-second timer which lstats and empties a full log
through a fresh descriptor. An ordinary start arms no timer. Parent log lines carry only timestamps, PIDs, ports,
attempt counts, exit codes and errno labels, never environment values.

When every attempt fails while client state is `connected` (a join has committed), the parent marks
recycling before `exit(1)`, so its exit cleanup keeps the Codex routing `connectClient` wrote
instead of restoring native Codex; a standalone restart still restores. The standalone recycle
waits for its replacement to answer, exits 1 when it never did, and falls back to `config.port`
when the listener recorded none. A supervised process (`OCX_SERVICE=1`) never spawns and exits 1
for its supervisor. Coverage: `tests/server/restart-replacement.test.ts`,
`tests/cli/cli-restart-handoff.test.ts`, `tests/server/system-restart.test.ts` and
`tests/clients/client-runtime.test.ts`. The client runtime's bound restart (OCX-6) keeps serving when its replacement fails, so it alone passes `notReady: "terminate"`: an unready replacement is stopped and `not_ready` returns only after its exit is observed (`tests/server/restart-replacement-not-ready.test.ts`; contract in [Remote Link](../remote-link.md)).

A process the desktop app spawned spawns no replacement at all. The app sets
`OCX_DESKTOP_SUPERVISED=1` on its sidecar; `handleStart` consumes it with the other start markers and
records the parent pid (`src/lib/system-restart-contract.ts`). While that parent is still this
process's parent and alive, the drain-and-restart (completed and deadline paths alike) marks
recycling and exits 75, the standalone recycle exits 75 once its cleanup ran, and the app starts the
replacement itself ([desktop shell](../desktop-shell.md#keeping-the-runtime-alive)). This check runs before the service
rule, because that app, not a service manager, is the parent. An app that crashed leaves the runtime
re-parented or its parent dead, and the restart falls back to the detached replacement. Every
detached replacement's environment drops the marker. Coverage:
`tests/clients/desktop-supervised-restart.test.ts`.

## Package cache refresh

src/update/refresh-scheduler.ts owns the package cache timer and per-channel singleflight for the running proxy. Eligible npm, pnpm and Bun installs refresh missing or 20-hour-stale `version.json` after bind, check staleness hourly and retry failures with bounded backoff. Each server start owns one scheduler reference; the last matching stop disarms the timer. A stopped automatic lookup cannot write a late result, but an explicit check joining that lookup marks explicit interest and writes its successful result even if the last listener stops before it resolves. Source/mise/standalone installs and `OCX_DISABLE_UPDATE_CHECK=1` do not start automatic lookup; explicit requests remain available.
A pnpm 11/12 global virtual-store install (`<store>/v11/links/...`) is verified only against the store pnpm itself names. `src/update/pnpm-global-install.mjs` classifies the listed package by its link spellings (`v<N>/links`, or a configured virtual-store directory inside a store carrying pnpm's `files` and index markers). Classification only chooses the proof and never accepts a package: a spelling is never proof, so a classified package is accepted only on the store proof, and a pinned global-store owner is re-proven at preflight, readback, rollback and orchestrated post-update re-resolution (`resolvePnpmGlobalOwner` with `requireStoreProof`). Every effective spelling on the package's link chain is judged, the listed one first: a `v<N>/links` component classifies unless the package finally lands in an isolated install (a `node_modules/.pnpm` store) inside that same links directory, and pnpm's store markers on any versioned ancestor of any spelling classify. During an update a store owner's store and global group are also pinned by device and inode, and a replaced directory stops the transaction before `pnpm add` or a rollback. A layout without store links or pnpm's store markers keeps the released legacy verifier with no pnpm version or store query, as on dev. A legacy group that merely sits under a store-like directory is refused without the store proof; the refusal names that cause and points to `pnpm add -g` (docs-site troubleshooting/update-failed). For a global-store owner it requires a pnpm major whose behavior was checked (11 or 12), takes pnpm home from the environment the pnpm commands receive (`PNPM_HOME`, `XDG_DATA_HOME/pnpm`, then the platform default), refuses a missing anchor, a control character, or an anchor that is not canonical (on Windows also any of `"%!^&|<>` in the anchor, printed store path, global directory or global bin directory, which cmd.exe re-parses after quoting), and runs `store path --dir=<pnpm home>` without `--store-dir` through the same runner, environment and read cwd as `list -g`. The answer must be one absolute path ending in `v<N>`, and it and the listed global group must also be canonical, because a linked spelling would widen the roots every hop is confined to. Canonical means no `.` or `..` segment, no link or junction component, and a realpath equal to the spelling; its lexical spelling and canonical target are pinned separately, rechecked before install, readback and rollback, carried through orchestrated parent/child verification, and the lexical spelling is passed as `--store-dir` to `add` and rollback. The listed package spelling must have no `.` or `..` segment, its realpath must be inside that store, and `src/update/transactional-install.mjs` requires every link hop from the listed spelling to stay inside the canonical global group or the store; it then confines dependency links, entry points, and any ancestor or Node global lookup root that lies inside the store to the store. Lookup roots above or outside the store (a user's ~/node_modules, NODE_PATH, including dangling entries) are not part of the package and are ignored, except that a declared dependency missing from the store and resolvable from an ancestor node_modules is refused (a required dependency missing from the store is always refused). Each link's own text is followed component by component, so a `..` detour through an outside directory cannot be collapsed away. Configured virtual-store directories must also lie inside it. Legacy isolated or hoisted groups are not global-store owners: they make no store query, carry no store fields, and keep the released verification, which still refuses any package that uses store links without a selected store.

src/update/async-check.ts uses the existing owner-bound registry target with a bounded asynchronous child; pnpm owner discovery runs in src/update/pnpm-owner-worker.ts off the request loop. Read-only pnpm owner and registry probes — in the scheduler, the synchronous updater, and the `bin/ocx.mjs` package-manager self-update — run from the installed update module directory via `src/update/pnpm-read-policy.mjs` with project pnpmfiles disabled, never from the caller's workspace. pnpm mutations (`add -g`, rollback) instead run in unique private temporary workspaces outside the package, with an explicit empty workspace boundary to stop parent-project discovery. Both updater lanes supervise these mutations with a POSIX process group or Windows Job Object; unconfirmed termination retains the fence and prevents readback or another mutation. Both npm_config_ and pnpm_config_ ignore-pnpmfile controls are set case-insensitively for pnpm 10/11. Cleanup removes only known files and an empty unchanged directory; unexpected contents remain for inspection. On Windows, this also avoids pinning the replaced package as cwd. `src/update/notify.ts` writes successful results atomically and preserves a dismissal only for the same channel and version. The interactive pre-bind prompt reads the cache and does not launch a second detached refresh. `src/update/badge.ts` only reads the cache and reports unknown at 40 hours. The pnpm update result retains its legacy `rolledBack` signal for a verified previous version, including an unchanged active tree. Its `rollbackPerformed` field is true only when a rollback transaction succeeds and the restored tree and shims verify; orchestration must use that distinction when reporting an actual rollback. `src/update/orchestrated-pnpm.mjs` provides read-only post-update evidence: it re-resolves the selected pnpm owner, requires the original global group and bin directory, and verifies the active package version, source, dependencies and generated shims. It is a verification building block; it does not itself initiate an update. The orchestrated outcome classifier treats malformed phase records and unconfirmed installer termination as uncertain (exit 12), and requires an absolute active root on an installed record before it can report success. `src/update/orchestrated-child.mjs` forwards catchable signals and waits at most 60 seconds for child close after interruption; a timeout is unconfirmed, not evidence of termination. Its optional parent watchdog reports overrun without signalling the child; the caller must detach its handles and preserve in-flight evidence.

The desktop badge snapshot in src/update/desktop-badge.ts is process-local display state keyed by a Tauri session id. A 60-second shell heartbeat renews receipt time; entries expire after 180 seconds and the store retains at most 32 sessions. It is separate from the package version cache and from the updater job/ownership transaction. A proxy restart reports unknown until a bound desktop shell republishes; no update installation can be authorized by this snapshot.

Desktop startup diagnostics use `src/service/desktop-startup.ts` to read the ownership record, the login registration (macOS: launchd; Linux: the `~/.config/autostart/OpenCodex.desktop` entry that auto-launch writes, credited only when `XDG_CONFIG_HOME` is unset or `~/.config`; it must launch an unquoted absolute `opencodex-desktop` with exactly `--autostart`, without conditional keys, and not be hidden or disabled) and exact parent/child executable paths (Linux: `/proc/<pid>/exe` and the parent pid from `/proc/<pid>/stat`) without mutating them. A durable desktop claim survives a failed identity or supervision check; its protection requires fresh matching identity, enabled login registration, and live supervision. Only ownership `none` enters the unowned branch: verified supervision adds `supervisor: { supervisorPid, runtimePid, app }` with `owned: false`, and protection requires that same app's verified login registration and a fresh, running, viable diagnostic. Unknown ownership and CLI-owned claims receive no supervision credit. The independent process evidence requires two matching snapshots and correlation of the target, PID-file and runtime-port PIDs, as described in [desktop supervision](desktop-supervision.md#runtime-ownership-from-the-apps-side); it never becomes ownership. An unloaded macOS job receives credit only from two matching plist/target/enabled snapshots; a boolean plist Disabled default combines with explicit launchctl overrides, and malformed or changing evidence refuses credit. On macOS, ownership and PID are re-read before crediting an owned result; on Linux, the complete owned evidence chain is read twice and both reads must agree. The startup-health subprocess uses `selfLaunchArgv` to support both source and compiled entrypoints. On macOS, a missing LaunchAgent counts as disabled only when repeated absence checks surround matching independently verified Desktop supervision and unchanged ownership; unreadable paths, dangling links, replacement and process races remain unknown.

On Linux, a dashboard update worker started from the systemd user service is launched through an executable regular file at a trusted absolute path — `/usr/bin/systemd-run`, `/bin/systemd-run`, `/usr/local/bin/systemd-run` (local installs), or `/run/current-system/sw/bin/systemd-run` (the NixOS layout) — with `--user --scope --quiet --collect` (`src/update/worker-launch.ts`), so it leaves the service cgroup before the updater stops `opencodex-proxy.service`; the default `KillMode=control-group` otherwise kills it with the proxy (#5750). The inherited `PATH` is never searched, and each candidate's resolved target — plus every ancestor directory able to substitute it — must be root-owned and not group/world-writable: a trusted-path symlink into a user-replaceable directory is skipped, as is a group-writable `/usr/local/bin`, rather than exec'd under the service account. Candidates are tried in order and a path whose no-op scope probe fails falls through to the next trusted path; the probe applies only when `INVOCATION_ID` is set, and every other case keeps the plain detached spawn. The management route resolves the launcher with `resolveSystemdRunAsync` before spawning, so first-request probing overlaps other work instead of blocking the event loop for up to twenty seconds. `--scope` moves `systemd-run` itself into the scope and then execs the worker, so the recorded PID is the worker's (`tests/update/update-worker-launch.test.ts`). A dashboard update that would run, with or without restart, refuses before any package mutation when the proxy runs inside a systemd service: the innermost `.service` or `.scope` unit of `/proc/self/cgroup` decides (a `.service` other than the per-user manager is a service, so a unit that unsets `INVOCATION_ID` is still seen; a terminal or app `.scope` is not, even with an inherited `INVOCATION_ID`), and only when no cgroup can be read does `INVOCATION_ID` alone count, failing closed unless a trusted scope launcher works and the cgroup places the proxy in OpenCodex's own `opencodex-proxy.service` below a `user@<uid>.service` manager: the update stops the proxy before replacing the package, so a worker left in the service cgroup dies with it, and a custom system unit with `User=` is not one the updater can restart, nor may an installed but inactive user unit become the restart target (`dashboardRestartRefusal`, 409 `update_restart_unsupervised`, #7967).
