# Codex write substrate, part 3 — lock protocol

The failure to prevent is not merely two writers entering together. The failed
OFF design could block Bun's event loop while waiting, could derive two lock keys
for one symlinked default home, and could let a hostile entry in a shared temp
directory decide where SQLite opened. Its own race test also required an OFF
setter to wait for an apply and then remove it, but the proposed synchronous API
never said whether contention waited, timed out, or failed immediately
(`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:284-303,344-350`).
Audit therefore rejected the design as a missing concurrency substrate, not as a
missing boolean (`devlog/_fin/260803_codex_desktop_toggle/008_audit_synthesis_wp4_r2.md:46-58`).

This document specifies that substrate boundary. It is research and protocol,
not an implementation diff.

## Decision

Use an **async, cross-process, SQLite-backed per-canonical-`CODEX_HOME` lock**.
Acquisition has a required finite deadline and returns one of `acquired`, `busy`,
or `refused`; expected contention is never an exception. SQLite's OS lock is the
holder authority. There is no PID/mtime lease takeover and no stale-lock unlink.
Acquiring it proves exclusion only, never ownership: service-home, external-provider,
journal, provenance, and desired-state admission must pass read-only before the
caller asks the lock module to create or open anything, then be rechecked under
the lock (`devlog/_plan/260804_codex_write_substrate/004_ownership_and_convergence.md:106-139`).

The protocol is deliberately **barging-allowed**, not FIFO. A contender sleeps
asynchronously with bounded jitter and retries `BEGIN IMMEDIATE` until its
deadline. This gives no request-order or starvation guarantee when three or more
processes contend. It does give the property WP4 actually needs: with one current
holder and one waiting OFF setter, the setter either acquires after release and
then removes, or returns typed `busy` at its deadline. A test may assert that
two-party sequence; it may not assert global arrival order.

The database lives in a private, per-OS-user namespace derived from the canonical
login home, not `tmpdir()`, not `CODEX_HOME`, and not `OPENCODEX_HOME`:

```text
<real user home>/.opencodex/native-write-locks/v1/
  <sha256>.sqlite
```

`<sha256>` is the full lowercase hexadecimal SHA-256 of
`"opencodex-codex-write-lock-v1\0" + canonicalCodexHome`. The domain prefix makes
the key unusable as an accidental alias for another hash namespace. Keeping all
64 hex characters avoids introducing a truncation collision into a correctness
key.

**INFERRED:** a fixed home-relative namespace is preferable to a platform/fallback
ladder here. Two processes owned by one user must derive the same lock even when
one has `XDG_RUNTIME_DIR` and another does not, or when one has a custom
`OPENCODEX_HOME`. The repository has no general runtime-directory resolver: its
only `XDG_RUNTIME_DIR` logic discovers the systemd user bus and falls back to
`/run/user/<uid>` (`src/service.ts:1977-2007`); `LOCALAPPDATA` is used to discover
third-party Windows data, not OpenCodex coordination (`src/codex/plugins-doctor.ts:111`,
`src/claude/desktop-3p-paths.ts:60`). OpenCodex's own default per-user state root
is already `~/.opencodex` (`src/config.ts:527-535`).

## Existing coordinator: config mutation

`withConfigMutationLockSync` is the first prior art to preserve.

| Question | Current answer |
|---|---|
| Where | `getConfigDir()/config-mutation.sqlite`; sidecars are registered as owned config paths (`src/config.ts:1718-1762`). |
| Preparation | It asserts the test-home boundary before creating anything, creates/chmods the config directory to `0700`, and attempts Windows ACL hardening (`src/config.ts:1731-1756`). |
| Acquisition | It opens Bun SQLite, chmods the database to `0600`, sets `busy_timeout=0`, then executes `BEGIN IMMEDIATE` (`src/config.ts:1784-1791`). |
| Busy behavior | Fail immediately. `SQLITE_BUSY` becomes `ConfigMutationLockError("Config mutation already in progress")`; every other open/acquisition failure becomes the same typed exception with a different message and original `cause` (`src/config.ts:1792-1800`). |
| Critical section | The callback is synchronous. The transaction commits after it returns; callback or commit failure rolls back and rethrows (`src/config.ts:1803-1814`). |
| Release | Closing the SQLite handle releases the OS lock in `finally` (`src/config.ts:1815-1818`). |
| Stale holder | There is no lease or stale-file deletion. Process exit releases the SQLite lock (`src/config.ts:1767-1773`); the abrupt-exit regression proves a later writer acquires without recovery (`tests/config-mutation-lock.test.ts:105-129`). |
| Reentrancy | Reentrant only on the current synchronous call stack through `configMutationLockDepth`; returning a Promise is forbidden (`src/config.ts:1765-1783`). |

