# WP11 — one bounded writer per canonical `CODEX_HOME`

Research: `003_lock_protocol.md`. Shared contract: `005_contract.md`.

The failure is lock splitting plus event-loop denial, not a missing mutex. Two
spellings of one existing Codex home can reach different textual paths
(`src/codex/paths.ts:6-24`), while a lock held across provider discovery or history
walking would recreate the 10.5-second listener stall that blocked the previous OFF
design. WP9 has already made catalog commit synchronous and fixed-size; WP10 has
already put history behind its own sibling Worker-held lock. WP11 supplies only the
native acquisition and coordinated synchronous commit section.

The prior plan still invented admission callback/result types and based the
namespace on `homedir()`. Round 2 invalidated both choices. Admission is the
contract's exact `AdmissionSnapshot`; and the pinned Bun 1.3.14 probe showed both
`os.homedir()` and `os.userInfo().homedir` follow environment-controlled home.
Effective-user identity — uid on POSIX, SID on Windows — is the namespace authority
(`005_contract.md` §§4, 7).

**This document is WP12's lock section.** It was written as a standalone WP11 and
opened by asserting that WP11 was independently landable; round 7 established the
opposite and merged the two phases (see the Round 6 resolution below). The lock
consumes WP8b's identity/transition-state/types, WP9's synchronous candidate commit,
and WP10's separate history protocol — and it is delivered together with the
`AdmissionSnapshot` producer and the first production caller, because without those
its API cannot be exercised by anything but a fabricated snapshot.

All current-code citations and diff context below were rechecked on 2026-08-04 at
`7bde9e0c977721fc0b9d8617c85ff17de7c07658`.

## Round 6 — three findings that came from running the code, not reading it

Rechecked on 2026-08-05 at `86e5d677b`, with executed probes rather than citation.
All three change what B must build.

> **Read this section as a HISTORICAL RECORD of how each finding was reached, not
> as instructions.** It was written while this was still a standalone WP11, so its
> sentences say "WP11 does X" and some of them propose remedies that later rounds
> then defeated — the F2 adjacency rule most of all. Every prescriptive decision
> lives below, in the merged-phase sections; where the two disagree, those win.
> The findings are kept in their original shape deliberately: a remedy that was
> wrong is more useful with the reasoning that produced it attached than deleted.

### F1 — the coordinator refuses to open on every routed install (blocking)

`openCodexCoordinatorTransaction` initializes a missing row only after
`assertInitialStateCanBeCreated()` proves the record is not legacy and
`classifyNativeRoutedResidue()` returns `clean`
(`src/codex/transition-state.ts:263-303`). A routed `config.toml` — which is
exactly what every user with the proxy applied has — is residue. Executed against
a temp home containing a routed `model_provider = "opencodex"` block:

```text
REFUSED: CodexCoordinatorLegacyAmbiguousError
  | A missing coordinator row cannot be initialized while native Codex routing residue exists.
```

The same probe against a clean home opens and returns
`{"nativeBefore":0,"nativeAfter":1,...}`.

So the plan's instruction to "place WP9's fixed catalog/native commit under the new
lock" is, as written, a **regression for every existing routed installation**: a
catalog refresh that succeeds today would begin refusing. The compatibility-adoption
path that `005_contract.md:705-800` designed for this is **not implemented** —
`withCodexCompatibilityNativeHandoff` and `adoption-pending` have zero occurrences
in `src/`.

The phase therefore ships the lock **without rewiring the existing catalog commit
to require N**. `commitCodexCatalogCandidate` keeps `K -> C`
(`src/codex/convergence.ts:393-406`), which is already correct and already
cross-process safe. That seam moves under N only once the adoption path makes
opening N legal on a routed home. Landing the lock and its rewiring in one
phase would mean landing a refusal for the current user base to satisfy a document.

That is not a scope dodge: WP11's own accept criteria (C5/C6/C7/C18) are about
acquisition, identity, and namespace. None of them requires the catalog seam to be
the first caller. What WP11 must NOT do is ship a module with no caller — defect #10
in this unit was exactly that — so the deliverable includes the real
`convergeCodexNativeUnderLock` entry consumed by a production route, gated to the
homes where N can legally open, plus the falsifiable test that a routed home refuses
with a typed reason instead of throwing.

#### The direction asymmetry — real, but it does NOT supply a caller

"N cannot open" is not uniform, and the difference decides which production path
WP11 can legally serve. Probed both directions against real temp homes:

| Operation | Home state when N is taken | Result |
|---|---|---|
| **apply** (route Codex at the proxy) | clean — not yet routed | `OPEN OK`, expectation `{nativeBefore:0, nativeAfter:1}` |
| **restore** (unroute back to native) | already routed | `REFUSED` — legacy-ambiguous |

A first apply on an unrouted home is the one state the strict initializer accepts,
because the residue it refuses is the routing this operation has not performed yet.

**That is where I claimed a production caller, and review round 6 proved the claim
false.** The paragraph that stood here named `injectCodexConfig`
(`src/codex/inject.ts:487`) as a caller WP11 could serve. Three facts kill it:

1. Production reaches `injectCodexConfig` **directly** from `src/codex/sync.ts:58,110`
   and `src/cli/init.ts:197`. None of them goes through `convergence.ts`, which is
   the only module this phase's write scope was allowed to modify. Adding an entry
   point to `convergence.ts` therefore adds an export nothing calls.
2. `injectCodexConfig` cannot become the synchronous commit callback as it stands.
   It journals (`src/codex/inject.ts:530`), writes native files
   (`:601`), and then **awaits** the history job (`:614`). The synchronous native
   section has to be split from post-N history dispatch before any of it can sit
   under N.
3. There is no runtime producer of a full `AdmissionSnapshot` at all. It exists only
   as an interface (`src/codex/convergence-types.ts:495`); the sole thing production
   builds today is `CatalogAdmissionSnapshot`. WP11's own API requires the former.

So the narrowing as written *was* a dodge, and its own falsification test — "if the
apply path cannot legally take N either, fold WP11 into WP12" — has now fired. The
resolution is recorded below rather than argued away.

#### Resolution: WP11 MERGES INTO WP12. This document becomes WP12's lock section.

My first attempt at a resolution was "mechanism-only": ship the lock and its tests,
move the caller to WP12, and defend the boundary by analogy to WP8b, which also
shipped before it had a consumer. Round 7 rejected the analogy, correctly.

WP8b was a **contract** consumed by four later phases; publishing it first is what
stopped WP9-WP12 from inventing four incompatible shapes. WP11 has exactly **one**
planned consumer, and the two things needed to exercise its API — a production
`AdmissionSnapshot` producer and the apply/restore split in `inject.ts` — both arrive
in that same consumer. So a standalone WP11 can only prove that a **fabricated**
snapshot and a **fabricated** callback drive the primitive. It cannot prove the API
fits the one real caller it exists for. That is precisely the shape this unit keeps
producing: a green, unusable seam.

The surrounding documents already assume the merged shape and were never consistent
with a standalone WP11:

- `005_contract.md:635` assigns WP11 "that complete async N → K → C mechanism **and
  its broader caller rewire**".
- `040_ownership_convergence.md:15` states WP9-WP11 "already provide the working
  `convergeCodex` funnel ... and native lock" — a claim a mechanism-only WP11 makes
  false.
- `040_ownership_convergence.md:211` is where the actual call edge lives.

So the merge is not a concession, it is the reading that makes three documents agree.

**What this means concretely:**

- The N mechanism has **no independent completion gate**. It is audited together
  with its first production caller, or it is not audited.
- It may still land as its own commit for reviewability. A commit boundary is not a
  phase boundary.
- The goalplan work-phase is restructured accordingly: `wp11` is closed as *merged*,
  and `wp12` carries the mechanism, the admission producer, the `inject.ts`
  apply/restore split, and the first call edge as required tasks.
- **F4 is a separate COMMIT within WP12, not a separate merge.** The ACL
  pathname-cache defect is a live bug in shipped code
  (`src/lib/windows-secret-acl.ts`) and does not depend on the lock, so it is written
  and verified first rather than queued behind the admission producer. It is still
  audited under WP12's gate: "lands alone" would have meant a shipped repair with no
  active phase reviewing it, which is the gap the merge exists to close.

