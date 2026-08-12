# 010 — continuation hard cap with durable per-entry spill

Date: 2026-08-01  
Work phase: wp2  
Depends on: none  
Binding inputs: `000_state_store_inventory.md` §1, `005_impl_roadmap.md` locked decision 1, `006_roadmap_audit_synthesis.md` R1-3/R2-1.

## Outcome

Make the Responses continuation store authoritative but unconditionally bounded in RAM.
An entry that would leave resident bytes above 64 MiB is synchronously written to a
dedicated id-keyed, generation-distinct spill file, file-fsynced, atomically published
(no-replace link/exclusive-copy),
and only then replaced by a small RAM stub. This is process-crash durability, not a
power-loss guarantee: this phase does not claim parent-directory fsync portability.
Any write failure removes the resident entry and records a bounded tombstone. A stub
whose file is missing or corrupt produces the same terminal structured
continuation-not-found response telling the caller to resend the full context; it never
forwards a naked delta and does not claim an automatic client retry.

The legacy debounced `responses-state.json` path remains the persistence path for small
resident entries. Its 2 MiB per-entry and 24 MiB snapshot selection rules are not reused
as the spill mechanism and are not relaxed.

No new 010 configuration surface is added. Keep the owner-local RAM ceiling fixed at
64 MiB and retain only the existing test override; 040 owns the configurable process-wide
retained-state budget. A separate continuation knob would create two user settings with
overlapping demotion authority and could raise the local store above the global budget.

## Current contract and verified anchors

- `src/responses/state.ts:6-20` owns count, TTL, 64 MiB nominal RAM cap, legacy snapshot
  limits, and stale snapshot-temp cleanup.
- `src/responses/state.ts:22-78` has one resident shape, one `states` map, one byte
  counter, and centralized `setEntry()` / `deleteEntry()` accounting.
- `src/responses/state.ts:202-250` lazily loads v1/v2 monolithic snapshots and treats
  corrupt snapshots as an empty cache.
- `src/responses/state.ts:252-299` performs debounced best-effort snapshot writes. It
  skips a serialized pair above 2 MiB and stops newest-first selection at 24 MiB.
- `src/responses/state.ts:319-334` prunes TTL/count and then bytes only while
  `states.size > 1`. This is the last-entry exemption to delete.
- `src/responses/state.ts:336-350` returns the original request on every miss; the
  caller cannot distinguish ordinary absence from a known broken spill.
- `src/responses/state.ts:363-369` reads provider metadata and does lazy-load/prune;
  `:371-408` exposes observe-only metrics without loading, pruning, or serializing.
- `src/responses/state.ts:415-455` synchronously stores expanded input plus output and
  immediately prunes/schedules persistence.
- `src/server/responses/core.ts:1092-1115` expands before parsing and detects expansion
  only by object identity.
- `src/server/responses/core.ts:1228-1239,1338-1343` already returns structured 400s for
  canonical-forward and Kiro misses, while `:1445-1449` still warns and forwards a
  passthrough naked delta.
- `tests/responses-state.test.ts:535-555` asserts the obsolete “newest survives even
  when over cap” policy.
- `tests/responses-state.test.ts:660-883` covers restart, stale/corrupt snapshots, and
  the obsolete “oversized stays in RAM but is skipped on disk” contract at `:856-883`.

Inventory blast-radius constraint: “evicting/rejecting the newest row makes the next
chained turn a naked delta.” This phase therefore spills or emits an explicit miss; it
does not truncate replay history.

### A-gate corrections (Banach) — consumer contract ledger

The implementation and regression pass must account for every current consumer of the
changed state contract:

- `src/responses/parser.ts:269` consumes replay-prefix provenance; spill materialization
  must set the provenance WeakMap on the exact expanded body just like a resident hit.
- `src/server/lifecycle.ts:89` awaits `flushResponseState()` during shutdown; a concurrent
  legacy snapshot flush must serialize the already-committed stub/tombstone representation
  and must never inline, lose, or race a spill payload.
- `src/server/management/system-routes.ts:88` publishes `responseStateMetrics()`;
  `gui/src/components/MemoryObservabilityCard.tsx:27` owns its GUI type and
  `tests/memory-watchdog.test.ts:181` owns the scalar/privacy contract. All added fields
  remain finite numbers and expose no response ids, paths, digests, or payload content.