This lock should remain fail-fast and synchronous. It protects short config and
credential commits, and its comment explicitly avoids freezing the Bun event loop
(`src/config.ts:1767-1773`). Changing it into the native-write lock would expand
its critical section across async native work and recreate the audit failure.

The new coordinator should look like it in three ways: SQLite is the process-crash
authority, `busy_timeout=0` prevents SQLite from synchronously parking Bun, and
the database is persistent while the transaction is ephemeral. It deliberately
differs in three ways: acquisition retries asynchronously to a deadline, expected
outcomes are returned rather than thrown, and async reentrancy is refused rather
than inferred from one process-global depth counter.

## The repository already has three concurrency families

Adding another ad hoc `*.lock` algorithm would increase disagreement about stale
ownership, release, and contention. The current tree has these families.

### 1. OS-backed SQLite transactions

- Config mutation is synchronous and fail-fast as described above.
- Native-profile switching is already async: it repeatedly opens a stable lock
  file, tries `BEGIN IMMEDIATE` with `busy_timeout=0`, sleeps 50 ms on busy, and
  returns retryable `NATIVE_PROFILE_BUSY` after a 5 s deadline
  (`src/codex/native-profile-manager.ts:77,313-370`). It keeps the transaction
  across an awaited operation and releases by rollback/close
  (`src/codex/native-profile-manager.ts:373-387`).
- Native-main shared/exclusive claims use the same stable-file helper and SQLite.
  The exclusive claim retries asynchronously only until its caller-supplied
  deadline (`src/codex/native-main-claim.ts:107-160`). The long-lived owner also
  uses `busy_timeout=0; BEGIN IMMEDIATE`, publishes `contended`, and schedules an
  async retry (`src/codex/native-main-owner.ts:160-194`).

This is the family the new lock belongs to. In particular, the stable-file helper
already rejects non-regular/symlink entries, opens with `O_NOFOLLOW` on POSIX,
captures `(dev, ino)`, and detects path substitution after open
(`src/codex/native-main-lock-file.ts:58-125`). Its Windows hardening is already a
required ACL operation (`src/codex/native-main-lock-file.ts:127-131`). The new
coordinator should reuse or generalize that owner; it should not copy those checks
into a fourth file.

### 2. Exclusive-create files with stale recovery

- Prompt-layer writes use `flag: "wx"`, PID plus acquisition age, atomic rename
  quarantine for stale takeover, and token-checked release
  (`src/codex/prompt-lock.ts:28-44,75-121,124-142`).
- OAuth refresh uses an async deadline and jitter, but its lock is an exclusive
  file and stale recovery compares snapshots before unlink
  (`src/oauth/store.ts:171-193`).
- Codex credential refresh also polls an exclusive file asynchronously, but it
  declares staleness from age and unlinks the path (`src/codex/account-store.ts:299-373`).
- Shim autorestore uses an exclusive directory containing a token-named owner
  record; it combines PID, creation time, mtime, inode identity, and a second
  snapshot before stale deletion (`src/codex/shim.ts:722-801,804-840`).

These locks exist because their files are themselves the ownership record. They
are not the model for native writes. A paused but live process, PID reuse, clock
jump, or path replacement turns stale-file deletion into correctness policy.
SQLite already provides crash release without any of those guesses.

### 3. Process-local flights