Everything below this line is therefore **WP12's lock section**, rewritten to the
decisions above. Where the historical text conflicts with them, the decisions win —
and the sections that conflicted have been rewritten rather than annotated, because
round 7's finding was exactly that corrective prose above a contradictory body is
instance #16 of treating an absence as a guarantee.

### F2 — the initializer's residue guard reads the AMBIENT home, not the locked one

Absence-as-guarantee #14. `classifyNativeRoutedResidue()` resolves its own home
through `getCodexHome()` (`src/codex/native-residue.ts:524`), which re-reads
`process.env.CODEX_HOME` (`src/codex/paths.ts:32-35`). `readIntegrationRecord()`
resolves its path the same ambient way. But `resolveCodexCoordinatorDatabasePath`
is keyed by the **caller-supplied canonical home**. Executed with ambient
`CODEX_HOME` pointing at a clean directory and the explicit target home routed:

```text
ambient CODEX_HOME = <tmp>/clean
explicit home      = <tmp>/routed
OPENED OK for a ROUTED explicit home -> residue check used the AMBIENT home
```

The guard passed by inspecting a directory that is not the one being locked. Every
existing caller happens to pass the ambient home, so the defect is latent today and
becomes live the moment WP11 accepts an explicit `codexHome` — which its API does.

Consequence: `CodexWriteLockOptions.codexHome` may not be forwarded to a
coordinator whose safety guard reads a different home. The lock refuses with
`authority_not_proven` when the canonical target home is not identical to the
ambient `getCodexHome()` result, and a test drives the mismatch.

> The sentence that stood here — "making the guard home-parameterized is WP12's
> job" — was written when WP11 and WP12 were separate phases, and it was wrong on
> its own terms even then: round 8's symlink probe showed the comparison alone
> cannot close this. Parameterizing the guard is required work in THIS phase. See
> the acquisition section.

**The obvious version of that remedy is itself a TOCTOU**, and it was caught by
probing rather than by reading. `getCodexHome()` re-resolves `process.env.CODEX_HOME`
on every call (`src/codex/paths.ts:32-35`), so two calls inside one operation can
return two different directories:

```text
same call, two answers: true | a -> b
```

A comparison that calls `getCodexHome()` once to validate and lets the coordinator
call it again to check residue proves nothing: the second read is a fresh read. So
the check is not "compare the two", it is **resolve the ambient home exactly once,
canonicalize it, use that single value for both the comparison and the lock target,
and refuse if the caller supplied anything else**.

> ~~And the residue guard's own later read is covered because it is bounded by N — a
> second process that changes the environment cannot change ours.~~ **Struck.** N
> serializes the coordinator database, not `process.env`, and it is not even held
> when that read happens. Round 8 then showed the deeper error: a second process
> does not need our environment at all, because it can retarget the symlink that
> our `CODEX_HOME` names. The mechanism is the parameterized guard, not this
> argument.

That last clause is a claim, not an assumption, so it needs a guard rather than a
comment: the B phase adds a test that fails if any production module under `src/`
assigns to `process.env.CODEX_HOME`. Today `rg -n "env.CODEX_HOME\s*=" src` finds
nothing, and an absence that nothing enforces is precisely the defect this unit has
now hit fourteen times.

**And the grep proves the claim false, which is why it was run.** Production code
does assign `process.env.CODEX_HOME`, in two places:

- `src/codex/history-worker.ts:158` — WP10 added this in THIS session. The Worker
  receives the parent's home in its run message and installs it before doing any
  history work.
- `src/storage/policy-worker.ts:34` — the same bootstrap shape, older.

Both are Worker entry bootstraps: they set the variable once, at thread start,
before that thread resolves any path, so neither mutates the home of a thread that
is mid-operation. That makes the invariant WP11 needs narrower and checkable:
**no assignment to `process.env.CODEX_HOME` outside a Worker bootstrap**, i.e. none
on a thread that could be holding N. The B-phase guard asserts exactly that, with
the two known bootstraps as named exceptions, so a third assignment added on a
request path fails the test instead of silently invalidating the once-resolved home.

Writing this down mattered more than the guard does. The paragraph above originally
asserted the grep was empty; running it produced two hits, one of them added by this
very session. That is instance #15 in miniature — the absence was asserted from
memory of the design instead of from the tree — and it is the reason every claim in
this phase gets executed rather than recalled.

#### Two more holes review found in this same remedy

The canonicalize-once rule above is necessary and still not sufficient.

**A symlinked default home refuses itself.** With no `CODEX_HOME` set,
`getCodexHome()` returns `defaultCodexHome()` **without** `realpath`
(`src/codex/paths.ts:23`), while WP11's target is `realpathSync.native`-canonical. On
a machine where `~` or `~/.codex` is a symlink, the two strings differ and the lock
refuses a home that is in fact the same directory. The comparison must canonicalize
**both** sides before comparing, never the target alone.

**The comparison must be adjacent to the open.** Acquisition retries across `await`
boundaries. A comparison performed before the retry loop and an
`openCodexCoordinatorTransaction` performed after it are separated by suspension
points, so the guard re-reads the environment in between. The canonical ambient home
is resolved once, and the equality check is re-asserted **immediately before** the
synchronous open with no `await` between them.

**And one citation in the original F2 text was simply wrong.** It said
`readIntegrationRecord()` resolves its path from the ambient CODEX_HOME. It does not:
its path comes from `getConfigDir()` (`src/codex/integration-record.ts:28`), which is
`OPENCODEX_HOME`, a different variable. Only `classifyNativeRoutedResidue()` reads
the ambient Codex home. The defect is real and the mechanism was misdescribed; the
narrower true statement is what B implements against.

### F4 — absence-as-guarantee #15: ACL success is cached by pathname, not identity

This one is a live defect in shipped code, not only in the plan.
`hardenStableLockFile` delegates to `hardenSecretPathAsync`
(`src/codex/native-main-lock-file.ts:127`), which returns success purely because the
**pathname** is in a module-level `Set<string>` (`src/lib/windows-secret-acl.ts:36,461`).
Nothing in that cache is bound to the file's identity. Review's executed probe
hardened a path, unlinked it, recreated it at the same name, and re-hardened:

```text
{"firstCalls":3,"totalCalls":3,"replacementWasRechecked":false}
```

The replacement file received **zero** ACL calls. The plan's "validate the DB, refuse
substitution" section inherits this: it treats "no path change observed" as proof
that the cached ACL still describes the current inode. It does not, and on Windows
that means a substituted coordinator database can be adopted with the previous
file's hardening credited to it.

Remedy for B: bind the ACL success cache to stable file identity, or invalidate the
entry when the stable descriptor's last reference closes so the next acquisition
revalidates. The regression test must be release → replace → **reacquire**;
substituting the file during a single held acquisition does not reach the cache and
would pass with the fix removed.

### F5 — deadline exhaustion must not be a permanent refusal

The result taxonomy carries `busy/deadline` as retryable, but the acquisition section
classifies ACL failure — including timeout — as a non-retryable refusal, and says only
SQLite busy retries. A caller-supplied short remaining deadline can time ACL work out
without proving anything unsafe; that is exhaustion, not unsafe authority. Worse, the
current ACL code rethrows a sanitized untyped `Error`
(`src/lib/windows-secret-acl.ts:484`), discarding the `ETIMEDOUT` discriminator the
classification would need.

B preserves a typed timeout discriminator through sanitization, maps outer-budget
exhaustion to `busy/deadline`, and reserves non-retryable refusal for verified
ACL/ownership/path failures.

### F6 — citation corrections

Verified accurate: `native-main-lock-file.ts:35-55,74-131`,
`native-main-owner.ts:75-91`, `home.ts:135-146`, `paths.ts:6-24`.

Corrected:

| Cited | Problem | Use instead |
|---|---|---|
| `src/config.ts:1853-1859` | those lines are config-generation reads, not the conditional-rename statement | `src/config.ts:1949` |
| `src/config.ts:1767-1818` | stops before callback execution, commit, rollback, and close | `src/config.ts:1779-1839` |
| `windows-secret-acl.ts:217-328,404-494` | misses `HardenOptions`/deadline clamping and the exported async entry | add `:45` and `:512` |