- `tests/issue-702-expired-replay-state.test.ts:250-283` remains the fail-closed reference:
  known broken local state must stop before upstream I/O, while an ordinary miss on an
  upstream-capable API-key Responses provider retains its current native-continuation path.

## File changes

### NEW `src/responses/spill-store.ts`

Own all spill filesystem I/O. Do not put spill code in the generic config writer: the
legacy writer is best-effort and does not fsync.

```ts
export const RESPONSE_SPILL_VERSION = 1;
export const RESPONSE_SPILL_DIR_NAME = "responses-state-spill";
export const RESPONSE_SPILL_ORPHAN_GRACE_MS = 15 * 60_000;
export const RESPONSE_SPILL_SCAN_MAX = 4_096;
export const RESPONSE_SPILL_CLEANUP_MAX = 512;

export interface ResponseSpillPayload {
  version: 1;
  responseId: string;
  createdAt: number;
  items: unknown[];
  providers?: OcxProviderContinuationState;
}

export interface ResponseSpillRef {
  version: 1;
  fileName: string;     // id slug + id digest + payload digest prefix + generation + size
  digest: string;       // lowercase SHA-256 of the exact UTF-8 file bytes
  payloadBytes: number;
}

export type ResponseSpillReadResult =
  | { ok: true; payload: ResponseSpillPayload }
  | { ok: false; reason: "missing" | "corrupt" };

export interface ResponseSpillCleanupResult {
  scanned: number;
  removed: number;
  failed: number;
  bytesRemoved: number;
}

export function writeResponseSpillDurably(
  responseId: string,
  state: Omit<ResponseSpillPayload, "version" | "responseId">,
): ResponseSpillRef;
export function readResponseSpill(
  responseId: string,
  ref: ResponseSpillRef,
): ResponseSpillReadResult;
export function deleteResponseSpill(ref: ResponseSpillRef): void;
export function recoverOrphanedResponseSpills(
  referencedFileNames: ReadonlySet<string>,
  dir?: string,
): ResponseSpillCleanupResult;
```

#### A-gate corrections (Banach) — spill identity and process-crash durability

`writeResponseSpillDurably()` transaction, in this exact order:

1. Serialize `{version:1,responseId,createdAt,items,providers}` once and compute UTF-8
   bytes and SHA-256 from those exact bytes.
2. Allocate a generation-unique basename
   `<sanitized-id>.<id-digest-12>.<content-digest-24>.<generation>.<payloadBytes>.spill.json`.
   Normalize the id to NFC, replace every character outside `[A-Za-z0-9._-]` with
   `_`, collapse repeated `_`, trim the visible portion to 80 characters, and use
   `response` if it becomes empty. `id-digest-12` is the first 12 lowercase hex
   characters of SHA-256(responseId); `content-digest-24` is the first 24 lowercase
   hex characters of the payload SHA-256 from step 1 (the prefix MUST be at least
   16 hex characters). Without a
   content component, re-spilling the same id with different content but equal
   byte length would rename ONTO the live old file and destroy it before the stub
   swap — a crash in that window leaves a persisted stub pointing at bytes with
   the wrong digest. `generation` is a process-local monotonic counter; advance it
   until the destination basename is absent. Old and new generations therefore
   coexist on disk until the swap completes. Require the full owned-file regex
   before joining it to the spill directory.
3. Resolve `<config>/responses-state-spill/<basename>`; create/harden the directory
   to user-only permissions.
4. Open a same-directory unique temp with `wx` and mode `0600`.
5. Write all bytes, call `fsyncSync(fd)`, close the descriptor, and harden the temp.
6. Link the temp to the newly allocated destination with an atomic NO-REPLACE
   primitive (round-5 blocker 2: plain `renameSync` replaces an existing
   destination on POSIX): use `fs.linkSync(temp, dest)` — which fails with
   `EEXIST` when the destination exists — then `unlinkSync(temp)`; on Windows,
   where `link` support varies by filesystem, fall back to `copyFileSync(temp,
   dest, COPYFILE_EXCL)` + fsync of the copy. An `EEXIST` loss means another
   writer allocated the same generation basename: advance the generation
   counter and retry allocation (bounded retries), then treat persistent
   failure as a sanitized write failure. The normal path never replaces an
   existing destination: same-id/same-size and even same-content replacements
   receive a distinct generation basename.
   A different generation for the same id never shares a destination: the old generation's
   file stays untouched through the publication and is unlinked only AFTER the new
   publication and in-memory stub swap have both succeeded. A crash between publication
   and swap leaves both
   files; the stub still references the old valid generation and startup GC removes the
   newer unreferenced file as an orphan.
