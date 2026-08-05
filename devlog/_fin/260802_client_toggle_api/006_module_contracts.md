# 006 — Canonical module contracts (single source of truth)

A-gate amendment (round 1, blockers 3/4/5/6/8). The decade docs were written
in parallel and drifted on type names, discriminants, and signatures. This
document is now the ONLY place shared types are defined; every decade doc
references it and may not redeclare them. Where a decade doc disagrees with
this file, this file wins.

## 1. Serialization (WP1) — corrected

**Verified 2026-08-02 on Bun 1.3.14:**
`Bun.YAML.stringify({a:1,b:{c:"d"}})` returns `"{a: 1,b: {c: d}}"` — **flow
style, no trailing newline**. It is valid YAML, but it is not what a user
expects to find in their `config.yaml`, and it breaks the "exactly one
trailing newline" contract 010 claimed.

Decision: **hand-render YAML too**, the same way TOML is hand-rendered. Both
documents we emit are shallow (a provider map plus a model list), so a narrow
block-style renderer is ~40 lines and fully testable, and it gives us stable
bytes we control.

```ts
/** Block-style YAML for the shallow shapes we emit. Throws on anything else. */
export function renderYaml(value: unknown, indent?: number): string;

/** Every serializer returns text ending in exactly one "\n". */
export function serializeDocument(document: unknown, format: ConfigFormat): string;
```

Accept criterion (010 §5, amended): for all four formats and all six clients,
`text.endsWith("\n") && !text.endsWith("\n\n")`, and each text round-trips
through its format's parser to a deep-equal document.

## 2. Managed contribution — the fix for "one provider key" (blocker 3)

A client's generated document is NOT a single provider block, and Kimi owns
**two** regions (`providers.opencodex` plus every `models["opencodex/..."]`
entry). The ownership unit is therefore a *set of fragments*, not one key.

```ts
/** One owned fragment: a JSON path plus the value we put there. */
export interface ManagedFragment {
  /** Path from the document root, e.g. ["providers","opencodex"]. */
  path: readonly string[];
  value: unknown;
}

/**
 * Everything opencodex contributes to one client's config. Produced by the
 * WP1 builder (which knows the client's schema), consumed by merge/remove and
 * fingerprinted as a unit.
 */
export interface ManagedContribution {
  /**
   * WP1's own id type. `IntegrationClientId` is a WP2 alias OF this type, not
   * a separate one — WP1 must typecheck before WP2 exists, so the dependency
   * only ever points backwards (A-gate round 2, blocker 3).
   */
  clientId: ExportClientId;
  fragments: readonly ManagedFragment[];
}

/** WP1 gains this per client; it replaces the "ownership.path" idea in 020. */
export type BuildContribution = (ctx: ExportContext) => ManagedContribution;
```

**Module ownership of shared types (blocker 3).** These live in
`src/clients/config-export.ts` (WP1), because WP1 is the earliest phase that
needs them: `ConfigFormat`, `ManagedFragment`, `ManagedContribution`,
`BuildContribution`. WP2's `src/integrations/registry.ts` re-exports
`export type IntegrationClientId = ExportClientId;` as a readability alias.
No WP1 file imports from `src/integrations/`.

**Canonical model loader (blocker 4).** Both the existing
`/api/client-config` route and the new integration routes need the same
"visible, non-disabled catalog rows as `ExportModel[]`" list. Today
`listManagementModelRows` and `toExportModel` are private to
`src/server/management/model-routes.ts`. WP1 extracts them:

```ts
// src/server/management/model-rows.ts  (NEW, WP1 scope)
export async function listManagementModelRows(config: OcxConfig): Promise<ManagementModelRow[]>;
export function toExportModel(row: ManagementModelRow): ExportModel;
/** Visible (non-disabled) rows as export models — the one loader both routes use. */
export async function loadExportModels(config: OcxConfig): Promise<ExportModel[]>;
```

`model-routes.ts` imports from it instead of declaring them; WP4's file scope
gains this import change. No behavior change to `/api/client-config` — the
extraction is mechanical and its existing test pins the envelope.