### The type block must not redeclare the capability

The public-contract fence below prints its own `unique symbol` brand and its own
`CodexCoordinatorTransaction`. Both already exist:
`src/codex/convergence-types.ts:331` owns the public interface and
`src/codex/transition-state.ts:148` owns the private brand. The fences compile in
isolation — which is exactly why the fence check did not catch this — but an
integration compile assigning `openCodexCoordinatorTransaction(...).capability` to
the plan's local type fails:

```text
TS2741: Property '[codexCoordinatorTransactionBrand]' is missing in type
'convergence-types.CodexCoordinatorTransaction'
but required in type 'plan.CodexCoordinatorTransaction'.
```

The implementation **imports** `CodexCoordinatorTransaction` from
`./convergence-types` and declares no local brand. The fence below is retained as the
historical shape; where it declares the brand and interface, read the import.

### F3 — `journal_mode` and reentrancy needed no new mechanism

A pinned-Bun probe shows `bun:sqlite` opens in `delete` mode by default and leaves
no `-wal`/`-shm` sidecar after a committed `BEGIN IMMEDIATE`, so the plan's
"forces rollback journal mode" is a verification, not a conversion. And a second
`openCodexCoordinatorTransaction` on a held path in the SAME process already fails
with `SQLiteError: database is locked`, because `busy_timeout = 0` is set before
`BEGIN IMMEDIATE` (`src/codex/transition-state.ts:416`).

`AsyncLocalStorage` reentrancy detection therefore is not what prevents a
same-process deadlock — SQLite already does. It exists to turn an
indistinguishable `busy` into a typed `refused/reentrant`, which is a diagnosis
improvement, not an exclusion mechanism. The test must assert the typed reason,
not "does not hang", or it proves nothing SQLite was not already doing.

## IN / OUT

IN:

- `src/codex/codex-write-lock.ts` (NEW) — exact contract module name; canonical
  target identity, effective-user namespace, finite async acquisition, synchronous
  coordinated commit, release, and typed lock mechanics.
- `src/codex/convergence.ts` (MODIFY) — add the native convergence entry that takes
  N and publishes a transition, called by the WP12 admission pipeline. It does NOT
  move the **existing catalog commit** under N: that seam keeps its current `K -> C`
  (`src/codex/convergence.ts:393-406`), because N refuses to open on a routed home
  and rewiring it would break every applied install (F1).
- `src/codex/inject.ts` (MODIFY) — split the synchronous native mutation from the
  awaited history dispatch (`:530` journal, `:601` native writes, `:614` awaited
  history) so the native section can sit beneath N and history stays outside it.
- The WP12 admission producer (MODIFY/NEW per `040_ownership_convergence.md`) —
  without it there is no `AdmissionSnapshot` at runtime and the lock's API cannot be
  called at all. `AdmissionSnapshot` is today only an interface
  (`src/codex/convergence-types.ts:495`).
- `src/codex/transition-state.ts` (MODIFY through its public owner API) — lend
  WP11 a narrow opaque capability backed by the already-open coordinator
  transaction; this module remains the sole native-generation/transition-row owner.
- `src/codex/integration-record.ts` (consumed through `updateIntegrationRecord`) —
  persist provenance/non-CAS JSON only inside the synchronous coordinated section.
- `src/codex/native-main-lock-file.ts` (MODIFY) — reuse stable descriptor and
  substitution checks; add only a caller-supplied ACL deadline cap.
- `src/lib/windows-secret-acl.ts` (MODIFY) — accept a stricter remaining deadline;
  current callers retain the 5-second default.
- `tests/codex-write-lock.test.ts` (NEW),
  `tests/helpers/codex-write-lock-child.ts` (NEW), and
  `tests/windows-secret-acl.test.ts` (MODIFY).

OUT:

- New admission, authority, generation, record, observed-state, or convergence
  result shapes. WP11 imports `AdmissionSnapshot`, `CommitExpectation`, and
  `UserIdentity` from the contract modules (`005_contract.md` §§1-4, 7). The
  native-lock result below remains owned by this lock module; it is a mechanism
  result projected by `convergence.ts`, not a competing convergence union.
- History mutation/locking. WP10 owns H and its two short fail-fast H->N
  operations; WP11 only ensures N is released before history dispatch.
- Transition-row schema, generation allocation, or JSON transition state. Those
  belong to `transition-state.ts`; `integrations/codex.json` contains provenance
  and extensions, never `nativeGeneration`, `currentTxId`, or history scheduling.
- Provider gathering or any awaited history work inside the native held section.
- Desired-state, service ownership, external-provider, journal, and provenance
  policy — WP12. WP11 compares snapshots and enforces order; it does not decide
  what `owned` means.
- `src/codex/paths.ts` global behavior, PID files, leases, stale-file deletion,
  FIFO tickets, process-local queueing, GUI, releases/deploys, and port 10100.

No-code/config reuse is insufficient: process-local flights do not coordinate two
processes. Reusing `native-main-lock-file.ts` is required for its stable descriptor
and `(dev, ino)` checks (`src/codex/native-main-lock-file.ts:35-55,74-131`); WP11
does not add another raw-open owner.

## Public contract consumes `AdmissionSnapshot`

The shared type names and result taxonomy already exist after WP8b. WP11 implements
them in `src/codex/codex-write-lock.ts`; it does not publish the former
`CodexWriteLockAdmissionPhase` or `CodexWriteLockAdmissionResult` unions.

```ts
import type {
  AdmissionSnapshot,
  CodexCoordinatorTransaction,
  CommitExpectation,
} from "./convergence-types";

export const CODEX_WRITE_LOCK_MAX_TIMEOUT_MS = 30_000;

export type CodexWriteLockResult<T> =
  | { status: "acquired"; value: T; waitedMs: number; lockId: string }
  | { status: "busy"; reason: "deadline" | "cancelled"; retryable: true; waitedMs: number }
  | {
      status: "refused";
      reason:
        | "codex_home_missing"
        | "codex_home_unsafe"
        | "authority_not_proven"
        | "namespace_unsafe"
        | "lock_path_unsafe"
        | "unsupported_filesystem"
        | "reentrant"
        | "lock_unavailable";
      retryable: false;
      message: string;
    };

export interface CodexWriteLockOptions {
  codexHome?: string;
  timeoutMs: number;
  signal?: AbortSignal;

  /** Read-only snapshot obtained before any namespace creation. */
  admitted: AdmissionSnapshot;

  /**
   * Authoritative synchronous re-read while native + config coordination is held.
   * It returns the exact shared shape; no lock-specific admission union exists.
   */
  readAdmissionUnderLock(): AdmissionSnapshot;
}

export interface CodexWriteCommitContext {
  readonly canonicalCodexHome: string;
  readonly lockId: string;
  readonly admission: AdmissionSnapshot;
  readonly expectation: CommitExpectation;
  /**
   * Opaque authority over the ALREADY-OPEN BEGIN IMMEDIATE transaction N.
   * It exposes one conditional row operation, not SQLite or transaction control.
   */
  readonly coordinator: CodexCoordinatorTransaction;
}

// NO local brand and NO local interface here. `CodexCoordinatorTransaction` is
// imported above from `./convergence-types` (`src/codex/convergence-types.ts:331`);
// its private brand belongs to `src/codex/transition-state.ts:148` and to nothing
// else. Redeclaring either compiles fine in isolation — which is why the per-document
// fence check did not catch it for several rounds — and then fails at the only place
// that matters, assigning a real `openCodexCoordinatorTransaction(...).capability`:
//
//   TS2741: Property '[codexCoordinatorTransactionBrand]' is missing in type
//   'convergence-types.CodexCoordinatorTransaction' but required in type
//   'plan.CodexCoordinatorTransaction'.

type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * A TYPE, not a bodyless declaration.
 *
 * `export async function f(...): Promise<T>;` with no body is TS2391, and a
 * reviewer has caught that exact form in this unit three separate rounds by
 * compiling the documents. Publishing the shape as a type makes the mistake
 * structurally impossible to reprint.
 */
export type WithCodexWriteLock = <T>(
  options: CodexWriteLockOptions,
  commit: (context: CodexWriteCommitContext) => Synchronous<T>,
) => Promise<CodexWriteLockResult<T>>;
```