- `runIntegrationMutationFlight` joins an identical per-client request for 120 s,
  rejects a different request as busy for up to 10 minutes, and forgets the entry
  afterward (`src/server/management/integration-routes.ts:35-37,83-95,146-183`).
- Storage cleanup returns `already_running` from one process-local Promise slot
  (`src/storage/policy-job.ts:415-438`).
- Credential, quota, lifecycle, image-description, and catalog-prime paths use
  Promise/Map single-flights for duplicate suppression; for example Codex token
  refresh joins a grant-keyed Promise and separately takes its cross-process file
  lock (`src/codex/account-store.ts:290-302,400-433`).

Flights collapse work in one process. They do not serialize a CLI, service, and
second OpenCodex process targeting the same native home. A process-local flight
may sit in front of the new lock as an optimization, but it cannot be the lock.

## Acquisition contract

The public acquisition result is a closed union:

```ts
type CodexWriteLockAcquireResult =
  | { status: "acquired"; handle: CodexWriteLockHandle; waitedMs: number }
  | { status: "busy"; reason: "deadline" | "cancelled"; retryable: true; waitedMs: number }
  | { status: "refused"; reason:
        | "codex_home_missing"
        | "codex_home_unsafe"
        | "authority_not_proven"
        | "namespace_unsafe"
        | "lock_path_unsafe"
        | "unsupported_filesystem"
        | "reentrant"
        | "lock_unavailable";
      retryable: false; message: string };
```

This is a shape specification, not an implementation diff. Programmer errors
such as a negative timeout may throw before I/O; filesystem, ACL, SQLite-open,
contention, cancellation, and path-validation outcomes do not.

Acquisition takes a required `timeoutMs`, an optional `AbortSignal`, and injectable
clock/sleep seams. **INFERRED:** production callers cap `timeoutMs` at 30 s; the
Codex OFF setter uses 15 s, while startup/background convergence uses 5 s. There
is no unbounded default. A zero timeout is a valid fail-fast probe.

The algorithm is:

1. Resolve and validate canonical `CODEX_HOME`. Missing or unsafe returns
   `refused` before namespace creation.
2. Require the caller's pre-lock authority receipt. A missing/stale receipt is
   `refused`; the lock itself does not infer ownership from path access.
3. Resolve and validate the per-user namespace and expected lock path without
   following links.
4. Open a stable regular lock file, enforce private ownership/mode/ACL, and retain
   its identity handle.
5. Open SQLite with `busy_timeout=0`, force rollback-journal mode, and attempt
   `BEGIN IMMEDIATE`.
6. On `SQLITE_BUSY`, close the candidate handles, check cancellation/deadline,
   then `await` a jittered 25-75 ms delay and retry from stable-path validation.
   Another contender may barge during that delay.
7. On success, re-assert path identity and return `acquired`. The handle owns the
   SQLite transaction until explicit release.
8. Release rolls back, closes SQLite, then closes the stable side descriptor.
   The persistent database is not unlinked.

The critical operation may `await`; acquisition waiting and the operation itself
therefore do not stop the server event loop. That is the key difference from the
failed synchronous proposal, whose wrapped history path could synchronously hold
for about 10.5 s (`devlog/_fin/260803_codex_desktop_toggle/008_audit_synthesis_wp4_r2.md:25-30`).

### Fairness

Fairness is **weak, deadline-bounded, barging allowed**:

- no FIFO queue or ticket is claimed;
- jitter reduces lock-step polling but does not establish ordering;
- every waiter terminates by acquisition, cancellation, refusal, or deadline;
- a newly arriving process may acquire before an older sleeper;
- no caller may use acquisition order as business ordering.

The linearization order is the order of successful SQLite transactions, not
request arrival. The old test phrase “final state follows lock acquisition order”
remains valid (`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:589-594`);
“final state follows request arrival order” would be a new and false promise.

### Stale holder

PID and mtime are diagnostics only. They are not takeover authority.