7. Return the ref only after publication succeeds. On every failure, close/unlink the temp
   best-effort and rethrow a sanitized error containing no response id or path.

The id+content+generation-keyed layout keeps lifecycle/TTL/tombstone ownership by response
id while the content-digest and generation components provide replacement uniqueness.
A sanitized visible component makes orphan diagnosis practical, the size component permits
bounded startup accounting without opening every file, and the short id digest prevents collisions after
sanitization/truncation. The full content digest remains in the stub and is verified on
read; neither visible id nor filename size is trusted as integrity proof.

Windows `renameSync(temp, existingDestination)` is not a portable atomic-replace
primitive. Generation-distinct destination basenames make that caveat moot: 010 never
intentionally publishes over the old file. The state owner preserves the old row and
spill file while writing the candidate, swaps to the new stub only after the new
publication succeeds, and only then unlinks the old file. File fsync before publication
plus same-directory atomic no-replace publication (link / exclusive copy) is the
process-crash durability boundary claimed here. Parent-directory fsync is
not required by 010, so sudden-power-loss namespace durability remains outside the claim.

This phase deliberately uses a synchronous transaction. `rememberResponseState()` is
called from synchronous bridge completion callbacks (`src/bridge.ts:143,811-817` and
`src/server/relay.ts:498,680-718`); an un-awaited asynchronous spill would permit an
unbounded pending-write closure chain and a post-response stub race. The synchronous
path is the bounded in-flight window: at most one transaction exists on the JS thread,
with no queue. Spills are exceptional, not the small-entry hot path.

`readResponseSpill(responseId, ref)` receives the trusted expected id from the in-memory
map lookup. It must reject symlinks/non-regular files, require the basename to
match the owned regex, require stat size to match both the filename size and
`ref.payloadBytes`, enforce ref/content digest equality, validate the exact schema and
require `payload.responseId === responseId`, and return `corrupt` on any parse,
shape, or digest failure. Never return partial items.

### MODIFY `src/responses/state.ts`

### A-gate corrections (Banach) — failure-safe measurement and replacement

Replace the current `JSON.stringify(entry.items).length` / weightless-on-error behavior at
`src/responses/state.ts:52-60`. The one resident measurement serializes the complete retained
payload `{responseId,createdAt,items,providers}` once and measures its UTF-8 bytes with
`TextEncoder` or `Buffer.byteLength`; provider metadata and the map key are therefore part of
admission accounting. Cached `sizeBytes` is this measured payload weight. A serialization
failure rejects the candidate from resident storage and atomically replaces the old row, if
any, with a bounded `spill-failed` tombstone before unlinking an old spill file; it must never
retain a zero-weight or partially measured row.

`setResidentEntry()` must not preserve the current delete-first behavior at
`src/responses/state.ts:64-68`. Measure the complete candidate before mutating `states`. For
an ordinary insert or resident-row replacement, commit the measured resident row and then
run the normal synchronous prune/demotion loop. Replacement of an existing spill stub uses
the separate literal-B2 transaction below and never installs an intermediary resident row.

Replace the monomorphic row with this union:

```ts
interface ResidentResponseState {
  kind: "resident";
  createdAt: number;
  items: unknown[];
  providers?: OcxProviderContinuationState;
  sizeBytes: number;
}
interface SpilledResponseState {
  kind: "spill";
  createdAt: number;
  providers?: OcxProviderContinuationState;
  spill: ResponseSpillRef;
  sizeBytes: number; // cached serialized stub bytes, not payloadBytes
}
interface SpillFailedResponseState {
  kind: "spill-failed";
  createdAt: number;
  sizeBytes: number;
}
type StoredResponseState = ResidentResponseState | SpilledResponseState | SpillFailedResponseState;

export type PreviousResponseReplayFailure = {
  code: "previous_response_not_found";
  reason: "spill_missing" | "spill_corrupt" | "spill_failed";
};
```

