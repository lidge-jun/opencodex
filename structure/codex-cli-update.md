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
manifest and Node identities must match the final observation. Text stays bounded
to 256 KiB and Node to 128 MiB. The native backing uses the same finite 1 GiB
`MAX_NATIVE_BACKING_BYTES` as POSIX, defined in `src/codex/cli-installation-limits.ts`.
The native reader bounds aggregate requests to that backing plus 128 MiB Node
and twelve 1 MiB text requests; hash-only bytes are never buffered whole.
Only the opt-in content observation streams the entrypoint, npm CLI, Node and native bytes. The
plan path sets it, so the plan-bound `installContentDigest` is preserved; a bare check holds the
same files — Node and native included — open and identity-checked metadata-only, with zero content
bytes read and a null `installContentDigest`.

PATH-only candidate selection, autostart wrappers, global/vendor fallback,
app/Store/MSIX bundles and version-manager ownership remain unverified and unmanaged.
The explicit `attest` report stays observation-only. Only the production plan predicate
creates private plan evidence; copying a public report cannot enable Windows planning.
This observes linkage and content, not publisher authenticity or a whole-tree guarantee.
Metadata queries use the observed Node/npm paths under freshly matching held handles,
the existing isolated npm configuration/cache, and the pinned registry. No installer runs.
A completed Windows plan has a deterministic ID. Only the bounded x64 prefix predicate below
may set `applicable: true`; other observed layouts retain `windows_apply_disabled`.
Active/unknown sessions still refuse earlier. Apply never overrides a refused plan.

## Independent Windows child lifetime primitive

`src/codex/windows-cli-child.ts` supplies an opt-in Windows x64 child owner, with native ABI/handle
ownership in `src/codex/windows-cli-child-native.ts` and overlapped output in
`src/codex/windows-cli-child-pipe.ts`. Windows apply consumes it for pack, installer and version
children. ARM64 is unsupported.

It starts only an explicit drive-absolute `.exe` plus argv: `CreateProcessW(CREATE_SUSPENDED)`,
assignment to an unnamed non-inheritable Job, then `ResumeThread`. There is no PID reopen,
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
`tests/codex-integration/codex-cli-update-windows-apply.test.ts` covers real offline npm in private
shared fixtures, unrelated package/shim preservation, terminal close failure, partial mutations,
absence, selection, unknown retention, async pins and persistence retry. One JS launcher executes
a compiled CLR x64 backing fixture that verifies Job membership and returns the version. This is
executable-fixture evidence, not a run of the vendor Codex product.

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
terminal apply staging; an uncertain live child retains that staging and its lease.
The owned staging directory is canonicalized immediately after creation, so symlinked temporary roots
and macOS's /var alias are supported without accepting a linked archive file.
`src/codex/cli-update-artifacts.ts` streams compressed integrity and tar validation with independent
256 MiB compressed, 512 MiB total unpacked, 384 MiB member and 4,096 member bounds. Only small
manifest/entrypoint bytes are retained; native and auxiliary members retain size/mode/hash metadata.
Links, traversal, unsupported tar records, dependency-bearing manifests and missing backing files refuse.
After ReadStream construction it exclusively owns the archive descriptor. The held-fd identity check
precedes explicit stream destruction, and verification waits for the close event on success and failure;
pipeline settlement alone is not close completion and the caller never closes that raw fd again.

After artifact preparation, selection/content, the approved metadata and active/unknown process blockers
are re-observed. The awaited process scan is the last yield before install; in the same event-loop turn
as the spawn a synchronous guard re-checks the signal, prefix identity, the byte-level preimage and the
launcher's live canonical selection. npm receives only two verified local tarball specs and an explicit canonical prefix,
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
exit retains lease/staging and reports its PID with an ambiguous result. Existing sessions are never signalled.
Verified target readback and execution are `applied` even after nonzero installer exit; unchanged full original evidence
is `not_applied` even after exit zero. Partial, unreadable or uncertain results are `ambiguous`.
Cleanup failures are path-free `cleanupErrors` alongside the computed outcome. A failed or thrown
lease release marks retention unverified without preventing staging cleanup; cleanup does not replace
the readback outcome. Uncertain live installer/version children still retain both lease and staging.
The POSIX path refuses Windows; Windows uses the separate transaction above. Non-npm managers remain unsupported.