Per-client fragments:

| Client | fragments |
|---|---|
| opencode | `["provider","opencodex"]` |
| pi / hermes / gajae | `["providers","opencodex"]` |
| openclaw | `["models","providers","opencodex"]` |
| kimi | `["providers","opencodex"]` **and one `["models","opencodex/<selector>"]` per model** |

Removal removes **exactly the recorded fragment paths** — never a prefix
scan. The record stores the paths, so a user's own `models["opencodex/foo"]`
written before we existed is not ours and is not deleted (it reads as
`conflict`, per 003 §3 "our key with no ownership record").

`buildClientConfig` (the existing whole-document builder) stays for the
read-only export surface. `buildContribution` is the new writer-side
function. They share the same per-client model normalization.

## 3. Snapshot state — absent vs expired (blocker 6)

`null` was overloaded: "the file did not exist" and "the snapshot was
collected" are different facts and only one of them is recoverable.

```ts
export type SnapshotRef =
  | { kind: "none" }                    // the file did not exist before this op
  | { kind: "stored"; relPath: string } // snapshot bytes on disk
  | { kind: "expired" };                // row survives, bytes were GC'd

export interface JournalEntry {
  opId: string;
  clientId: IntegrationClientId;
  kind: "apply" | "disable" | "refresh" | "restore";
  at: string;
  configPath: string;
  snapshot: SnapshotRef;
  /** Fingerprint of the file AFTER this op. "" when the op left no file. */
  resultFingerprint: string;
  /** True when the op's result was file absence — restore means "delete". */
  resultAbsent: boolean;
  /**
   * The ownership record as it stood BEFORE this operation (null when we
   * owned nothing yet). This is what makes restore honest: the snapshot
   * restores the bytes, and this restores the provenance that matched them.
   *
   * Without it, restore had to re-derive ownership from the restored file,
   * and the only available signal was our provider-id prefix — which would
   * silently adopt a user's own `opencodex/...` entry and let a later disable
   * delete it. Ownership is never inferred from a prefix (A-gate round 4,
   * blocker 4).
   */
  priorRecord: OwnershipRecord | null;
}
```

`priorRecord` also closes the compensation gap (blocker 5): a failed
refresh/disable/restore restores the file **and** re-puts `priorRecord`, so a
client whose record was replaced cannot end up with the new record after the
new file was rolled back.

`readSnapshot(opId)` returns `{ kind: "none" } | { kind: "stored"; text } |
{ kind: "expired" }`. Restore semantics follow the tag:

- `none` → restore means **remove the file we created**, allowed only when the
  current file is still ours by fingerprint. This is the "restore a fresh
  apply back to absence" case the audit found unrepresentable.
- `stored` → write those bytes back (with the §5 preflight).
- `expired` → refuse `snapshot-expired`.

**Ordering fix:** GC runs **after** the journal row is committed, never during
capture, so a crash between capture and append can never orphan the newest
snapshot.

**Secret handling:** snapshot bytes may contain a user's own credentials (we
copy their file verbatim). They are written with `atomicWriteFile`, which
applies `0600` plus Windows ACL hardening — the same protection opencodex
gives its own credential store. This is no longer an open question.

## 4. Writer result — one union, one spelling (blocker 4)

```ts
export type RefusalReason =
  | "not_installed"
  | "conflict"
  | "unsafe"
  | "non_loopback"
  | "drift_requires_confirm"
  | "snapshot_expired"
  | "write_failed";

export interface WriteOk {
  ok: true;
  changed: boolean;
  state: IntegrationState;
  clientId: IntegrationClientId;
  /** Present when the operation was journaled (changed === true). */
  opId?: string;
  message: string;
}

export interface WriteRefused {
  ok: false;
  /** ONE field name across every layer. 030's `refused` is retired. */
  reason: RefusalReason;
  state: IntegrationState;
  clientId: IntegrationClientId;
  message: string;
  /** Absolute path of a recoverable snapshot, when one exists. */
  snapshotPath?: string;
}

export type WriteOutcome = WriteOk | WriteRefused;
```