`CodexWriteLockResult` is the lock module's own bounded mechanism result.
`convergence.ts` exhaustively projects it into `ConvergeOutcome`; no route consumes
it directly. `CodexCoordinatorTransaction` is the only handle passed to the
callback — **imported**, not redeclared, from `./convergence-types`. It is branded by
`transition-state.ts` alone and exposes only the contract's null-safe conditional
transition-row update. It is one-shot for this transition, and the lock verifies that
it returned `updated` for the exact expectation before allowing C to release. It
exposes neither the `Database` object nor `COMMIT`,
`ROLLBACK`, or `close`. Opening another connection in the callback is wrong: it
would contend with WP11's own `BEGIN IMMEDIATE` instead of updating through N.
The conditional return rejects ordinary `async` callbacks at typecheck;
the implementation also detects a cast thenable, rolls back, and throws a
`TypeError`. Provider I/O, subprocesses, serialization, history walking, retry
sleeps, and any other awaitable work are forbidden beneath `commit`.

## Admission and synchronous config-record section

The fixed order is:

```text
resolve canonical existing CODEX_HOME                         read-only
derive lock id + detect same-task reentrancy                  read-only
compare options.admitted to target home                       read-only
  non-authorizing snapshot -> return refused; create NOTHING
resolve effective UserIdentity + OS runtime root              read-only
validate/create private user namespace
validate/open stable DB; BEGIN IMMEDIATE                      native lock held
withConfigMutationLockSync                                    config lock held
  authoritative readAdmissionUnderLock()                      fresh snapshot
  compare digest + config generation + intent + ownership
  read transition pair and form CommitExpectation             from row in N
  commit(context with opaque N capability)                    synchronous
    native writes + provenance-only integration-record update
    conditional transition-row update through the same N
  verify exact nativeAfter + txId on the still-open N
release config lock
assert stable lock path; COMMIT N; close DB + side fd
```

This replaces the former two generic admission callbacks. The first
`AdmissionSnapshot` is enough to refuse before namespace creation. The second is
an authoritative re-read inside the coordinated commit; the lock does not reduce it to
a boolean or manufacture an authority receipt.

`withConfigMutationLockSync` is already synchronous, fail-fast, and reentrant only
for the current synchronous stack (`src/config.ts:1779-1839`, which includes the
callback execution, commit, rollback, and close the shorter range cut off). The
native lock may
hold it because no await occurs. Config-generation reads/updates and
provenance-only `updateIntegrationRecord` calls happen before that callback returns.
The native generation bump, `txId`, and pending history schedule are owned by the
transition row and are conditionally updated through the capability backed by N.
WP11 verifies that exact row before C returns, releases C, and then commits N.

The previous version ended the successful path with `ROLLBACK`. That was wrong: it
discarded the transition row the whole design depends on, so a successful native
commit became indistinguishable from an unrecorded partial write and stale Workers
could not be rejected. `ROLLBACK N` remains only for callback failure, failed row
update/verification, cast-thenable rejection, or another refusal before commit.

If the config coordinator is busy, the attempt releases the native lock and retries
only while the outer monotonic deadline remains; deadline expiry returns typed
`busy`. It never releases and commits against the old admission. A non-cooperating
filesystem writer remains detectable after commit, as scoped by `005_contract.md`
§3; this phase does not promise a portable conditional rename that
`src/config.ts:1949` explicitly says the filesystem lacks.

## Canonical `CODEX_HOME` identity — C6

1. Select nonblank explicit `codexHome`, else nonblank `process.env.CODEX_HOME`,
   else `defaultCodexHome()` (`src/codex/home.ts:135-146`). Blank explicit input is
   a programmer error.
2. Expand only leading `~`, resolve absolute, and require an existing directory.
   Missing/non-directory refuses before identity namespace work.
3. `realpathSync.native` every spelling, default and explicit.
4. Refuse known unsupported UNC/WSL DrvFS target classes through the existing
   predicate (`src/codex/native-main-owner.ts:75-91`).
5. Windows normalizes/case-folds the canonical result; POSIX hashes the exact
   realpath string.
6. Hash `"opencodex-codex-write-lock-v1\0" + normalizedCanonicalHome` with full
   SHA-256 lowercase hex.

Default, explicit, absolute, tilde, and symlink spellings of one existing directory
must contend on one lock. Two distinct existing directories must not. A missing
home is refused: preserving an unresolved suffix would either split one future home
on case-insensitive filesystems or alias two on case-sensitive ones.

## Namespace and hardening — C7

### No home accessor participates

Delete `homedir()` from the import list and delete the prior
`realpathSync.native(homedir())/.opencodex/...` design. The pinned Bun probe in
`005_contract.md` §7 proves both home accessors can be changed by `HOME`; using
`os.userInfo().homedir` would preserve the defect.

Consume `UserIdentity` and the one final-path resolver from
`src/codex/user-identity.ts`:

```ts
import {
  resolveEffectiveUserIdentity,
  resolveCodexCoordinatorDatabasePath,
} from "./user-identity";
```

Call `resolveEffectiveUserIdentity()`, then pass that identity and the canonical
`CODEX_HOME` to `resolveCodexCoordinatorDatabasePath(...)`. Its return value is the
**final database path** and is consumed verbatim. The lock does not import
`resolveOsRuntimeDirectory`, encode uid/SID, hash the home for path construction,
or append `opencodex`, `native-write-locks`, a version, or `.sqlite`. The prior
version reconstructed those segments locally; that was wrong because it let the
lock holder and transition-state callers open different databases despite the
contract's single resolver (`005_contract.md:861-877`).

### Component validation

Walk components one at a time; never recursive-mkdir across an unvalidated parent.

- Existing components are `lstat`ed and must be real directories, not symlinks,
  junctions, or reparse redirects. `ENOENT` permits one `mkdirSync(..., 0700)`,
  followed by the same validation.
- POSIX requires exact effective uid and mode `0700` for directories, `0600` for
  the DB/rollback journal. Wrong owner/mode refuses; the lock does not chmod a suspect
  existing path.
- Windows validates non-junction identity and runs the existing required per-user
  ACL owner within the remaining outer deadline
  (`src/lib/windows-secret-acl.ts:45,217-328,404-494,512`). A **verified** ACL,
  ownership, or path failure refuses. **Timeout does not**: exhausting the outer
  budget is `busy/deadline` and retryable, because a short caller-supplied deadline
  proves nothing about safety (F5). That requires preserving the `ETIMEDOUT`
  discriminator through sanitization at `src/lib/windows-secret-acl.ts:484`, which
  today rethrows an untyped `Error` and destroys it.
- The ACL success memo is bound to file identity, not pathname — **shipped**, and the
  shape it settled on is not the one this section originally prescribed. It separates
  two questions the first fix conflated:
  - `object` = `dev:ino` — is this the same file? Compared **before and after** the
    icacls sequence, because "what is at this path now" does not answer "what did
    icacls operate on".
  - `freshness` = `ctimeNs` — has this file's metadata moved since? Stored from the
    **post-harden** read and deliberately NOT compared across the ACL call: icacls
    changes permissions and a permission change moves ctime (probed,
    `{ctimeChangedByChmod: true}`), so comparing it there would have rejected every
    successful harden and failed closed on the first harden of every path on Windows.

  Ephemeral temps already invalidated through `forgetEphemeralSecretPath`
  (`src/config.ts:214,241,309,336,480,501-510`); the stable destination memo that
  `hardenStableLockFile` uses never did, and observed absence now retires it. All
  **four** public entry points are covered — file and directory, sync and async —
  because the suite was twice found to be proving the wrong half: removing the async
  attribution alone left every test green while async is the path
  `hardenStableLockFile` actually takes (`src/codex/native-main-lock-file.ts:148`),
  and a pathname-only memo applied to directories ALONE also left every test green
  while `hardenSecretDir` backs config, management-auth, tray, spill-store, and
  `native-profile-manager.ts:153`.