Add a private `WeakMap<object, PreviousResponseReplayFailure>` beside
`replayedInputPrefixLengths` and an observe-only accessor:

```ts
export function previousResponseReplayFailure(body: unknown): PreviousResponseReplayFailure | undefined;
```

Centralize transitions; no caller mutates `states`, counters, or spill files directly:

```ts
function measureResidentEntry(id: string, entry: ResidentInput): ResidentResponseState | null;
function setResidentEntry(id: string, entry: ResidentInput): void;
function replaceSpillEntryAtomically(
  id: string,
  expected: SpilledResponseState,
  candidate: ResidentResponseState,
): void;
function swapResidentForSpill(id: string, expected: ResidentResponseState, ref: ResponseSpillRef): void;
function replaceWithSpillFailure(id: string, expected?: StoredResponseState): void;
function deleteEntry(id: string, options?: { deleteSpill?: boolean }): void;
function materializeEntry(id: string, entry: StoredResponseState):
  | { ok: true; state: ResidentResponseState }
  | { ok: false; failure: PreviousResponseReplayFailure };
```

**Literal-B2 atomic replacement:** replacing an existing spill stub follows one transaction
and never routes through `setResidentEntry()` or an intermediary resident row:

1. Read `expected = states.get(id)` and measure the complete candidate while `expected`
   remains installed and replay-addressable.
2. Serialize the candidate and synchronously write, file-fsync, and publish the
   distinct-generation spill file. Until publication succeeds, every lookup still sees and
   can replay `expected`; the old file remains untouched.
3. Build the new stub from the candidate's `createdAt`, provider metadata, measured stub
   bytes, and returned `ResponseSpillRef`. Verify `states.get(id) === expected`, then perform
   one accounting/map transition from the old stub directly to the new stub.
4. Only after the new stub is installed, queue `expected.spill` on the bounded
   `pendingSpillUnlinks` deferral (NOT an immediate unlink — see the deferred-deletion
   contract below): the old generation must survive until the debounced snapshot that
   references the new stub is durable, because a crash before that flush reloads the OLD
   stub, which must still find its file. A crash before the swap leaves the old row/file
   authoritative and the new file orphan-recoverable; a crash after the swap but before
   the snapshot flush replays through the old snapshot stub against the still-present old
   file; a crash after the flush leaves the new row authoritative and the queued old file
   orphan-recoverable.
5. Serialization or publication failure atomically replaces `expected` with the bounded
   tombstone, then unlinks the old file; it never exposes a resident candidate or naked delta.

`deleteEntry()` subtracts the row's RAM `sizeBytes`; for a spill stub it also unlinks the
dedicated file unless `deleteSpill:false` is used during a verified atomic swap. TTL/count
eviction therefore removes spill files. No secondary OWNERSHIP state exists — but one
bounded piece of deferred-DELETION bookkeeping does (review C1-1/C2-1): a superseded
generation cannot be unlinked at swap time, because the new stub only becomes durable
when the debounced snapshot flushes; a crash before the flush reloads the OLD stub,
which must still find its file. The swap therefore queues the old ref in
`pendingSpillUnlinks` (hard cap 128 entries — small refs, not payloads; overflow
unlinks oldest-first immediately, accepting the narrow crash-window regression only
under pathological replacement churn), and `persistNow()` drains the queue strictly
AFTER the snapshot write succeeds. The queue holds no payload bytes, never counts
toward `storedResponseBytes`, and is not ownership: files it references are already
unreferenced by the post-flush snapshot and would be reclaimed by orphan GC anyway —
the queue only accelerates that reclamation.

Replace the byte loop with:

```ts
while (storedResponseBytes > byteCap() && states.size > 0) {
  const oldestId = states.keys().next().value as string | undefined;
  if (!oldestId) break;
  const entry = states.get(oldestId)!;
  if (entry.kind !== "resident") { deleteEntry(oldestId); continue; }
  try {
    const ref = writeResponseSpillDurably(oldestId, {
      createdAt: entry.createdAt,
      items: entry.items,
      ...(entry.providers ? { providers: entry.providers } : {}),
    });
    swapResidentForSpill(oldestId, entry, ref); // only after durable success
  } catch {
    replaceWithSpillFailure(oldestId, entry);   // R2-1: no hot oversized row
    spillCounters.writeFailures++;
  }
}
```