Discriminant literals are **snake_case everywhere** (they travel to JSON), so
040's `drift_requires_confirm` is canonical and 030's `drift-needs-confirm`
is retired. `snapshotPath` is part of the union, so 040 must forward it and
060's manual-recovery Notice is reachable.

## 5. Exact writer/state signatures (blocker 4)

`ManagementContext` does not carry models or port, so the writer takes its own
explicit input rather than being handed a route context:

```ts
export interface IntegrationWriteInput {
  clientId: IntegrationClientId;
  models: readonly ExportModel[];
  config: OcxConfig;
  port: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /**
   * The whole integration state store, bound to one root (records, journal,
   * snapshots, maintenance). Defaults to `createIntegrationStateStore()`.
   * A per-call directory parameter was not enough: retention honored it while
   * records and the journal still resolved the global root, so an "isolated"
   * operation could still mutate the developer's store (A-gate round 11).
   */
  store?: IntegrationStateStore;
  /** Test seam: read/write/now. Defaults to `defaultIntegrationIO(store)`. */
  io?: IntegrationIO;
}

export interface IntegrationIO {
  /**
   * ONLY a missing file yields `{ kind: "missing" }`. Every other failure
   * (EACCES, EPERM, EISDIR, …) yields `{ kind: "failed" }`, which the writer
   * MUST treat as `unsafe`. Collapsing both to `null` would let an
   * unreadable-but-present config be overwritten as if it were absent
   * (A-gate round 3, blocker 3).
   */
  readText: (path: string) =>
    | { kind: "text"; text: string }
    | { kind: "missing" }
    | { kind: "failed"; code?: string };
  /**
   * `failed` is distinct from `missing`. Collapsing a stat failure into
   * absence bypassed the unreadable-file protection before `readText` ever
   * ran (A-gate round 10, blocker 2): only ENOENT is absence.
   */
  statKind: (path: string) => "file" | "dir" | "other" | "missing" | "failed";
  writeText: (path: string, text: string) => void;   // defaults to atomicWriteFile
  removeFile: (path: string) => void;
  mkdirp: (path: string) => void;
  now: () => number;
  /**
   * Bookkeeping seams. Without them the compensating-write path cannot be
   * activated in a test, so the rollback guarantee would be unverifiable
   * (A-gate round 3, blocker 6).
   */
  appendJournal: (entry: JournalEntry) => void;
  putRecord: (record: OwnershipRecord) => void;
  dropRecord: (clientId: IntegrationClientId) => void;
}
```

### Bookkeeping order and compensation (blocker 6)

**HTTP mapping is routed by `reason`, never by `state` (A-gate round 5).**
A refusal's `state` describes the file; its `reason` describes what went
wrong. Mapping on state first meant a `write_failed` that happened to occur in
a `conflict` state was reported as `integration_conflict`, silently dropping
`message`/`snapshotPath`/`residual` — the recovery information the flag exists
to deliver. The rule:

| `reason` | HTTP envelope |
|---|---|
| `conflict` | `integration_conflict` |
| `unsafe` | `integration_unsafe` (carries recovery fields) |
| `drift_requires_confirm` | `integration_drift_confirmation_required` |
| `snapshot_expired` | `integration_snapshot_expired` |
| `not_installed` / `non_loopback` | `integration_mutation_failed` |
| **`write_failed`** | **`integration_mutation_failed`, always, carrying `message`, `snapshotPath`, and `residual`** |

No branch may inspect `state` before `reason`.

Fixed order: **client file → ownership record → journal row.** The record
precedes the row because a record without a row is just a thin history, while
a row without a record advertises an operation the classifier cannot
corroborate — a phantom.

| Failure point | Compensation | Result |
|---|---|---|
| record write throws | restore the client file, then re-put `priorRecord` (or drop when it was null) | `write_failed` |
| journal append throws | restore the client file, then re-put `priorRecord` (or drop when it was null) | `write_failed` — no phantom row is possible because the row is last |
| **any compensating step throws** — file write, record put, or record drop | none available | `write_failed` with `residual: true` and `snapshotPath` |