- If a holder exits or crashes, the OS closes its SQLite handle and releases the
  transaction. The next retry can acquire, as the config-lock crash test already
  demonstrates (`tests/config-mutation-lock.test.ts:105-129`).
- If a holder is alive but hung, it is not stale. Contenders return `busy` at
  their deadlines. Stealing from a live process would permit two native writers.
- The database file may outlive every holder. Its age says nothing about lock
  ownership and is never grounds for deletion.

This means there is no PID-reuse problem, no heartbeat lease to tune, and no
unlink race. Operational recovery from a genuinely hung live holder is to stop
that process, not to let another process guess.

### Reentrancy

The lock is non-reentrant for the same logical async operation. A nested attempt
for the same canonical home returns `refused/reentrant` immediately. It must not
reuse the config lock's process-global depth counter: while an async holder is
suspended, an unrelated request in the same process could otherwise observe a
positive depth and enter the critical section without owning SQLite.

Unrelated tasks in the same process are ordinary contenders and may wait. The
implementation therefore needs logical-owner context, not a single global
boolean. A helper that already receives an acquired handle may call internal
`...Unlocked` operations explicitly; it must not acquire again.

## Namespace and path hardening

### Why the temp directory is rejected

`tmpdir()/opencodex-native-locks` is a global name on systems where the temp root
is shared. The first user can create that directory with inaccessible ownership,
and an existing symlink can redirect later lock opens. A requested mode on
`mkdir` or SQLite create does not repair or authenticate an existing entry. The
failed design specified only modes, not identity checks
(`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:296-303`).

The repository uses `tmpdir()` for isolated tests and disposable probes, such as
the Codex runtime probe (`src/codex/runtime.ts:251-253`), not for a production
cross-process ownership namespace. The lock therefore stays under the canonical
OS user's home.

### Validation rules

Every path component introduced by OpenCodex is validated before SQLite sees it.

On POSIX:

- canonical user home must be an existing directory resolved with
  `realpathSync.native`;
- `.opencodex`, `native-write-locks`, and `v1` must each be a real directory, not
  a symlink, owned by `process.getuid()`, with effective mode `0700`;
- the database, when present, must be a regular non-symlink file owned by the
  same uid with effective mode `0600`;
- open uses `O_NOFOLLOW`, then `fstat`; `lstat` after open must match the retained
  `(dev, ino)` before acquisition and before release;
- any existing SQLite sidecar at the expected `-journal`, `-wal`, or `-shm` name
  must also be a same-owner regular non-symlink file with mode `0600`. The lock
  database uses rollback-journal mode, so WAL/SHM are unexpected residue and cause
  refusal rather than silent reuse.

On Windows:

- the same `lstat`/realpath identity rules reject symlinks, junctions, and
  reparse-point substitution;
- directory and file ACL hardening is required, not best effort, using the same
  Windows secret-path owners already used by stable native lock files
  (`src/codex/native-main-lock-file.ts:127-131`);
- post-open stable identity is rechecked even though POSIX `O_NOFOLLOW` is not
  available there.

Creation is allowed only after the parent has passed validation. Each new
directory is created `0700`, then re-read and validated; the database is created
`0600`, then re-read and validated. An existing owned entry with a broader mode,
an entry owned by another uid, a symlink/reparse point, unexpected sidecar, or a
path whose identity changes is **not** chmodded, unlinked, renamed, or recreated
by acquisition. It returns typed `refused`. Automatic repair would mutate an
entry whose ownership is precisely what could not be established.

No acquisition path escalates privileges. The response names the unsafe path in
redacted form and tells the user to inspect/remove it themselves.

## Canonical `CODEX_HOME` identity

The current split is a real lock-splitting bug. Explicit `CODEX_HOME` is
realpathed after an existence/directory check (`src/codex/paths.ts:6-21`), while
the default returns `~/.codex` (or a WSL-detected home) without realpathing
(`src/codex/home.ts:135-146`, `src/codex/paths.ts:22-24`). If `~/.codex` is a
symlink, default and explicit spellings can name the same directory but hash
different strings.

The lock protocol has one resolver for both forms:

1. Select the raw effective home with existing precedence: nonblank
   `CODEX_HOME`, otherwise `defaultCodexHome()`.
2. Expand leading `~`, make the path absolute, require an existing directory,
   then call `realpathSync.native` regardless of whether the source was explicit
   or default.
3. On Windows, normalize separators and case-fold the real path before hashing;
   the repository already treats Windows path identity case-insensitively in
   diagnostics (`src/codex/home.ts:164-183`). On macOS and Linux preserve the
   real path returned by the filesystem. For an existing case-insensitive macOS
   directory, realpath supplies the stored directory-entry spelling; a
   case-sensitive volume keeps distinct paths distinct.
4. Hash the normalized canonical string with the domain-separated full SHA-256
   described above.

Consequences:

- default `~/.codex`, explicit `~/.codex`, an absolute spelling, and any symlink
  to the same existing directory take the same lock;
- Windows case/separator variants take the same lock;
- two different existing canonical directories take different locks;
- a missing home returns `refused/codex_home_missing` and creates no namespace or
  lock artifact.

Refusing a missing home is deliberate. Canonicalizing the deepest existing parent
and appending missing segments cannot satisfy both requirements on all filesystems:
lowercasing the absent suffix aliases two distinct future homes on case-sensitive
APFS, while preserving it splits one future home on case-insensitive APFS. There
is no inode or canonical directory entry to resolve yet. Native writes already
require a real target; creation/installation of `CODEX_HOME` is a separate
operation and must complete before this lock can protect it.

**INFERRED:** bind mounts or other namespace aliases that `realpath` does not
collapse are outside the supported equivalence set. Supporting them would require
a portable directory file-identity key and a decision about remote/network
filesystems. The protocol returns `refused/unsupported_filesystem` where SQLite
locking semantics or stable file identity cannot be established; it does not
pretend path hashing solved that case.

## `mutatePersistedConfig`: real outcomes and retryability

The previous design's statement that all `unavailable` outcomes were
non-retryable was wrong specifically for `conflict`. `conflict` means three fresh
snapshot checks observed continuing byte movement, not malformed authority
(`src/config.ts:1841,1870-1913`). Retrying the whole mutation after backoff is the
intended recovery once the competing writer settles.

The complete taxonomy is:

| Actual outcome | Where | Retry policy |
|---|---|---|
| returned `committed` | Fresh bytes stayed stable through revalidation and `persistConfigUnlocked` completed (`src/config.ts:1885-1910`). | Success; do not retry. |
| returned `unchanged` | The first callback or confirmation callback says no change (`src/config.ts:1877-1879,1894-1898`). | Success; do not retry. Native convergence is a separate decision and must not be skipped merely because config was unchanged. |
| returned `unavailable/missing` | The file is absent before lock or at an under-lock read (`src/config.ts:1864-1869,1871-1875,1885-1888,1900-1903`). | Not an immediate retry. Retry only after the config is restored/created by an authorized path. |
| returned `unavailable/invalid` | The file exists but is unreadable/invalid at the same read points (`src/config.ts:1698-1711,1849-1850,1864-1903`). | Not an immediate retry. Requires repair of the file or permissions. |
| returned `unavailable/conflict` | All three rebase attempts observe competing byte changes (`src/config.ts:1841,1885-1912`). | **Retryable** from the beginning with bounded backoff and a fresh native-lock deadline. No partial config commit occurred. |
| thrown `ConfigMutationLockError`, cause `SQLITE_BUSY` | Config transaction acquisition lost (`src/config.ts:1784-1800`). | Retryable contention. While the OFF setter already owns the outer native lock, it may retry only within the remaining outer deadline; it must not release and silently reorder. |
| thrown `ConfigMutationLockError`, non-busy cause | Coordinator database could not be opened/acquired (`src/config.ts:1792-1800`). | Refused/write failure, not blind retry. Permissions, path, disk, or SQLite setup may be broken. |
| thrown callback/hook error | Either mutation callback or the test seam throws inside the transaction (`src/config.ts:1877-1883,1894-1898`). | Domain-specific failure. The generic primitive cannot label it retryable. |
| thrown persistence/commit/close-path error | Atomic config persistence or SQLite commit fails; the catch rolls back when possible and rethrows (`src/config.ts:1803-1818,1909-1910`). | Treat as non-retryable/commit-ambiguous until disk is reread. Never automatically issue a second OFF/ON write from the exception alone. |

