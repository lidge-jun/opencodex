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
package prefix comes from the shim directory and its `node_modules` tree. This plan
currently requires prefix-local `node.exe` and npm. Derivation may propose a PATH Node only
when the local Node probe proves `not-found`; a refused/reparse probe never counts as absent.
The production plan still refuses that external candidate: a standard npm cmd-shim runs bare
`node` when its local Node is absent, and CMD can prefer the invocation working directory.
The proof-bound launcher snapshot has PATH/PATHEXT but no target-shim invocation
cwd/search-result evidence, so a separate Node cannot be selected safely yet. The production runtime resolver confirms the explicit Codex override's
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

PATH-only or separate-prefix Node selection, autostart wrappers, global/vendor fallback,
app/Store/MSIX bundles and version-manager ownership remain unverified and unmanaged.
The explicit `attest` report stays observation-only. Only the production plan predicate
creates private plan evidence; copying a public report cannot enable Windows planning.
This observes linkage and content, not publisher authenticity or a whole-tree guarantee.
Metadata queries use the observed Node/npm paths under freshly matching held handles,
the existing isolated npm configuration/cache, and the pinned registry. No installer runs.
A completed Windows read-only plan has a deterministic ID and `applicable: false`,
`refusal: windows_apply_disabled`; active/unknown sessions still refuse earlier.
The independent Windows apply entrypoint remains refused before inspection or lease creation.

## Independent Windows archive layout

The independent `src/codex/cli-update-windows-layout.ts` verifies Windows x64 archives and
returns only prefix-relative expected files, sizes and content digests; `applicable` and
`mutationAuthority` remain false. No plan, selection, installer, lease or apply consumer uses it.
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
readback comparison requires the complete set. A future consumer must separately prove live held
file identities, package lookup, selected Node/shim and write authority; a matching DTO grants none.
Coverage: `tests/codex-integration/codex-cli-update-windows-layout.test.ts` uses only synthetic
archives and captured shim bytes, with no npm installation or native executable invocation.

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
Windows apply remains refused. Shims and non-npm managers remain unsupported.

`bin/ocx.mjs` includes the proof-bound Codex candidate snapshot for the published `start` command as well as the updater commands; this makes the production management plan work without accepting request-supplied candidate evidence. `src/codex/cli-update-inspection-context.ts` is the shared bridge from that Node snapshot to the installer inspector. Direct Bun/source launches have no trusted candidate and fail closed; neither path reconstructs write targets from display data. `src/codex/cli-update-job.ts` owns the bounded durable admission ledger shared by CLI and management. Request IDs are scoped to the protected config root and payload digest; exact retries return the same opaque job, conflicts refuse, and a full ledger refuses new admission. Every store operation requires a canonical same-owner config parent with safe write permissions and canonical ancestry to filesystem root; each ancestor must be owned by root or the current user, and shared-writable ancestors are refused unless root-owned and sticky. Only confirmed apply admission may create one absent config-root level, which is revalidated as owner-private. Plan and status reads never create it, and an existing root must pass the same canonical/no-link checks. This path-based ancestry check prevents untrusted other-user writable ancestors from redirecting store operations; it does not defend against concurrent tampering by the same user or root. Atomic updates use a private same-owner POSIX directory, no-follow reads and a short exclusive lock. Unresolved records are not expired. An in-process generation and revision own completion writes; after restart a queued/running record projects as `ambiguous` with `owner_state_unknown`, without claiming the old owner stopped. A `retained` lease state requires an execution reason that proves acquisition and intentional preservation; synthetic job errors, unverified release and release exceptions project as `unknown`. The path-free DTO separates owner state, installer child state, lease retention and overall lifetime uncertainty with fixed outcome/reason/cleanup codes.

`src/cli/codex-cli-update.ts` records confirmed CLI apply in that ledger and exposes `status <job-id>` from the same protected record, without requiring a GUI token. `src/server/management/codex-cli-update-routes.ts` exposes a proof-bound read-only plan, confirmed `gui-session` plus trusted-loopback apply admission, and authenticated status. HTTP apply returns after durable admission; disconnect does not cancel the worker. Dashboard display data is never accepted back as a candidate, prefix, executable or managed-selection attestation. There is no dashboard job UI in this contract.

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