`residual` covers bookkeeping compensation too, not just the file: a swallowed
`dropRecord`/`putRecord` failure would leave provenance that disagrees with
the file, which is exactly the state the flag exists to announce.

**Snapshot GC is not part of the transaction.** `appendOperation` commits the
row; pruning old snapshots afterwards is post-commit best-effort and its
failure is logged, never surfaced as an append failure. Otherwise a GC error
would trigger compensation for an operation that already succeeded — the
phantom row this ordering exists to prevent (blocker 5).

**But best-effort must not mean invisible (A-gate round 5, blocker 4).**
Snapshots can hold the user's own credentials, so "keep at most 10 per client"
is a retention promise, not housekeeping. A swallowed prune failure would let
credential-bearing files accumulate indefinitely while every operation
reported success. Therefore:

- `pruneSnapshots` returns a structured result
  (`{ ok: true } | { ok: false; error: string }`) instead of throwing or
  swallowing.
- A failure is recorded as a `maintenance` marker under the integrations dir
  and logged once, never as an operation failure.
- Every subsequent `appendOperation`, and the reader's first call after
  startup, retries pruning for that client and clears the marker on success.
- The status envelope exposes `retentionDegraded: boolean` per client so the
  GUI can say so rather than the user discovering it in a file listing.

Test: make `rmSync` throw, assert the row is still committed and the operation
still succeeds, assert the marker exists and `retentionDegraded` is true, then
let the next operation prune successfully and assert the bound is restored and
the marker is gone.

### `retentionDegraded` — the full cross-phase contract

A retention promise the user cannot see is not a promise, so this field is
specified end to end rather than left for each layer to invent (A-gate round 6,
blocker 3).

**Marker (WP2).** `<ocx config dir>/integrations/maintenance.json`:

```ts
export interface MaintenanceState {
  /** Per client: the last prune failure, or absent when healthy. */
  pruneFailures: Partial<Record<IntegrationClientId, { at: string; error: string }>>;
}

export function readMaintenance(dir?: string): MaintenanceState;
export function markPruneFailure(clientId: IntegrationClientId, error: string): void;
export function clearPruneFailure(clientId: IntegrationClientId): void;
/** Re-attempts every marked client; called at the start of each operation. */
export function retryPendingPrunes(): void;
```

If writing the marker *itself* fails, the failure is logged once and the state
is still derivable without it: `readIntegrationState` counts snapshot files and
sets `retentionDegraded` when the count exceeds the bound. The marker is an
optimization for retry scheduling, never the only witness — a durable claim
must not depend on a write that can fail.

**WP2 status.** `IntegrationStatus` gains
`retentionDegraded: boolean` and `snapshotCount: number`.

**WP4 envelope.** Both `IntegrationStateEnvelope` and each list item carry
those two fields verbatim from the status object; no route recomputes them.