- Existing DB or `-journal` must be regular, same-user private entries. Existing
  `-wal`/`-shm` refuses. The lock **verifies** rollback journal mode rather than
  forcing it: a pinned-Bun probe shows `bun:sqlite` already opens `delete` and leaves
  no `-wal`/`-shm` sidecar after a committed `BEGIN IMMEDIATE` (F3).
- `openStableLockFile` retains the side descriptor; validate descriptor metadata,
  assert path identity before/after SQLite open, after `BEGIN IMMEDIATE`, before
  commit, and before close.
- SQLite uses `busy_timeout=0`, `locking_mode=NORMAL`, and verified
  `journal_mode=DELETE`. The OS transaction is holder authority.

The DB persists after release. There is no unlink, stale takeover, heartbeat, PID,
or mtime authority. Process death releases the OS lock; a live hung holder remains
the holder and contenders reach their deadline.

### Core new-module diff

```diff
+import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
+import { resolve, win32 } from "node:path";
+import { AsyncLocalStorage } from "node:async_hooks";
+import { Database } from "bun:sqlite";
+
+import { withConfigMutationLockSync } from "../config";
+import { updateIntegrationRecord } from "./integration-record";
+import {
+  resolveCodexCoordinatorDatabasePath,
+  resolveEffectiveUserIdentity,
+} from "./user-identity";
+
+function coordinatorDatabasePath(canonicalHome: string): string {
+  const identity = resolveEffectiveUserIdentity();
+  return resolveCodexCoordinatorDatabasePath(identity, canonicalHome);
+}
```

No `node:os` home accessor is imported.

## Acquisition, release, and reentrancy — C5

The total timeout is required, finite, integral, and within `0..30_000` ms.
Acquisition uses monotonic `performance.now()`. Zero receives one fail-fast
`BEGIN IMMEDIATE`. **Two** conditions retry: SQLite busy/locked, and exhaustion of
the outer budget during Windows ACL work, which is `busy/deadline` (F5). Verified
filesystem, ACL, malformed DB, identity, permission, and journal-mode failures are
refusals. The distinction is not cosmetic: a refusal tells the caller never to try
again, and a short deadline is not evidence of an unsafe namespace.

Retry sleeps are async uniformly bounded 25-75 ms, clipped to remaining deadline,
and abortable. Barging is allowed; no caller/test infers FIFO. Candidate SQLite and
side descriptors close after every failed attempt.

`AsyncLocalStorage<ReadonlySet<string>>` rejects same-task same-home reentrancy. It
is a **diagnosis** layer, not the exclusion mechanism: a second open on a held path
in the same process already fails `SQLITE_BUSY`, because `busy_timeout = 0` precedes
`BEGIN IMMEDIATE` (`src/codex/transition-state.ts:416`). Its only job is to turn that
indistinguishable `busy` into a typed `refused/reentrant` (F3), so its test asserts
the typed reason and not "does not hang" — the latter passes with ALS deleted.
A separate task is an ordinary contender. Caller exceptions propagate after
rollback/release; they are never converted to busy/refused.

**The ambient-home re-assert sits here, in the acquisition loop, not before it.**
Every attempt performs, in one uninterrupted synchronous stack:

```text
canonicalAmbient = realpathSync.native(getCodexHome())
require canonicalAmbient === canonicalTarget      // both sides canonicalized
openCodexCoordinatorTransaction(finalDatabasePath) // no await, no callback between
```

Re-comparing the value captured before the retry sleeps proves nothing, because
`getCodexHome()` re-reads the environment on every call (`src/codex/paths.ts:32-35`)
and the coordinator's own residue guard reads it again inside the open. Only a fresh
read that shares a synchronous stack with the open denies another task the chance to
interleave. "N bounds it" is false and was struck: N serializes the coordinator
database, not `process.env`, and it is not even held until the open begins.

Canonicalizing **both** sides is required, not tidiness. With no `CODEX_HOME` set,
`getCodexHome()` returns `defaultCodexHome()` **without** `realpath`
(`src/codex/paths.ts:23`), so on a machine where `~/.codex` is a symlink an
uncanonicalized ambient value refuses the very home it names.

**Adjacency is not sufficient, and calling it "the bounded version until the real fix
lands" was wrong.** It closes JavaScript task interleaving — nothing can run between
two synchronous calls in one isolate — and closes nothing else. Another **process**
needs no interleaving at all, because the two `realpath` calls are two separate
filesystem observations of a selector that a third party owns:

```text
CODEX_HOME=<base>/current, where current -> clean-A
check saw:  clean-A                  # the fresh adjacent read accepts A
<another process atomically retargets current -> routed-B>
guard saw:  routed-B                 # the coordinator's own read resolves B
SAME SYNCHRONOUS STACK, DIFFERENT DIRECTORY: true
```

That is executed output, not a hypothetical. The lock would hold coordinator A while
the safety guard cleared B.

So parameterizing `classifyNativeRoutedResidue()` with the canonical target is
**required for correctness in this phase**, not deferred hardening: the guard must
receive the resolved directory rather than resolve one for itself. The adjacent read
stays as defense-in-depth against the in-isolate case, and it is explicitly not the
mechanism. The acceptance criterion is mutation-named accordingly: restore ambient
resolution inside the guard and a real second-process symlink-retarget test must fail.

```diff
+const transaction = openCodexCoordinatorTransaction(finalDatabasePath);
+// transaction has already executed BEGIN IMMEDIATE: N is held here.
+const value = withConfigMutationLockSync(() => {
+  const current = options.readAdmissionUnderLock();
+  assertAdmissionStillCurrent(options.admitted, current);
+  const expectation = transaction.expectation();
+  const result = commit({
+    canonicalCodexHome,
+    lockId,
+    admission: current,
+    expectation,
+    coordinator: transaction.capability,
+  });
+  transaction.assertPublished(expectation);
+  return result;
+});
+transaction.assertStablePath();
+transaction.commit();
```

`openCodexCoordinatorTransaction` is a transition-state owner API, not a second
SQLite implementation in WP11. Its controller retains commit/rollback/close and
path-stability authority; only `transaction.capability` crosses into the callback.
`commit` must perform the conditional `beginTransition` after its native/provenance
writes. `assertPublished` rejects zero-row/conflict/unavailable or the wrong exact
pair before C is released. The callback performs no logging or response shaping.
Those occur after both locks release.

## Deadlock order and sibling history sequence

Legal order:

```text
native/coordinator transaction N (BEGIN IMMEDIATE)
  -> config transaction C
       -> authoritative AdmissionSnapshot re-read
       -> config generation read/update when config changes
       -> synchronous native commit
       -> provenance-only integration-record update
       -> conditional transition-row update through already-open N
  -> release C
  -> COMMIT N
-> release N

history lock (later, in Worker)
  -> fail-fast coordinator N claim check; if busy, release H and retry
  -> manifest + rollouts + DB + post-probe while holding H, not N
  -> fail-fast coordinator N terminal CAS; if busy, release H and retry
-> release history
```

The complete order is `N -> C` plus a short `H -> N`. There is no `C -> N`, no
`C -> H`, and no held `N -> H`. Native releases N before dispatching history. At
claim and terminal boundaries a Worker may hold H while attempting only a
fail-fast conditional operation on N; `SQLITE_BUSY` releases H and retries, so it
never waits while preserving the edge. Between those boundaries history traversal
holds H alone. A stale history job is generation/transaction-rejected before
mutation or loses the terminal CAS, so it cannot overwrite the winner's durable
schedule (`005_contract.md:780-811`).

Never call `withCodexWriteLock` from inside `withConfigMutationLockSync` or a
`mutatePersistedConfig` callback. Current inverse-edge search found config-owned
callbacks at `src/config.ts:1829,1870,2145`, the account wrapper at
`src/codex/account-store.ts:281`, and auth mutation at
`src/codex/auth-api.ts:670`; none currently imports the new lock. Add a dependency-
graph test that protects this direction. Source substring matching inside one file
is not enough.

## Shared helper deadline changes

`native-main-lock-file.ts` keeps ownership of stable descriptors. Add only an
optional stricter timeout for Windows hardening:

```diff
 export async function hardenStableLockFile(
   path: string,
   platform: NodeJS.Platform = process.platform,
+  timeoutMs?: number,
 ): Promise<void> {
   if (platform === "win32") {
     try { chmodSync(path, 0o600); } catch { /* ACL below is authoritative. */ }
-    await hardenSecretPathAsync(path, { required: true });
+    await hardenSecretPathAsync(path, { required: true, timeoutMs });
     return;
   }
   chmodSync(path, 0o600);
 }
```

Written against the CURRENT signature, which differs from this section's original
sketch in three ways that later rounds forced and that the timeout addition must
preserve:

- **`platform` is a parameter.** A direct `process.platform` read made the Windows
  branch unreachable from a test on any other host, which is how an audit deleted
  the whole delegation with 89 tests still green.
- **The `chmod` is no longer unconditional-and-swallowed.** On Windows it is
  best-effort because the required ACL decides; on POSIX the mode IS the mechanism,
  there is no fallback, and a failure must propagate. Swallowing it told the caller
  that a pre-existing permissive coordinator database had been hardened when nothing
  had changed — creation mode `0600` does not repair an existing file.
- **`timeoutMemoKey: path` was removed.** `timeoutMemoKey()` already falls back to
  `targetPath`, so it was redundant and unobservable; a test pinning it would have
  passed with the mechanism gone.

`windows-secret-acl.ts` clamps the caller value to the existing configured budget;
it may shorten but never enlarge it. Existing callers that omit `timeoutMs` retain
current behavior. Required ACL failure still rejects.

## Test plan

`tests/helpers/codex-write-lock-child.ts` imports and calls the production API. It
accepts explicit test paths/timing through its environment, prints one typed result,
and never opens SQLite directly.

### Real-process identity and exclusion

1. Child holds home A; parent deadline returns typed busy and its callback does not
   run; a timer advances while waiting; parent later acquires after release.
2. Abrupt holder exit releases without unlink/stale recovery; live holder is never
   stolen across repeated deadlines.
3. Default/explicit/absolute/tilde/symlink/case-equivalent spellings of one existing
   home produce one ID; distinct homes acquire independently.
4. Missing homes refuse before namespace creation.

### Effective-user namespace activation — carried #7/C18

Run real pinned-Bun child processes, not pure resolver mocks:

1. Child A: `HOME=<fake-a>`, `USERPROFILE=<fake-common>`; hold the production lock.
2. Child B: `HOME=<fake-b>`, `USERPROFILE=<fake-common>`; same OS user and
   `CODEX_HOME`; assert busy on the **same** DB path/lock id.
3. Repeat with `HOME=<fake-common>` and independently different
   `USERPROFILE=<fake-a|fake-b>`.
4. On Windows, vary `USERPROFILE` while retaining the real account SID. On POSIX,
   vary both variables independently while retaining the real uid.
5. Assert exactly one namespace under the uid/SID component. A test that sets HOME
   and USERPROFILE to the same fake value in both children is insufficient because
   it cannot catch the original split.

Use `process.execPath` and assert the pinned Bun version expected by CI before the
probe. Do not substitute Node or a same-process environment mutation.

### Admission/config-record ordering

- Non-authorizing pre-snapshot leaves the runtime namespace absent.
- Under-lock authoritative snapshot mismatch calls no commit and writes no record.
- A cooperating config transition while gather is outside the lock prevents stale
  commit.
- A successful commit shows exact `nativeAfter` and this `txId`; another tx at the
  same numeric generation is interference.
- Inject config-lock contention; assert bounded retry/typed busy and no stale
  commit.
- Prove config/native generation and integration-record update occur inside the
  synchronous section by blocking a contender at each seam.

### Boundary/hardening

- Compile-time async callback rejection plus runtime thenable rejection and release.
- Callback throw releases then propagates.
- Namespace symlink/junction, wrong owner/mode, DB/journal substitution, WAL/SHM,
  malformed DB, **verified** ACL failure, and unsupported filesystem all refuse
  without repair/deletion. ACL **timeout** is `busy/deadline`, not refusal (F5).
- **Release → replace → reacquire** (F4): harden a coordinator DB, release the
  acquisition, unlink and recreate a different file at the same pathname, then
  reacquire and assert the replacement was re-hardened. Substituting the file while
  a single acquisition is still held does NOT exercise the memo and passes with the
  fix removed — that shape is explicitly insufficient.
- Environment mutation **during** acquisition retry, not merely before it: a home
  changed while the contender sleeps must be caught by the fresh adjacent read.
- Windows CI executes real SID/junction/ACL success; POSIX executes real uid/mode.
- Dependency graph proves no inverse C->N or C->H acquisition and no held N->H;
  history's only H->N edges are the fail-fast claim and terminal operations.

## Verification

