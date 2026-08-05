# WP8b — the shared surfaces, owned once

Audit round 1 (`006_audit_synthesis.md`) failed four ways on one cause: four
phase docs, written in parallel, each invented its share of a surface they all
touch. Round 2 (`007_audit_synthesis_r2.md`) failed because the first version of
this document **declared** ownership without **transferring** it — `020`, `030`
and `040` still carried their own record schema, their own route mapping and
their own module names, in roughly thirty places.

So this document is now the complete definition of every shared surface, and the
four phase docs are rewritten as consumers against the reviewer's section list.
A contract nobody collected is a fifth opinion.

All current-code citations in this document were rechecked on 2026-08-05 at
`8a8323f7885da957120218495715cab8593a5d66`.

## IN / OUT

IN: `src/config.ts` (MODIFY — durable config-generation API),
`src/codex/integration-record.ts` (NEW — sole owner of the JSON record),
`src/codex/transition-state.ts` (NEW — sole owner of the CODEX_HOME-keyed
SQLite transition row),
`src/codex/convergence.ts` (NEW — the single entry point),
`src/codex/convergence-types.ts` (NEW — every shared type),
`src/codex/generation.ts` (NEW), `src/codex/user-identity.ts` (NEW — §7),
`src/server/management/sync-response.ts` (NEW — the one adapter),
`tests/codex-integration-record.test.ts` (NEW),
`tests/codex-transition-state.test.ts` (NEW),
`tests/codex-convergence-contract.test.ts` (NEW),
`tests/codex-user-identity.test.ts` (NEW).

OUT: catalog mechanics (WP9), history mechanics (WP10), the full native-lock
namespace/acquisition API, broad caller adoption, and ownership mechanics — all
**WP12**, which absorbed the former WP11. WP10 is the one narrow exception to that
native-lock boundary: it
uses the already-owned N transaction as a compatibility native-handoff exclusion
from each retained native mutation through its history authorization. The final
coordinator path, transition table/CAS, config-generation API, shapes and funnel
are IN; the domain work performed while those coordinators are held is OUT.

### What "lands first" has to mean (round 2 N2)

The reviewer showed the previous version could not land: it was "OUT: every
behavior" while declaring a runtime `convergeCodex`, and a throwing placeholder
is not a safe commit.

So WP8b lands **types, validators, both durable-state owners, the config-generation
API, the final coordinator-path resolver and the response adapter — and rewires
nothing.** `convergeCodex` is declared here as a type only; WP9 supplies its first
real implementation and rewires the catalog callers at that commit.

**Invariant for every phase in this unit:** each phase typechecks and preserves
behavior at its own commit. No phase may leave a placeholder that a later phase
is required to replace before the tree is correct.

## 1. The record: one owner, one schema