After each swap/tombstone, re-check the condition. A stub/tombstone that alone exceeds
the test override is deleted, so the invariant remains `storedResponseBytes <= byteCap()`.
Delete the `states.size > 1` exemption and update the old test-only cap comment.

`expandPreviousResponseInput()` behavior:

- resident: current expansion, unchanged;
- spill: call `readResponseSpill(previousId, entry.spill)`, fully validate, expand from
  payload, and set replay provenance on the exact expanded body;
- missing/corrupt spill: leave body unchanged, set the failure WeakMap, increment the
  matching counter, delete the stub and bad/missing file best-effort, then insert a
  `spill-failed` tombstone for deterministic later calls;
- spill-failed: leave body unchanged and set `{code, reason:"spill_failed"}`;
- ordinary absent/TTL-expired id: preserve the current generic miss behavior.

`previousResponseProviderState()` reads the provider copy on a spill stub without loading
the payload. Tombstones return undefined.

Extend metrics without filesystem reads:

```ts
export interface ResponseStateMetrics {
  count: number;
  residentCount: number;
  spillStubCount: number;
  tombstoneCount: number;
  totalBytes: number;
  spillPayloadBytes: number;
  largestBytes: number;
  oldestAgeMs: number;
  spillWrites: number;
  spillWriteFailures: number;
  spillReadFailures: number;
}
```

`spillPayloadBytes` is the sum of refs, not file stat calls. `responseStateMetrics()`
remains observe-only. Update `src/server/management/system-routes.ts:88`, the GUI
`ResponseState` type, and `tests/memory-watchdog.test.ts:181` so every new field is
finite, scalar-only, and privacy-safe without making the metrics probe load/prune/read files.

Snapshot compatibility:

- Keep `version:2` and the exact current serialization/selection for resident rows.
- Persist spill stubs and tombstones because both are small; never inline spill payload.
- Continue accepting v1/v2 resident rows and recomputing resident bytes locally.
- On first load, collect referenced basenames, run orphan cleanup, then prune. Startup
  cleanup removes unreferenced valid spill/temp names only after the 15-minute grace;
  it never follows symlinks and obeys scan/cleanup caps.
- `clearResponseStateMemoryForTests()` clears memory only. `clearResponseStateForTests()`
  also removes this test home's spill directory after deleting known refs.

### MODIFY `src/server/responses/core.ts`

### A-gate corrections (Banach) — caller-driven recovery contract

Immediately after `body = expandPreviousResponseInput(body)` and before parsing, inspect
`previousResponseReplayFailure(body)`. Return one canonical response for all three known
failure reasons:

```ts
formatErrorResponse(
  400,
  "previous_response_not_found",
  "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
)
```

Add a `classifyError()` branch in `src/lib/errors.ts` mapping that explicit type to
`{type:"invalid_request_error", code:"previous_response_not_found"}`. Do not expose
the spill reason, response id, digest, path, or OS error. Remove the `:1445-1449`
warn-and-forward path for known spill failures; ordinary upstream-capable misses retain
their existing routing behavior. The guaranteed recovery contract is this terminal 400
telling the caller to resend full context without `previous_response_id`; no automatic
Codex/client retry is claimed.

Endpoint acceptance coverage exercises the route classes around
`src/server/responses/core.ts:1228-1239,1338-1343,1445-1449`: for a known spill failure,
each affected path returns status 400 with
`error.type === "invalid_request_error"`,
`error.code === "previous_response_not_found"`, and the canonical resend message before
any auth/upstream I/O. Existing ordinary-miss behavior remains separately asserted,
including the API-key provider case in `tests/issue-702-expired-replay-state.test.ts`.

## Regression tests

### A-gate corrections (Banach) — contract redefinitions and added classes

Extend `tests/responses-state.test.ts` with these exact tests/fixtures:

- `spills the only oversized continuation and leaves resident bytes at or below cap`
- `does not swap a resident row to a stub before fsync and no-replace publication succeed`
- `replays provider metadata and function_call_output history through a spill stub`
- `replays a durable spill after simulated process restart`
- `returns previous_response_not_found for a missing spill file without forwarding delta`
- `returns previous_response_not_found for a corrupt or digest-mismatched spill`
- `spill write failure evicts resident bytes and records one bounded tombstone`
- `disk permission failure increments spillWriteFailures without retaining payload`
- `replacing a response id deletes its previous dedicated spill file`
- `TTL and count eviction delete dedicated spill files and release stub bytes`
- `startup orphan cleanup removes only old unreferenced regular spill files`
- `startup orphan cleanup preserves referenced young live and unrelated files`
- `concurrent flush and synchronous demotion cannot inline or lose the spill stub`
- `small entries retain the legacy v2 debounced snapshot representation`
- `same-id spill replacement keeps the old row replay-addressable until atomic stub swap`
  (the injected publication hook replays the id before swap and gets the old payload;
  after swap it gets the new payload; the old file exists through swap and is unlinked after)
- `crash between new-generation publication and stub swap preserves the old row and reclaims the new orphan`
- `same response id and equal-size replacement use distinct basenames and unlink old only after stub swap`
- `spill-failed tombstone survives simulated process restart and returns the canonical failure`
- `spill replay preserves replay-prefix provenance and compaction-marker acknowledgement`
- `multibyte resident payload accounting uses complete UTF-8 bytes including provider metadata`
- `serialization failure rejects the candidate and records a bounded tombstone`
- `write fsync or publication failure cleans its temp and preserves no unmeasured resident payload`
- `EEXIST publication loss advances the generation and retries within the bound`
- `orphan cleanup obeys scan and cleanup caps rejects symlinks and counts failed unlink`
- `response-state management metrics keep every added field finite scalar and privacy-safe`
- redefine `tests/responses-state.test.ts:535` as
  `byte cap spills over-cap rows instead of evicting prior continuation ids`;
- redefine `tests/responses-state.test.ts:557` as
  `byte accounting across restart preserves spilled ids and recomputes resident and stub bytes`;
- redefine `tests/responses-state.test.ts:856` as
  `oversized entries replay from dedicated spill across restart while small entries use snapshot`;
- redefine `tests/responses-state.test.ts:960` as
  `empty store reports every resident spill tombstone and counter metric as zero`;
- redefine `tests/responses-state.test.ts:999` (including the exact object at `:1007`) as
  `metrics remain side-effect free with the complete additive metric shape`.

Every test intended to exercise spill sets `setResponseStateByteCapForTests(...)` below
the fixture's measured UTF-8 payload size and restores it in `finally`. In particular, the
current 3 MiB fixture at `tests/responses-state.test.ts:856` must run under a lower override;
the 2 MiB legacy snapshot-entry cap alone does not trigger spill.

Add endpoint coverage in `tests/issue-702-expired-replay-state.test.ts` (the
nearest existing expired-replay endpoint owner, per A-gate note; not the combo
failover e2e) named:

- `known continuation spill failure returns terminal structured previous_response_not_found before upstream I/O`.

Fixtures must use an injected spill I/O seam, not chmod-only assertions that are unreliable
on Windows. The durability-order test records `write`, `fsync`, `close`, `harden`, `publish`,
`stub-swap` and asserts that order exactly.
The seam is a module-level injectable in `spill-store.ts`
(`setSpillIoForTest({write,fsync,link,copyFileExcl,unlink}| null)` — `publish` covers
both the link path and the exclusive-copy fallback), and the `stub-swap`
event is recorded by `state.ts` calling a `noteStubSwapForTest()` hook exported
from the same seam — the order assertion therefore spans the
`spill-store.ts`/`state.ts` boundary through one recorder.

Verification:

```bash
bun test tests/responses-state.test.ts tests/issue-702-expired-replay-state.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

## Commit

`feat(responses): hard-cap continuation state with durable spill`

## Explicitly not changed

- No replay truncation, history compaction, provider-metadata dropping, or naked-delta fallback.
- No use of the 2 MiB/24 MiB monolithic snapshot as spill storage.
- No change to small-entry debounce timing or newest-first snapshot selection.
- No change to `store:false` force policy, partial-output eligibility, replay provenance,
  Cursor checkpoint semantics, or Kiro conversation identity.
- No provider adapter logic, request body cap, stream relay, or `#820` scheduler/lease work.
- No user-visible spill paths/digests and no security notes outside this closed implementation unit.