```bash
bun test tests/codex-write-lock.test.ts --test-name-pattern "real two-process exclusion"
bun test tests/codex-write-lock.test.ts --test-name-pattern "HOME and USERPROFILE independently"
bun test tests/codex-write-lock.test.ts tests/windows-secret-acl.test.ts tests/native-main-claim.test.ts tests/native-main-owner-lifetime.test.ts tests/config-mutation-lock.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

Run focused tests/typecheck on macOS, Linux, and Windows. No command starts, stops,
syncs, restores, or ensures the proxy; port 10100 is untouched.

## Deliberate residuals

- `realpath` does not collapse bind-mount/filesystem-namespace aliases. Unsupported
  network target classes are refused; arbitrary cross-namespace identity is not
  claimed.
- The caller chooses a finite automatic/explicit deadline within the API cap. WP11
  owns enforcement, not later policy values.
- Missing `CODEX_HOME` creation remains another operation/domain.
- Non-cooperating arbitrary filesystem ABA is outside the contract's proof bound.

## Accept criteria

Every criterion below names the **mutation that must turn it red**. A criterion with
no such mutation is not a criterion; this unit has shipped five live defects beside
8000 passing tests, so "the suite is green" carries no weight here. Each one was
checked against the question *would this still pass with the mechanism removed?* —
and the ones that did were rewritten rather than kept.

- **C5** — finite async acquisition yields typed acquired/busy/refused behavior;
  callback is synchronous/bounded; no stale takeover or FIFO claim exists.
  *Red when:* N acquisition is replaced by direct callback execution — the real
  two-process exclusion test must fail.
- **C6** — all real spellings of one existing home share one lock; distinct homes
  do not; missing homes refuse before artifacts.
  *Red when:* the canonicalization step is dropped — symlink and tilde spellings
  must stop contending.
- **C7/C18** — namespace keys on effective uid/SID beneath the OS runtime directory,
  never any home accessor. Real pinned-Bun children with independently varied HOME
  and USERPROFILE prove one lock for one user/home.
  *Red when:* the uid/SID component is replaced by any home accessor — the two
  children must stop sharing one lock.
- Config generation, authoritative admission re-read, native/provenance writes,
  and the conditional transition-row update share N->C; C releases before N commits.
  This is **four independent claims**, so it takes four mutations. One that only
  deletes the whole call edge still passes while any single seam escapes N->C.
  *Red when (each separately):* (a) the apply/restore → N call edge is removed;
  (b) the config-generation read/update moves outside N->C; (c) the
  provenance/integration-record update moves outside it; (d) the native writes move
  outside it. Each must fail its own test.
  Unmeetable without the WP12 caller, which is exactly why the phases are merged.
- **F1** — a routed CODEX_HOME returns a typed refusal carrying the coordinator's
  legacy-ambiguous reason rather than throwing, **and** the existing catalog commit
  still succeeds on that same routed home. Two claims, two mutations.
  *Red when:* (a) the catalog commit is moved under N — the routed-home catalog test
  must fail; (b) the typed refusal is replaced by a thrown exception — the refusal
  test must fail. (a) alone would let a throwing implementation pass.
- **F2** — the successful matched-home path reaches `BEGIN IMMEDIATE`; a home changed
  **during acquisition retry** is caught; and a home changed by **another process**
  retargeting the selector symlink is caught.
  *Red when:* (a) the fresh adjacent ambient read is replaced by the value captured
  before the retry sleeps — the environment-change-during-retry test must fail;
  (b) `classifyNativeRoutedResidue` is restored to resolving the home itself — the
  second-process symlink-retarget test must fail. (a) alone is satisfied by the
  adjacent-read-only implementation that the executed probe above defeats.
- **F3** — same-process reentrancy returns `refused/reentrant`, distinguishable from
  the `busy` SQLite alone produces.
  *Red when:* ALS is removed — the reason must degrade to `busy`. Asserting only
  "does not hang" is vacuous, because `busy_timeout = 0` already guarantees that.
- **F4** — a harden is credited only to the object it was performed on, through all
  **four** public entry points: file/sync, file/async, dir/sync, dir/async.
  *Red when (each separately, and each across all four parameterizations):* (a) `dev` is
  dropped from the object; (b) `freshness` is dropped from the memo value; (c) the
  before/after object comparison is removed; (d) observed absence keeps the memo;
  (e) an unreadable observation satisfies the memo; (f) a zero inode is accepted as
  an identity; (g) the FULL identity is compared across the ACL call — this one is
  the Windows-breaking form, since icacls moves ctime; (h) the async attribution
  alone is removed; (i) a pathname-only memo is applied to directories alone.
  (j) `hardenStableLockFile`'s Windows delegation is deleted; (k) its `required:
  true` is weakened to `false`; (l) its POSIX `chmodSync` is deleted; (m) that
  chmod failure is swallowed again; (n) the claim-site call to it is deleted; (o) the owner-site default is
  replaced by a no-op; (p) the claim-site platform threading is removed; (q) the
  owner-site platform threading is removed; (r) the claim site swallows a required
  hardening failure; (s) the owner site swallows it; (t) the claim reclassifies a
  denied ACL as busy; (u) the owner reclassifies it as contended; (v) the owner publishes a transient
  `held` before settling `unavailable`; (w) the owner schedules a retry from that
  permanent refusal, republishing `unavailable` each time; (x) the owner hardens a
  different existing file; (y) the claim hardens a different existing file; (z) the owner hardens correctly and
  then fails to acquire; (aa) the owner never publishes `held`; (ab) the claim
  hardens and then silently skips its protected operation; (ac) the claim races the harden against
  a 1ms timer, continuing while icacls is still in flight; (ad) a DIRECTORY-only
  failure policy diverges from the file policy — required soft-failing on an
  ordinary failure or a timeout, or optional throwing on either; (ae) a memo entry
  proven wrong is kept instead of retired; (af) directory memos alone are exempted
  from that retirement; (ag) an unreadable observation keeps its memo while a
  successful re-harden masks which mechanism deleted it; (ah) an OPTIONAL caller is
  allowed to trust a pathname-only memo; (ai) an optional caller trusts it when the
  identity is UNOBSERVABLE; (aj) observed absence retires the memo only for required
  callers; (ak) an optional caller compares the object but ignores freshness;
  (al) an optional caller accepts an unobservable identity. Reported precisely: the
  optional-only form reddens the four optional entry points; a broader form that
  also bypasses required callers reddens eight. Counting the wider one against the
  narrower description overstated the evidence, so both are named.
  (h) through (al) are not redundant — each survived every other check. (h) and (i)
  cover production callers the primitive tests missed: `hardenStableLockFile` takes
  the async path, and `hardenSecretDir` backs config, management-auth, tray,
  spill-store, and `native-profile-manager.ts:153`. (j) and (k) are a different
  layer entirely: deleting the whole ACL delegation left 86 tests green across three
  files, because every test proved the primitive and none proved production still
  called it. `hardenStableLockFile` takes its platform as a parameter for exactly
  that reason — a direct `process.platform` read made the Windows branch unreachable
  from a test.
  (l) and (m) are the POSIX side of the same wrapper, where the mode is the whole
  mechanism: deleting `chmodSync` left 89 tests green because the only POSIX test
  asserted that no ACL command ran, which was true of the working and the broken
  version alike. (n) is one layer further out again — nearly every claim test injects
  `hardenPath`, so the production default was never exercised, and the resolved
  platform is now threaded into it so a forced-Windows claim reaches the real
  delegation.
  (o) is the same hole on the owner side, found after the claim side was fixed:
  replacing that default with a no-op left 91 tests green. (p) and (q) are the half
  that threading alone does not prove — a test omitting `platform` cannot tell a
  threaded platform from a wrapper re-reading `process.platform`, because on the
  host they agree. Both are covered by forcing `platform: "win32"` from the outer
  API with no `hardenPath` and requiring the real ACL runner to execute, which can
  only happen if the default is called AND the platform reached it.
  (r) and (s) are the third distinct claim about the same two call sites: proving
  the hardener RUNS is not proving its FAILURE matters. Appending `.catch(() => {})`
  at either site left 93 tests green, because the forced-Windows tests observe a
  successful invocation and the wrapper's own failure test cannot see a caller
  swallowing the rejection. That is the whole point of `required: true` — on Windows
  the ACL is the only thing keeping other accounts out of a coordinator database, so
  one whose ACL could not be applied must not go on to be used. A claim must never
  run its operation and an owner must never report `held`.
  (t) and (u) are the fourth claim about those same sites, and the one that
  "it rejected" cannot see: a denied ACL must be a **non-retryable refusal**.
  Broadening `isBusy()` to match the ACL message left 95 tests green, because the
  claim test accepted any rejection — including `NATIVE_MAIN_CLAIM_BUSY` — and the
  owner test accepted any state except `held`, including `contended`, which
  schedules a retry (`src/codex/native-main-owner.ts:194`). A permanent denial that
  enters the retry scheduler is an endless reacquire loop wearing the costume of
  contention. The claim must reject with `NATIVE_MAIN_CLAIM_UNAVAILABLE`; the owner
  must settle at `{ status: "unavailable", reason: "lock-unavailable" }` and stay
  there.

  ### The class, not the twenty-second instance

  Rounds 10-18 each produced exactly one finding in this surface, and (v) is what
  named the pattern: these were never independent accidents. Each test proved ONE
  projection of a conjunctive contract — some hardener ran, the platform arrived,
  the operation stopped, the classification was right — and a later mutation kept
  the asserted projection while breaking an unobserved one.

  **A terminal snapshot cannot prove that something never happened.** (v) publishes
  `held` and then immediately `unavailable`: both reads see `unavailable`, while
  every subscriber saw a caller briefly believe it owned an unhardened database.
  The test now subscribes first and asserts the ordered trace
  `acquiring -> unavailable` with `held` and `contended` forbidden at any point.

  So the rule for every production call edge in this unit, and the reason the list
  above is a matrix rather than a list: assert the exact target, the default
  binding, the platform provenance, the success ordering, the failure propagation,
  the exact refusal taxonomy, the complete observable state trace, and the absence
  of retries or protected-operation execution. For an asynchronous state machine,
  assert an ordered trace and forbidden events — never only the eventual state.

  **Corollary, learned by breaking the rule in the act of writing it.** The first
  trace assertion collapsed consecutive duplicates before comparing. A retry loop
  republishing `unavailable` normalizes to exactly the same two entries, so the test
  claimed a complete trace and an absence of retries while discarding the evidence
  of both — mutation (w). Never normalize, deduplicate, sort, or otherwise project
  an event trace unless that normalization is itself part of the production
  contract. And where a count is the claim, count it: the ACL attempt counter is
  what makes "attempted exactly once" executable rather than asserted.

  **Where a trace does not exist, say so rather than inventing one.**
  `withNativeMainSharedClaim` publishes no intermediate ownership state, so its
  observable failure contract is the exact `NATIVE_MAIN_CLAIM_UNAVAILABLE`
  rejection, the protected operation never running, and the hardener targeting the
  right database. Adding a subscribe API solely so a test could assert a trace would
  be machinery that strengthens no public contract.

  **And the matrix has to be assertions, not prose.** (x) and (y) are the proof:
  the rule above already said "assert the exact target", and both callers were then
  redirected at an unrelated existing file with every test still green — because
  each one asserted only that *some* `/grant:r` happened. Writing a matrix into a
  plan does not execute it. Every dimension named here is now a concrete assertion
  at both call edges: `expect(seen.every(args => args[0] === expected)).toBe(true)`
  against `nativeMainClaimPath(context)` and `join(codexHome, NATIVE_MAIN_OWNER_DB)`,
  in the success and the failure test alike.

  **And the matrix applies per entry point, not per property.** (ad) is the class
  arriving one level up: the memo-attribution matrix was parameterized over all four
  public entry points, so it looked exhaustive — but the failure-POLICY tests were
  written only against the file APIs. Four directory-only mutations survived the
  whole suite. Parameterizing one property over four entry points does not
  parameterize the others; each property needs the parameterization, not each entry
  point.

  **(ae) is a cache state nothing justified.** A lookup that missed left the stale
  entry in place, so after a mismatch and a *failed* re-harden the old value
  survived and restoring the old identity satisfied it again with no ACL work.
  Biting that needs exact-identity ABA, which §Deliberate residuals puts outside the
  proof bound — but scope is not a reason to keep an entry we have just proven does
  not describe what is at the path. A miss now retires it. The test has to fail the
  re-harden to see this at all: a successful one overwrites the memo and hides
  whether the miss retired anything, which is what the first version of that test
  did.

  **The row that stayed empty longest was the successful one.** Every test here
  proved a failure path or an invocation; none required the operation to actually
  succeed. So (z), (aa) and (ab): an owner that hardens correctly and then fails to
  acquire, an owner that never publishes `held` at all, and a claim that hardens and
  then silently skips its protected operation, all passed. The success tests now
  require the claim's operation to run, to return its value, and to run **after**
  the ACL — and the owner to reach `held`, with a deferred ACL runner proving the
  trace is exactly `["acquiring"]` while hardening is still in flight and exactly
  `["acquiring", "held"]` once it completes.

  **"After" has to mean after it FINISHED.** (ac) is the same row failing a second
  time in a subtler form: recording `acl` when `/grant:r` is invoked and then
  `operation` proves only that hardening *began* first. Wrapping the harden in
  `Promise.race([harden, Bun.sleep(1)])` — an early continuation that on real
  Windows lets an `icacls` sequence longer than a millisecond stay in flight while
  the claim proceeds — passed that ordering assertion. Both edges now use the
  deferred-runner shape: hold the ACL unresolved, require the protected work has
  NOT started, release it, then require the result. An event marker taken at the
  START of an operation cannot order anything against its COMPLETION.

  **The rule applies to every property, including the ones added last.** (af) and
  (ag) are the memo-retirement branch failing its own four-entry-point rule the
  moment it shipped: exempting directories alone from the retirement passed all 113
  tests, because the retirement test drove `hardenSecretPath` only. And (ag) is the
  attribution trap in miniature — the unreadable test let the ACL succeed, so
  `recordHarden` deleted the entry for its own reasons and a terminal count of zero
  could not say which mechanism retired it. The ACL now fails BEFORE `recordHarden`
  runs, and the re-satisfaction check is what proves the lookup did it.

  **Requiredness is an axis, not a policy footnote.** (ah): every identity and
  retirement scenario called with `required: true`, and the optional-policy tests
  use fresh paths with no memo, so neither could see an optional-only bypass.
  Adding `if (!opts.required && cache.has(targetPath)) return { ok: true }` left
  all 119 tests green, letting an optional caller accept any object at a
  previously hardened pathname without observing identity, retiring the memo, or
  running icacls. Optional means a failure is REPORTED rather than thrown; it does
  not mean unattributed.

  And closing the broad shortcut was not the same as closing the axis — writing
  "every memo property is now parameterized over requiredness" while only the
  observable-mismatch property was, is the projection mistake at the level of a
  claim about coverage. (ai) and (aj) are the other two memo properties with the
  same bypass: an optional caller trusting a memo whose identity cannot be
  observed, and observed absence retiring the memo for required callers only.
  Both left every test green. The suite is now the full cross-product — four entry
  points x {required, optional} x how the memo can be wrong — with a shared
  `expectRefused` that throws for required and asserts `{ok:false, diagnostics}`
  for optional, so the same attribution is proven either way.

  That last axis turned out to be two axes, which is (ak) and (al). "Stale
  identity" hid WHICH component moved: a memo comparing `dev:ino` while ignoring
  freshness passed a matrix whose stale case moved `ino` and `ctimeNs` together.
  "Unobservable identity" hid WHY: a thrown stat and a zero inode both produce
  `observe() === null`, and only the thrown case was driven — leaving the zero-inode
  form, the one NTFS is reported to produce, untested on the platform this module
  exists for. The matrix now enumerates `{dev-only, ino-only, freshness-only}` and
  `{stat throws, zero inode}` explicitly. Note that a bypass placed AFTER the absence handling is dead code and
  reddens nothing; the reachable form has to precede it, which is worth knowing
  before concluding that a mutation "survives".

  The matrix, enumerated, is: exact target · default binding · platform provenance ·
  **successful completion** · **ordering relative to the ACL** · failure propagation ·
  refusal taxonomy · raw observable trace · attempt count · protected operation
  absent on failure. Any row unasserted at either edge is a hole, and each of these
  rows was found by someone deleting the production code behind it.

  **Activation gate, not a test:** the NTFS `bigint` inode behaviour is UNVERIFIED.
  `observe()` treats a zero inode as unobservable, so if Bun returns zero there,
  every REQUIRED Windows harden fails closed and this whole surface is inert in the
  one place it exists for. A pinned-Bun probe on real Windows/NTFS must confirm a
  nonzero, stable file index before F4 is called complete (goalplan `wp12t0c2`).
  A file index alone is not enough, because three other production assumptions ride
  on that platform and none of them is observable from here: `dev:ino` must survive
  a real `icacls` edit (the before/after comparison assumes it), post-ACL `ctimeNs`
  must be readable and stable for an immediate memo hit (the memo stores it), and an
  ordinary unlink/recreate must move at least one memo component. Exact-identity ABA
  during hardening stays the documented residual.
  This is recorded here as well as in the goalplan so this document cannot be read
  as complete on its own.

  The `timeoutMemoKey: path` argument was REMOVED from that call site rather than
  asserted. `timeoutMemoKey()` already falls back to `targetPath` and the caller was
  passing the target path, so it was unobservable and a test pinning it would have
  been vacuous. The option remains for atomic writers that mint a fresh temp per
  write and need the stable destination as the key (#612); this caller has no temp.
  Replacement is driven through the stat seam rather than a real unlink/recreate:
  ext4 recycles an inode immediately and APFS did not once in 200 cycles, so a
  real-file version asserts different things on different machines — which is how a
  fix broken on Linux passed here on macOS.
- **F5** — outer-budget exhaustion during ACL work returns retryable
  `busy/deadline`; verified ACL/ownership/path failure returns non-retryable refusal.
  *Red when:* `ETIMEDOUT` is collapsed into a generic refusal — the deadline
  classification test must fail.
- `transition-state.ts` alone owns native generation/txId/history scheduling; JSON
  owns none of them, and the lock never opens a second coordinator connection in C.
  *Red when:* (a) a second coordinator connection is opened inside C — it must
  self-contend and fail, not silently succeed; (b) `nativeGeneration` or `currentTxId`
  is written into `integrations/codex.json` — the JSON-ownership test must fail.
- Lock edges are N->C and short fail-fast H->N only; stale history jobs are rejected
  by generation/transaction identity without any C->N, C->H, or held N->H edge.
  *Red when:* (a) each inverse edge is added in turn (C->N, C->H, held N->H) — the
  dependency-graph test must fail for each; (b) the generation/txId stale-job
  rejection is removed — a stale job must be observed overwriting the winner.
- **Phase honesty** — the goalplan records the merge: `wp11` closed as *merged*, and
  `wp12` carrying the mechanism, the admission producer, the `inject.ts` split, and
  the first call edge as required tasks. If the caller does not land, the PR body
  says the lock is unused, in those words.
  *Red when:* (a) the WP12 admission producer is removed — the production-entry test
  or the compile must fail; (b) the goalplan merge state is reverted so a standalone
  WP11 could be declared done; (c) the PR body claims a live substrate while the
  caller is absent. (b) and (c) are checked by reading them, not by a test — and
  saying so is the point, because a criterion that pretends to be automated when it
  is not is worse than one that admits it.