**GUI.** The client page's status line appends
`integrations.retention.degraded` ("백업 정리가 밀려 있습니다 — 오래된 백업이
남아 있을 수 있습니다") when the flag is set; the overview card shows no badge
for it, because it is a maintenance condition, not an integration state.

**Tests.** `tests/integrations-journal.test.ts` →
`prune failure marks retention degraded and a later operation clears it`;
`tests/management-integration-routes.test.ts` →
`state envelope carries retentionDegraded and snapshotCount`;
`gui/tests/integrations-surfaces.test.tsx` →
`renders the retention notice only when degraded`.

Claiming a rollback that did not happen is the one failure mode worse than the
original error, so the refusal type carries the residual flag:

```ts
export interface WriteRefused {
  ok: false;
  reason: RefusalReason;
  state: IntegrationState;
  clientId: IntegrationClientId;
  message: string;
  snapshotPath?: string;
  /** True when compensation failed and the file is in an intermediate state. */
  residual?: boolean;
}
```

`restoreIntegration` uses the same order and the same compensation, including
for its own record/journal writes.

### Config-dir seam

`resolveConfigDir` is **private** in `src/config.ts`; the public accessor is
`getConfigDir()`. Every integration module uses `getConfigDir()`, and
`integrationsDir(dir = getConfigDir())` takes an optional override so tests
redirect state without mutating the environment.

**One store, bound once (A-gate round 11).** Threading a `stateDir` parameter
through individual functions was half a fix: retention and pruning honored it
while records, the journal, and snapshots still resolved the global root, so an
operation that believed itself isolated could read and mutate the developer's
real store. The seam is therefore an object, bound once and passed whole:

```ts
export interface IntegrationStateStore {
  readonly root: string;                 // <config dir>/integrations
  readRecords(): Partial<Record<IntegrationClientId, OwnershipRecord>>;
  putRecord(record: OwnershipRecord): void;
  dropRecord(clientId: IntegrationClientId): void;
  appendJournal(entry: JournalEntry): void;
  listOperations(clientId?: IntegrationClientId, limit?: number): JournalEntry[];
  findOperation(opId: string): JournalEntry | null;
  captureSnapshot(clientId: IntegrationClientId, opId: string, text: string | null): SnapshotRef;
  readSnapshot(entry: JournalEntry): { kind: "none" } | { kind: "stored"; text: string; path: string } | { kind: "expired" };
  countSnapshots(clientId: IntegrationClientId): number | null;
  pruneSnapshots(clientId: IntegrationClientId): { ok: true } | { ok: false; error: string };
  readMaintenance(): MaintenanceState;
  markPruneFailure(clientId: IntegrationClientId, error: string): void;
  clearPruneFailure(clientId: IntegrationClientId): void;
  retryPendingPrunes(): void;
}

/** Every path this store touches derives from `root` — no global fallback. */
export function createIntegrationStateStore(root?: string): IntegrationStateStore;
```

`IntegrationWriteInput.stateDir` is replaced by `store?: IntegrationStateStore`
(defaulting to `createIntegrationStateStore()`), and `IntegrationIO`'s
`appendJournal`/`putRecord`/`dropRecord` are bound to that same store rather
than to module-level functions. There is no remaining path by which one
operation can straddle two roots.

Isolation test: seed real records, journal, snapshots and a maintenance marker;
run apply → disable → restore against a store rooted at a temp dir; assert
every real file is byte-identical afterwards.

```ts

export function readIntegrationState(input: Omit<IntegrationWriteInput, "io"> & { io?: IntegrationIO }): IntegrationStatus;
export function applyIntegration(input: IntegrationWriteInput): WriteOutcome;
export function disableIntegration(input: IntegrationWriteInput): WriteOutcome;
/**
 * Restore takes the SAME input as apply/disable plus the operation to undo.
 * It needs `models`/`config`/`port` because after writing the snapshot back it
 * must rebuild the fresh contribution to classify the result as current vs
 * stale — a restore that cannot say which state it produced is a rollback the
 * UI has to guess about (A-gate round 2, blocker 4).
 */
export interface IntegrationRestoreInput extends IntegrationWriteInput {
  opId: string;
  confirmDrift?: boolean;
}
export function restoreIntegration(input: IntegrationRestoreInput): WriteOutcome;
```

`clientId` on a restore input must equal the journal row's `clientId`; a
mismatch is a programming error and throws rather than writing the wrong
client's file.

`IntegrationIO` is the seam blocker 7 requires: compare-before-commit is
tested by a `readText` that returns different bytes on the second call, and
`write_failed` by a `writeText` that throws — no monkey-patching of `node:fs`.
`now` makes the single-flight stale-replacement branch reachable in a test.

The route layer builds `IntegrationWriteInput` from `ManagementContext` plus
the catalog rows it already fetches for `/api/client-config` — 040 §route
handlers are amended to do exactly that.

## 6. Journal row over the wire (blocker 5)

ONE name, used by 040 and 060 identically:

```ts
export interface IntegrationJournalRow {
  opId: string;
  clientId: IntegrationClientId;
  kind: "apply" | "disable" | "refresh" | "restore";
  at: string;
  configPath: string;
  /** Derived per request: "none" | "stored" | "expired". */
  snapshot: SnapshotRef["kind"];
  /** Derived per request; see 040. `undoEligible` in 060 is retired. */
  undoable: boolean;
}
```

040's pasted handler must actually build this (the audit found it returning
raw operations), and 060 consumes `snapshot === "expired"` for the
`백업 만료됨` row and `undoable` for the undo affordance.