`bin/ocx.mjs` includes the proof-bound Codex candidate snapshot for the published `start` command as well as the updater commands; this makes the production management plan work without accepting request-supplied candidate evidence. `src/codex/cli-update-inspection-context.ts` is the shared bridge from that Node snapshot to the installer inspector. Direct Bun/source launches have no trusted candidate and fail closed; neither path reconstructs write targets from display data. `src/codex/cli-update-job.ts` owns the bounded durable admission ledger shared by CLI and management. Request IDs are scoped to the protected config root and payload digest; exact retries return the same opaque job, conflicts refuse, and a full ledger refuses new admission. Every store operation requires a canonical same-owner config parent with safe write permissions and canonical ancestry to filesystem root; each ancestor must be owned by root or the current user, and shared-writable ancestors are refused unless root-owned and sticky. Only confirmed apply admission may create one absent config-root level, which is revalidated as owner-private. Plan and status reads never create it, and an existing root must pass the same canonical/no-link checks. This path-based ancestry check prevents untrusted other-user writable ancestors from redirecting store operations; it does not defend against concurrent tampering by the same user or root. Atomic updates use a private same-owner POSIX directory, no-follow reads and a short exclusive lock. Unresolved records are not expired. An in-process generation and revision own completion writes; after restart a queued/running record projects as `ambiguous` with `owner_state_unknown`, without claiming the old owner stopped. A `retained` lease state requires an execution reason that proves acquisition and intentional preservation; synthetic job errors, unverified release and release exceptions project as `unknown`. The path-free DTO separates owner state, installer child state, lease retention and overall lifetime uncertainty with fixed outcome/reason/cleanup codes.

`src/cli/codex-cli-update.ts` records confirmed CLI apply in that ledger and exposes `status <job-id>` from the same protected record, without requiring a GUI token. `src/server/management/codex-cli-update-routes.ts` exposes a proof-bound read-only plan, confirmed `gui-session` plus trusted-loopback apply admission, and authenticated status. HTTP apply returns after durable admission; disconnect does not cancel the worker. Dashboard display data is never accepted back as a candidate, prefix, executable or managed-selection attestation. There is no dashboard job UI in this contract.

On Windows, `src/codex/cli-update-job-store-windows.ts` maps the same ledger contract onto NTFS handle semantics and the public admit/read/finish API in `src/codex/cli-update-job.ts` dispatches to it asynchronously. Each ancestor from the volume root is opened relative to its already-held parent — never a re-parsed path — and refused on any reparse attribute, then evaluated under the "trusted-ancestry" ACL policy (owner is the serving token or SYSTEM/Administrators/TrustedInstaller; untrusted grantees may hold read and, on admin-owned ancestors only, broad create-only rights). The config-root parent and a pre-existing config root are verified under the "write-private" policy and are never rehardened; only a directory the call itself creates is icacls-hardened and held to the strict "private" rule. File identity is the volume serial plus 128-bit file ID with single link and no pending delete, the dev:ino analog. Ledger writes go through a private hardened temp that is byte/ACL/identity-verified, renamed while its handle is held, re-read through the published name, and flushed at the directory. The admission mutex is a mkdir lock plus an owner record released only while both held pins still show this call identity and content, so a leftover lock blocks later admission exactly like POSIX. ACL snapshots are taken per phase through the shared bounded PowerShell read in `src/lib/windows-owner-acl.ts` (async variant), not per path. Pins bind each object to its verified state for the operation and the private DACL confines writers, but this is not a proof against concurrent mutation by the serving account or an elevated process, which sit inside the trust boundary as on POSIX. The backend is x64-only; cross-account (other-SID) and ARM64 behavior are unverified.

An ACL-query timeout fails closed without accepting a late result. Its PowerShell child may still
hold transient handles while termination settles, so lock cleanup may fail and retain a busy mutex;
the store does not automatically reclaim that leftover lock. Filtered-token behavior is also unverified.

The ledger retains at most 64 jobs, including terminal jobs, and never prunes request IDs automatically.
At capacity it refuses new request IDs with `store_full`; existing matching retries still return the same job.
Capacity expansion and operator recovery require a separate design that preserves deduplication and job-status evidence.
`src/codex/cli-update-job-execution.ts` allows at most eight worker start/completion lock attempts,
with asynchronous 25 ms waits and no stale-lock reclamation. HTTP admission reports `job_store_busy`
with status 503 and `Retry-After: 1`; permanent admission failures do not advertise a retry delay.
Only engine exceptions synthesize `job_result_unknown`; persistence retries keep the same actual result.
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