`PersistedConfigMutationOutcome` describes only the returned branches
(`src/config.ts:1832-1839`). Callers that claim an exhaustive status matrix while
ignoring exceptions are not exhaustive.

## Lock ordering and deadlock analysis

The OFF setter needs one atomic ordering point across desired intent and native
state. It therefore takes locks in this order:

```text
Codex native-write lock (async, per canonical CODEX_HOME)
  -> config mutation lock (sync, per OPENCODEX_HOME)
     -> release config lock before any further await
  -> native remove/converge
-> release native-write lock
```

No code may acquire the native-write lock from inside
`withConfigMutationLockSync`, `mutatePersistedConfig`'s callback, or any helper
called by those callbacks. The config callback stays synchronous; waiting for the
config lock uses its existing fail-fast exception and a bounded outer async retry.

The current tree has no inverse nesting:

- every direct `withConfigMutationLockSync` call is in `src/config.ts` or the
  credential-store wrapper (`src/config.ts:1826-1829,1861-1913,2144-2176`;
  `src/codex/account-store.ts:278-285`);
- the only external `mutatePersistedConfig` caller mutates plan strings in its
  callback and performs no native operation (`src/codex/auth-api.ts:660-701`);
- config persistence writes only config/account files; it does not import or call
  native-profile, native-main, prompt, shim, integration, or proposed Codex-write
  acquisition;
- the existing native-profile lock is acquired inside `NativeProfileManager`
  operations and does not appear under a config-lock callback
  (`src/codex/native-profile-manager.ts:313-388,553,610`).

Therefore adding only the edge `native-write -> config` cannot close a cycle in
the current graph. The proof must remain mechanical: a source-shape regression
should enumerate all config-lock callbacks and reject imports/calls into the
native-write owner, while native-write tests exercise config busy, conflict, and
success under one held outer transaction.

Two qualifications matter:

1. `withConfigMutationLockSync` has synchronous reentrancy
   (`src/config.ts:1765-1783`). That does not authorize async native-lock
   reentrancy and does not change the global order.
2. Codex credential refresh currently has its own file lock and can later take the
   config lock (`src/codex/account-store.ts:433-469`). Native write critical
   sections must not perform credential refresh or provider network work. That is
   already required by the gather/commit split; violating it would add a longer
   temporal dependency even if it did not immediately form an inverse native-lock
   edge.

## Protocol assertions for the later implementation plan

The implementation phase should be rejected unless tests activate all of these
paths:

1. A held lock keeps Bun responsive; an OFF waiter acquires after release and its
   mutation wins in the two-party race.
2. Deadline expiry returns typed `busy` without a native or config write.
3. A crashed child releases SQLite ownership without PID/mtime cleanup.
4. A live hung holder is never stolen after any age.
5. Default, explicit, absolute, and symlink spellings of one existing home map to
   one full hash; distinct homes map to different hashes.
6. Missing home refuses before namespace creation.
7. Wrong owner/mode, symlink/reparse namespace component, substituted database,
   and unexpected sidecar each return `refused` and are not repaired.
8. A nested same-task acquisition refuses immediately; a separate same-process
   task waits normally.
9. Barging is permitted by contract: tests assert exclusion and deadlines, not
   FIFO arrival order.
10. Outer native-lock plus config `SQLITE_BUSY` and config `conflict` each retry
    only within the remaining outer deadline; non-busy config failure does not.

The hardest unresolved-looking question was missing-home identity on
case-insensitive filesystems. It is resolved here by refusing to invent a lock
key before a canonical directory exists. Any later requirement to coordinate
creation of `CODEX_HOME` is a different lock domain and must not weaken this one.