## 7. Phase-boundary corrections (blocker 2)

- **WP2 verifies without WP3.** Its tests construct config files and
  `OwnershipRecord` fixtures **directly on disk** (write a file, write a
  record, classify). No activation scenario may say "apply, then …" — apply
  does not exist yet. The 020 activation table is rewritten accordingly.
- **WP5 and WP6 merge into one work-phase (WP5).** The audit is right that a
  shell with no surfaces cannot compile-and-verify on its own. The merged
  phase closes with the GUI building, `lint:gui` clean, and its routing +
  surface tests green. The goalplan's `workPhases[]` is amended: seven phases,
  not eight.

## 8. Diff-level completeness (blocker 1)

Every decade doc carries: each file with NEW/MODIFY, real signatures (no
`ctx: {...}`), complete bodies for new modules, before/after context for
modifications, and exact test filenames. **No gap is deferred to a later P.**
The round-1 wording that scheduled the remaining bodies as per-phase work is
retired — DIFFLEVEL-ROADMAP-01 requires the roadmap to be executable *before*
A, and "fill it in per cycle" is exactly what that rule forbids.

Named gaps and where they are now closed:

| Gap | Closed in |
|---|---|
| Hermes/OpenClaw/Kimi/Gajae builder + contribution bodies | `011_wp1_builders.md` |
| OpenCode/Pi `summarize` + `buildContribution` | `011` addendum A |
| `model-rows.ts` canonical loader body | `011` addendum B |
| Journal + ownership bodies, `readIntegrationState` | `021_wp2_journal_impl.md` |
| Writer bodies (apply/disable/restore, merge/remove) | `031_wp3_writer_impl.md` |
| Journal route handler + row derivation | `040` §journal (rewritten in place) |
| WP6 principal components | `061_wp6_components.md` |
| docs-site + test filenames | `070` scope list (already concrete) |

### Module map (every new file, one place)

| Path | Phase | Purpose |
|---|---|---|
| `src/integrations/serialize.ts` | WP1 | `renderYaml`, `renderToml`, `serializeDocument` |
| `src/server/management/model-rows.ts` | WP1 | canonical `ExportModel[]` loader |
| `src/integrations/registry.ts` | WP2 | client paths, detection, `isLoopbackOnly()` (delegates to the export registry — 020 amendment) |
| `src/integrations/ownership.ts` | WP2 | fingerprints, records |
| `src/integrations/state.ts` | WP2 | classifier + `readIntegrationState` |
| `src/integrations/config-io.ts` | **WP2** | `parseConfig`, `loadTarget`, `defaultIntegrationIO` |
| `src/integrations/journal.ts` | WP2 | journal + snapshots |
| `src/integrations/merge.ts` | WP3 | path set/delete, fragment merge/remove |
| `src/integrations/writer.ts` | WP3 | apply / disable / restore |
| `src/server/management/integration-routes.ts` | WP4 | the five routes |

**Phase-boundary rule (blocker 2).** WP2 must typecheck and test with no WP3
file present. Everything its reader needs — `parseConfig`, `loadTarget`,
`defaultIntegrationIO` — therefore lives in **`src/integrations/config-io.ts`,
owned by WP2**, and WP3's `merge.ts` imports `parseConfig` from there rather
than declaring it. The earlier "writer-io.ts, WP3 but lands in WP2" phrasing
was a dependency inversion wearing a note; a shared module owned by the
earlier phase is the actual fix. `021` documents its body; `031` imports it.

Sub-decade docs (`011`, `021`, `031`, `061`) are the standard overflow form
(LEXICO-SPLIT-01): they carry the long paste-ready bodies so the decade doc
stays the readable design, and they are part of the same phase.
