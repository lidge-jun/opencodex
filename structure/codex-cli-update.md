# Codex CLI Update

`src/codex/cli-update-plan.ts` constructs the read-only update plan;
`src/codex/app-server-processes.ts` supplies its process observation.
Installation inspection follows the [runtime inspection contract](runtime.md#lifecycle),
and explicit Windows observation follows its [separate read-only contract](runtime.md#explicit-codex-cli-installation-observation).

Explicit Codex CLI installation observation does not discover a Codex home or read/write its state. See the [read-only observation contract](runtime.md#explicit-codex-cli-installation-observation).

The read-only CLI update plan binds npm executable selection to the inspected launcher PATH.
`bin/ocx.mjs` captures proxy variables (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY,
in any case) and NODE_EXTRA_CA_CERTS before Bun loads project dotenv. The proof-bound
snapshot preserves each key's spelling and value, including aliases and empty strings;
`src/cli/launcher-context.ts` validates and freezes that allowlisted transport map.
`src/cli/codex-cli-update.ts` forwards it with the inspected PATH/PATHEXT to the plan's
npm resolver. The resolver replaces all ambient aliases with the captured entries:
project dotenv cannot supply missing settings or change the captured precedence.
An older snapshot without a transport map conveys no transport settings, with no
ambient fallback. Snapshot values are internal inputs, never report or diagnostic fields.
Registry integrity requires a canonical base64 SHA-512 digest of exactly 64 bytes; malformed or truncated tokens refuse the target.
Plan identity also binds a bounded content observation (installContentDigest): a versioned file set
fixed by the supported npm-global layout — the package manifest, its declared bin/codex.js
entrypoint, and the platform backing manifest plus vendored binary at the layout's modeled
locations. The vendored binary is streamed in chunks under a finite 1 GiB bound sized for the
published backings (about 297 MB for linux-x64 at 0.163.0). The actually selected launcher stays bound through the existing canonical-path and
manifest-linkage provenance; the observation covers those files' bytes only and claims nothing about
which file a launcher run would execute, artifact authenticity, or the rest of the install tree. The
modeled locations follow Node's module lookup evaluated against the bound inspection environment
— the captured PATH/NODE_PATH/HOME and the node binary that PATH resolves — never the
inspecting process's own runtime globals. The backing is selected by the Node launcher's
`process.arch`, carried in the same snapshot, because a Bun override or PATH fallback may run a
different architecture under Rosetta; a snapshot without it falls back to the inspecting process's
arch, and an unknown value invalidates the context. The optional HOME/NODE_PATH seeds are withheld on
Windows, where the modeled lookup never runs, and dropped when they would push the serialized
launch context past its cap, so the selection snapshot survives: a local optional-package lane can
still bind, while the global and vendor-fallback lanes stay unmodelable and fail closed. Missing
required files, an out-of-prefix resolution, an unreadable or mid-observation-changed file, a
retargeted selection link, or an unmodelable global lookup all fail closed. The selector and lexical
links are checked after the final file-identity pass while native descriptors remain open; this
observes linkage at that boundary and does not prevent later symlink mutation. A managed install with
no bound content is refused install_content_unverified before any registry query. The digest is
observation only — it carries no execution guarantee — so the apply phase re-observes
rather than rely on it. The observation is opt-in: the plan path requests it because the planId
binds it, while a bare check leaves the digest null rather than paying the bounded read.
Selection observation uses the runtime resolver with provenance's bounded no-follow, nonblocking state reader and local executable-path policy. Windows supports the restricted handle-bound plan predicate below; other Windows layouts remain deferred.
Its child environment drops npm configuration overrides, named Node startup/output controls,
the `LD_*`/`DYLD_*` loader families and the OpenSSL startup configuration and
provider/engine search variables; proxy settings and `NODE_EXTRA_CA_CERTS` remain supported.
Ambient NODE_COMPILE_CACHE is replaced with an owned path inside the isolation directory because
npm's own enableCompileCache() otherwise recreates a default cache outside that directory.
Distinct npm config files, npm/Node caches and logs stay under the owned temporary root with best-effort
cleanup; a cleanup error does not replace the computed plan/refusal. Registry metadata
and the request-path process-table scan wait off the server event loop: the bounded npm
children and the darwin/Windows enumerations resolve asynchronously while keeping the
per-query deadline, bounded output, termination and status-null refusal lanes of the
synchronous contract, so a stalled registry cannot park unrelated proxy requests or
streaming; the apply re-scan uses the same async scan. Linux /proc observation remains
synchronous underneath as bounded filesystem reads rather than a child-process wait.
The POSIX update scan includes all readable users by default, retaining an explicitly injected UID scope.
Linux per-process `status`/`cmdline` read failures invalidate a complete observation except for `ENOENT`
(a process that disappeared); incomplete observation refuses with `blocked_process_state_unknown`;
the restart/kill path skips unreadable entries while retaining independently verified same-user app-server targets. This plan neither installs a runtime nor signals
an existing Codex session. Windows enumeration/installation limits remain unchanged.

## Windows read-only plan predicate

`src/codex/cli-windows-plan-provenance.ts` admits only a proof-captured, drive-absolute
`CODEX_CLI_PATH` naming the exact standard npm `codex.cmd` grammar. The global npm
package prefix comes from the shim directory and its `node_modules` tree. A prefix-local
`node.exe` and npm bind as the shim's own interpreter toolchain. When the local probe
proves `not-found`, the captured PATH's Node/npm pair binds instead as the updater's
metadata toolchain; a refused or reparse probe never counts as absent, and a separate
toolchain without the launcher arch anchor stays refused because its arch could not be
tied to the selection at all. The bound Node is never claimed to be the interpreter a
later `codex.cmd` invocation resolves: the shim's bare `node` falls through to the
ambient invocation working directory — CMD prefers the current directory over PATH —
and no launcher snapshot can carry that per-invocation property. The production runtime resolver confirms the explicit Codex override's
priority without saved-state reads or probes. A PE header binds Node's architecture;
the package manifest/bin, npm manifest/bin, Node and the first in-prefix platform
package plus native backing are observed together. Backing lookup follows the
nearest-first Node lanes and is repeated while the files and ancestors remain held.
Native handles refuse reparse points, writers and rename/delete sharing; initial
manifest and Node identities must match the final observation. Plan paths and configured manager roots must match their held handles' normalized long DOS names; unresolvable or aliased roots refuse management.
Manager roots remain held through inspection and metadata queries. Text stays bounded to 256 KiB and Node to 128 MiB. The native backing uses the same finite 1 GiB
`MAX_NATIVE_BACKING_BYTES` as POSIX, defined in `src/codex/cli-installation-limits.ts`.
The native reader bounds aggregate requests to that backing plus 128 MiB Node
and twelve 1 MiB text requests; hash-only bytes are never buffered whole.
Only the opt-in content observation streams the entrypoint, npm CLI, Node and native bytes. The
plan path sets it, so the plan-bound `installContentDigest` is preserved; a bare check holds the
same files open and identity-checked, reading only bounded manifests, shim bytes and the Node PE header;
entrypoint, npm CLI, native and full Node digest streams stay unread, with a null `installContentDigest`.

PATH-only candidate selection, autostart wrappers, global/vendor fallback,
app/Store/MSIX bundles and version-manager ownership remain unverified and unmanaged.
The explicit `attest` report stays observation-only. Only the production plan predicate
creates private plan evidence; copying a public report cannot enable Windows planning.
Refusals retain fixed gate codes and available native/derivation reason codes in a report-keyed
WeakMap, exposed only by `windowsCodexCliPlanRefusalForTests` for regression failure messages.
These diagnostics contain no paths or exception text, do not serialize with the report, and
do not change managed status, content digests, private plan evidence or fail-closed decisions.
This observes linkage and content, not publisher authenticity or a whole-tree guarantee.
The fresh-source Worker case in `tests/codex-integration/codex-cli-windows-plan.test.ts`
rebuilds private evidence through the native inspector inside that realm before resolving
owned fixture metadata. It does not establish compiled-worker or Windows ARM64 support.
Metadata queries use the observed Node/npm paths under freshly matching held handles,
the existing isolated npm configuration/cache, and the pinned registry. No installer runs.
Before metadata executes, `openWindowsCliToolchainAuthority` in `src/codex/cli-update-job-store-windows.ts`
opens the complete npm package tree with reparse-refusing relative handles and verifies every owner
and ACL under the prefix's write-private policy. Node and module lookup directories are held too.
ACL reads use handle-normalized long paths, including for 8.3 input spellings. A bounded whole-tree
content/identity digest enters the plan ID; post-approval module drift changes that ID. Apply retains
the execution authority through pack, install and version verification, including unknown lifetimes.
The bounds are 8,192 entries, 128 MiB per file and 512 MiB total; unsupported authority refuses execution.
`src/codex/windows-npm-execution.ts` installs an argv-bound synchronous Node resolution hook before
npm's entrypoint. Both CommonJS and ESM may load only builtins and files within the held npm tree;
ancestor/global fallback, including a later-created volume-root node_modules, refuses before module
execution. Node versions without synchronous hooks fail closed. Executable-local DLLs are pinned too.
A completed Windows plan has a deterministic ID. Only the bounded x64 prefix predicate below
may set `applicable: true`; other observed layouts retain `windows_apply_disabled`.
Active/unknown sessions still refuse earlier. Apply never overrides a refused plan.

## Independent Windows child lifetime primitive

`src/codex/windows-cli-child.ts` supplies an opt-in Windows x64 child owner, with native ABI/handle
ownership in `src/codex/windows-cli-child-native.ts` and overlapped output in
`src/codex/windows-cli-child-pipe.ts`. Windows apply consumes it for pack, installer and version
children. ARM64 is unsupported.

It starts only an explicit drive-absolute `.exe` plus argv: `CreateProcessW(CREATE_SUSPENDED)`,
assignment to a non-inheritable Job, then `ResumeThread`. Installer/verifier Jobs have a random
global name and protected current-user DACL for durable read-only recovery; other Jobs stay unnamed.
An existing named object refuses creation. Normal execution uses original handles; no PID reopen,
shell, breakaway fallback, process-count limit or kill-on-close limit. Assignment/resume failures
reap the original suspended primary before user code; failed termination retains an unknown owner.
`STARTUPINFOEXW` and an explicitly rooted attribute buffer whitelist exactly the three owned,
inheritable stdio handles with `bInheritHandles=TRUE`. Parent read/event/Job/process/thread handles
are not inheritable, and parent copies of the stdio ends close before any await. This is forward
isolation from unrelated inheritable handles, not reverse protection from a foreign unrestricted
`CreateProcess(TRUE)` while those stdio handles are temporarily inheritable.

The output pipe uses an unpredictable name, a protected current-token-user DACL, remote-client
rejection, and a real overlapped read buffer/event. Cancellation retains that memory until native
completion settles; neither `PeekNamedPipe` nor a Worker script URL is used. Captured bytes are
decoded together as UTF-8. Installer output is discarded; pack captures 1 MiB and continues draining
excess without termination. Neither policy adds an overall deadline or running-abort kill. Version
alone has the existing 16 KiB, 8 second deadline and 1 second reap policy and may terminate its Job.
A termination acknowledgment, timeout, I/O error, failed wait/query or PID absence is not terminal.
The original primary handle must signal and a successful Job accounting query must report zero
active processes; exit code 259 is valid once that handle signals. Output still drains after Job
emptiness. Normal `CreateProcess` descendants are covered; WMI-created processes are not claimed.
`cleanupComplete` separately establishes disposal: terminal plus EOF can still leave failed-close
handles owned. Such owners and lease/staging remain retained with `child_cleanup_failed`; the job
projects the child as terminal and the lease as retained, without claiming successful cleanup.
Unknown results retain the owner and all lease/staging obligations. Setup failures with no process
use `cleanupUnstartedWindowsChild` to settle any connect operation and release only owned handles.

The Windows transaction adopts lifetime and lease/staging retention before every child start,
including pack. Its strong owner registry keeps unknown children and their toolchain pins alive.
The npm `--fetch-timeout=120000` remains a separate fetch policy, not a process lifetime deadline.
`tests/codex-integration/codex-cli-windows-child.test.ts` exercises actual owned native fixtures,
including overlapping whitelist isolation, stdout-free descendants, incompatible nested Jobs,
pre-user-code failures, byte caps, cancellation settlement, wait/query failures and version reaping.

## Independent Windows archive layout

The independent `src/codex/cli-update-windows-layout.ts` verifies Windows x64 archives and
returns only prefix-relative expected files, sizes and content digests; `applicable` and
`mutationAuthority` remain false. The Windows transaction consumes this content contract only
after obtaining separate selection and installation authority.
The main root is `node_modules/@openai/codex`; the explicit sibling backing is
`node_modules/@openai/codex-win32-x64`, with `vendor/x86_64-pc-windows-msvc/bin/codex.exe`.
Exact direct-version and npm-alias references retain the archive verifier's metadata/linkage rules.
An opt-in Windows archive mode uses `src/codex/cli-update-windows-paths.ts` to reject ASCII case
and file/directory collisions, ADS, device names, trailing dots/spaces and unknown non-ASCII paths,
including directory records. Embedded node_modules files cannot shadow the modeled backing.
The full native member still streams into its digest; at most 4 KiB from that same stream is retained
for the AMD64 PE32+ header check. This does not prove a complete valid image, signature or execution.
Native members remain unbuffered and Windows does not use POSIX executable-bit admission.
The exact codex/codex.cmd/codex.ps1 size/hash expectations model npm cmd-shim 8.0.0's node-shebang
output; tests/fixtures/codex-windows-npm-shims.json records the official npm tarball URL/integrity,
raw archive source-file hashes and actual exported-function generation with intercepted filesystem
calls. All three generated strings matched the retained bytes. No npm installation or lifecycle
script ran; the offline fixture test checks byte consistency, not registry provenance afresh.
Other shim grammars remain unsupported. All archive auxiliary files enter the expected set and digest, and
readback comparison requires the complete set. The consumer separately proves live held
file identities, package lookup, selected Node/shim and write authority; a matching DTO grants none.
Coverage: `tests/codex-integration/codex-cli-update-windows-layout.test.ts` uses only synthetic
archives and captured shim bytes, with no npm installation or native executable invocation.

## Explicit Windows x64 apply

`src/codex/cli-update-windows-apply.ts` implements the Windows transaction behind the existing
confirmed CLI/HTTP admission and planId contract. `src/codex/cli-update-windows-observation.ts`
admits bounded shared global prefixes. The two Codex package trees and three shims are targets;
all other prefix entries, including `node_modules/.package-lock.json`, are preservation obligations.
Observation is capped at 4,096 entries, 512 MiB total and 384 MiB per file, including unrelated
packages. Oversized namespaces, unsupported ACL ancestry and ARM64 refuse without repair.
Actual ACL evidence decides profile-path support; an unsafe AppData ancestor on one host does
not establish that every profile is unsafe. No existing ancestor is rehardened.
The job-store native primitives provide a separate `.ocx-codex-cli-apply.lock` lease. Prefix,
parent and package-scope directory pins deny rename/delete; ACLs are verified before creation
and before/after execution. Only newly created lock/staging objects are hardened. The current
account and kernel-equivalent administrators remain inside the trust boundary; other-SID and
filtered-token behavior is not claimed as empirically tested. Reparse paths fail closed.

The observed Node/npm pair stays pinned across awaited work. Private staging owns npm configs,
caches, Windows temp/profile variables and version state. Exact tarballs are verified before
the final fresh plan, selected command, preimage, authority and session checks. Pack and install
have no overall process deadline or cancellation kill. Unknown child state retains child handles,
toolchain pins, lease and staging; it is never converted to terminal by PID absence.

Readback enumerates both package trees (including auxiliary files), three shims, empty directories,
the hidden lock, absence of the new backing, and unrelated prefix entries. Unrelated bytes, file
identities and directory identities must stay equal; added entries make the result ambiguous.
Only the separately held transaction lock/staging is excluded. It rejects unexpected target entries,
links, unsupported Windows names, unreadable/oversized observations and untrusted ACLs. The native
reader's optional installation-domain SHA-256 uses the same held stream, retaining raw SHA-256 as
the default. `not_applied` requires identical scoped preimage and selection, not merely an old
version; it is not a claim that npm performed no I/O. A complete target is classified by readback,
not npm's exit code. Version uses the pinned Node with the verified JS entrypoint in private cwd,
then repeats selection/content observation; it does not attest arbitrary future CMD lookup.
Cleanup errors remain separate from the result. The existing job execution layer retries result
persistence without repeating installation. No automatic rollback or stale-lock recovery exists.
`tests/codex-integration/codex-cli-update-windows-apply.test.ts` covers authority and toolchain pins.
Its siblings `tests/codex-integration/codex-cli-update-windows-apply-install.test.ts`,
`tests/codex-integration/codex-cli-update-windows-apply-outcomes.test.ts` and
`tests/codex-integration/codex-cli-update-windows-apply-shared.test.ts` cover real offline npm,
partial mutations, retention, persistence retry, unrelated package/shim preservation and terminal
close failure. `tests/helpers/codex-cli-windows-apply-fixture.ts` keeps cleanup ownership per file.
One JS launcher executes a compiled CLR x64 backing fixture that verifies Job membership and
returns the version. This is executable-fixture evidence, not a run of the vendor Codex product.

## Explicit POSIX apply

`src/cli/codex-cli-update.ts` accepts `apply --plan-id <32 lowercase hex> --yes` with optional JSON output.
`src/codex/cli-update-apply.ts` applies only a selected, managed, non-shim POSIX npm-global installation.
The inspector provides process-local canonical prefix/launcher/package evidence through an internal WeakMap;
public report locations are display-only and are never reconstructed into write targets.
`src/codex/cli-update-lease.ts` acquires one installation-prefix mutex without reentrancy, delegation,
waiting, or automatic stale/empty/suspicious-owner recovery. Only a matching owned directory and owner
file can be released. This apply lease is separate from service ownership leases.

Under that lease, a fresh applicable plan must match the approved ID. Main and platform metadata include
exact versions, canonical SHA-512 integrity and official registry tarball URLs; all artifact fields,
platform and inspection architecture contribute to plan identity. Platform aliases whose published
manifest name is also `@openai/codex` are modeled explicitly. The existing isolated npm environment,
cwd, cache and distinct npmrc boundary is reused for metadata, exact-version pack and install calls.
The version verification child inherits the owned Node compile-cache path, which is removed with
terminal apply staging; an uncertain live child retains that staging and its lease. A verifier setup
failure before any child exists is terminal evidence instead, so the lease is released and later applies are not blocked.
`src/codex/cli-update-paths.ts` supplies the shared POSIX ancestry policy for the lease,
mutation paths and job store. Canonical ancestors must be root/current-user owned and lack group/other
write permission; root-owned sticky ancestors are allowed. Every existing directory under the npm
prefix must additionally lack shared write permission, including executable, scope and package parents.
Their identities and permissions are revalidated before spawn. Directory links and unbounded trees refuse.
Staging is a private 0700 same-owner child of a canonical trusted temporary root; unsafe TMPDIR refuses
with `staging_path_untrusted`. Canonical temporary aliases (including macOS /var) remain supported.
Staging identity/ancestry is rechecked before install; npm temp and compile-cache writes stay inside it.
The policy excludes other-user namespace replacement, not concurrent changes by the same user or root.
`src/codex/cli-update-artifacts.ts` streams compressed integrity and tar validation with independent
256 MiB compressed, 512 MiB total unpacked, 384 MiB member and 4,096 member bounds. Only small
manifest/entrypoint bytes are retained; native and auxiliary members retain size/mode/hash metadata.
Links, traversal, unsupported tar records, dependency-bearing manifests and missing backing files refuse.
After ReadStream construction it exclusively owns the archive descriptor. The held-fd identity check
precedes explicit stream destruction, and verification waits for the close event on success and failure;
pipeline settlement alone is not close completion and the caller never closes that raw fd again.

After artifact preparation, selection/content, the approved metadata and active/unknown process blockers
are re-observed. Inside the worker realm the awaited process scan is the last yield before install; in
the same worker event-loop turn as the spawn a synchronous guard re-checks the cancellation state,
prefix identity, the byte-level preimage and the launcher's live canonical selection, and the per-job
commit fence's PREPARING-to-COMMITTED compare-exchange is the final guard before the installer spawn —
a parent cancel that already landed wins, while a cancel landing after COMMITTED defers to the live
child's close and readback. npm receives only two verified local tarball specs and an explicit canonical prefix,
with offline mode, optional dependencies omitted, lifecycle scripts disabled and no audit/fund/lockfile
side effects. Main manifests are not rewritten to make installation succeed. Cancelled preparation
refuses; cancellation during an admitted npm child waits for its close rather than killing it. The lease
and staging remain held while the installer is live or uncertain. There is no automatic retry or rollback.
`src/codex/cli-update-files.ts` compares the complete bounded regular-file sets after installation,
including auxiliary members and executable status; original-state readback also compares original modes.
The preimage covers selected roots and every planned main/backing mutation root, recording both full
existing file sets and absent roots. A newly created sibling backing cannot be called unchanged merely
because the previously selected nested backing and main package still match.
Required launcher/native paths must also pass the current user's X_OK check; another user's executable bit alone is insufficient.
After file/selection readback, the selected launcher runs with `--version` in an owned home/temp sandbox,
with 16 KiB output and an eight-second deadline. Normal exit and the exact target version are required.
Only this verification's new POSIX process group may be terminated on a deadline; an unconfirmed close/group
exit retains lease/staging and reports its PID with an ambiguous result. Its observer survives the bounded
reap result: late close plus group absence, or a group probe returning ESRCH, releases that owner's
admission and cleans up its lease/staging without rewriting the ambiguous receipt. Existing sessions are never signalled.
Verified target readback and execution are `applied` even after nonzero installer exit; unchanged full original evidence
is `not_applied` even after exit zero. Partial, unreadable or uncertain results are `ambiguous`.
Cleanup failures are path-free `cleanupErrors` alongside the computed outcome. A failed or thrown
lease release marks retention unverified without preventing staging cleanup; cleanup does not replace
the readback outcome. Uncertain live installer/version children still retain both lease and staging.
The POSIX path refuses Windows; Windows uses the separate transaction above. Non-npm managers remain unsupported.

## Worker realm and the selection commit window

The plan and apply bodies execute inside a dedicated Worker realm so their synchronous file hashing and
directory walks never occupy the parent's HTTP/event loop. `src/codex/cli-update-worker.ts` is the
per-job worker entrypoint, registered as `cli-update-worker` in the standalone build's
`WORKER_ENTRIES` (`scripts/build-standalone.ts`); `src/codex/cli-update-job-worker.ts` is the
parent-side dispatch the CLI and the management route call. The run message carries the allowlisted
frozen launcher snapshot — never the parent's trustedContext and never supplemented from ambient
environment — plus two shared-memory cells from `src/codex/cli-update-selection-gate.ts` and at most
the two home overrides as transport. `src/codex/cli-update-inspection-context.ts` exposes the shared
factory that rebuilds production inspection deps from that snapshot inside whichever realm calls it, so
the worker derives its own fresh selected-command evidence; the installer inspector's mutation-evidence
WeakMap is per-realm, which is exactly why the whole job — not just its hashing — must run there.

A job is one fresh Worker, one unique requestId and the parent ledger generation; no wire generation
exists. The worker runs one message, replies and drains; a second run is ignored, so a stale
or duplicate delivery cannot attach new work to a dying realm. Settlement requires BOTH a valid reply
and the worker's own close — a done payload alone is never terminal evidence because a legitimate
result may still report installer_state_unknown or version_process_state_unknown with a retained lease
and a live verification child. The host never calls terminate(): an unresponsive worker may still own a
running npm child, so every post-delivery loss — worker death, message error, an implausible or missing
reply, or done without close inside the bounded grace — settles `ambiguous`/`job_result_unknown` with
the lease reported retained and the still-live worker tracked rather than silently leaked. A spawn
throw before the run message exists is the only `refused`/`preparation_failed` path, because no job
code provably ran. Ledger completion writes keep their existing bounded retry.

Entry installation is limited to `Bun.isMainThread === false`; importing either entry or its
test fixture in the main realm must not replace that realm's message handler. Bun 1.4.4 does not
provide `self.close()`: terminal completion removes the worker's message handler and lets referenced work
drain naturally, without `process.exit()` or parent termination. A real Bun-subprocess regression
keeps the worker alive after handler removal until that exact child exits. This establishes the
referenced Bun-child path only, not arbitrary native handles or all OS descendants. Bun's close
event marks worker termination and can precede full thread exit; it is not independent proof that
every installer descendant or retained native owner has finished.

Windows native ownership acquires an internal execution-retention token before authority acquisition.
The token roots the acquisition anchor, then the registered Owner, across registration exceptions.
The authority publishes its context to that anchor before opening pins or awaiting ACL checks.
If acquisition rejects, its finally attempts cleanup before the caller checks the published pin set;
only an empty set releases the token. Failed pins keep the context/realm rooted and report ambiguous
ownership even though no successful Authority object was returned. Native-load failure before a
context exists holds no such pins. This internal callback never crosses a job/HTTP DTO boundary.
Raw FFI handles alone are not considered Worker keepalive: unresolved process/Job/pipe or cleanup
keeps the run-once handler installed. Only successful terminal cleanup removes the Owner and releases
its token. No polling, automatic retry/reap or termination follows from retention; a retained realm
can remain resident until separately authorized recovery. A crash still loses in-memory ownership
and leaves durable state unknown. The pure lifetime test is not native disposal evidence.
Authority disposal is proved only after identity/token-fenced lock removal, absent staging and
an empty pin set. Its `resourcesReleased` evidence is separate from release's ACL diagnostic.
Disposal follows the original held objects' deletion, even if the pathname is unreadable or replaced.
Apply preserves that diagnostic in cleanup errors, but releases the execution token once staging,
toolchain and authority disposal are all proved, including during terminal recovery.
A failed CloseHandle stays in the apply-only `WindowsApplyAuthorityPins` set; its closeAll skips
failed closes instead of retrying or forgetting them, preserving Owner/token with `lease_release_unverified`.
The ordinary ledger/status PinSet keeps its pre-existing best-effort disposal contract; this change
does not claim to repair or prove all native cleanup in those shared job-store callers.
The direct authority regression registers fixture ownership before setup/acquisition, observes
the acquisition's initially empty pins, and requires release success, absent lock and empty pins
before reacquiring. An uncertain release retains its fixture and background producer for teardown;
it does not retry CloseHandle or convert namespace absence into pin-clean evidence.
Fixture teardown needs both a correlated non-retained, cleanup-confirmed result and Worker join;
the entire message stream must be well-formed and correlated with exactly one result. Worker close
alone, any foreign/error/malformed traffic, missing reply or retained owner never permits root removal.

Cancellation crosses realms through shared memory, not a message: the parent CASes the job fence
PREPARING-to-CANCELLED, the worker's `isCancelled` checkpoints read that word during its synchronous
sections, and the worker's own PREPARING-to-COMMITTED CAS immediately before the installer spawn is the
irrevocable start decision, not proof of successful CreateProcess/ResumeThread. COMMITTED is not
"cancelled" — later cancellation defers to actual child/readback evidence. A plain signal cannot interrupt a
synchronous worker section, signal-based cancellation alone is not equivalent and is not used as the
worker path's only channel.

The worker's final window is also serialized against the parent's own selection mutations through one
process-wide gate cell. The gate covers exactly seven parent operations: `persistCodexRuntime` and
`clearPersistedCodexRuntime` in `src/codex/runtime.ts` (busy refusal — the
`codex_cli_selection_busy` error — before mkdir, cache invalidation or the swallowing unlink catch),
the three public shim boundaries (`src/codex/shim-overlay.ts` on POSIX, `src/codex/shim.ts` on Windows; install, auto-restore, uninstall —
busy in their existing failure/deferred/removed:false shapes before namespace creation, the restore
lock and journal mutation), the remote-workspace app-server `Bun.spawn` in
`src/remote-control/workspace-codex-runtime.ts` (busy refuses after running the same bridge/isolation
cleanup a spawn throw runs, so a rejected bridge stop cannot skip isolation removal), and
`src/codex/desktop-app-restart.ts` (busy returns the new `selection_mutation_busy` skipped reason
before the restart lock, package discovery, any app quit and the handoff, so a queued relaunch — and
its own lock-acquisition failure — cannot slip inside the window). Writers never wait: the commit
window spans the final process scan through terminal installer evidence and readback. Windows directory
observations retain bigint device/inode identities, including the second namespace check after
asynchronous ACL/file observations. Windows also
renews full authority ACL/identity, inspector and full scoped preimage after acquisition, then performs
the final process scan, synchronous held-identity/selection/cancellation checks, CAS and synchronous
native Create/Assign/Resume with no intervening await. Windows retains the gate through native Job
settlement, post-install readback and version verification. Unknown child lifetime keeps exclusion.
The process-wide gate carries an owner generation; stale release cannot free a later owner.
Observed Worker close seals PREPARING to CANCELLED before recovering that generation.
Committed Worker death, PID absence and timeout alone cannot establish installer termination.
Explicit `recoverWindowsCodexCliInstallations` uses retained original process/Job handles, then
readback before releasing exclusion; terminal proof survives a transient readback failure for retry.
Failed toolchain pin disposal remains strongly retained and surfaces cleanup uncertainty.
Handle-relative opens root every backing buffer reachable through OBJECT_ATTRIBUTES until
NtCreateFile returns, including its nested Unicode string and text, across allocation/GC pressure.
Windows ACL/content observations can take substantial
time; neither a short held window nor a hard I/O deadline is claimed. Acquisition's 30s deadline does
not bound time held. A synchronous
parent writer must not park the event loop behind it, so a held gate is an immediate busy. The gate is
one cell for the whole process rather than per-configDir because alias, junction and case spellings of
the same target must not split the exclusion; a writer on a different configDir can also see busy.
The gate's holder word carries a unique generation; release compares that exact owner, so an obsolete
observer cannot clear a later window. An installer/verifier with unconfirmed terminal state retains the
gate as well as lease/staging. `src/codex/cli-update-worker-recovery.ts` observes worker close: a fence
that never committed is atomically cancelled before releasing that worker's owner, preventing a late
commit after Bun's close notification. A committed fence is sealed against a subsequent verifier spawn. After commit,
worker close alone does not release admission: the published detached POSIX process group must be absent,
or the worker must have published terminal cleanup. Missing child publication stays uncertain. Recovery
continues probing a known group after dispatch settlement. Preparation refusal and terminal readback release it.
Cancellation precedes the holder check, including a close before gate acquisition. Verifier arming
failure before invocation preserves no-child proof; terminal durable writes retry while admission
stays closed. Publication uses a bounded pair of owner-specific temporary names, so transient storage
failures cannot consume admission capacity with one new partial file per retry.

`src/codex/cli-update-recovery.ts` persists a private, token-scoped recovery record under the config root
before commit/spawn, publishes each child group after spawn, and records terminal cleanup before gate
release. On Windows the same protocol uses the native job-store backend's pinned canonical ancestry,
private DACLs, bounded regular-file reads, file flush and handle-bound publication. Uncertainty is
durable before commit; each installer/verifier Job name is armed before native creation. Its primary
PID and native creation FILETIME are published after start. `src/codex/windows-cli-recovery.ts`
opens only that random global Job for query and verifies the original process lifetime is terminal.
`src/codex/windows-cli-recovery-guardian.ts` starts a separate observer after Job assignment and
before primary resume. It inherits only a query-only Job handle and a pre-opened private proof file;
it cannot terminate the installer. Only zero Job members permits its flushed terminal proof. This
proof is also required after restart: name disappearance alone cannot prove descendant termination.
Observer failure leaves armed evidence fenced. Normal settlement also joins the observer before
staging cleanup. Its HOME/profile/AppData, compiler temp and PowerShell analysis-cache paths all
resolve inside that private staging root. Access/query failure, missing identity and
unproven armed or partial publication remain fenced. Parent admission additionally requires owner-process
absence; same-process closed-worker recovery first seals its exact generation against another spawn.
No recovery probe signals an installer. Terminal markers release only the proven token; alias homes
read the same canonical store. The native-child restart regressions live in
`tests/codex-integration/codex-cli-update-windows-recovery.test.ts`.
Starting the verifier first resets the child publication and durable record to armed, so an old
installer group's exit cannot clear a new verifier. Parent admission checks these records after restart:
terminal records permit admission; child records require both parent-process absence and whole-group
absence. Parent recovery creates a missing store under the same trusted ancestry/private-permission
policy and durably publishes its exact token's terminal marker before releasing admission, including
the config parent's new directory entry. A late arm for a token with a verified marker is a no-op;
markers also shadow an already interrupted publication and resolve that owner's partial precommit record.
After restart, a complete terminal pending write from either publication path is recognized without
renaming or changing the job receipt. It must pass the same private/no-follow file checks, name the exact
token, carry a null child group, and match the published record's parent identity when present. Fresh
parent absence and any published child's whole-group absence are required. Every unshadowed pending
file must independently satisfy these checks; malformed, armed, foreign or unsafe evidence stays fenced.
On Windows, a complete pending child may instead replace its published armed authority through the
same protected flush, ACL verification and atomic rename path, retaining the pending file until rename.
Both records must match token, parent
PID and Job name; the armed PID/creation time must be null and the child identity complete. Publication
requires parent absence, a matching terminal guardian proof, exact child lifetime absence/reuse and a
fresh absent/zero-active Job check. Any read, validation or publication failure keeps admission fenced.
Guardian death before terminal proof remains fenced, even when the primary and named Job are absent.
Admission re-probes non-terminal lifetime evidence on every attempt, so later group exit is observed
without retaining a pre-restart observer or caching a stale refusal.
Absent recovery history admits ordinary callers, including a symlinked config home or ancestor.
Existing evidence is read through the canonical home target with its trusted ancestry; a linked recovery
store, unsafe target, or evidence that becomes unreadable stays fenced. Updater mutation eligibility
retains its stricter canonical/no-alias policy. EPERM, unrelated malformed/partial records,
and an armed record without a safely reconcilable child stay closed for
operator inspection. PID reuse can delay recovery but cannot prove absence. The protected durable job
ledger keeps its existing ambiguous result; fence recovery neither retries installation nor converts it
to success. Abandoned installation-prefix leases and staging after process death are not reclaimed by
this admission recovery. Old jobs lacking recovery records retain their existing unknown-state projection.
Ordinary config writes, account operations, model requests, existing session interrupt/close and
arbitrary subprocesses are not gated. The gate claims nothing about processes the parent does not own:
an external installer, a handoff helper's delayed descendants, or an OS-level snapshot race stays the
documented residual it always was.

`bin/ocx.mjs` includes the proof-bound Codex candidate snapshot for the published `start` command as well as the updater commands; this makes the production management plan work without accepting request-supplied candidate evidence. `src/codex/cli-update-inspection-context.ts` is the shared bridge from that Node snapshot to the installer inspector. Direct Bun/source launches have no trusted candidate and fail closed; neither path reconstructs write targets from display data. `src/codex/cli-update-job.ts` owns the bounded durable admission ledger shared by CLI and management. Request IDs are scoped to the protected config root and payload digest; exact retries return the same opaque job, conflicts refuse, and a full ledger refuses new admission. Every store operation requires a canonical same-owner config parent with safe write permissions and canonical ancestry to filesystem root; each ancestor must be owned by root or the current user, and shared-writable ancestors are refused unless root-owned and sticky. Only confirmed apply admission may create one absent config-root level, which is revalidated as owner-private. Plan and status reads never create it, and an existing root must pass the same canonical/no-link checks. This path-based ancestry check prevents untrusted other-user writable ancestors from redirecting store operations; it does not defend against concurrent tampering by the same user or root. Atomic updates use a private same-owner POSIX directory, no-follow reads and a short exclusive lock. Unresolved records are not expired. An in-process generation and revision own completion writes; after restart a queued/running record projects as `ambiguous` with `owner_state_unknown`, without claiming the old owner stopped. A `retained` lease state requires an execution reason that proves acquisition and intentional preservation; synthetic job errors, unverified release and release exceptions project as `unknown`. The path-free DTO separates owner state, installer child state, lease retention and overall lifetime uncertainty with fixed outcome/reason/cleanup codes.

`src/cli/codex-cli-update.ts` records confirmed CLI apply in that ledger and exposes `status <job-id>` from the same protected record, without requiring a GUI token. `src/server/management/codex-cli-update-routes.ts` exposes a proof-bound read-only plan, confirmed human dashboard session (`hasHumanDashboardSession`) plus trusted-loopback apply admission, and authenticated status. Plan and job reads use ordinary management admission. HTTP apply returns after durable admission; disconnect does not cancel the worker. Dashboard display data is never accepted back as a candidate, prefix, executable or managed-selection attestation. There is no dashboard job UI in this contract. `tests/server/persistent-dashboard-consent.test.ts` covers management admission and the apply service boundary.

On Windows, `src/codex/cli-update-job-store-windows.ts` maps the same ledger contract onto NTFS handle semantics and the public admit/read/finish API in `src/codex/cli-update-job.ts` dispatches to it asynchronously. Each ancestor from the volume root is opened relative to its already-held parent — never a re-parsed path — and refused on any reparse attribute, then evaluated under the "trusted-ancestry" ACL policy (owner is the serving token or SYSTEM/Administrators/TrustedInstaller; untrusted grantees may hold read and, on admin-owned ancestors only, broad create-only rights). The config-root parent and a pre-existing config root are verified under the "write-private" policy and are never rehardened; only a directory the call itself creates is icacls-hardened and held to the strict "private" rule. File identity is the volume serial plus 128-bit file ID with single link and no pending delete, the dev:ino analog. Ledger writes go through a private hardened temp that is byte/ACL/identity-verified, renamed while its handle is held, re-read through the published name, and flushed at the directory. The admission mutex is a mkdir lock plus an owner record released only while both held pins still show this call identity and content, so a leftover lock blocks later admission exactly like POSIX. ACL snapshots are taken per phase through the shared bounded PowerShell read in `src/lib/windows-owner-acl.ts` (async variant), not per path. Pins bind each object to its verified state for the operation and the private DACL confines writers, but this is not a proof against concurrent mutation by the serving account or an elevated process, which sit inside the trust boundary as on POSIX. The backend is x64-only; cross-account (other-SID) and ARM64 behavior are unverified.

Apply-authority disposal requires successful identity/token-fenced delete-on-close of both original
lock objects, zero remaining pins and no staging. A replacement at the pathname neither proves nor
prevents this owner's disposal; failed deletion or close retains its Worker execution token.
Apply-authority release checks held identity before and after its ACL read. An ACL-only failure
still attempts deletion through the original token-fenced pins and reports a failed release verdict.
That verdict alone does not retain the Worker: proved resource disposal permits closure and a later apply.
Identity failure preserves the lock while closing pins. Repeated release cannot affect a later owner.

Each successful handle-relative `relOpen` registers its handle exactly once before returning it;
callers use that already-owned handle without wrapping it in another `keep` registration.
This applies to config/store pins, read/write/published leaves and lock/owner pins, so disposal
does not revisit a stale duplicate registration after the original handle has closed.

An execution invocation reserves its admitted generation before asynchronous admission or
running-record publication; only that invocation releases the reservation after a failed begin.
Competing deliveries cannot clear the live owner's completion authority. An unpublished verified
ledger temp is deleted through its held handle before close. Successful rename disables that
cleanup permanently for the invocation, including failures during published-name readback or flush.
The store checks the held ancestors and config root against the normalized DOS long name with
the same comparison used by `src/codex/windows-installation-files.ts`; 8.3 aliases refuse before
ledger access, and a missing config root is created only beneath an already canonical held parent.
ACL hardening and descriptor reads use extended-length command targets, including recovery
publication, ledger temps, admission locks and apply leases. Native pinning and alias comparisons
retain canonical long DOS paths; command spelling does not admit an aliased mutation root.

An ACL-query timeout fails closed without accepting a late result. Its PowerShell child may still
hold transient handles while termination settles, so lock cleanup may fail and retain a busy mutex;
the store does not automatically reclaim that leftover lock. Filtered-token behavior is also unverified.

The async Windows ledger stays in the parent realm: CLI/HTTP await admission and status reads,
and one generation-fenced callback dispatches the Worker. The store/Worker regressions in
`tests/windows/windows-codex-cli-job-store.test.ts` cover stale completion refusal and an unknown
still-live fixture Worker whose persisted child/lease state remains unknown. The production-entry
case refuses the null proof-bound snapshot in the enabled Windows lane; neither store case claims a successful Windows installation.

The ledger retains at most 64 jobs, including terminal jobs, and never prunes request IDs automatically.
At capacity it refuses new request IDs with `store_full`; existing matching retries still return the same job.
Capacity expansion and operator recovery require a separate design that preserves deduplication and job-status evidence.
`src/codex/cli-update-job-execution.ts` allows at most eight worker start/completion lock attempts,
with asynchronous 25 ms waits and no stale-lock reclamation. HTTP admission reports `job_store_busy`
with status 503 and `Retry-After: 1`; permanent admission failures do not advertise a retry delay.
Engine exceptions and uncertain Worker dispatch produce `job_result_unknown`; persistence retries keep the same actual result.
Transient completion-write failures have the same bounded retry budget. Permanent failure reports
`job_result_persistence_failed` while retaining the computed result in the error; it does not establish durable completion.
CLI apply prints that failure with the admitted job ID, normalized outcome/reason, lease retention and fixed cleanup codes
in both human and JSON output, and exits 1. It never publishes raw result/error fields or reruns the installer to recover the receipt.
Unknown result/cleanup codes are normalized to fixed-code uncertainty before writing, so they cannot poison later reads.
Unsupported prefixes and unavailable lease storage are distinct from a held installation lease.
Missing/unreadable CLI job status has a structured `job_unavailable` JSON error and a nonzero exit.
CLI apply exits 0 only for an `applied` job; other outcomes and pending duplicates exit 1, including JSON output.
Failed lock initialization rolls back only the fresh directory and partial owner file whose identities this call proves;
replacement identities or unprovable ownership remain fail-closed. Fully initialized locks retain token-fenced cleanup.