`020` and `040` both wrote `integrations/codex.json` with a required `version: 1`
containing different fields, so a record from either is malformed to the other
(audit #3).

**TypeScript compile prelude.** The TypeScript fences in this document are
concatenated contract fragments. Compile them in document order after prepending
`import type { OcxConfig } from "../types";`. `OcxConfig` is the real export used
by `src/config.ts:48`; omitting this prelude gives TS2304 even though the contract
itself is otherwise valid.

```ts
/**
 * The non-CAS JSON record for the Codex integration.
 *
 * ONE owner. WP12 writes provenance here through `updateIntegrationRecord` —
 * never its own read/merge/write. Cross-process transition state is deliberately
 * absent; it belongs to the CODEX_HOME-keyed SQLite row below.
 *
 * Provenance is OPTIONAL at v1. A record written before WP12 is valid, and
 * unknown extension sections from a newer writer remain valid and preserved.
 */
export interface CodexIntegrationRecord {
  version: 1;
  provenance?: CodexProvenanceLedger;
  /** Unknown keys from a newer writer survive every older-writer update. */
  readonly [extra: string]: unknown;
}
```

### The section types, defined HERE (round 2 #3)

The first version referenced `CodexHistoryState` and `CodexProvenanceLedger`
without defining them, so `020` and `040` kept their own. Both live in
`convergence-types.ts` and both phases import them:

```ts
/** The exact history mutation authorized by the durable coordinator row. */
export type CodexHistoryOperation =
  | "skip"
  | "apply-opencodex"
  | "migrate-openai"
  | "restore-openai"
  | "recover-legacy-openai";

/** Why this exact history job is authorized; the kind is persisted with its id. */
export type CodexHistoryAuthority =
  | { readonly kind: "admission-snapshot"; readonly id: string }
  | { readonly kind: "wp10-compatibility"; readonly id: string }
  | { readonly kind: "explicit-legacy-recovery"; readonly id: string };

export interface CodexHistoryState {
  status:
    | "adoption-pending"
    | "converged"
    | "pending"
    | "running"
    | "blocked"
    | "unknown"
    | "not-evaluated";
  /**
   * Why it is not converged, when it is not. These are terminal observations
   * for one attempt, not reasons to collapse the durable retry schedule.
   */
  reason?:
    | "db-busy"
    | "permission"
    | "unreadable"
    | "schema"
    | "timeout"
    | "shutdown-cancelled"
    | "worker-died"
    | "overtaken"
    | "foreign-state-db"
    | "record-write-failed";
  attempts: number;
  /** null means "no timer armed"; see 020 — it must never mean "never again". */
  nextRetryAt: string | null;
  /** The durable history job this state belongs to, so an overtaken job is detectable. */
  txId: string | null;
  /** null only for the generation-zero unscheduled row or ephemeral not-evaluated projection. */
  operation: CodexHistoryOperation | null;
  /** null means the final probe could not produce a trustworthy row count. */
  pendingRows: number | null;
  /** null means the final probe could not produce a trustworthy manifest count. */
  backupEntries: number | null;
  /** Unknown keys from a newer writer, preserved verbatim. */
  readonly [extra: string]: unknown;
}

/**
 * A manifest read is evidence, not an optional convenience. `missing` alone
 * certifies path absence; `ready` certifies a present valid matching v1 file and
 * may carry zero entries. Every failed read keeps its failure class and a null
 * count so absence can never be manufactured from unreadable bytes.
 */
export type NonNegativeHistoryManifestEntryCount = number & {
  readonly __nonNegativeHistoryManifestEntryCount: "validated-non-negative-integer";
};

export type CodexHistoryManifestRead<T> =
  | { readonly kind: "missing"; readonly manifest: null; readonly backupEntries: 0 }
  | { readonly kind: "ready"; readonly manifest: T;
      readonly backupEntries: NonNegativeHistoryManifestEntryCount }
  | { readonly kind: "unreadable"; readonly manifest: null; readonly backupEntries: null }
  | { readonly kind: "malformed"; readonly manifest: null; readonly backupEntries: null }
  | { readonly kind: "unsupported"; readonly manifest: null; readonly backupEntries: null }
  | { readonly kind: "foreign-state-db"; readonly manifest: null; readonly backupEntries: null };

/**
 * Every mutable Codex artifact for which the provenance ledger can authorize a
 * restore. Embedded config fragments share the `config` entry because they are
 * committed and restored as one file. Dynamic history ids name the exact row or
 * rollout whose semantic pre-image is retained.
 */
export type CodexArtifactId =
  | { readonly kind: "config" }
  | { readonly kind: "generated-profile" }
  | { readonly kind: "active-catalog"; readonly canonicalPath: string }
  | { readonly kind: "catalog-backup"; readonly form: "hashed" | "legacy";
      readonly canonicalPath: string }
  | { readonly kind: "models-cache" }
  | { readonly kind: "injection-journal" }
  | { readonly kind: "history-row"; readonly stateDbId: string; readonly threadId: string }
  | { readonly kind: "history-manifest"; readonly stateDbId: string;
      readonly canonicalPath: string }
  | { readonly kind: "history-manifest-entry"; readonly stateDbId: string;
      readonly threadId: string }
  | { readonly kind: "history-rollout"; readonly stateDbId: string;
      readonly canonicalPath: string };

export interface CodexProvenanceEntry {
  artifact: CodexArtifactId;
  baseline:
    | { kind: "absent" }
    | { kind: "present"; sha256: string; bytesBase64: string };
  /** Hash of what WE wrote. null when the write did not complete. */
  postImage: string | null;
  txId: string;
  at: string;
  /** Entry-level extensions are preserved, not only ledger/top-level keys. */
  readonly [extra: string]: unknown;
}

export interface CodexProvenanceLedger {
  entries: readonly CodexProvenanceEntry[];
  readonly [extra: string]: unknown;
}

export type CodexArtifactObservation =
  | "applied"
  | "absent"
  | "missing"
  | "residue"
  | "drifted"
  | "unreadable"
  | "invalid"
  | "not-evaluated"
  | "unknown";

/**
 * Read-only proof of what Codex has now, not what persisted intent requests.
 * `isApplied` is true only for aggregate `applied`; a partial surface can never
 * be flattened into true. OFF is operationally converged only at `absent`.
 */
export interface CodexObservedState {
  aggregate: "applied" | "absent" | "partial" | "external" | "blocked" | "not-evaluated";
  /** null only for a catalog-scoped request that deliberately did not observe. */
  isApplied: boolean | null;
  desired: "on" | "off" | "unknown";
  /** null only when aggregate is `not-evaluated`. */
  converged: boolean | null;
  authority: {
    service: "owned" | "foreign" | "unknown";
    externalProvider: string | null;
  };
  surfaces: {
    config: CodexArtifactObservation;
    profile: CodexArtifactObservation;
    catalog: CodexArtifactObservation;
    cache: CodexArtifactObservation;
    journal: "absent" | "pending" | "live" | "invalid" | "unknown" | "not-evaluated";
    history: {
      state: CodexHistoryState;
      database: CodexArtifactObservation;
      manifest: CodexArtifactObservation;
      rollouts: CodexArtifactObservation;
    };
    provenance: {
      state: "verified" | "missing" | "conflict" | "unreadable" | "unknown" | "not-evaluated";
      nativeGeneration: number | null;
      currentTxId: string | null;
    };
  };
}

export type CatalogNotice = "provider-auth" | "provider-network" | "fallback";

/** Sanitized catalog fact safe to append to management mutation responses. */
export type CatalogDisposition =
  | { status: "committed"; changed: boolean; degraded: boolean;
      notices: readonly CatalogNotice[] }
  | { status: "skipped";
      reason: "not-requested" | "catalog-unavailable" | "busy" | "stale" | "refused";
      retryable: boolean }
  | { status: "failed"; reason: "provider-auth" | "provider-network" | "disk";
      phase: "gather" | "commit"; retryable: boolean; partialWrite: boolean };
```

`CatalogDisposition` contains no provider name, URL, token text, path, digest or
raw exception. `CodexObservedState.aggregate` follows the five-state projection
already derived from the real config/profile/catalog/cache/journal/history surfaces
(`devlog/_plan/260804_codex_write_substrate/004_ownership_and_convergence.md:235-273`);
its nested observations keep the
one-artifact partial cases testable instead of hiding them behind that aggregate.
For a clean non-`skip` history convergence, `reason` is absent and both probe counts
are zero. `skip` is the sole converged exception: it deliberately performs no probe
and stores null counts rather than manufacturing zero evidence.
An unreadable DB/manifest uses `unreadable`; a readable but unsupported table or
manifest shape uses `schema`; a watchdog uses `timeout`; graceful drain uses
`shutdown-cancelled`; and failure of the terminal CAS uses
`record-write-failed` in the returned observation while leaving the previously
persisted `pending` schedule intact. Any failed/unavailable final probe stores null,
never a zero-looking count.
An otherwise valid manifest naming another canonical state DB uses
`foreign-state-db`; it is preserved and blocks convergence rather than becoming an
empty manifest for this DB.
`not-evaluated` is an ephemeral artifact projection used by WP9's catalog-scoped
compatibility outcome and, for the three nested history artifacts only, by an
authorized `skip`. Catalog scope persists no history state; `skip` instead persists
`CodexHistoryState { status:"converged", operation:"skip" }` and makes no artifact
claim. Neither case answers an unobserved artifact with a false-looking boolean.

### Durable state: the JSON CAS was wrong

The previous contract called `updateIntegrationRecord` a CAS because it compared
two JSON fields and replaced the file while *the caller's* coordinator was held.
That was wrong. Native and history callers hold different coordinators, so an old
history Worker can read JSON at N, a native transition can replace it at N+1, and
the Worker can then replace the file with stale N. Serialization under two
non-overlapping locks is not compare-and-swap.

The key was wrong as well. `integrations/codex.json` is under `OPENCODEX_HOME`, but
native exclusion is keyed by canonical `CODEX_HOME`. Two OpenCodex installations
sharing one Codex home therefore serialized and then consulted different counters.
The pair and all history scheduling/terminal state move to one SQLite row in the
final CODEX_HOME-keyed coordinator database. The JSON record keeps exactly
`version`, the provenance ledger, and unknown extension members; none is the
authority for transition admission, Worker overtaking, or retry scheduling.

```ts
export interface CodexTransitionVersion {
  readonly nativeGeneration: number;
  readonly currentTxId: string | null;
}

export interface CodexTransitionState extends CodexTransitionVersion {
  /** Durable schedule, or non-dispatchable adoption authority, plus latest observation. */
  readonly history: CodexHistoryState;
  readonly historySchedule: null | Readonly<{
    jobId: string;
    operation: CodexHistoryOperation;
    authority: CodexHistoryAuthority;
  }>;
}

/** Both the native pair and exact durable history authorization are CAS input. */
export interface CodexHistoryScheduleExpectation extends CodexTransitionVersion {
  readonly historyJobId: string;
  readonly operation: CodexHistoryOperation;
  readonly authority: CodexHistoryAuthority;
}

export type IntegrationRecordRead =
  | { kind: "missing"; record: null }
  | { kind: "ready"; record: CodexIntegrationRecord }
  | { kind: "invalid"; message: string };

export type ReadIntegrationRecord = () => IntegrationRecordRead;

export type IntegrationRecordUpdate =
  | { kind: "updated"; record: CodexIntegrationRecord }
  | { kind: "invalid"; message: string };

/**
 * Update only non-CAS JSON data. Callers may not add transition or schedule
 * fields. The updater preserves unknown keys at every object level.
 */
export type UpdateIntegrationRecord = (
  mutate: (record: CodexIntegrationRecord) => CodexIntegrationRecord,
) => IntegrationRecordUpdate;

export type TransitionStateRead =
  | { kind: "ready"; state: CodexTransitionState }
  | { kind: "legacy-ambiguous"; message: string }
  | { kind: "unavailable"; reason: "busy" | "unsafe-path" | "database" };

export type TransitionStateUpdate =
  | { kind: "updated"; state: CodexTransitionState }
  | { kind: "conflict"; current: CodexTransitionState }
  | { kind: "unavailable"; reason: "busy" | "unsafe-path" | "database" };

export type ReadCodexTransitionState = () => TransitionStateRead;

/** Publish N+1 and its pending schedule with one conditional SQLite UPDATE. */
export type BeginCodexTransition = (
  expected: CodexTransitionVersion,
  next: Readonly<{
    txId: string;
    direction: "apply" | "remove";
    operation: Exclude<CodexHistoryOperation, "recover-legacy-openai">;
    authoritySnapshotId: string;
    nextRetryAt: string;
  }>,
) => TransitionStateUpdate;

/**
 * Authorize the explicit legacy recovery without inventing a native routing
 * generation. The expected state must be terminal; unresolved native work wins.
 */
export type AuthorizeCodexLegacyHistoryRecovery = (
  expected: CodexTransitionState,
  next: Readonly<{
    jobId: string;
    authorityId: string;
    nextRetryAt: string;
  }>,
) => TransitionStateUpdate;

/**
 * Positive WP10 authority for the one missing-row exception. This is derived
 * only by `history-job.ts` from a real retained high-level native callback.
 */
export type CodexCompatibilityNativeIntent =
  | Readonly<{
      kind: "retained-apply";
      operation: Exclude<CodexHistoryOperation,
        "restore-openai" | "recover-legacy-openai">;
    }>
  | Readonly<{
      kind: "retained-restore";
      operation: "restore-openai";
    }>;

/**
 * WP10-only bridge for current roots that predate WP12 native admission. The
 * transition-state owner binds this one-shot closure to both the already-open N
 * handle and the complete row read from that handle after acquisition. Callers
 * supply no expected row and cannot make the closure open another N connection.
 */
export type AuthorizeCodexCompatibilityHistory = (
  next: Readonly<{
    jobId: string;
    operation: Exclude<CodexHistoryOperation, "recover-legacy-openai">;
    authorityId: string;
    nextRetryAt: string;
  }>,
) => TransitionStateUpdate;

type SynchronousCompatibilityHandoff<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * WP10's narrow native-mutation-to-history-authorization exclusion. The callback
 * starts only after N is held, must authorize exactly once through the supplied
 * transaction-bound closure, and returns before N is committed and released. A
 * compatibility adoption additionally requires either atomic publication of a
 * complete `adoption-pending` coordinator or a valid row already in that state;
 * an earlier path-absence observation and a rowless file are never authority.
 */
export type WithCodexCompatibilityNativeHandoff = <T>(
  intent: CodexCompatibilityNativeIntent,
  mutateNativeAndAuthorize: (
    authorize: AuthorizeCodexCompatibilityHistory,
  ) => SynchronousCompatibilityHandoff<T>,
) => T;

/** Change only history columns when the exact pair, job and operation still own the row. */
export type UpdateCodexHistoryTransition = (
  expected: CodexHistoryScheduleExpectation,
  history: CodexHistoryState,
) => TransitionStateUpdate;
```

WP8b implements and exports `const readIntegrationRecord: ReadIntegrationRecord`
and `const updateIntegrationRecord: UpdateIntegrationRecord` from
`src/codex/integration-record.ts`, plus
`readCodexTransitionState`, `beginCodexTransition`, and
`updateCodexHistoryTransition` from
`src/codex/transition-state.ts`; these are executable functions in that phase, not
ambient declarations. WP10 adds `withCodexCompatibilityNativeHandoff` and
`authorizeCodexLegacyHistoryRecovery` there. There is deliberately no standalone
runtime `authorizeCodexCompatibilityHistory(expected, next)` export: the only value
of that type is the one-shot closure supplied by the handoff while its N transaction
is live.

The coordinator is a **sibling**, not an extension of `config-mutation.sqlite`.
The existing database path is derived from `getConfigDir()`
(`src/config.ts:1745-1776`), whose resolver reads `OPENCODEX_HOME`
(`src/config.ts:543-550,1268-1270`); extending it would repeat the split-key
defect. The sibling uses the same Bun SQLite pattern — private
file, `busy_timeout=0`, `BEGIN IMMEDIATE`, process-exit lock release
(`src/config.ts:1790-1839`) — but its final database path is keyed by effective
user plus canonical `CODEX_HOME` (§7). WP11's native exclusion transaction and
both transition-state callers open this same database.

The exact singleton row is:

```sql
CREATE TABLE codex_transition_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  native_generation INTEGER NOT NULL CHECK (native_generation >= 0),
  current_tx_id TEXT,
  history_status TEXT NOT NULL,
  history_reason TEXT,
  history_attempts INTEGER NOT NULL CHECK (history_attempts >= 0),
  history_next_retry_at TEXT,
  history_tx_id TEXT,
  history_operation TEXT CHECK (history_operation IN
    ('skip', 'apply-opencodex', 'migrate-openai', 'restore-openai',
     'recover-legacy-openai')),
  history_authority_kind TEXT CHECK (history_authority_kind IN
    ('admission-snapshot', 'wp10-compatibility', 'explicit-legacy-recovery')),
  history_authority_id TEXT,
  history_pending_rows INTEGER,
  history_backup_entries INTEGER,
  updated_at TEXT NOT NULL,
  CHECK (history_status IN
    ('adoption-pending', 'converged', 'pending', 'running', 'blocked', 'unknown')),
  CHECK (history_reason IS NULL OR history_reason IN
    ('db-busy', 'permission', 'unreadable', 'schema', 'timeout',
     'shutdown-cancelled', 'worker-died', 'overtaken', 'foreign-state-db',
     'record-write-failed')),
  CHECK (history_pending_rows IS NULL OR history_pending_rows >= 0),
  CHECK (history_backup_entries IS NULL OR history_backup_entries >= 0),
  CHECK ((native_generation = 0 AND current_tx_id IS NULL)
      OR (native_generation > 0 AND length(trim(current_tx_id)) > 0)),
  CHECK ((history_tx_id IS NULL
          AND history_operation IS NULL
          AND history_authority_kind IS NULL
          AND history_authority_id IS NULL)
      OR (length(trim(history_tx_id)) > 0
          AND history_operation IS NOT NULL
          AND history_authority_kind IS NOT NULL
          AND length(trim(history_authority_id)) > 0)),
  CHECK (history_operation IS NULL
      OR (history_operation = 'recover-legacy-openai'
          AND history_authority_kind = 'explicit-legacy-recovery')
      OR (history_operation != 'recover-legacy-openai'
          AND history_authority_kind IN ('admission-snapshot', 'wp10-compatibility'))),
  CHECK (history_authority_kind IS NULL
      OR history_authority_kind IN ('wp10-compatibility', 'explicit-legacy-recovery')
      OR (history_authority_kind = 'admission-snapshot'
          AND native_generation > 0
          AND history_tx_id = current_tx_id)),
  CHECK (native_generation = 0 OR history_operation IS NOT NULL),
  CHECK (history_status != 'adoption-pending' OR
    (native_generation = 0
     AND current_tx_id IS NULL
     AND history_reason IS NULL
     AND history_attempts = 0
     AND history_next_retry_at IS NULL
     AND history_tx_id IS NOT NULL
     AND history_operation IS NOT NULL
     AND history_operation != 'recover-legacy-openai'
     AND history_authority_kind = 'wp10-compatibility'
     AND length(trim(history_authority_id)) > 0
     AND history_pending_rows IS NULL
     AND history_backup_entries IS NULL)),
  CHECK (history_operation IS NOT NULL OR
    (history_status = 'unknown'
     AND history_reason IS NULL
     AND history_attempts = 0
     AND history_next_retry_at IS NULL
     AND history_pending_rows IS NULL
     AND history_backup_entries IS NULL))
);
```

The observation columns project to `CodexHistoryState`; job id, operation and typed
authority kind/id are schedule metadata required to restart the exact Worker after process
death. `adoption-pending` carries the same complete identity but is deliberately not
Worker-dispatchable until a real retained native callback changes it to `pending`.
`not-evaluated` remains ephemeral and is rejected by the table. A native
transition publishes its winner and schedule atomically with this null-safe conditional update
(SQLite `IS` is required for the initial null txId):

```sql
UPDATE codex_transition_state
   SET native_generation = ?, current_tx_id = ?,
       history_status = 'pending', history_reason = NULL,
       history_attempts = 0, history_next_retry_at = ?, history_tx_id = ?,
       history_operation = ?, history_authority_kind = 'admission-snapshot',
       history_authority_id = ?,
       history_pending_rows = NULL, history_backup_entries = NULL,
       updated_at = ?
 WHERE singleton = 1
   AND native_generation = ?
   AND current_tx_id IS ?;
```

The first two bound values are `{nativeAfter,newTxId}`; the last two are the
expected `{nativeBefore,currentTxId}`. Worker claim/retry/terminal updates use the
same `WHERE native_generation = ? AND current_tx_id IS ?` predicate and additionally
require `history_tx_id IS ? AND history_operation IS ? AND
history_authority_kind IS ? AND history_authority_id IS ?`; they change only
`history_*`, never the native pair. The operation is therefore CAS authority, not a
hint carried only in Worker IPC.
The row count, not a later JSON read, is the CAS result.

The operation set is intentionally semantic rather than a provider direction:

- `skip` is derived when admitted apply intent has `syncResumeHistory:false`; it
  performs no manifest, rollout, or history-DB read/write and may terminally record
  `converged` with both counts null because it makes no zero/zero claim.
- `apply-opencodex` is legacy-mode apply: retain originals in the manifest, patch
  rollouts, and tag eligible rows `opencodex`.
- `migrate-openai` is loopback-mode apply: consume a valid matching manifest through
  restore and then eject remaining legacy `opencodex` rows to `openai`.
- `restore-openai` is native removal: consume the matching manifest through generic
  restore and then eject remaining routed rows. It remains distinct from migration
  even though both currently share restore mechanics because their authorization and
  retry cause differ.
- `recover-legacy-openai` is the explicit `recover-history --legacy-openai` salvage:
  eject eligible legacy rows and patch their rollouts without reading, consuming,
  deleting, or replacing the manifest. This is not generic restore.

`BeginCodexTransition` receives the native direction and the operation derived by
convergence and rejects an impossible pair (`remove` with anything except
`restore-openai`, or `apply` with `restore-openai`/`recover-legacy-openai`). External
callers still provide only `action`, scope, reason and mode. The Worker request
carries the durable job id and operation copied from the row; it has no
`targetProvider` or caller-chosen direction. It re-reads the row under H and rejects
IPC whose job/operation differs before any probe or mutation.

WP10 must land before WP12, and the current apply/restore roots have neither a WP12
`AdmissionSnapshot` nor a native routing pair published by convergence. Inventing a
snapshot id or bumping `nativeGeneration` would violate the settled phase boundary.
The latest review found that authorizing only **after** the retained native root
returned could lose the newer operation: apply writes config/profile/journal before
history (`src/codex/inject.ts:594-604`), and restore changes config plus K-serialized
catalog state before history (`src/codex/inject.ts:765-789`). If A was already
`running`, B could complete the newer native restore, see non-terminal A, refuse its
schedule, and leave A free to terminally record the obsolete direction.

WP10 therefore brings forward exactly one piece of WP11: the N-backed compatibility
native-handoff exclusion. `history-job.ts` enters
`withCodexCompatibilityNativeHandoff` **before** invoking a retained synchronous
native mutation, receives an authorizer closure bound to that already-open N handle
and the complete row read from that handle after `BEGIN IMMEDIATE`, and uses it before
returning from the callback. `authorize(next)` has no `expected` parameter and may be
called once; a second call, callback return without one call, or attempted use after
the callback is a transaction error and rolls back. It reads no coordinator state and
opens no SQLite connection. This bound shape was chosen because passing `expected`
would let a caller retain a pre-N row, while re-reading through
`readCodexTransitionState` would open another `BEGIN IMMEDIATE` and contend with its
own transaction (`src/codex/transition-state.ts:473-489`). The transaction then
commits/releases N before any Worker spawn or await. Current apply/restore owners still derive one of
`skip | apply-opencodex | migrate-openai | restore-openai`; they supply the derived
operation as the matching `CodexCompatibilityNativeIntent` and supply the synchronous
native callback to `history-job.ts`; they never call the transition-state API directly
and never move native generation in WP10.

That transaction-bound `authorize` closure replaces the exact row it captured from
the already-open transaction with a fresh pending job id,
`authority.kind:"wp10-compatibility"`, and fresh opaque authority id **regardless of
whether the older history state is terminal, pending, or running**. N exclusion makes
that authorization order the retained native-mutation order; replacing non-terminal
work is therefore supersession by a newer native operation, not theft by a peer.
The CAS leaves the native pair unchanged and matches the prior pair, job, operation,
complete authority, and status. The older Worker subsequently loses its full-identity
terminal CAS, cannot clear the winner's timer, and the guardian can repair from the
new durable schedule. The id is a job authorization nonce, not a digest of config or
credentials and is never logged.

No CLI, server, `inject.ts`, or low-level history writer imports either transition-
state authorizer. `history-job.ts` is the sole bridge and scheduling edge in §8's
middle inventory. WP12-final graph reachability removes the compatibility handoff
once admission-snapshot scheduling owns native convergence.

What does **not** move is equally explicit: WP10 does not implement
`codex-write-lock.ts`, the uid/SID namespace mechanics for that full lock, canonical
target/admission validation, finite async acquisition/retry and result taxonomy,
`CommitExpectation`, provenance coordination, or adoption by every native writer.
**WP12** owns that complete async N → K → C mechanism and its caller rewire — the two
are one phase, because round 7 established that the mechanism cannot be audited apart
from the caller that supplies its admission snapshot (`030_lock_protocol.md`, Round 6
resolution). WP10 only closes the retained native-mutation-to-history-authorization gap
using the coordinator database and transition owner that already landed in WP8b.

Explicit legacy recovery cannot honestly advance `nativeGeneration`: §3 defines it
as a routing transition, while this command changes history only. Under N,
`authorizeCodexLegacyHistoryRecovery` conditionally replaces only a terminal history
schedule with a fresh job id and `recover-legacy-openai`, leaving the native pair
unchanged and persisting `authority.kind:"explicit-legacy-recovery"`. Its `WHERE`
includes the expected native pair, prior history job id, prior operation, and prior
authority kind/id. A pending/running schedule refuses as busy rather than discarding
native repair. This separate history job identity is why ordinary native schedules
reuse `currentTxId` but the explicit recovery job need not.

A zero-row native result means another transition won despite this caller's
admission: do not write JSON or spawn its Worker; any native bytes already committed
are unresolved and the current row's winner owns repair. Re-admit if the deadline
permits, otherwise return `deferred`. A zero-row Worker result means `overtaken`:
do not write the JSON record, do not clear the
winner's timer, and schedule from the row returned by a fresh read. A zero-row
guardian update means its timer was stale and is replaced from the current row.
Database busy/unavailable is typed `busy`/`deferred`; no caller guesses success.

The eleventh absence-as-guarantee review found that this strict initializer was the
only production behavior available. The current owner refuses routed residue before
inserting singleton 1 (`src/codex/transition-state.ts:263-303`), and the real routed-
catalog fixture proves the missing coordinator returns `legacy-ambiguous`
(`tests/codex-native-residue.test.ts:213-242`). A production-reference audit also
finds no caller of `readCodexTransitionState`, `beginCodexTransition`, or
`openCodexCoordinatorTransaction` outside the transition owner; the executable entry
points at `src/codex/transition-state.ts:348-385,473-518` are reached only by tests
today. Shipping the owner therefore did not initialize existing routed installations.

The twelfth absence-as-guarantee review found that “truly absent” was still a
check-then-open claim. The owner records `ENOENT` from `lstatSync`
(`src/codex/transition-state.ts:356-373`), later opens with `create:true`, and passes
the stale boolean into initialization (`src/codex/transition-state.ts:374-385`). A
second process can create an unversioned/rowless file between those steps, yet the
first process treats it as its own new database. The thirteenth review then found the
process-death hole in the proposed exclusive final-path claim: rollback/close plus
`finally` cleanup handles a caught failure, but kill after creation closes the
descriptor and leaves the zero-byte path permanently visible. The strict initializer
correctly rejects that existing version-zero database at
`src/codex/transition-state.ts:282-303`, so neither the intended callback nor guardian
recovery can run.

The **general initializer's authority rule remains unchanged and fail-closed**.
Read/observe,
`BeginCodexTransition`, Worker claim/terminal work, guardian retry, explicit legacy
recovery, and direct transaction opens may create the ordinary unscheduled `{0,null}`
row only when the JSON record is missing or valid with no legacy transition fields
and every native surface is clean. Invalid/legacy JSON, routed residue, indeterminate
native evidence, an existing unversioned/unsupported database, or an existing
database with no authoritative singleton still refuses. The residue classifier
checks every routed surface and returns any `indeterminate` result before `residue`
(`src/codex/native-residue.ts:520-556`), so unreadable or ambiguous bytes cannot enter
the exception. An `OPENCODEX_HOME`-local positive pair is never imported because a
second home may hold a different claimant.

Its creation mechanism does change: a native-clean ordinary initializer also builds a
complete v1 temp database and atomically no-clobber-publishes the ordinary singleton
`{ native_generation:0, current_tx_id:null, history_status:'unknown' }` with null
schedule/reason/timer/probe fields and zero attempts. It never opens a missing final
path with SQLite `create:true`. Thus every coordinator database first visible at the
final name has a supported schema and authoritative singleton, whether it is the
ordinary clean row or the compatibility row below.

WP10 adds one private **compatibility-adoption** mode beneath
`withCodexCompatibilityNativeHandoff`; it is not an option on the public transaction
opener. “Positively authorized” means all of the following are true: the sole graph-
permitted caller is `history-job.ts`; it received a real retained high-level native
callback; its closed intent is `retained-apply` with exactly
`skip | apply-opencodex | migrate-openai` or `retained-restore` with exactly
`restore-openai`; and the callback must consume the transaction-bound authorizer
exactly once. Residue detection, startup observation, a Worker/guardian retry,
history-only recovery, or an arbitrary operation value is not positive authority.

When the final coordinator path is genuinely absent and those record/residue/intent
preconditions hold, the transition owner uses that same complete-database publisher
to publish compatibility authority **before** invoking the native callback. It
exclusively creates a unique mode-`0600` temp file in the final directory, opens
SQLite only at that temp path, creates the complete v1 schema, and commits singleton 1
with exactly:

- `native_generation = 0`, `current_tx_id = NULL`;
- `history_status = 'adoption-pending'`, `history_reason = NULL`,
  `history_attempts = 0`, `history_next_retry_at = NULL`;
- a fresh non-empty `history_tx_id`, the exact intent-derived non-recovery
  `history_operation`, `history_authority_kind = 'wp10-compatibility'`, and a fresh
  opaque non-empty `history_authority_id`;
- `history_pending_rows = NULL`, `history_backup_entries = NULL`, a fresh
  `updated_at`, and `PRAGMA user_version = 1`.

The temp database uses a completed rollback-journal transaction, is closed with no
live journal/WAL sidecar, is reopened read-only through the ordinary row validator,
and its database bytes are fsynced before publication. The owner then publishes it
with the same atomic no-clobber shape required for create-once backups in §3: a
same-directory exclusive hard link or platform rename-without-replace equivalent.
An ordinary replacing rename is forbidden. `EEXIST` means another process won and
always enters the strict existing-database path after the unpublished temp is
scrubbed. A successful link/rename is followed by parent-directory fsync; a hard-link
temp alias is then removed without touching the final name. No SQLite handle opened
on the temp crosses publication. Cooperating processes never open a published or stale
temp alias as SQLite; after a crash they may only unlink an alias whose non-symlink
regular-file identity matches the validated final database.

The publication operation is the crash boundary. Before it, the final path is absent
and a killed creator can leave only a non-authoritative unique temp; the next real
operation ignores that temp and can publish anew. During it, the no-replace primitive
makes the final name atomically either absent or linked to the already complete,
validated v1 database. After it, including death before temp-alias cleanup, final-path
reopen, native callback, or authorization, every opener sees the complete typed
`adoption-pending` row. There is no visible zero-byte/version-zero interval and no
final-path `finally` unlink on any post-publication failure.

An ordinary opener validates `adoption-pending` as a ready coordinator state, never
as `legacy-ambiguous`, but it does not dispatch a history Worker: the row proves that
native mutation may not have started or may have died mid-callback. In WP10, only a
new positively authorized real retained apply/restore handoff may transition it. That
handoff takes N, re-runs its current closed-intent native callback idempotently, and
its transaction-bound `authorize(next)` conditionally replaces the complete row it
observed with the current operation's fresh `pending/wp10-compatibility` schedule.
The current operation may match or supersede the interrupted operation; N still makes
the committed schedule order equal the retained native-mutation order. Callback
throw, authorization failure, or process death rolls N back and leaves the durable
`adoption-pending` row unchanged for the next real operation. WP12's fully admitted
native transition may later supersede it through `BeginCodexTransition`; ordinary
readers, Worker/guardian claim or terminal paths, explicit legacy recovery, and
residue observation may not transition it or relabel its authority.

Startup's ordinary apply/restore root therefore recovers automatically by re-entering
the handoff. If an explicit caller cannot finish within its bounded attempt, it
returns the typed ready state with `history.status = 'adoption-pending'` and the
action “rerun the same requested apply/restore”; doctor reports the same action.
Guardian sees the valid row but arms no history Worker until a native handoff changes
it to `pending`. It is never a permanent rowless refusal.

The fail-closed guard is not relaxed for pre-existing files. `adoption-pending` may be
created only in the complete temp database whose final publication won from true path
absence after the private positive checks; it is never inserted into an existing
unversioned, unsupported, malformed, or rowless database and is never inferred from
residue. Such existing databases still refuse exactly as today. Caught pre-publication
cleanup may exact-identity-unlink only the unpublished temp. Among **cooperating**
processes that cleanup never unlinks a committed valid final-path row; a foreign
in-place writer can retain the same file identity, so identity is substitution
evidence rather than proof of unchanged contents.

This is a compatibility schedule over evidence the current high-level operation just
took responsibility for, not an empty baseline inferred from residue. Once the row
exists, legacy JSON fields have no authority and are removed on the next successful
non-CAS record update while all unrelated unknown keys survive.

A missing JSON file is valid and the first provenance update creates `{version:1}`.
Unreadable/unparseable JSON is not empty: provenance mutation fails closed. Unknown
members survive at the record, ledger, and individual `CodexProvenanceEntry` levels;
tests seed a nested future key in an entry and require deep-equal preservation
after an older-writer update.

## 2. One convergence entry point

Audit #2: `010` originally proposed rewiring 16 management callers to a direct
gather/commit helper while `040` never touched them, so a provider edit could commit
catalog bytes with no ownership, provenance, intent or lock check. The audited
`refreshCodexCatalogBestEffort` root has since been replaced on this branch by the
catalog-only convergence closure (`src/server/management-api.ts:133-160`), but the
shared funnel rule remains the reason that transitional implementation may not become
a second final entry point.

```ts
/**
 * The ONLY way Codex-owned bytes are written. Startup, ensure, /api/sync, the
 * CLI verbs and all 16 management mutation callbacks funnel here.
 *
 * The funnel is the point: admission, generation checks and the lock live in one
 * place, so a new caller cannot forget them. Round 1's 16 callers each held
 * their own path to a commit.
 */
export type ConvergeCodex = (
  request: ConvergeRequest,
) => Promise<ConvergeOutcome>;

export interface ConvergeRequest {
  /**
   * The caller says WHEN, never WHICH WAY.
   *
   * Round 2 N1: an `apply | remove` request let `/api/sync` skip while desired
   * state was OFF instead of removing residue, which violates C11 and
   * contradicts the rule that callers cannot supply desired state. The
   * direction is derived from admitted persisted intent, full stop.
   *
   * `observe` writes nothing and is the status read.
   */
  action: "converge" | "observe";
  /**
   * WP9 management mutations use `catalog`; explicit/lifecycle convergence uses
   * `full`. Scope limits work, but still never lets the caller choose direction.
   */
  scope: "catalog" | "full";
  /** Why, for the record and for log attribution. */
  reason:
    | "startup"
    | "ensure"
    | "api-sync"
    | "cli"
    | "cli-recover-history"
    | "management-mutation";
  /** Automatic callers fail fast and defer; explicit ones may wait. See §5. */
  mode: "automatic" | "explicit";
  deadlineMs: number;
}
```

`ConvergeOutcome` is a discriminated union, never a thrown exception for an
expected condition:

```ts
export type ConvergeOutcome =
  | { kind: "catalog-only"; changed: boolean;
      observed: CodexObservedState; catalogRefresh: CatalogDisposition;
      history: CodexHistoryState }
  | { kind: "history-recovered"; changed: boolean;
      observed: CodexObservedState; nativeGeneration: number;
      currentTxId: string | null; history: CodexHistoryState }
  | { kind: "converged"; direction: "applied" | "removed"; changed: boolean;
      observed: CodexObservedState; nativeGeneration: number;
      currentTxId: string;
      catalogRefresh: CatalogDisposition; history: CodexHistoryState }
  | { kind: "skipped"; reason: "already-converged";
      observed: CodexObservedState; catalogRefresh: CatalogDisposition; history: CodexHistoryState }
  | { kind: "refused"; authority: "service-home" | "external-provider" | "journal" | "provenance";
      message: string; observed: CodexObservedState }
  | { kind: "busy"; surface: "lock" | "history" | "config"; retryAfterMs: number }
  | { kind: "deferred"; direction: "applied" | "removed"; changed: boolean;
      unresolved: readonly UnresolvedSurface[];
      nativeGeneration: number; currentTxId: string;
      observed: CodexObservedState; catalogRefresh: CatalogDisposition; history: CodexHistoryState }
  | { kind: "failed"; surface: string; message: string };

/**
 * Note what is NOT here: `desired-off`. Desired OFF is not a skip — it is a
 * `converged` with `direction: "removed"`. That is round 2 N1: the old shape let
 * a sync while OFF return "skipped" and leave routed residue on disk.
 */
export type UnresolvedSurface =
  | "config"
  | "native"
  | "catalog"
  | "cache"
  | "journal"
  | "provenance"
  | "history";
```

This is deliberately a type alias, not the bodyless function declaration that
produced TS2391 in audit round 3. WP8b exports the type and lands no runtime
placeholder. WP9 supplies the first `convergeCodex` implementation and assigns it
to `ConvergeCodex` in the same commit that rewires catalog callers.

`ConvergeRequest`'s `cli-recover-history` reason identifies the explicit command
boundary, not a provider/direction supplied to the Worker. It is accepted only with
`action:"converge"`, `scope:"full"`, `mode:"explicit"`; convergence maps that
command to the one fixed `recover-legacy-openai` authorization. The history-only
outcome is `history-recovered`, not `converged {direction:"removed"}`, because the
native pair and routing bytes did not move.

WP9's `scope:"catalog"` implementation is **catalog-only**: it gathers,
commits, and reports catalog/cache/backup disposition while preserving each route's
primary 2xx/201. It does not inject config/profile, recover journals, or dispatch
history before WP10-WP12 land those mechanisms. WP12 strengthens that same funnel
to full observed-state convergence; there is no second entry point.
Its `catalog-only` outcome sets non-catalog observations to `not-evaluated` and uses
an ephemeral history value with `status:"not-evaluated"`, zero attempts, null txId,
operation, timer, and probe counts. It does not claim either full direction.

An unresolved surface also names its scheduler. `config` schedules a fresh
pre-gather admission; `native`, `catalog`, `cache`, `journal`, and `provenance`
schedule a full convergence for the record's current transaction; `history`
schedules the history guardian for that transaction. A scheduling write itself is
part of the durable record update, not a best-effort callback after the response.

**Best-effort callers stay best-effort.** The 16 management callbacks keep their
2xx and report the outcome in a `catalogRefresh` field; they do not start
failing loudly because a catalog refresh deferred. What changes is that the
outcome is *visible* instead of swallowed by a bare `catch`.

## 3. Generations: an expected transition, not a bare counter

Round 1 #5/#6 and round 2 N3. Three separate defects lived here.

`mutatePersistedConfig` documents its own limit (`src/config.ts:1950-1955`):

> A writer that ignores the coordinator can still change bytes after the final
> check because the filesystem has no portable conditional rename.

A content hash passes an A→B→A cycle. And my first counter was **bumped by every
native commit and compared before/after** — so a successful write always
mismatched. I specified a mechanism whose success condition was
indistinguishable from its failure condition.

### Two counters, not one

```ts
/** Bumped by every cooperating CONFIG write. Owned by src/config.ts. */
export interface ConfigGeneration { readonly value: number; }

/** Bumped by every cooperating NATIVE ROUTING commit. Owned by transition-state.ts. */
export interface NativeGeneration { readonly value: number; }

export type ConfigGenerationRead =
  | { kind: "ready"; generation: ConfigGeneration }
  | { kind: "unavailable"; reason: "busy" | "database" };

export type ConfigGenerationBump =
  | { kind: "updated"; generation: ConfigGeneration }
  | { kind: "conflict"; current: ConfigGeneration }
  | { kind: "unavailable"; reason: "busy" | "database" };

export type ExpectedConfigGenerationSyncResult<T> =
  | { kind: "matched"; generation: ConfigGeneration; value: T }
  | { kind: "conflict"; current: ConfigGeneration }
  | { kind: "unavailable"; reason: "busy" | "database" };

export type ReadConfigGeneration = () => ConfigGenerationRead;
export type BumpConfigGeneration = (expected: ConfigGeneration) => ConfigGenerationBump;
export type WithExpectedConfigGenerationSync = <T>(
  expected: ConfigGeneration,
  commit: () => T,
) => ExpectedConfigGenerationSyncResult<T>;
```

Round 2 #6: the previous version said "two counters, both in the record" and
then defined one. They are distinct because they answer different questions —
did the user's configuration move, versus did somebody else write Codex's files.

The WP9 seam audit forced a narrower definition of that second question. At native
publication, the implemented transition row requires every positive
`native_generation` to carry an ordinary native schedule whose `history_tx_id`
equals `current_tx_id`, a non-null typed `history_operation`, and a non-empty
admission-snapshot history authority id
(`src/codex/transition-state.ts:74-83`, to be amended by this contract).
`beginCodexTransition` therefore always
publishes a pending HISTORY SCHEDULE with the pair
(`src/codex/transition-state.ts:314-344`), and `assertPublished` rejects a caller
that did not publish one (`src/codex/transition-state.ts:420-428`). Advancing the
pair for catalog bytes alone would invent history work that does not exist and
cross WP10/WP12's boundary.
After that ordinary schedule reaches a terminal state, §1's explicit history-only
compatibility/recovery CAS may publish a different job while preserving the positive
native pair; that does not retroactively turn the history-only job into a routing
generation.

So the native generation identifies a **NATIVE ROUTING transition**: `config.toml`,
the generated profile, and the injection journal, exactly the artifacts whose
routing change requires history follow-up. The active catalog, hashed/legacy
catalog backups, and models cache are not routing artifacts. Rewriting them can
change what Codex lists; it cannot change where Codex sends traffic. A
`scope:"catalog"` commit therefore neither reads `CommitExpectation` nor advances
the native pair. The implemented `ConvergeOutcome` confirms that boundary:
`catalog-only` has no `nativeGeneration` or `currentTxId`, while the full routing
outcomes carry both (`src/codex/convergence-types.ts:207-224`).

That is an honest reduction in protection: a catalog-only commit is not guarded
against staleness by the native pair. Its independent protection is the per-source
observation check below plus the catalog serialization primitive that excludes every
first-party catalog/backup/cache writer through publication. A catalog-only commit
must never write a routing artifact; if a future phase needs to write one, it uses
`scope:"full"` and publishes the native transition plus its truthful history
schedule.

WP8b adds executable `readConfigGeneration`, `bumpConfigGeneration`, and
`withExpectedConfigGenerationSync` exports to `src/config.ts` with the callable
types above. They use a singleton
`config_generation(singleton INTEGER PRIMARY KEY CHECK(singleton=1), value INTEGER
NOT NULL CHECK(value>=0))` row in the existing `config-mutation.sqlite`. Creation
and `INSERT OR IGNORE (1,0)` happen under that database's `BEGIN IMMEDIATE`.
`bumpConfigGeneration({value:N})` executes
`UPDATE config_generation SET value = value + 1 WHERE singleton = 1 AND value = N`;
one changed row returns N+1, zero rows returns `conflict` with a fresh current read,
and busy/open failure returns `unavailable`. Every cooperating persisted config
commit calls the bump before committing the SQLite transaction; unchanged mutations
do not bump. This closes the former scope hole: WP9 delegates this owner to WP8b,
and `src/config.ts` is now explicitly IN.

The second seam audit caught a lock-shaped hole in that API. Reading generation N,
then later calling a synchronous catalog writer does not prevent a cooperating config
writer from committing N+1 in between. `withExpectedConfigGenerationSync(expected,
commit)` is the owner-side guard for that interval. It enters the **existing** config
mutation transaction, validates `expected` with the already-held SQLite `Database`
handle, runs `commit` synchronously on a match, and releases the transaction only
after `commit` returns. Conflict returns the current generation without invoking the
callback. Acquisition/open failure returns `unavailable`.

The implementation must call `readConfigGenerationInTransaction` (or its private
equivalent) on `configMutationDatabase`; it must not call `readConfigGeneration`,
`readConfigGenerationAtPath`, or any helper that opens a second SQLite connection.
The active transaction already owns the write lock, so a second connection would
contend with its caller instead of validating it. WP9 catalog commit is the first
consumer. This guard uses the config mutation lock that exists in WP8b and has no
dependency on WP11's future native lock. Catalog-only work validates but does not
bump the config generation because it writes no persisted OpenCodex config bytes.

### Catalog serialization is a permanent, separate primitive (seam audit rounds 3-4)

The round-3 auditor ran the retained management `POST /api/sync` chain while a
catalog candidate was paused after validation. `refreshCodexModelCatalog`
(`src/codex/refresh.ts:40-52`) reaches catalog replacement
(`src/codex/catalog/sync.ts:664-733`) and models-cache replacement
(`src/codex/catalog/sync.ts:832-850`). That writer neither advances config generation
nor enters `withExpectedConfigGenerationSync`, so the config transaction alone let it
publish Y before convergence resumed and replaced Y with bytes gathered from X. This
is a first-party writer retained by this plan, not a foreign hand edit that the
contract may merely detect.

WP9 therefore lands `src/codex/catalog-write-serialization.ts`, a cross-process
**catalog serialization primitive K** keyed by effective user plus canonical
`CODEX_HOME`. K uses its own private SQLite database returned by
`resolveCodexCatalogSerializationDatabasePath`, `busy_timeout=0`, and a
`BEGIN IMMEDIATE` transaction with bounded outer retry. Process exit releases the
transaction. It is a different database and ownership surface from the coordinator
transaction N and from `config-mutation.sqlite`; sharing either database would make
the required nesting self-contend or silently key exclusion by `OPENCODEX_HOME`.

K is permanent. It is **not** WP11's native write lock, does not read or advance the
native pair, and is not a placeholder that WP11 removes. WP11 later wraps native
routing writes in N; catalog, backup, and cache publication remains a different
surface and continues to require K after WP11 and after the four transitional roots
are removed.

K exposes a synchronous owner-held callback acquired before any config transaction;
that callback receives a fresh catalog-write permit for that acquisition. Every
low-level catalog/hashed-backup/legacy-backup/models-cache mutator requires the
permit. The callback may enter `withExpectedConfigGenerationSync`, but performs no
provider request, runtime probe, OAuth refresh, subprocess, Promise, or other awaited
work. At WP9, convergence's outer async orchestration may retry a fail-fast K
acquisition within `deadlineMs`, but each acquisition attempt and the complete K -> C
publication callback are synchronous. Lock busy/unavailable follows each retained
function's existing no-write or write-failure path rather than changing it to a
Promise.

Round 4 showed why “the replacement is under K” is not enough. The audited retained
`/api/sync` chain read the active catalog, captured `onDiskCatalog`, awaited provider
gathering, and only then wrote from that captured state. The landed branch now makes
that seam visible: it captures pre-await evidence (`src/codex/catalog/sync.ts:619-630`),
then after gathering acquires K, revalidates and rereads the active catalog before
writing (`src/codex/catalog/sync.ts:736-775`). The contract requires that corrected
shape because taking K after an await cannot by itself make captured X fresh. Cache
invalidation and restore are also read-transform-write operations, not bare
replacements.

Only slow provider/network gathering may therefore remain outside K. Every
first-party catalog root uses exactly one of these two freshness shapes:

1. **Under-K recomputation:** acquire K before the authoritative filesystem read,
   perform the deterministic read-transform/derivation and every resulting write
   while K remains live. This is required for the synchronous retained startup and
   CLI cache invalidation roots and native restore; they have no provider/network
   await that justifies a pre-K filesystem snapshot. If a compatibility helper has
   already prepared such state, it repeats the authoritative read and derivation
   under K and discards the pre-K result.
2. **Evidence-bound precomputation:** slow provider/network work and deterministic
   preparation may run before K only when every filesystem value, absence, selector,
   and process-local authority that influenced the result is sealed as candidate
   evidence. After acquiring K, the writer revalidates that complete evidence before
   any mutation. Catalog convergence returns `stale` on drift; retained `/api/sync`
   discards/regathers or follows its existing no-write/write-failure path without
   changing its public return shape. Both use this shape so provider gathering stays
   outside K without treating the earlier `onDiskCatalog` as current merely because K
   was later acquired.

No retained root may mix the shapes by reading X before K and then performing only
the transform or replacement under K. Public signatures, return shapes, slow-provider
gather order, and compatibility behavior stay unchanged; the freshness boundary does
not. K makes the state-producing read-transform-write transaction serializable by
lock-held recomputation or lock-held evidence validation, not just by guarding its
last rename.

The same round exposed a second absence-as-proof defect. An opaque TypeScript type
proves only that a permit-bearing call path exists; it cannot prove the callback still
holds K. `src/codex/catalog-write-serialization.ts` therefore owns a module-private
active-permit registry. Each successful `BEGIN IMMEDIATE` acquisition mints a new
unexported permit object and transaction identity and registers their binding to the
canonical `CODEX_HOME`. There is no public constructor, brand, or registration API.
Every low-level mutator calls the K owner's runtime assertion with its permit and the
canonical `CODEX_HOME` that owns the target set before its first filesystem mutation,
including temp creation, hardening, unlink, link, rename, truncate, or replacement.
That owning home is not inferred from a target parent because an accepted configured
catalog target may be absolute and outside `CODEX_HOME`. The assertion accepts only
the exact registered object whose transaction is still active and whose bound home
equals the mutator's supplied owning home.

The K owner revokes/removes the permit in `finally` **before** committing/rolling back
and releasing K, including callback throws. One live permit may authorize the fixed
sequence of low-level mutations in its own callback; it cannot be reused by a later K
acquisition, even for the same home. A leaked post-callback permit, an object forged
through a cast/prototype/symbol copy, a revoked permit presented during another
transaction, and a live permit for home A presented to a home-B writer all refuse
before any filesystem mutation. The symbol graph remains a useful reachability check,
but runtime liveness/home validation is the proof that K is actually held.

The global order is:

```text
native/coordinator transaction N, when present
  -> catalog serialization K, when catalog/backup/cache bytes may be written
       -> config transaction C, when generation admission is required
            -> synchronous validation and artifact writes
       -> release C
  -> commit N while K is still held for a full transition, then release K
-> release N
```

Thus catalog-only work takes `K -> C`; a retained writer that is already under N
takes `N -> K`; and full convergence takes `N -> K -> C`. There is no `C -> K`, no
`K -> N`, and no catalog path acquires history H. A history Worker separately takes
`H -> N` for its fail-fast claim read and terminal CAS; both N acquisitions have
`busy_timeout=0` and finish before H is released. There is no `N -> H`, `K -> H`, or
`C -> H`, and the history Worker never enters K or C. The combined graph is therefore
the DAG `H -> N -> K -> C`; adding H does not invalidate WP9's settled
`N -> K -> C` proof because it adds only a new source edge and no edge back to H.
Using the already-open N capability
to publish/commit its row while K is held is not a new acquisition edge. Config-owned
callbacks remain forbidden from calling either N or K. A graph test protects those
negative edges, including inverse-edge fixtures for `N -> H`, `K -> H`, and
`C -> H`, plus cross-domain Worker fixtures for `H -> K` and `H -> C`. This extends,
rather than reverses, the settled N -> C discipline.

### The expected transition

```ts
export interface CommitExpectation {
  /** Read at admission. */
  readonly nativeBefore: number;
  /** What OUR full routing commit will produce. Always nativeBefore + 1. */
  readonly nativeAfter: number;
  /** Identifies the commit that performed the bump. */
  readonly txId: string;
}
```

The rule, stated so a test can check it:

> After the commit, the coordinator row must show **exactly** `nativeAfter` AND `txId`
> equal to ours. `nativeAfter` with a different `txId` is another writer that
> raced us to the same number. Anything else is interference: the outcome is
> `deferred` with the surface named, never `converged`.

The earlier “there is no window” claim was wrong. Process exclusion cannot make
separate file replacements and the coordinator-row update atomic. Holding
N + K + C provides **no cooperating native/config/catalog interleaving while the
process is alive**; a crash can still leave any prefix of the artifact sequence with
the old coordinator pair.

Recovery for a `scope:"full"` routing transition is therefore artifact-specific.
Config, generated profile, catalog, hashed/legacy backups, cache, and journal
recover only from their ledger baseline plus matching post-image; a missing/null
post-image preserves and refuses. History rows, manifest entries, and rollouts
remain `pending` and are re-probed/repaired by the history guardian. A missing
record with native residue or an invalid/ambiguous record refuses automatic
deletion. On restart, observation compares every artifact to the ledger/current
pair, records the unresolved surfaces, and schedules a fresh current transition;
idempotence is required but is not described as filesystem atomicity. Catalog-only
staleness is instead admitted by the source observations below, not retroactively
described as protection by a pair it never advanced.

### Prevention for cooperating writers (round 2 #5, seam audit rounds 2-3)

C2 says a stale candidate **cannot be committed**. Detect-after-commit permits
exactly the write C2 forbids. Full routing work later follows `030`'s N -> C lock
order. WP9 catalog-only work must not acquire that future native lock, so its fix is
the permanent K -> C composition: catalog serialization plus the owner-side
config-generation guard, both independent of WP11.

The first amendment named the config lock but not an API that held it through catalog
publication. The auditor's N -> N+1 interleaving was therefore a cooperating config
writer the text promised to prevent. Catalog commit enters K first and then
`withExpectedConfigGenerationSync`: generation validation and the complete
synchronous catalog commit execute inside one already-held config transaction while
the catalog permit remains live. The round-3 retained-writer interleaving is excluded
by K even though that writer does not cooperate with config generation.

So:

| Writer | Mechanism |
|---|---|
| cooperating config writer (ours) | **prevented** — K remains held while `withExpectedConfigGenerationSync` holds C through validation and synchronous commit |
| cooperating catalog/backup/cache writer (ours, including all four WP9 transitional roots) | **prevented** — every real replacement requires the same CODEX_HOME-keyed K permit |
| non-cooperating (hand edit, foreign tool) | **detected** when its drift is visible at final revalidation, reported `deferred`; a write after that check remains outside the claim |

Re-gather is bounded by `deadlineMs`. On expiry the outcome is `deferred` with a
typed reason and another convergence is scheduled — the retry loop terminates on
a deadline, not on hope (round 1 #5's missing termination rule).

### Target identity, honestly bounded

A candidate records the canonical parent directory and the file identity
(dev+inode where available) of each target, not the textual path — a parent
symlink can retarget while the path string is unchanged, and `atomicWriteFile`
resolves the effective target only at commit (`src/config.ts:192-213`).

The WP9 seam auditor then demonstrated the missing content dimension by gathering
a candidate, truncating and rewriting the catalog in place, and committing the
stale candidate. Path, canonical parent, parent identity, file identity, config
generation, and native pair all remained unchanged. Target identity says where a
write will land; it does not say that the bytes gather consumed are still current.

The catalog admission snapshot therefore retains a required **catalog-home
selection observation** plus a closed set of **role-bearing source observations**
for every filesystem source whose presence, absence, or bytes influenced
preparation. Home selection records whether the raw selector came from the
`CODEX_HOME` environment value or the default resolver, the uncanonicalized raw
selector string, the resulting canonical CODEX_HOME path, and that root directory's
filesystem identity. The active catalog, each consulted hashed/legacy backup or
models-cache fallback, runtime/auth selection state, and any later file source all
identify why they were consulted. `$CODEX_HOME/config.toml` remains the required
`catalog-target-selection` observation. Its ABSENCE selects the default catalog
path, so absence is evidence and is recorded even though there is no byte buffer to
hash.

For a present source, the observation owner computes SHA-256 from the **same exact
buffer** it returns. A separate pre-read is not equivalent. For an absent source,
it records the consulted logical path, the canonical missing-leaf path derived from
the canonical parent, stable parent identity, and `fileIdentity:null`. Immediately
before the first commit write, commit re-observes every candidate-bound source and
compares state, logical/canonical path, parent identity, file identity, and digest
where present. PRESENT -> ABSENT, ABSENT -> PRESENT, identity drift, or digest drift
is `stale`. An unreadable source, an unresolvable canonical parent/source, or
ambiguous identity is refused rather than assumed unchanged. Thus a config file
that appears after default-target gather cannot authorize a commit to the obsolete
default target even when that target's own parent, inode, and bytes never moved.

The same under-K-and-C check first re-reads the current raw environment/default
selector, re-runs the production home resolver, and compares selector kind, raw
string, canonical home, and root identity with the captured observation. It then
derives again, from that re-resolved home, `config.toml`,
the default catalog, models cache, and every relative configured catalog target, and
recomputes the catalog/backup/cache target set. Every derived target must equal the
candidate's logical and canonical target evidence before any write. A selector
symlink retarget from A to B is therefore `stale` even if A's `config.toml`, catalog,
parent, and inode remain byte-for-byte unchanged. The accepted A -> B -> A exclusion
still applies only when the complete excursion returns to identical selector, root,
source, and target evidence before this check.

Process-local runtime and bundled-catalog memos are not filesystem observations, but
round 3 proved they are still authority when their values influence a candidate. Each
owner therefore maintains a process-lifetime monotonic epoch and an immutable value
identity. Population, replacement, clear, invalidation, persisted-runtime write, and
test reset increment the applicable epoch before exposing the new state; epochs are
never reset or reused, and memo values are immutable. The exact epoch and value
identity returned with a consumed runtime or bundled template are sealed into the
private candidate and compared with the owner's current pair under K and C before
the first write. Any change, including invalidate-and-repopulate with byte-identical
content, is `stale`.

Round 4 made “immutable” operational rather than aspirational. The audited tree
returned `resolveCache.value` and `bundledCatalogCache.value` directly, so a caller
could change authority without owner assignment, invalidation, or epoch movement.
The current worktree now exposes recursively readonly runtime shapes and clones plus
deep-freezes cache publication/reads (`src/codex/runtime.ts:16-48,90-105,417-470,505-516`),
and the bundled owner does the same (`src/codex/catalog/bundled.ts:60-138,268-302`).
The contract requires that landed behavior; it must not regress to the audited alias.

The runtime and bundled-cache owners must instead clone incoming values into private
owner snapshots, recursively freeze every reachable object and array before
publication, and never return the private cache object itself. A read API returns a
detached recursively frozen clone or an immutable view paired with the owner's
epoch/value identity; that returned graph and the candidate's sealed copy must not
provide a mutable alias back to owner state. Shallow `Object.freeze` is insufficient.
The cache-backed read interfaces expose recursively readonly shapes as well as runtime
enforcement; TypeScript `Readonly<T>` at the top level alone is not the contract. Any
intentional cache change goes through the owner assignment/invalidation API, which
constructs and deep-freezes a new private snapshot and increments the epoch before
exposing it.
Existing tests and callers may no longer rely on mutating an object returned by
`resolveCodexRuntime` or the bundled loader to alter cache state.

When runtime identity influences a candidate, `codex-runtime.json` is additionally
an **always-required** `runtime-selection` filesystem observation, PRESENT or ABSENT,
even when the runtime came from a warm process memo. A PRESENT persisted selection is
parsed from the exact observed buffer and a warm runtime is usable only if its
identity agrees; ABSENT permits a matching warm runtime but binds that absence to the
candidate. A later process that creates, replaces, or removes the file is therefore
caught by source re-observation even though it cannot advance this process's epoch.
The bundled memo uses its epoch/value identity directly; no fake filesystem source is
invented for an in-memory value.

This is deliberately per-source evidence from one gather. It is not the deleted
`ContentRevision` design, does not hash the whole persisted configuration, and does
not turn content into a global revision or transition authority. That rejected
design tried to make one content value stand in for cooperating generations and
failed the A→B→A case. This check instead binds a prepared catalog candidate to the
finite set of filesystem observations that produced it while leaving config
admission and native routing authority with their existing owners.

**What this does not do** (round 2 #6): it cannot detect a parent-symlink A→B→A
that happens entirely between two checks. C17 is therefore scoped to *cooperating
transitions and single-direction drift*, not to arbitrary filesystem ABA. Claiming
otherwise would be a promise the filesystem does not offer.

The same limit applies to source observations: they detect single-direction state,
identity, and content drift, including ABSENT -> PRESENT and an ordinary in-place
truncate-and-rewrite, but not a full state/content A→B→A that returns to identical
evidence before the commit check. The re-observation is also not filesystem
atomicity; a non-cooperating writer can still change bytes after the final
comparison. The outcome must preserve those C17 bounds rather than promote a digest
into a guarantee the filesystem cannot provide.

### Catalog single-flight is bound to gather authority (seam audit round 5)

Round 5 reproduced the same absence-as-equivalence defect before candidate
construction. `providerCatalogFingerprint` covers endpoint and catalog fields but
omits `authMode`, `apiKey`, and `headers`
(`src/codex/catalog/provider-fetch.ts:476-499`). `gatherFlightKey` hashes that partial
projection (`src/codex/catalog/provider-fetch.ts:501-520`), even though flight capture
resolves credential-bearing request authority
(`src/codex/catalog/provider-fetch.ts:408-445`) and model fetch branches on the
captured auth mode (`src/codex/catalog/provider-fetch.ts:814-826`). The in-flight map
lookup is the join boundary (`src/codex/catalog/provider-fetch.ts:1128-1169`). A generation-N forward-auth gather
can therefore supply empty bytes to a generation-N+1 key-auth admission; B's later
K -> C validation is honest but irrelevant because no evidence says A produced the
joined result.

The reviewed intermediate WP9 worktree prefixed that key with a plain SHA-256 of the
auth-store buffer. The current branch has already replaced that specific mistake with
a process-keyed auth identity and full provider-graph comparison
(`src/codex/catalog/provider-fetch.ts:408-445,1114-1124,1134-1161`). That landed
partial repair does not weaken this contract: result authority, complete source and
process evidence, and the no-stable-credential-digest rule remain required rather
than inferred from a map-key implementation.

This contract keeps single-flight sharing rather than prohibiting all cross-admission
sharing. The admission gate exists to suppress a thundering herd of provider model
requests, and simultaneous management mutations using the same resident config and
the same observed authority are legitimately equivalent. The narrower rule is that
**only complete gather-authority equality may share**. Different resident config
references do not share even when their JSON content happens to match. Different
config generations, auth snapshots, native-catalog/source inputs, or relevant
process-local observations do not share. Prohibiting every cross-admission join would
be safe but would discard that useful equivalence and multiply upstream requests.

Before consulting the in-flight map, gather constructs and recursively freezes one
`CatalogGatherAuthorityIdentity`. Its components are:

1. the opaque process-local WeakMap identity of the exact retained
   `Readonly<OcxConfig>` reference, its admitted `ConfigGeneration`, and a snapshot
   identity of the exact config graph at admission. Canonical encoding preserves
   object-key presence, primitive type, array order, and sorted object keys; a value
   that cannot be encoded exactly is refused. The snapshot identity detects an
   illicit in-place mutation, while the reference identity preserves the settled
   exact-resident-config contract;
2. an auth snapshot for every enabled provider: provider name, effective auth mode,
   credential state, exact resolved API-key or observe-only OAuth access-token bytes
   (or explicit absence), the exact `provider-auth-selection` observation that chose
   an OAuth account/token, and the final discovery method, URL, and normalized header
   set after transport defaults. Beside it, a detached recursively frozen effective
   discovery-policy snapshot records the registry-transport match outcome, the exact
   `url`/`path`/`query` location policy (including explicit absence), the final method
   and URL, the complete declarative filter, and the clamped `maxResponseBytes` and
   `maxModels`. Header names are lowercase and sorted; values remain byte-exact inside
   the keyed input. Forward and local modes are explicit states, not absence;
3. the exact native-slug/source input. When combo resolution needs native rows, the
   filesystem-evidence owner returns a detached immutable ordered slug/capability
   snapshot and records every consulted active-catalog/cache source, PRESENT or
   ABSENT, under the closed `native-catalog-selection` role. Its identity also covers
   the exact process-static registry, generated Jawcode metadata, and pinned upstream
   snapshot revisions used to derive provider/native rows. When native input is not
   consulted, an explicit `unused` value is part of the identity;
4. an identity of the complete source-evidence session sealed for flight launch,
   including home/target selection and every auth/native observation captured so far;
5. relevant process-local input: the exact runtime and bundled memo evidence plus a
   per-provider immutable model-cache/cooldown snapshot with monotonic owner epoch and
   value identity. Provider cache/cooldown evidence binds flight admission and join
   equivalence; it is not added to K -> C revalidation because the flight itself may
   advance that cache while producing its immutable result. The already-settled
   runtime/bundled evidence remains candidate-bound and is revalidated at commit.

No credential is stored in that identity. At process start the gather-authority owner
mints an unexported random 256-bit HMAC key. Each `*Identity` above is a
domain-separated HMAC-SHA-256 over a length-prefixed canonical encoding of the exact
inputs just listed; `authorityId` is another domain-separated HMAC over the component
tuple. The key, canonical plaintext, API keys, OAuth tokens, and header values are
never exported, logged, serialized, placed in `CatalogDisposition`, or used as a
stable cross-process identifier. A plain SHA-256 of a credential, an API key copied
into `providerCatalogFingerprint`, or a stable unsalted digest is forbidden because
it turns the in-flight key into credential material or an offline guessing oracle.
The private candidate's existing exact-buffer source digest may still revalidate the
`provider-auth-selection` file under K -> C; it is HMACed as input to the flight
identity and never becomes the map key, result surface, log, or response itself.
The opaque HMAC values are process-local and may be discarded when the flight settles.

The in-flight owner stores `{ authority, promise }`, not a bare promise. Its primary
bucket is `authorityId`, but joining additionally requires exact equality of the
deep-frozen component identities; a mismatch or collision starts a distinct admitted
flight (or returns typed busy when the admission gate is full). The flight receives
the captured config/auth/discovery-policy/native/source/process snapshots as
arguments and may not re-resolve them after claiming its slot. That prohibition binds
the whole post-await tail, not only the join decision: round 8 found
`augmentRoutedModelsWithRegistryOpenAiApiRows` re-reading the registry after the
network await, so a flight could key and carry its authority honestly and still emit
bytes derived from a policy that changed while it waited. The current branch passes
the captured policy into the post-await augmentation
(`src/codex/catalog/provider-fetch.ts:1200-1213,1330-1337`). Every downstream
augmentation input — including the registry-transport match outcome that decides
whether trusted OpenAI rows are added — is passed in from the captured snapshot.
`GatherFlightResult` carries the exact
authority identity that produced its models and omissions. Before candidate
construction, every caller compares that result identity with its own expected
identity. Inequality discards the result and returns retryable `stale` or regathers
within `deadlineMs`; it never builds or commits a candidate. This result check is
required defense in depth even though the map key should already prevent the join.

### The provider model-cache decision is captured before flight lookup (round 6)

Round 6 found that component 5 named authority which WP9 did not own. The current
owner stores mutable `CatalogModel[]` values and returns the private array from both
fresh and stale reads (`src/codex/model-cache.ts:17-21,147-155`), while `setCached`
retains the caller's array alias (`src/codex/model-cache.ts:158-168`). It also has no
epoch around cooldown mutation, clear, reconciliation, or budget eviction
(`src/codex/model-cache.ts:74-86,172-208,225-226`). A caller can therefore mutate a
nested cached model in place and change the next gather without any owner-observed
assignment or identity movement. This is the same defect already closed for the
runtime and bundled owners, not evidence that mutable aliases are safe here.

`src/codex/model-cache.ts` is consequently **IN for WP9**. Duplicating an epoch or a
snapshot in `provider-fetch.ts` is rejected: it would let the consumer attest to a
copy while the canonical cache/cooldown owner continued to change invisibly. The
owner stores only private recursively deep-frozen clones; `setCached` never retains
the caller's array or any nested object/array. `getFreshCached`, `getStaleCached`, and
the flight-specific decision reader return detached recursively deep-frozen,
recursively readonly snapshots, never the private graph. Shallow array cloning or
top-level `Object.freeze` does not satisfy this rule.

The owner maintains one process-lifetime monotonic epoch. Every result-affecting
owner mutation advances it before the replacement is observable: every `setCached`
publication even when the replacement is byte-identical, every
`markModelsFetchFailure` cooldown change, every state-changing `clearModelCache`,
every accepted reconciliation generation (including its provider removals), and
every successful budget eviction. The epoch is never reset or reused. Discovery
status and warning-suppression bookkeeping stay outside this identity only while no
catalog result reads them; if a future gather branch consumes one, that field and
all of its mutations enter this same owner snapshot before that branch lands.

After config, effective auth, native-source, and runtime/bundled inputs are captured,
but **before the first `gatherInflight` lookup**, gather calls the model-cache owner
synchronously once with the ordered enabled-provider set, the admitted TTL/cooldown
durations, and one clock observation. For every provider the owner returns a detached,
deep-frozen closed decision snapshot: `unused`, `fresh-cache`, `cooldown`, or
`network`; the used variants carry the exact detached fresh/stale model value or
explicit absence, owner epoch, `fetchedAt`/`failureAt` where present, and the exact
`freshUntil`/`cooldownUntil` boundary that produced the decision. The
gather-authority owner computes the process-keyed value identity over that exact
snapshot and includes the ordered tuple in `modelCacheDecisionIdentity`.

The keyed flight receives those decision snapshots as arguments. After claiming its
slot it may not call `getFreshCached`, `getStaleCached`, or
`isModelsFetchCoolingDown`, and a network-failure fallback uses the stale value sealed
before lookup rather than re-reading the owner. The flight may publish success or
failure through the owner's ordinary mutation APIs; those writes advance the epoch,
which prevents a later caller from joining on the superseded decision. Time passage
does not fake an epoch mutation: a caller captured after `freshUntil` or
`cooldownUntil` gets a different effective decision identity even when the owner
epoch and stored bytes are unchanged. Callers captured on the same side of the same
boundary may still share, preserving the intended thundering-herd suppression.

### Create-once means no-clobber publication (seam audit round 2)

Hashed and legacy catalog backups are immutable first-winner snapshots. The ordinary
`atomicWriteFile` helper cannot publish them: its final rename replaces an existing
destination (`src/config.ts:213` in the audited tree). An absence check followed by
that helper is a check-then-write race, not create-once.

`src/codex/internal/catalog-writer.ts` therefore owns a synchronous atomic
no-clobber publication primitive. It creates and hardens a unique temp beside the
resolved target, then publishes with an operation whose contract is
**destination-must-not-exist** — an exclusive hard link (`link`) or a platform
rename-without-replace equivalent. Ordinary overwriting rename is not a fallback.
The temp is scrubbed/removed on every unpublished path.

`EEXIST` means another process won publication after our validation. The writer
must resolve, read, and validate that winner as a regular, non-routed catalog backup
under stable parent/file identity. A valid winner is preserved and the receipt says
`preserved`; malformed, unreadable, routed, symlinked, or identity-ambiguous content
is refused. The loser never unlinks, truncates, or overwrites the winner. A
check-absent-then-`atomicWriteFile` sequence does not satisfy this contract, even if
the earlier target-identity check was correct.

## 4. Admission returns a snapshot, not a boolean

Audit #8: `040`'s intent reader returns ON/OFF while `010`'s gather needs a full
`OcxConfig`, so either gather uses the stale server object or the claimed
"two reads" is wrong.

```ts
/** Why a filesystem observation influenced catalog preparation. Closed by contract. */
export type CatalogRequiredSourceRole = "catalog-target-selection";

export type CatalogConditionalSourceRole =
  | "bundled-catalog-template"
  | "active-catalog-merge"
  | "hashed-backup-fallback"
  | "legacy-backup-fallback"
  | "models-cache-fallback"
  | "native-catalog-selection"
  | "runtime-selection"
  | "provider-auth-selection";

export type CatalogSourceRole =
  | CatalogRequiredSourceRole
  | CatalogConditionalSourceRole;

/** Portable normalized identity: POSIX dev/inode or Windows volume/file id. */
export interface CatalogFilesystemIdentity {
  readonly volume: string;
  readonly fileId: string;
}

export interface CatalogParentIdentity extends CatalogFilesystemIdentity {
  readonly canonicalPath: string;
}

/** Required evidence for the selector that chose every CODEX_HOME-derived path. */
export interface CatalogHomeSelectionObservation {
  readonly selector: Readonly<{
    readonly kind: "environment" | "default";
    /** Exact pre-canonicalization selector string used by the production resolver. */
    readonly raw: string;
  }>;
  readonly canonicalCodexHome: string;
  readonly rootIdentity: CatalogFilesystemIdentity;
}

export type CatalogProcessLocalObservation =
  | { readonly state: "unused" }
  | { readonly state: "used"; readonly epoch: number; readonly valueIdentity: string };

/** Candidate-bound evidence for mutable process-local authority, never file evidence. */
export interface CatalogProcessLocalEvidence {
  readonly runtime: CatalogProcessLocalObservation;
  readonly bundledCatalog: CatalogProcessLocalObservation;
}

/** Flight-only cache/cooldown authority, captured before any in-flight lookup. */
export interface CatalogProviderModelCacheDecisionEvidence {
  readonly provider: string;
  readonly ownerEpoch: number;
  /** Process-keyed HMAC of the exact detached owner snapshot and decision. */
  readonly valueIdentity: string;
  readonly decision:
    | Readonly<{ kind: "unused" }>
    | Readonly<{ kind: "fresh-cache"; freshUntil: number }>
    | Readonly<{ kind: "cooldown"; cooldownUntil: number;
        stale: "present" | "absent" }>
    | Readonly<{ kind: "network"; freshUntil: number | null;
        cooldownUntil: number | null; stale: "present" | "absent" }>;
}

/** Non-secret-bearing identity of every authority input admitted to one gather flight. */
export interface CatalogGatherAuthorityIdentity {
  readonly version: 1;
  /** Process-local keyed HMAC over every component below; never a raw content hash. */
  readonly authorityId: string;
  readonly admittedConfig: Readonly<{
    /** Opaque WeakMap identity of the exact resident Readonly<OcxConfig> reference. */
    readonly referenceIdentity: string;
    readonly generation: ConfigGeneration;
    /** Keyed HMAC of the exact canonical config snapshot, including secret-bearing fields. */
    readonly snapshotIdentity: string;
  }>;
  readonly authSnapshotIdentity: string;
  /** HMAC of every result-affecting field in the detached effective discovery policy. */
  readonly discoveryPolicyIdentity: string;
  readonly nativeCatalogSourceIdentity: string;
  readonly sourceEvidenceIdentity: string;
  readonly processLocalEvidenceIdentity: string;
  /** HMAC of the ordered per-provider decisions captured before flight lookup. */
  readonly modelCacheDecisionIdentity: string;
}

/** Exact gather-time evidence for one consulted filesystem source. */
export type CatalogSourceObservation<R extends CatalogSourceRole = CatalogSourceRole> =
  | {
      readonly state: "present";
      readonly role: R;
      readonly logicalPath: string;
      readonly canonicalPath: string;
      readonly parentIdentity: CatalogParentIdentity;
      readonly fileIdentity: CatalogFilesystemIdentity;
      /** Digest of the exact buffer returned to gather. */
      readonly sha256: string;
    }
  | {
      readonly state: "absent";
      readonly role: R;
      readonly logicalPath: string;
      readonly canonicalPath: string;
      readonly parentIdentity: CatalogParentIdentity;
      readonly fileIdentity: null;
    };

export type CatalogRequiredSourceObservations = Readonly<{
  [R in CatalogRequiredSourceRole]: CatalogSourceObservation<R>;
}>;

export type CatalogConditionalSourceObservations = Readonly<{
  [R in CatalogConditionalSourceRole]: readonly CatalogSourceObservation<R>[];
}>;

export interface CatalogSourceEvidence {
  /** Required before any CODEX_HOME-derived target or source path is accepted. */
  readonly homeSelection: CatalogHomeSelectionObservation;
  readonly required: CatalogRequiredSourceObservations;
  /** Every role is a required key; an empty list means the role was not consulted. */
  readonly conditional: CatalogConditionalSourceObservations;
}

/** The shared WP8b/WP9 snapshot; it authorizes catalog work only. */
export interface CatalogAdmissionSnapshot {
  config: Readonly<OcxConfig>;
  generation: ConfigGeneration;
  /** Exact retained-reference/generation/snapshot identity used by gather authority. */
  readonly configIdentity: CatalogGatherAuthorityIdentity["admittedConfig"];
  targets: Readonly<{
    catalog: string;
    cache: string;
    catalogBackups: readonly string[];
  }>;
  /** Candidate-bound present/absent evidence, produced by the sole read owner. */
  sourceEvidence: CatalogSourceEvidence;
}

export interface AdmissionSnapshot {
  config: Readonly<OcxConfig>;
  configDigest: string;
  intent: "on" | "off";
  generation: number;
  ownership: "owned" | "foreign" | "unknown";
  externalProvider: string | null;
  canonicalTargets: Readonly<{
    codexHome: string;
    opencodexHome: string;
    config: string;
    profile: string;
    catalog: string;
    cache: string;
    journal: string;
    integrationRecord: string;
    catalogBackups: readonly string[];
    historyDb: string;
    historyManifest: string;
    historyRollouts: readonly string[];
  }>;
  journalIdentity: string;
  provenanceIdentity: string;
  /** Digest of every authority field above; passed to the history Worker. */
  authoritySnapshotId: string;
}
```

The role set is closed because “refuse an incomplete list” was not enforceable on an
array of present-file digests: a caller could omit the absent source that selected a
default and leave no evidence of the omission. Pre-gather capture now starts with
the required `homeSelection`, the required `catalog-target-selection` observation
for the logical `$CODEX_HOME/config.toml` path, PRESENT or ABSENT, and every
conditional role key present as an empty list. Gather does not mutate that snapshot.
It returns the prepared candidate with an immutable copy whose conditional lists
contain every filesystem consultation in order, including absent alternatives that
caused a fallback and `native-catalog-selection` whenever native combo rows consult
active catalog/cache state, plus sealed `CatalogProcessLocalEvidence` and the complete
`CatalogGatherAuthorityIdentity` that produced the result. A missing home selection,
required role, conditional role key, required runtime-state observation, used-cache
epoch/value identity, config identity, or gather-authority component is structurally
invalid; commit accepts only the private candidate-bound evidence.

All gather filesystem reads route through the one evidence-producing owner,
`src/codex/catalog/filesystem-evidence.ts`. It owns an opaque gather-evidence
session: source reads append the matching PRESENT or ABSENT observation before
returning, while target probes append the existing target parent/file identity
evidence. Callers never append, remove, or reconstruct evidence arrays themselves;
only the owner can seal the complete session into the private candidate, and sealing
requires home selection plus the `catalog-target-selection` role. Raw `readFileSync`, `Bun.file`,
`existsSync`-then-read, `lstat`/`realpath` target probing, catalog helper, or indirect
wrapper that consults the filesystem outside that owner is a contract violation.
The symbol-granular graph test follows imports, aliases, re-exports, wrappers, and
literal dynamic imports to prove every gather filesystem read reaches that owner.
Adding a new source purpose requires adding a role here first, so an untyped array
cannot silently expand the authority surface.

The earlier one-read claim is withdrawn. Catalog admission and full admission have
different authority sources and must not be collapsed:

1. **Catalog pre-gather (WP9):** the management factory captures one exact resident
   `Readonly<OcxConfig>` reference and passes that same reference to catalog
   admission. `CatalogAdmissionSnapshot.config` is that object; the factory closure
   is the sole runtime caller of snapshot capture, and route callers receive no
   config parameter with which to substitute another authority. Catalog admission
   does not independently reconstruct full config from disk. It assigns the exact
   reference an opaque WeakMap identity, binds it to the observed generation, and
   computes the process-keyed config snapshot identity before any flight lookup.
   This deliberate capture is what prevents a route from substituting catalog
   authority. Admission separately observes config generation, raw/default home selection plus canonical
   home/root identity, targets, and the required `$CODEX_HOME/config.toml`
   `catalog-target-selection` role before gather. If runtime identity later
   influences the candidate, gather records `codex-runtime.json` PRESENT or ABSENT
   and seals the runtime/bundled memo epoch and immutable value identity actually
   consumed. Before provider work, gather completes the auth, native-source,
   source-session, and process-local components, then may join only a flight carrying
   the equal complete authority identity.
2. **Catalog under-lock (WP9):**
   acquire K, then
   `withExpectedConfigGenerationSync(snapshot.generation, commit)` validates the
   generation through the already-held config transaction and runs the complete
   synchronous catalog commit before C and K release. Commit re-resolves and compares
   home selection/root identity and every derived target, re-observes every
   candidate-bound `sourceEvidence` entry, and revalidates each used process-local
   epoch/value identity immediately before its first write. It does not read or
   advance a native `CommitExpectation`.
3. **Full pre-gather/under-lock/post-commit (WP12):** full admission reads persisted
   config and every authority/target field into snapshot A, fully re-reads snapshot B
   under N -> K -> C coordination whenever catalog bytes may be written, and
   post-commit re-reads persisted config plus every native/catalog/history surface
   into `CodexObservedState`. It never uses the server's long-lived object as a
   persisted-config fallback. Missing, unreadable, or invalid persisted config
   produces unknown/refusal. The outcome is not `converged` unless final observation
   agrees with admitted intent and the exact expected native pair.

`010`'s independent gather-time `readConfigDiagnostics()` remains removed: WP9 has
the captured management reference plus generation/source evidence, while WP12's
full admission owns its persisted diagnostic reads. Those are separate contracts,
not two interchangeable ways to populate one snapshot.

## 5. `/api/sync`, defined once

Audit #4: three phases defined this route and the last one dropped `Retry-After`
and both payload fields.

| `ConvergeOutcome` | Status | Body |
|---|---|---|
| `catalog-only` | 200 | `{ ok: true, changed, observed, catalogRefresh, history }` |
| `history-recovered` | 200 | `{ ok: true, changed, observed, nativeGeneration, currentTxId, history }` |
| `converged` | 200 | `{ ok: true, changed, observed, catalogRefresh, history }` |
| `skipped` (`already-converged`) | 200 | `{ ok: true, changed: false, observed, catalogRefresh, history }` |
| `refused` | 409 | `{ ok: false, authority, message, observed }` |
| `busy` | 503 + `Retry-After` | `{ ok: false, surface, retryAfterMs }` |
| `deferred` | 200 | `{ ok: true, changed, unresolved, observed, catalogRefresh, history }` |
| `failed` | 500 | `{ error: message, surface }` |

`busy` is 503 with `Retry-After` because it is transient and the client should
retry; `refused` is 409 because retrying changes nothing until a human acts.
`deferred` is 200 because the admitted bounded work DID happen — one or more
durably scheduled surfaces are outstanding and named, not collapsed into success.

There is no `desired-off` row, per §2: a converge while OFF removes and returns
`converged { direction: "removed" }`.

**One adapter, one place.** `src/server/management/sync-response.ts` exports a
single exhaustive `toSyncResponse(outcome): Response`. `010`, `020` and `040`
each mapped this route themselves (round 1 #4, still open in round 2); none of
them may now. The exhaustiveness is enforced by a `never` check on the union, so
adding an outcome variant without a row fails typecheck.

## 6. History: one lock, with overtaking detected and repaired

Round 1 #1 had no home; round 2 showed my first answer had two holes.

The real apply path writes manifest → rollouts → DB
(`src/codex/history-provider.ts:606,611,626`); restore writes rollouts → DB →
manifest deletion → a second ejection
(`src/codex/history-provider.ts:657,667,677,691`). SQLite guards only one of those
steps, so two processes corrupt each other through the files it never sees.

**One cross-process history lock**, acquired inside the Worker, held across the
entire unit — manifest, rollouts and the DB transaction together, including the
final post-probe. H is a distinct SQLite database, not an unnamed lock and not N's
database reused under another label. `resolveCodexHistorySerializationDatabasePath`
in §7 owns its final path from effective user identity, canonical `CODEX_HOME`, and
canonical state-DB identity. Every process consumes that path verbatim. Reusing N
would make the Worker's required coordinator reads self-contend; allowing callers to
invent H's path would split exclusion so two processes could each believe they own
the same history unit.

H and N are sibling databases but the lock order is **H -> N**, not “never held
simultaneously.” The live APIs prove the edge: the Worker calls
`readCodexTransitionState`, whose initialization path acquires `BEGIN IMMEDIATE`
(`src/codex/transition-state.ts:473-482`), for fail-fast admission and later calls
`updateCodexHistoryTransition`, which acquires another `BEGIN IMMEDIATE`
(`src/codex/transition-state.ts:521-533`), for terminal CAS while H remains held.
Both are fail-fast N acquisitions. The inverse edges `N -> H`, `K -> H`, and
`C -> H` are forbidden; §3 records why the resulting `H -> N -> K -> C` graph is
acyclic and keeps WP9's order valid.

Two things round 2 caught:

**Explicit CLI history still runs inline** through direct sync/restore calls
(`src/cli/index.ts:528,591,756,768,829`), outside any future history lock. Every
history caller takes this lock — server, CLI, startup, retry. A lock one caller can
skip is not a lock.

**Direction is not operation.** The coordinator row persists the §1
`CodexHistoryOperation` and its history job id, and every claim/retry/terminal CAS
matches both. Current behavior has five materially different authorizations:
`syncResumeHistory:false` means touch nothing (`src/codex/inject.ts:602-604`);
legacy apply backs up and tags `opencodex`; loopback apply migrates legacy rows to
`openai`; removal consumes the manifest and restores native state; and
`recover-history --legacy-openai` invokes only the unbacked legacy eject path
(`src/cli/index.ts:711-717`, `src/codex/history-provider.ts:701-710`). The Worker
derives its writer from the durable operation. A compatibility IPC field such as
`targetProvider` or direction, if temporarily retained during migration, is
validated against that operation and disagreement refuses before probe or write;
it never overrides the row.

**Unreadable is not absent — the ninth recurrence of this unit's defect.** The
current `readBackup` turns malformed JSON, unsupported shape, and a manifest for a
different state DB into `{entries:{}}` (`src/codex/history-provider.ts:204-216`),
and the pending probe starts from zero and swallows the failure
(`src/codex/history-provider.ts:749-754`). That lets a zero/zero post-probe certify
convergence from evidence it never read: once again, absence was treated as a
guarantee.

The sole manifest reader returns `CodexHistoryManifestRead<T>`. Only a genuinely
missing path returns `kind:"missing"`, `manifest:null`, and `backupEntries:0`.
The tenth absence-as-guarantee review found the opposite present case: the real
reader accepts a matching v1 manifest with `entries:{}`
(`src/codex/history-provider.ts:204-217`), and restore treats it as the ordinary
empty-manifest branch before ejecting residual routed rows
(`src/codex/history-provider.ts:656-665`). The first-party writer normally deletes an
empty manifest (`src/codex/history-provider.ts:220-226`), but writer policy cannot
erase valid evidence that the reader actually found.

Therefore every present valid matching v1 manifest returns `ready`, including zero
entries. Only the manifest validator constructs
`NonNegativeHistoryManifestEntryCount`, after proving an integer greater than or
equal to zero; `ready` with literal zero is valid only through that validator, while
negative, fractional, or non-finite counts are impossible. This option keeps file
presence in `kind:"ready"` and preserves the existing restore/ejection branch without
adding a second ready-state control path. Read/permission failure returns
`unreadable`, readable unsupported version/shape returns `unsupported`, and a valid
manifest naming another canonical state DB returns `foreign-state-db`. Every failure
preserves the file byte-for-byte, carries `backupEntries:null`, prevents all history
mutation, and blocks convergence. `unreadable` maps to `unknown/unreadable`,
`malformed`/`unsupported` to `unknown/schema`, and a foreign manifest to
`blocked/foreign-state-db`; no path deletes, replaces, or consumes failed evidence.

**Sibling locks permit overtaking, but the handoff itself may not be unordered.** A
releases N after atomically authorizing ON history; B may then acquire N and commit
native OFF while A traverses under H. That overtaking is intentional. What the latest
review rejected is a post-native/pre-authorization hole: no retained caller may write
native state before taking N or release N before publishing its compatibility
schedule. The previous check against `nativeBefore` was also the wrong side. After
A's future WP11 native commit, the record is expected to contain A's
`{ nativeAfter, txId }`, not `nativeBefore`; WP10's bridge leaves that pair unchanged
but replaces the complete older history identity while the same N exclusion is live.

This contract chooses **detect-and-repair**, not a transition gate shared across
the complete history unit. The guarantee is eventual convergence to the latest
durable native transition:

1. WP10's retained roots hold N from before native mutation through the compatibility
   authorization and commit the complete `history_status='pending'` schedule before
   any Worker spawn. WP11/WP12 later write `{nativeAfter, txId}` and that same complete
   schedule in one conditional row update. In both phases, if spawn never occurs or
   the Worker dies, the guardian/startup reader still has durable work to schedule.
2. A Worker checks that the coordinator row contains its `{nativeAfter, txId}` plus
   exact history job id, operation, and authority kind/id immediately after
   acquiring H through the fail-fast `H -> N` read. A mismatch returns
   `pending/overtaken` without mutation and schedules observation of the current row.
3. Because a newer native transition or history-only recovery authorization can
   commit during traversal, the Worker uses the §1 conditional SQLite update for its
   terminal history state. Its `WHERE` matches native pair, history job id, and
   operation. A zero-row CAS
   means its result is stale; it does not touch JSON, overwrite the newer pending
   schedule, or clear the winner's timer, and returns `overtaken`.
4. If an old Worker mutated history before detecting that final conflict, the newest
   transition remains durably pending and runs after the old Worker releases the
   history lock. Therefore stale history may exist temporarily, but it cannot become
   the terminal recorded state or cancel repair of the winner.

This is narrower than prevention. No test or caller may claim an old Worker cannot
write after a newer native commit; the testable claim is that the latest pair stays
durably scheduled and eventually owns the clean under-lock post-probe, even across
spawn failure, Worker death, or process restart.

Ordering, so absence of deadlock is checkable: WP10's compatibility native exclusion
**is N**. Its callback may enter K and then C where the retained native/catalog path
already requires them, authorizes history through the already-open N handle, and
releases N before history dispatch; it never calls H. A Worker holds H while
traversing and attempts only fail-fast short N transactions at claim/terminal
boundaries; it never invokes the native callback, K, or C. `SQLITE_BUSY` at N leaves
the current pending row intact, releases H, and retries from durable state. Thus the
existing DAG remains `H → N → K → C`: the handoff adds work *inside* N and no edge
back to H. The graph tests require the real `H -> N` edges and reject inverse
`N -> H`, `K -> H`, and `C -> H` reachability through direct imports, wrappers,
aliases, re-exports, and dynamic imports; they also reject the unneeded Worker edges
`H -> K` and `H -> C`.

## 7. The lock namespace has one environment-independent root per effective user

Round 1 #7 said `homedir()` reads `HOME`/`USERPROFILE`, so a service and a CLI
for the same user can take different locks. I accepted the fix — use
`os.userInfo().homedir` — and specified it.

The reviewer then **ran it on our pinned Bun 1.3.14**, and I reproduced the run:

```
HOME=/tmp/fakehome bun -e '...'
homedir:  /tmp/fakehome
userInfo: /tmp/fakehome
uid: 501   username: jun
```

Both home accessors return the fake environment path in this runtime. The
accepted fix does not work where we ship.

But the same probe shows the way out: **`uid` and `username` are real.** So the
coordination namespace keys on effective-user IDENTITY, never on a home path:

```ts
/**
 * Effective-user identity for the lock namespace.
 *
 * NOT a home path. Bun 1.3.14 returns an environment-controlled home from both
 * os.homedir() AND os.userInfo().homedir, so any home-derived namespace can be
 * split by a service and a CLI that see different HOME values — which defeats
 * exclusion entirely, silently.
 */
export type UserIdentity =
  | { platform: "posix"; uid: number }
  | { platform: "win32"; sid: string };
```

The key alone was not enough. The earlier `<os-runtime-dir>` called an undefined
resolver and allowed service/CLI processes to choose different parents through
`TMPDIR`, `XDG_RUNTIME_DIR`, or `LOCALAPPDATA`. The private root resolution used by
the final-path resolver below reads none of those variables.

```ts
/**
 * Resolve the effective account from operating-system identity APIs only.
 * Failure is a typed namespace refusal; username/home/environment fallback is
 * forbidden because it can split one account across two lock databases.
 */
export type ResolveEffectiveUserIdentity = () => UserIdentity;

/**
 * Return the FINAL SQLite coordinator database path for this exact canonical
 * CODEX_HOME. Consumers append no uid/SID, version, directory or filename.
 */
export type ResolveCodexCoordinatorDatabasePath = (
  identity: UserIdentity,
  canonicalCodexHome: string,
) => string;

/** Return K's FINAL database path; this is never the native coordinator path. */
export type ResolveCodexCatalogSerializationDatabasePath = (
  identity: UserIdentity,
  canonicalCodexHome: string,
) => string;

/**
 * Return H's FINAL database path for one canonical state database identity.
 * Consumers append nothing and may not substitute N or K's path.
 */
export type ResolveCodexHistorySerializationDatabasePath = (
  identity: UserIdentity,
  canonicalCodexHome: string,
  canonicalStateDbPath: string,
) => string;
```

WP8b implements and exports constants of the identity and coordinator function types
from `src/codex/user-identity.ts`; it does not ship declarations without bodies. WP9
adds the catalog-serialization resolver there with K, and WP10 adds the history
serialization resolver there with H. These are the only three exported
final-path resolvers; the private secure-root resolver is shared but is never exported
for consumer path composition. WP11, transition state, history, tests, cleanup, and K
consume their returned database path verbatim. No consumer appends `opencodex`, a
lock-directory name, `v1`, uid/SID, the home digest, or `.sqlite` a second time.

The canonical state-DB identity is path identity, not current inode identity. If the
DB exists, resolve it with `realpathSync.native`; if it is missing, resolve its
existing canonical parent and append the single basename without following a missing
leaf. Normalize Windows drive/UNC case exactly once. Reject a relative path,
non-directory/unsafe parent, symlink/reparse ambiguity, or a canonicalization failure.
Do not key H by dev/inode: SQLite replacement or recovery may change the inode while
the logical database still requires the same exclusion. Do not key it by the raw
request path: aliases would split the lock.

Exact platform algorithm:

- **macOS and Linux:** obtain the effective uid from `getuid(2)` (Bun
  `process.getuid()` is the public call). Require `/tmp` to resolve by
  `realpathSync.native`, be a real directory owned by uid 0, and have the sticky
  bit plus world-write/search semantics. The root is
  `<real-/tmp>/opencodex-runtime-v1-<decimal-uid>`. Create that one component with
  mode `0700`; on every use, `lstat`/descriptor checks require a non-symlink real
  directory, exact effective uid, and exact `0700`. There is no `/run/user`,
  `XDG_RUNTIME_DIR`, `TMPDIR`, home, or cwd fallback. Failure refuses.
- **Windows:** open the current process effective token with `TOKEN_QUERY`, call
  `GetTokenInformation(TokenUser)`, and canonicalize it with
  `ConvertSidToStringSidW`. Blank/malformed SID or any API failure refuses; account
  name and `USERPROFILE` are not fallbacks. Resolve `FOLDERID_LocalAppData` with
  `SHGetKnownFolderPath` for that same effective token, ignoring the `LOCALAPPDATA`
  environment variable. The root is
  `<known-folder>/OpenCodex/Runtime/v1/<canonical-SID>`. Resolve and inspect each
  component without following a reparse redirect, then require/harden an ACL owned
  by that SID that grants only that SID, `SYSTEM`, and `Administrators`. Known-folder,
  SID, canonicalization, reparse, owner, or ACL failure refuses; there is no temp or
  ProgramData fallback.

The final path returned by `resolveCodexCoordinatorDatabasePath` is
`<resolved-per-user-root>/native-write-locks/<sha256-of-canonical-CODEX_HOME>.sqlite`;
the final path returned by `resolveCodexCatalogSerializationDatabasePath` is the
distinct sibling
`<resolved-per-user-root>/catalog-write-locks/<sha256-of-canonical-CODEX_HOME>.sqlite`.
The final path returned by `resolveCodexHistorySerializationDatabasePath` is the
third sibling
`<resolved-per-user-root>/history-write-locks/<sha256-of-length-prefixed-(canonical-CODEX_HOME,canonical-state-DB-path)>.sqlite`.
Length-prefixing is mandatory; string concatenation with a separator is not a tuple
encoding. Thus the same user/home/DB resolves one H across service and CLI processes,
while two state DBs under one home do not serialize each other and H can never equal N
or K. H uses `busy_timeout=0` and `BEGIN IMMEDIATE`; bounded waiting belongs to the
Worker's outer acquisition loop, not SQLite.
POSIX directories are `0700` and files `0600`; Windows applies the required ACL to
the root, databases, and rollback journals. Every existing component is checked
before use and again through stable descriptors around SQLite open/transaction
boundaries. A symlink, junction/reparse redirect, wrong owner, broad mode/ACL, or
substituted path is a refusal, never something the resolver repairs in place.

The test that matters, and the one my first version could not have failed: two
child processes with different `HOME`, `USERPROFILE`, `TMPDIR`, `XDG_RUNTIME_DIR`,
`TEMP`, `TMP`, and `LOCALAPPDATA` values but the same effective uid/SID and canonical
`CODEX_HOME` and canonical state DB must resolve the same **three final database
paths**, take the same N, K, and H locks respectively, and read/update the same
singleton transition row. A second canonical state DB must retain the same N/K paths
but resolve a different H. All three paths must differ so nested `N -> K` and `H -> N`
cannot self-contend on SQLite's database-wide writer slot.

## 8. Names

Audit #13. Fixed here so no phase invents a variant:

| Thing | Module |
|---|---|
| the native write lock | `src/codex/codex-write-lock.ts` |
| the catalog serialization primitive K | `src/codex/catalog-write-serialization.ts` |
| the history serialization primitive H | `src/codex/history-lock.ts` |
| the record | `src/codex/integration-record.ts` |
| the entry point | `src/codex/convergence.ts` |
| generations | `src/codex/generation.ts` |
| history worker | `src/codex/history-worker.ts` |

### Writer inventory and permitted roots, versioned by landing phase

The previous rule — “every low-level writer is under `internal/` and only
`convergence.ts` may reach it” — was unsatisfiable. `history-worker.ts` must call
history writers directly after it acquires the history lock. A module guard also
cannot distinguish importing a reader from importing a writer when both symbols
live in `inject.ts` or `journal.ts`. The inventory, not a directory slogan, is the
contract. This first table is the **WP12 final state**, not a claim that WP9 has
already migrated lifecycle and explicit callers:

| Domain | Low-level writer owner | WP12 final permitted runtime roots |
|---|---|---|
| native config/profile | `src/codex/internal/native-writer.ts` | `src/codex/convergence.ts` only |
| injection journal create/mark/restore/remove | `src/codex/internal/journal-writer.ts` | `src/codex/convergence.ts` only |
| catalog, hashed/legacy backups, models cache | `src/codex/internal/catalog-writer.ts`, each mutation requiring K's runtime-validated live permit | `src/codex/convergence.ts` only |
| history serialization transaction H | `src/codex/history-lock.ts` | `src/codex/history-worker.ts` only |
| history DB rows, manifest, rollout files | history write exports in `src/codex/internal/history-writer.ts` | `src/codex/history-worker.ts` only |
| transition pair and typed history schedule/terminal row | `src/codex/transition-state.ts` | `src/codex/convergence.ts` and `src/codex/history-worker.ts` only |
| JSON provenance ledger | `updateIntegrationRecord` in `src/codex/integration-record.ts` | `src/codex/convergence.ts` only |
| persisted OpenCodex config bytes and config generation | private writers in `src/config.ts` | exported `saveConfig`, `mutatePersistedConfig`, `saveConfigPreservingClaudeCode`, and the generation API in that same module only |

`src/codex/internal/catalog-writer.ts` is the contract-owned name. Phase documents
must use it; `internal/catalog-commit.ts` is not an alternate name for this owner.

WP9 has a narrower migration boundary: it moves the 16 management mutation
callbacks behind catalog convergence but intentionally leaves these four legacy
writer chains until WP12 installs full admission, observation, provenance, and
lifecycle convergence:

| WP9 transitional legacy root | Exact writer chain still permitted | WP12 final action |
|---|---|---|
| management `POST /api/sync` | `src/server/management/config-routes.ts` -> `src/codex/sync.ts` -> `src/codex/refresh.ts` -> provider gather -> K -> evidence revalidation -> catalog writer | rewire to full convergence and `toSyncResponse` |
| server startup cache invalidation | `src/server/index.ts` -> K -> authoritative cache read/derivation -> models-cache writer | route startup through full convergence/observer |
| CLI `sync-cache` | `src/cli/index.ts` -> K -> authoritative cache read/derivation -> models-cache writer | route the CLI command through full convergence |
| native restore | `src/codex/inject.ts` -> K -> authoritative backup/catalog read/derivation -> catalog restore writer | move restore behind full convergence/provenance |

This is an exact transitional allowlist by root module and writer symbol, not a
directory wildcard. `src/codex/sync.ts`, `src/codex/refresh.ts`, CLI, and
`src/codex/inject.ts` are therefore permitted only through the rows above at the
WP9 commit; no fifth legacy root may appear. WP12 removes every row and activates
the final table. Their signatures, return values, slow provider/network gather order,
and compatibility behavior do not change in WP9. Retained `/api/sync` binds its pre-K
provider gather to complete source/process evidence and revalidates that evidence
after K acquisition; the other three synchronous retained chains acquire K before
their authoritative filesystem read and keep it through deterministic derivation and
write. Each path supplies a runtime-live, same-home permit, after N if a later phase
has already placed that root under N. A contract test cannot enforce both versions at
once, and WP10 adds a real intermediate producer. The graph fixture therefore carries
an explicit
`"wp9-transitional" | "wp10-history-isolation" | "wp12-final"` inventory version:
WP9 expects exactly four catalog legacy chains; WP10 retains those four and adds only
these history scheduling edges:

| WP10 transitional root | Permitted transition-state symbols | Required authority |
|---|---|---|
| `src/codex/history-job.ts` | `withCodexCompatibilityNativeHandoff`, `authorizeCodexLegacyHistoryRecovery` | bound `wp10-compatibility` closure or `explicit-legacy-recovery`; never `admission-snapshot` |
| `src/codex/history-worker.ts` | `readCodexTransitionState`, `updateCodexHistoryTransition` | exact row-copied native pair, job, operation, and authority |

`history-job.ts` receives the convergence-derived operation; it does not derive from
or accept a Worker `targetProvider`/direction. It may schedule and supervise but may
not import a manifest/rollout/history-DB writer. WP12 changes the four catalog roots
and `history-job.ts` authorizer root to zero; `history-worker.ts` remains the sole H
and history-writer root and retains only claim/terminal coordinator access.

At the WP12-final transition, `inject.ts` is split: observation/parsing and pure
config/profile transforms stay readable there; every export that calls
`atomicWriteFile`/`unlinkSync` moves to `internal/native-writer.ts`. `journal.ts` is
split into read/validate/classify code (`journal.ts`) and the four mutating
operations in `internal/journal-writer.ts`. The writer half may import the reader
half; the reader half never imports or re-exports the writer. `catalog.ts` likewise
stops re-exporting direct writer symbols, while WP9 may move the four transitional
callers to explicit writer imports solely to keep their unchanged behavior
compiling. These splits are required before the WP12-final reachability assertion
can mean “reader imports are safe.”

The contract test publishes the phase-appropriate table as data and walks static imports, dynamic
imports, re-exports and aliases at **symbol** granularity. Every inventoried writer
must have exactly the permitted roots for that phase, and every filesystem/SQLite
mutator of a Codex-owned artifact must appear in the inventory. In the WP12-final
version, `history-job.ts`, management routes, CLI modules, `sync.ts`, `refresh.ts`,
`inject.ts`, and `journal.ts` are not permitted roots; they call convergence,
dispatch a Worker, or read only. That final prohibition must not be applied to the
four explicit WP9 transitional rows and the narrow WP10 scheduling rows before WP12
owns their migration.
At every inventory version, every catalog/backup/cache mutator must be reachable only
with K's permit and must call K's runtime liveness/transaction/home assertion before
its first filesystem mutation. Inverse-order graph fixtures reject `C -> K` and
`K -> N` even through wrappers, aliases, or re-exports. They also require the two
real Worker coordinator calls to establish `H -> N` and reject `N -> H`, `K -> H`,
`C -> H`, `H -> K`, and `H -> C` through the same indirections.

## 9. Baseline classes

Two, not three. A provenance baseline is `absent` or `present`, and `present`
carries the exact baseline bytes — which already expresses restoration for every
Codex artifact.

The `present-required-nonempty` class I added in the first version is **removed**
(round 2 #4). It came from the live Pi incident in
`005_disable_leaves_a_broken_file.md`, where a disable left `models.json` as `{}`
and violated Pi's required-`providers` schema. That is real, and it belongs to
`FOLLOWUP-FILECLIENT-01` with the rest of the six file clients — which this unit
lists as out of scope. It named no baseline bytes, no client schema and no
validator, because a Codex unit has nowhere to get them.

Housing a finding in the wrong unit is not housing it.

## Test plan

`tests/codex-integration-record.test.ts`: a v1 record with only `history` is
rejected as legacy transition state rather than treated as current authority; a
provenance-only record is valid. Unknown record, ledger, and individual-entry keys
survive a write, including a nested future object on one `CodexProvenanceEntry`;
unparseable fails closed rather than resetting. Missing creates only
`{version:1,provenance}` when provenance first writes.

`tests/codex-transition-state.test.ts`: two processes use different
`OPENCODEX_HOME` values and one canonical `CODEX_HOME`, resolve one final database
path, and observe one singleton row. Two native updates expecting `{0,null}` race;
exactly one conditional UPDATE changes one row and the loser returns `conflict`.
Pause an old Worker, publish a newer pair plus pending schedule, then finish the old
Worker: its terminal UPDATE changes zero rows and cannot alter JSON or the winner's
schedule. Change only the durable operation under the same native pair/job fixture
and require the stale terminal CAS to change zero rows. Table-drive every native
direction/operation pair and reject impossible combinations. Authorize explicit
`recover-legacy-openai` against a terminal row without advancing the native pair;
the same CAS must refuse a pending/running row and a stale prior job/operation.
Exercise the WP10 compatibility authorizer for each non-recovery operation against
generation zero and a positive unchanged native pair; it persists
`wp10-compatibility`, never advances the pair, and refuses stale prior authority.
When called through the N-bound handoff after a newer retained native mutation, it
must replace terminal, pending, and running older schedules with a fresh pending
identity. The old Worker's terminal CAS must then change zero rows. Its authority id
must not equal or derive from config/credential bytes and must not reach logs, JSON,
responses, or exceptions. Give B a deliberately stale complete row read before N,
let A publish a newer schedule, then enter B's handoff. B's callback retains that
stale object but has nowhere to pass it: the bound authorizer must use A's complete
row read from B's already-open N handle and publish B. Instrument coordinator
connection creation so any second handle throws; the handoff still succeeds with one
connection. **Broken changes:** restore an `expected` argument, call
`readCodexTransitionState()` inside the callback, or let the authorizer open another
coordinator connection; B conflicts after its native mutation or the second-handle
trap fires.
The general missing-DB/table path initializes only from native-clean/no-legacy state;
outside the explicit compatibility-adoption fixture, legacy JSON pair/schedule,
residue beside a missing row, malformed row, busy DB and unsafe path all fail closed
with the specified typed outcome. A valid `adoption-pending` row is the sole new
ready state: read/doctor may report it, but Worker/guardian and explicit recovery may
not turn it into history work.

`tests/codex-native-residue.test.ts`: add two compatibility-adoption fixtures that
begin with routed config, routed catalog, routed history rows/rollouts/manifest, and
**no coordinator database** under temporary homes. The apply fixture enters the real
`injectCodexConfig` high-level path
(`src/codex/inject.ts:482-654`); the restore fixture enters real
`restoreNativeCodex` (`src/codex/inject.ts:765-800`). Each must acquire N before its
retained callback, atomically no-clobber-publish the exact generation-zero
`adoption-pending` identity before that callback, then conditionally change that same
row to the current exact pending compatibility operation before Worker dispatch;
restore remains authorized even though its native callback removes the routed
config/catalog residue captured before publication. The Worker then repairs history
and terminally owns the same schedule. Run matching
negative fixtures for observe/read, guardian/Worker retry, explicit recovery,
operation/intent mismatch, invalid legacy JSON, indeterminate residue, and an existing
unversioned or rowless database; none may create a row or invoke the native callback.
**Broken changes:** route the handoff through the strict clean-only initializer, let
mere residue detection opt into adoption, publish a rowless/unscheduled `{0,null}`
database, let Worker/guardian dispatch `adoption-pending`, or authorize restore from a
post-callback clean observation; the real apply/restore fixture returns
`legacy-ambiguous`, dispatches history before native recovery, or the named negative
fixture creates authority.

Add a cross-process no-clobber race to `tests/codex-transition-state.test.ts`. Process
A and B both finish complete valid temp databases after observing final-path absence,
then race the final no-replace publication. Exactly one final name appears; it is a
validated v1 `adoption-pending` database from one contestant. The loser receives
`EEXIST`, scrubs only its unpublished temp, opens the winner as existing ready state,
and never overwrites or unlinks the final name. Separately place a foreign
unversioned/rowless file before publication and require strict refusal before the
native-callback sentinel. **Broken changes:** restore the stale
`databaseWasAbsent` + SQLite `create:true` path, use ordinary replacing rename, or
treat an existing rowless file as adoption authority; the final row is malformed,
the loser replaces the winner, or the callback sentinel fires.

Add child-process termination checkpoints to
`tests/codex-transition-state.test.ts` and
`tests/codex-native-residue.test.ts`: kill after exclusive temp creation but before
SQLite open, after SQLite open/complete temp commit but before publication,
immediately after no-clobber publication but before temp-alias cleanup/final reopen,
and during the retained native callback. In the first two cases the final path stays
absent and a subsequent real apply/restore publishes normally. In the latter two the
final path is a complete validated `adoption-pending` coordinator; the next real
apply/restore reads it as ready, re-runs its current native callback under N, changes
it to the exact pending compatibility schedule, and dispatches its Worker. Callback
throw and authorization rejection leave the same durable `adoption-pending` row and
return its documented rerun action; they do not unlink the final database. **Broken
changes:** create the final path before schema/row commit, publish with replacing
rename, dispatch a Worker directly from `adoption-pending`, or clean the final path in
`finally`; a killed child leaves rowless refusal, a competing winner is clobbered,
history runs before native completion, or the next operation cannot recover.

`tests/codex-convergence-contract.test.ts`: every `ConvergeOutcome` variant maps
to the §5 row, `busy` carries `Retry-After`, and a best-effort management caller
still returns 2xx while reporting a non-converged disposition. Concatenate all
TypeScript fences in document order, prepend the §1 `OcxConfig` import, and compile
with the repository TypeScript compiler so WP8b cannot regress to TS2304 or a
bodyless TS2391 declaration. Table-drive each artifact observation and require
`isApplied` only for the fully applied aggregate. A catalog-only commit neither
requests a `CommitExpectation` nor changes the native pair, and its projected
outcome has no pair fields. Prove `withExpectedConfigGenerationSync` validates on
the already-held transaction: while its callback is paused, a second cooperating
process cannot commit N+1, and the callback's catalog bytes finish before the lock
is released; conflict never invokes the callback. Instrument connection creation so
the guard cannot regress to `readConfigGenerationAtPath` and self-contend through a
second SQLite handle.

Table-drive history-operation derivation through the real full-admission inputs:
apply plus `syncResumeHistory:false` -> `skip`; legacy apply ->
`apply-opencodex`; loopback apply -> `migrate-openai`; remove ->
`restore-openai`; and the explicit recovery command ->
`recover-legacy-openai` through its history-only authorization CAS. No route or CLI
passes `targetProvider` or direction to the Worker. A migration-compatibility
fixture that injects either field with a disagreeing value must refuse before the
manifest probe or any writer call.

Add the distinct round-3 two-process catalog barrier. Process A gathers catalog X,
acquires K then C, completes generation/home/source/epoch/target validation, and
pauses immediately before its first write. Process B invokes the **real retained**
management `POST /api/sync` chain through `refreshCodexModelCatalog`, not a writer
stub or direct permit helper, and prepares Y. B must not replace catalog or cache
while A is paused. B may follow its retained no-write/failure path on fail-fast lock
unavailability or retry after A releases; if it later succeeds, final bytes are Y.
The forbidden trace is Y then X with A reporting `committed`. Reverse acquisition
order as well: if B wins K first, A must revalidate after it acquires K and return
stale rather than replace Y. Run the same exclusion shape for startup cache
invalidation, CLI `sync-cache`, and native restore, and require the inventory graph
to reject any catalog/backup/cache write reachable without K's permit.

Round 4 requires the direction that barrier did not cover. First let a retained
`/api/sync` A read X and begin slow provider gathering **before it owns K**. Let
convergence B acquire K and publish Y, then resume A so it acquires K second. A must
revalidate its complete pre-K evidence and discard/regather through its unchanged
public result path; it must not replace Y with X-derived bytes. Repeat with retained
`/api/sync` B as the K-first publisher,
so retained-vs-retained is covered independently of convergence. For the synchronous
startup cache invalidation, CLI `sync-cache`, and native restore roots, instrument the
authoritative filesystem read and prove it cannot begin before K; pause after that
read and prove a second retained/convergence writer cannot publish until the complete
read-transform-write releases K. The forbidden trace in every case is “A gathered X
first, B published Y under K, A acquired K second and restored X-derived bytes.”

Exercise K's runtime permit assertion against real temporary targets and a mutation
spy. Leak a permit and call a writer after its callback, present that revoked permit
during a later acquisition for the same home, forge a permit through a type cast and
prototype/symbol copying, and pass a still-live home-A permit to a home-B writer. Each
attempt refuses before temp creation, chmod, link, rename, unlink, truncate, or target
replacement, and target bytes remain unchanged. A fresh permit may authorize all
fixed writes inside its own live callback; this is distinct from reusing it in another
K transaction.

Table-drive every `CatalogSourceRole`. Gather from a present source,
truncate-and-rewrite that same inode, and require `stale` before any write. Gather
with `$CODEX_HOME/config.toml` absent, then create it with
`model_catalog_json` selecting another target; require `stale` with the old target
byte-identical. Repeat PRESENT -> ABSENT and present-byte/path changes. A compile
fixture omitting `homeSelection`, `required["catalog-target-selection"]`, or any
conditional role key must fail, while the complete shape compiles. The symbol graph
must fail when any gather reader performs or reaches a raw filesystem consultation
outside `catalog/filesystem-evidence.ts`, including an absence-only `existsSync`
branch and a direct target-identity `lstat`/`realpath` probe.
Unreadable or ambiguous re-observations refuse.

Create real temporary homes A and B and a raw `CODEX_HOME=current` symlink selecting
A. Gather against `A/a.json`, retarget `current` once to B without changing any A
file, and require the under-K-and-C home re-resolution to return stale with zero
writes to either home. Assert raw selector, canonical home, root identity, and every
derived config/default-catalog/cache/relative-configured target are compared. The
fixture must go red if admission retains only A's resolved `config.toml` evidence.

Warm runtime R1 and bundled template B1, then gather a candidate that consumes both.
While provider gathering is paused, replace/invalidate each process memo and require
its monotonic epoch/value check to reject before write, including invalidate then
repopulate with byte-identical data. Separately gather from warm R1 while
`codex-runtime.json` is observed ABSENT; create a persisted R2 from another process
without advancing config generation and require stale. Repeat PRESENT replacement
and removal. A candidate influenced by runtime identity but missing the PRESENT-or-
ABSENT `runtime-selection` observation is structurally refused. A PRESENT R2 that
disagrees with warm R1 may not be used to prepare a candidate in the first place.

Obtain runtime and bundled-cache results through their real public read APIs, gather a
candidate from them, and then attempt nested object and array mutation through the
returned values. The owner snapshot must remain byte-for-byte unchanged and the
mutation must be impossible because the returned detached clone or immutable view is
recursively frozen. If a supported explicit owner mutation is used instead, it must
move the epoch and the pending commit must return `stale` before any write. The
fixture must go red when either API returns its private cache object directly or
freezes only the top level; rewrite the existing runtime test that mutates the shared
alias so it uses the intentional owner mutation seam.

Add the round-5 live-flight authority matrix. Pause request A after generation N
forward-auth authority has claimed its provider flight. Persist N+1 with key auth and
an API key, capture request B from the new resident config, and resume both. B must
start a distinct flight or reject the joined result as retryable stale; it must never
construct or commit a candidate carrying A's empty result. Force a bucket collision
and prove the result-carried identity check still rejects A. The named broken mutation
**restore the legacy `providerCatalogFingerprint`/`gatherFlightKey` and remove the
result-authority equality check** reproduces the empty B catalog.

Repeat with unchanged config/generation while the exact observe-only OAuth-store
buffer changes active account/token state during A's live flight. B's
`provider-auth-selection` observation and auth snapshot identity must differ, so B
runs separately or rejects A's result. The named broken mutation **omit the OAuth
source observation and effective token from `authSnapshotIdentity`** makes B join and
accept A. Repeat with unchanged config/auth while the active native catalog/cache
observation changes the ordered native slug/capability input used by combo assembly.
B must not accept A's native rows. The named broken mutation **omit
`native-catalog-selection` and `nativeCatalogSourceIdentity` from flight identity and
result validation** makes the test red. Each fixture asserts the second caller's
candidate authority equals its own admission, while instrumented log/response/
serialization sinks receive neither the private identity nor the API key, OAuth
token, configured secret header, or their plain SHA-256 values.

Add the round-6 provider-cache decision matrix using the real owner APIs and a fake
clock. Pause A after its complete authority, including provider decisions, is captured
but before its flight settles. Mutate a nested object/array through the original
`setCached` input and through both public cache readers; neither attempt may alter the
owner snapshot. Then publish byte-identical models, mark a fetch failure/cooldown,
clear the provider, reconcile it away, and evict it through the real memory-budget
hook, one case at a time. Every actual owner mutation must advance the monotonic epoch,
give B a different model-cache decision/value identity, and prevent B from joining or
accepting A. The named broken mutations are **retain the `setCached` input alias or
return the private nested graph**, **skip the epoch bump for byte-identical
`setCached`**, **skip the failure/cooldown bump**, **skip the clear bump**, **skip the
reconciliation bump**, and **skip the eviction bump**; each must turn its own row red.
The harness instruments every required mutation path so omitting any one bump cannot
be masked by another mutation in the same row.

Without mutating the owner, capture A immediately before `freshUntil` and another A
immediately before `cooldownUntil`, cross exactly one boundary, and capture B. B must
receive `network` rather than `fresh-cache` or `cooldown` and must not join the
pre-boundary flight. The named broken mutation **key only the owner epoch/value while
re-reading TTL or cooldown after flight lookup** makes both boundary rows red. A flight
uses its sealed fresh/stale/absence decision and never calls the three cache/cooldown
readers after claiming its slot.

These privacy cases are behavioral sink assertions. Round 6 verified that
`bun run privacy:scan` still passes against the currently broken plain credential-
store digest, so scanner success is supplemental hygiene and is never accepted as
proof that keys, results, logs, serialization, or responses omit raw credentials and
stable unkeyed digests.

Race two create-once backup publishers after both observed ABSENT. Exactly one
no-clobber publication wins; the loser receives `EEXIST`, validates and preserves
the winner, and neither ordinary rename nor `atomicWriteFile` is called. Repeat with
malformed, unreadable, routed, symlinked, and identity-ambiguous winners and require
refusal without changing winner bytes. The graph inventory fixture runs as
`wp9-transitional` with exactly four catalog legacy chains, as
`wp10-history-isolation` with those four plus only the two typed history scheduling
rows, then as `wp12-final` with no legacy/compatibility authorizer root; a fifth WP9
catalog root, an overbroad WP10 `history-job.ts` edge, or a retained WP12 root fails.

`tests/codex-user-identity.test.ts`: real child processes vary every environment
home/runtime variable named in §7 and resolve the same three final database paths for
one effective uid or SID, canonical `CODEX_HOME`, and canonical state DB, with N, K,
and H paths pairwise distinct. A second state DB changes only H. Raw aliases that
canonicalize to the same state DB resolve the same H, and inode replacement at that
canonical path does not change H. POSIX
activates wrong owner/mode/symlink and non-sticky `/tmp` refusal through a
resolver seam; Windows CI activates token/SID failure, known-folder failure, reparse,
owner, and broad-ACL refusal. No case falls back to an environment directory.

WP10's Worker tests pause an old Worker during traversal, commit a newer transition,
then let the old mutation finish. Its terminal SQLite CAS must change zero rows, the
newer pending state must survive, and the guardian must repair it. Repeat with spawn suppressed,
Worker death, timeout, shutdown cancellation, unreadable/schema probes, and terminal
record-write failure; every failed probe count is null and the latest transition
remains durably schedulable.

Add both native-handoff orderings forced by the latest review. First, let A authorize
and reach `running` under H, then let B acquire N, complete the opposite retained
native mutation, replace A's running schedule with B's pending identity, and block at
H until A finishes; A loses its terminal CAS and B repairs all three surfaces.
Second, pause A after its last real native write but before its transaction-bound
authorization, then start B's attempt to authorize first. B must not enter its native
callback or complete authorization while A owns N; after A authorizes/releases, B
performs its native mutation and authorizes second. The concrete broken changes are
**release N after native mutation but before authorization**, **open N only after the
native callback returns**, and **restore the terminal-only compatibility predicate**:
the attempted inversion publishes B first or the running-schedule case drops B, and
the final-state/terminal-CAS assertions fail.

The second ordering also carries B's deliberately stale pre-N row and a connection-
creation trap. B must authorize from the complete row read on its one already-open N
handle after A releases. Adding a caller-supplied expected row makes B conflict after
its real native write; opening `readCodexTransitionState` or any second N connection
self-contends and trips the connection assertion.

Hold H in one process and prove a second service/CLI Worker for the same canonical
home/state DB cannot enter manifest, rollout, DB, probe, or terminal-CAS work. While
H is held, execute the real fail-fast claim read and terminal update and observe
`H -> N` without self-contention, proving H did not reuse N's path. The symbol graph
must retain those two required edges and fail independently for injected `N -> H`,
`K -> H`, `C -> H`, `H -> K`, and `H -> C` edges.

For the ninth absence-as-guarantee regression, probe a genuinely missing manifest
and require `kind:"missing"`, `manifest:null`, and `backupEntries:0`. Then seed, one case at a time, unreadable bytes,
malformed JSON, a readable unsupported version/shape, and a valid manifest naming a
different canonical state DB. Every present failure keeps its exact bytes, reports
`backupEntries:null`, performs no rollout/DB/manifest mutation, and cannot produce a
zero/zero converged state. For the tenth recurrence, seed a valid present matching v1
manifest with `entries:{}`. Preflight must return `kind:"ready"` with a validator-
constructed non-negative count of zero, generic restore must execute residual routed-
row ejection without manufacturing `missing` or `unsupported`, and post-probe must
still represent the present valid file as `ready` zero. The fixture preserves its
bytes under the current empty-manifest restore branch. A compile fixture accepts the
validator-produced ready-zero shape and rejects a negative count; `missing` remains
the only null-manifest zero shape. Run the same matrix through no-op admission, final
post-probe, guardian, and doctor projection so no wrapper reintroduces absence.

**The funnel must be provable, not grepped** (round 2 #2). A grep guard misses a
wrapper, re-export, alias or dynamic import. The writer-inventory test above is the
enforcement surface; it permits the history Worker without opening native/catalog
writes to it.

## Accept criteria

- C14 — all 16 management callers funnel through `convergeCodex`, enforced by the
  symbol graph; its WP9 inventory permits exactly the four transitional chains and
  its WP10 inventory adds only the typed `history-job.ts` compatibility/recovery
  authorizers plus the Worker's claim/terminal access; its WP12-final inventory
  permits no legacy or compatibility authorizer root. At every version every first-party
  catalog/backup/cache write requires a fresh permit from the same permanent K owner,
  and every low-level mutator rejects leaked, reused, forged, revoked, or wrong-home
  permits at runtime before filesystem mutation. **Broken change:** add a fifth WP9
  catalog root, retain the WP10 compatibility authorizer in WP12-final, or let a writer
  skip K's runtime permit assertion; the phase graph or permit mutation fixture fails.
- C16 — one owner, one schema; a record from any phase reads in every other. **Broken
  change:** add transition/history authority fields back to the JSON record or make
  provenance required at v1; the cross-phase round-trip/legacy-ambiguity fixture fails.
- C17 — cooperating transition ABA is detected by the durable config/native
  generations and exact txId, and a parent target that drifts once between gather
  and the under-lock commit check is detected by canonical target identity. A
  gathered catalog source whose state, identity, or bytes drift once is detected by
  its role-bearing observation even when the write target and both generations are
  unchanged. This includes required `config.toml` ABSENT -> PRESENT target-selection
  drift, changed OAuth-store authority, changed native-catalog selection, and a
  single-direction raw CODEX_HOME-selector/canonical-root retarget before writing.
  A shared provider flight is keyed by the complete non-secret-bearing
  `CatalogGatherAuthorityIdentity`, returns that producing identity, and cannot build
  a candidate when it differs from the caller's admission. Its model-cache/cooldown
  component is captured as an immutable, detached per-provider effective decision
  before flight lookup; every result-affecting owner mutation advances a monotonic
  epoch, and TTL/cooldown boundary passage changes the decision identity without
  pretending time is an owner mutation. The flight consumes that sealed decision and
  never re-reads cache/cooldown authority after claiming its slot. A runtime-influenced candidate always carries PRESENT-or-ABSENT
  `codex-runtime.json` evidence, and any used runtime/bundled process memo must retain
  its exact monotonic epoch and deeply immutable, non-aliased value identity through
  the commit check.
  Cooperating config N -> N+1 is prevented while the catalog callback holds C, and
  the two-process real `/api/sync` barrier proves every retained first-party catalog
  writer serializes or revalidates its authoritative read-transform-write under K,
  including the retained-gathers-first/acquires-second direction against convergence
  and another retained writer, so neither side can restore stale gathered bytes over
  a later first-party publication. Create-once backups use atomic no-clobber
  publication. An arbitrary filesystem, selector, or content A→B→A that completes
  wholly between two checks, and a non-cooperating write after the final comparison,
  are explicitly not claimed. **Broken change:** restore the partial
  `providerCatalogFingerprint` as the sole flight identity, remove result-authority
  equality, or replace complete under-K evidence revalidation with target-path-only
  comparison; the live-flight or stale-publisher fixture accepts X over Y and fails.
- Contributes to C15 with detect-and-repair: the latest native pair, history job id,
  typed operation, and authority kind/id are durably pending before spawn; a stale
  Worker cannot replace its transition row or the winner's schedule, and the guardian
  eventually repairs history. WP10 holds N from each retained native mutation through
  its compatibility authorization; a newer native handoff replaces even a pending or
  running older schedule, and the older Worker loses its terminal CAS. H has one contract-owned final path per effective
  user/canonical home/canonical state DB and takes only fail-fast `H -> N`;
  compatibility adoption atomically no-clobber-publishes a complete valid v1
  `adoption-pending` coordinator before native mutation. Process death before
  publication leaves the final path absent; death after publication leaves durable
  authority that only a later real native handoff (or WP12 full admission) may move to
  pending. Inverse
  `N/K/C -> H` edges are forbidden. Only `missing` proves path absence; a present
  valid matching v1 manifest is `ready` with a validated non-negative count, including
  zero, while
  unreadable, malformed, unsupported, and foreign-state-DB manifests remain
  preserved, nullable, and non-converged. WP10 implements that protocol. Also contributes to
  C2/C12 (generation-guarded catalog commit plus the phase-specific catalog/full
  admission and observation sequences). **Broken change:** acquire N only after the
  retained native mutation, release N before compatibility authorization, restore a
  caller-supplied expected row or second-connection read, derive creator authority from
  `lstat` `ENOENT` plus SQLite `create:true`, publish a rowless final-path claim, use a
  replacing rename, dispatch history from `adoption-pending`, or route an existing routed
  installation through the strict clean-only initializer, let observation/residue
  alone create a generation-zero row, restore the terminal-only compatibility
  predicate, release H between surfaces, classify a
  present ready-zero manifest as missing/unsupported, or commit catalog bytes after a
  generation/evidence conflict; the stale-row/one-handle, no-clobber-race,
  child-process-death recovery,
  routed apply/restore, negative-adoption, handoff-order, terminal-CAS, serialization, manifest, or
  stale-commit fixture fails respectively.
